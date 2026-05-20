from __future__ import annotations

import json
import os
import time
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Mapping, Optional, Protocol

JsonObject = Dict[str, Any]


@dataclass(frozen=True)
class RunnerProfile:
    runner_id: str
    display_name: Optional[str] = None
    capabilities: JsonObject = field(default_factory=lambda: {"runtime": "deterministic-adk-simulator", "workflowSchemaVersions": ["2025-01"], "supportsCancellation": True, "supportsHeartbeat": True})
    metadata: JsonObject = field(default_factory=dict)


@dataclass(frozen=True)
class RetryBackoff:
    max_attempts: int = 3
    initial_delay_seconds: float = 1.0
    multiplier: float = 2.0
    max_delay_seconds: float = 30.0

    def delay_for_attempt(self, attempt: int) -> float:
        if attempt < 1:
            return 0.0
        return min(self.max_delay_seconds, self.initial_delay_seconds * (self.multiplier ** (attempt - 1)))


def dead_letter_payload(reason: str, attempts: int, *, runner_id: Optional[str] = None, error: Optional[JsonObject] = None) -> JsonObject:
    return {"deadLetter": {"reason": reason, "attempts": attempts, "runnerId": runner_id, "lastError": error or {}, "deadLetteredAt": utc_now_iso()}}


@dataclass(frozen=True)
class LeasedJob:
    id: str
    kind: str
    payload: JsonObject
    status: str = "running"


@dataclass(frozen=True)
class RunRecord:
    id: str
    agent_id: str
    agent_version_id: Optional[str]
    status: str
    input: JsonObject


class RunStore(Protocol):
    def register_runner(self, profile: RunnerProfile) -> None: ...
    def heartbeat_runner(self, profile: RunnerProfile) -> None: ...
    def lease_job(self, worker_id: str, lease_seconds: int) -> Optional[LeasedJob]: ...
    def heartbeat_job(self, job_id: str, worker_id: str, lease_seconds: int) -> None: ...
    def reclaim_expired_leases(self) -> int: ...
    def get_run_for_job(self, job: LeasedJob) -> Optional[RunRecord]: ...
    def get_run_status(self, run_id: str) -> str: ...
    def mark_job(self, job_id: str, status: str, payload_patch: Optional[JsonObject] = None) -> None: ...
    def update_run(self, run_id: str, status: str, *, output: Optional[JsonObject] = None, error: Optional[JsonObject] = None, started: bool = False, completed: bool = False) -> None: ...
    def append_event(self, run_id: str, event_type: str, *, node_id: Optional[str] = None, node_info: Optional[JsonObject] = None, output: Optional[JsonObject] = None, payload: Optional[JsonObject] = None) -> None: ...
    def append_log(self, run_id: str, level: str, message: str, metadata: Optional[JsonObject] = None) -> None: ...
    def create_approval(self, run_id: str, node_id: str, prompt: JsonObject) -> str: ...


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class PostgresRunStore:
    def __init__(self, database_url: str) -> None:
        try:
            import psycopg
            from psycopg.rows import dict_row
        except Exception as exc:  # pragma: no cover - exercised when dependency missing in deployment
            raise RuntimeError("psycopg is required for Postgres-backed worker execution") from exc
        self._psycopg = psycopg
        self._dict_row = dict_row
        self.database_url = database_url

    def _connect(self):
        return self._psycopg.connect(self.database_url, row_factory=self._dict_row)

    @staticmethod
    def _json(value: Any) -> JsonObject:
        if value is None:
            return {}
        if isinstance(value, dict):
            return dict(value)
        if isinstance(value, str):
            loaded = json.loads(value)
            return loaded if isinstance(loaded, dict) else {}
        return {}

    def register_runner(self, profile: RunnerProfile) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO runner_registrations (runner_id, display_name, status, capabilities, metadata, last_heartbeat_at)
                    VALUES (%s, %s, 'online', %s::jsonb, %s::jsonb, now())
                    ON CONFLICT (runner_id) DO UPDATE SET
                      display_name = EXCLUDED.display_name, status = 'online', capabilities = EXCLUDED.capabilities,
                      metadata = EXCLUDED.metadata, last_heartbeat_at = now(), updated_at = now()
                    """,
                    (profile.runner_id, profile.display_name, json.dumps(profile.capabilities), json.dumps(profile.metadata)),
                )

    def heartbeat_runner(self, profile: RunnerProfile) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE runner_registrations SET status = 'online', metadata = %s::jsonb, last_heartbeat_at = now(), updated_at = now() WHERE runner_id = %s",
                    (json.dumps(profile.metadata), profile.runner_id),
                )

    def heartbeat_job(self, job_id: str, worker_id: str, lease_seconds: int) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE run_jobs
                    SET locked_at = now(), updated_at = now(),
                        payload = jsonb_set(payload, '{heartbeat}', %s::jsonb, true)
                    WHERE id = %s AND status = 'running'
                    """,
                    (json.dumps({"workerId": worker_id, "heartbeatAt": utc_now_iso(), "leaseSeconds": lease_seconds}), job_id),
                )

    def reclaim_expired_leases(self) -> int:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE run_jobs
                    SET status = 'queued', locked_at = NULL, updated_at = now(),
                        payload = payload || %s::jsonb
                    WHERE status = 'running'
                      AND locked_at IS NOT NULL
                      AND locked_at < now() - ((COALESCE((payload #>> '{lease,leaseSeconds}')::int, 60)) * interval '1 second')
                    """,
                    (json.dumps({"reclaimedAt": utc_now_iso()}),),
                )
                return int(cur.rowcount or 0)

    def lease_job(self, worker_id: str, lease_seconds: int) -> Optional[LeasedJob]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE run_jobs
                    SET status = 'running', locked_at = now(), updated_at = now(),
                        payload = jsonb_set(payload, '{lease}', %s::jsonb, true)
                    WHERE id = (
                      SELECT id FROM run_jobs
                      WHERE status = 'queued' AND available_at <= now()
                      ORDER BY available_at ASC, created_at ASC
                      FOR UPDATE SKIP LOCKED
                      LIMIT 1
                    )
                    RETURNING id::text, kind, status, payload
                    """,
                    (json.dumps({"workerId": worker_id, "leasedAt": utc_now_iso(), "leaseSeconds": lease_seconds}),),
                )
                row = cur.fetchone()
        if row is None:
            return None
        return LeasedJob(id=row["id"], kind=row["kind"], status=row["status"], payload=self._json(row["payload"]))

    def get_run_for_job(self, job: LeasedJob) -> Optional[RunRecord]:
        payload_run_id = job.payload.get("runId")
        with self._connect() as conn:
            with conn.cursor() as cur:
                if isinstance(payload_run_id, str):
                    cur.execute("SELECT id::text, agent_id::text, agent_version_id::text, status, input FROM runs WHERE id = %s LIMIT 1", (payload_run_id,))
                else:
                    cur.execute("SELECT id::text, agent_id::text, agent_version_id::text, status, input FROM runs WHERE run_job_id = %s LIMIT 1", (job.id,))
                row = cur.fetchone()
        if row is None:
            return None
        return RunRecord(id=row["id"], agent_id=row["agent_id"], agent_version_id=row["agent_version_id"], status=row["status"], input=self._json(row["input"]))

    def get_run_status(self, run_id: str) -> str:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT status FROM runs WHERE id = %s", (run_id,))
                row = cur.fetchone()
        return str(row["status"]) if row else "missing"

    def mark_job(self, job_id: str, status: str, payload_patch: Optional[JsonObject] = None) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                if payload_patch:
                    cur.execute(
                        "UPDATE run_jobs SET status = %s, payload = payload || %s::jsonb, updated_at = now() WHERE id = %s",
                        (status, json.dumps(payload_patch), job_id),
                    )
                else:
                    cur.execute("UPDATE run_jobs SET status = %s, updated_at = now() WHERE id = %s", (status, job_id))

    def update_run(self, run_id: str, status: str, *, output: Optional[JsonObject] = None, error: Optional[JsonObject] = None, started: bool = False, completed: bool = False) -> None:
        sets = ["status = %s", "updated_at = now()"]
        params: list[Any] = [status]
        if output is not None:
            sets.append("output = %s::jsonb")
            params.append(json.dumps(output))
        if error is not None:
            sets.append("error = %s::jsonb")
            params.append(json.dumps(error))
        if started:
            sets.append("started_at = COALESCE(started_at, now())")
        if completed:
            sets.append("completed_at = now()")
        params.append(run_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(f"UPDATE runs SET {', '.join(sets)} WHERE id = %s", params)

    def _next_sequence(self, cur: Any, table: str, run_id: str) -> int:
        cur.execute(f"SELECT COALESCE(MAX(sequence), 0) + 1 AS seq FROM {table} WHERE run_id = %s", (run_id,))
        return int(cur.fetchone()["seq"])

    def append_event(self, run_id: str, event_type: str, *, node_id: Optional[str] = None, node_info: Optional[JsonObject] = None, output: Optional[JsonObject] = None, payload: Optional[JsonObject] = None) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                sequence = self._next_sequence(cur, "run_events", run_id)
                cur.execute(
                    "INSERT INTO run_events (run_id, sequence, event_type, node_id, node_info, output, payload) VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb)",
                    (run_id, sequence, event_type, node_id, json.dumps(node_info or {}), json.dumps(output) if output is not None else None, json.dumps(payload or {})),
                )

    def append_log(self, run_id: str, level: str, message: str, metadata: Optional[JsonObject] = None) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                sequence = self._next_sequence(cur, "run_logs", run_id)
                cur.execute(
                    "INSERT INTO run_logs (run_id, sequence, level, message, metadata) VALUES (%s, %s, %s, %s, %s::jsonb)",
                    (run_id, sequence, level, message, json.dumps(metadata or {})),
                )

    def create_approval(self, run_id: str, node_id: str, prompt: JsonObject) -> str:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO human_approvals (run_id, node_id, status, prompt) VALUES (%s, %s, 'pending', %s::jsonb) RETURNING id::text",
                    (run_id, node_id, json.dumps(prompt)),
                )
                row = cur.fetchone()
        return str(row["id"])


class DeterministicWorkflowExecutor:
    def __init__(self, store: RunStore) -> None:
        self.store = store

    def execute(self, job: LeasedJob, run: RunRecord) -> None:
        payload = job.payload
        workflow = payload.get("workflowIr") or payload.get("workflow")
        if not isinstance(workflow, dict):
            raise ValueError("run job payload is missing workflowIr")
        adk_bundle = payload.get("adkBundle") if isinstance(payload.get("adkBundle"), dict) else {}
        manifest = adk_bundle.get("manifest") if isinstance(adk_bundle.get("manifest"), dict) else {}
        files = adk_bundle.get("files") if isinstance(adk_bundle.get("files"), list) else []
        nodes = {str(node.get("id")): node for node in workflow.get("nodes", []) if isinstance(node, dict) and node.get("id")}
        edges = [edge for edge in workflow.get("edges", []) if isinstance(edge, dict)]
        start_node_id = self._start_node_id(workflow, payload)
        resume = payload.get("resume") if isinstance(payload.get("resume"), dict) else None
        current = self._next_after(str(resume.get("nodeId")), edges) if resume and resume.get("nodeId") else start_node_id
        visited: list[str] = []
        last_output: JsonObject = dict(resume.get("response", {})) if resume and isinstance(resume.get("response"), dict) else dict(run.input)

        self.store.update_run(run.id, "running", started=True)
        self.store.append_log(run.id, "info", "Worker started run", {"jobId": job.id, "kind": job.kind, "adapter": "deterministic-adk-simulator"})
        if manifest:
            self.store.append_log(run.id, "debug", "Loaded compiled ADK artifact bundle", {"entrypoint": manifest.get("entrypoint"), "artifactCount": len(files), "compiler": manifest.get("compiler")})
        else:
            self.store.append_log(run.id, "warn", "Run job did not include an ADK manifest; continuing with workflow IR only", {"jobId": job.id})
        if resume:
            self.store.append_event(run.id, "hitl.resumed", node_id=str(resume.get("nodeId")), payload={"approvalId": resume.get("approvalId"), "response": last_output})

        while current:
            if self.store.get_run_status(run.id) == "canceled":
                self.store.append_log(run.id, "warn", "Run cancellation observed by worker", {"jobId": job.id, "nodeId": current})
                self.store.mark_job(job.id, "canceled")
                return
            node = nodes.get(current)
            if node is None:
                raise ValueError(f"workflow edge points to missing node '{current}'")
            node_info = {"name": node.get("name"), "type": node.get("type"), "category": node.get("category")}
            visited.append(current)
            self.store.append_event(run.id, "node.started", node_id=current, node_info=node_info, payload={"input": last_output})

            human_policy = node.get("humanInput") or (node.get("runtime") if isinstance(node.get("runtime"), dict) else {}).get("humanInput")
            if node.get("category") == "human-input" or human_policy:
                approval_id = self.store.create_approval(run.id, current, {"nodeId": current, "policy": human_policy or {}, "input": last_output})
                self.store.append_event(run.id, "hitl.paused", node_id=current, node_info=node_info, payload={"approvalId": approval_id, "policy": human_policy or {}})
                self.store.append_log(run.id, "info", "Run paused for human input", {"approvalId": approval_id, "nodeId": current})
                self.store.update_run(run.id, "awaiting_approval")
                self.store.mark_job(job.id, "succeeded", {"pausedRunId": run.id, "approvalId": approval_id})
                return

            last_output = self._execute_node_with_retry(run.id, current, node, last_output)
            self.store.append_event(run.id, "node.completed", node_id=current, node_info=node_info, output=last_output)
            if node.get("category") == "terminal":
                break
            current = self._select_next(node, edges)

        output = {"result": last_output, "visited": visited, "adapter": "deterministic-adk-simulator", "diagnostic": "Live Google ADK model/tool execution is intentionally not performed by this adapter."}
        self.store.append_event(run.id, "run.completed", output=output)
        self.store.append_log(run.id, "info", "Worker completed run", {"jobId": job.id, "visited": visited})
        self.store.update_run(run.id, "succeeded", output=output, completed=True)
        self.store.mark_job(job.id, "succeeded")

    def _execute_node_with_retry(self, run_id: str, node_id: str, node: Mapping[str, Any], input_payload: JsonObject) -> JsonObject:
        runtime = node.get("runtime") if isinstance(node.get("runtime"), dict) else {}
        retry = runtime.get("retry") if isinstance(runtime.get("retry"), dict) else {}
        max_attempts = max(1, int(retry.get("maxAttempts", 1) or 1))
        failures_before_success = int(((node.get("config") if isinstance(node.get("config"), dict) else {}) or {}).get("simulateFailures", 0) or 0)
        for attempt in range(1, max_attempts + 1):
            try:
                if attempt <= failures_before_success:
                    raise RuntimeError(f"simulated transient failure for {node_id}")
                return self._simulate_node(node, input_payload, attempt)
            except Exception as exc:
                if attempt >= max_attempts:
                    self.store.append_log(run_id, "error", "Node failed after retry policy was exhausted", {"nodeId": node_id, "attempt": attempt, "error": str(exc)})
                    raise
                self.store.append_log(run_id, "warn", "Node execution failed; retrying", {"nodeId": node_id, "attempt": attempt, "maxAttempts": max_attempts, "error": str(exc)})
        return input_payload

    def _simulate_node(self, node: Mapping[str, Any], input_payload: JsonObject, attempt: int) -> JsonObject:
        category = node.get("category")
        if category in {"start", "router", "loop", "memory", "transform"}:
            return dict(input_payload)
        if category == "terminal":
            return dict(input_payload)
        runtime = node.get("runtime") if isinstance(node.get("runtime"), dict) else {}
        return {
            **input_payload,
            "nodeId": node.get("id"),
            "nodeName": node.get("name"),
            "simulated": True,
            "attempt": attempt,
            "runtimeKind": runtime.get("kind", "noop"),
        }

    def _start_node_id(self, workflow: Mapping[str, Any], payload: Mapping[str, Any]) -> Optional[str]:
        if isinstance(payload.get("startNodeId"), str):
            return str(payload["startNodeId"])
        for node in workflow.get("nodes", []):
            if isinstance(node, dict) and node.get("category") == "start":
                return str(node.get("id"))
        return None

    def _select_next(self, node: Mapping[str, Any], edges: Iterable[Mapping[str, Any]]) -> Optional[str]:
        outgoing = [edge for edge in edges if edge.get("source") == node.get("id")]
        if not outgoing:
            return None
        if node.get("category") == "router":
            default = next((edge for edge in outgoing if edge.get("sourceHandle") == "default"), None)
            return str((default or outgoing[0]).get("target"))
        if node.get("category") == "loop":
            loop = node.get("loop") if isinstance(node.get("loop"), dict) else {}
            exit_handle = loop.get("exitHandle")
            if exit_handle:
                edge = next((candidate for candidate in outgoing if candidate.get("sourceHandle") == exit_handle), None)
                if edge:
                    return str(edge.get("target"))
        return str(outgoing[0].get("target"))

    def _next_after(self, node_id: str, edges: Iterable[Mapping[str, Any]]) -> Optional[str]:
        for edge in edges:
            if edge.get("source") == node_id:
                return str(edge.get("target"))
        return None


class Worker:
    def __init__(self, store: RunStore, *, worker_id: Optional[str] = None, lease_seconds: int = 60, profile: Optional[RunnerProfile] = None) -> None:
        self.store = store
        self.worker_id = worker_id or f"worker-{uuid.uuid4()}"
        self.lease_seconds = lease_seconds
        self.profile = profile or RunnerProfile(runner_id=self.worker_id, display_name="robflow worker-adk")
        self.executor = DeterministicWorkflowExecutor(store)

    def run_once(self) -> bool:
        self.store.register_runner(self.profile)
        self.store.heartbeat_runner(self.profile)
        self.store.reclaim_expired_leases()
        job = self.store.lease_job(self.worker_id, self.lease_seconds)
        if job is None:
            return False
        self.store.heartbeat_job(job.id, self.worker_id, self.lease_seconds)
        run = self.store.get_run_for_job(job)
        if run is None:
            self.store.mark_job(job.id, "failed", {"error": {"message": "No run found for leased job"}})
            return True
        if run.status == "canceled":
            self.store.mark_job(job.id, "canceled")
            self.store.append_log(run.id, "warn", "Skipping canceled run", {"jobId": job.id})
            return True
        try:
            self.executor.execute(job, run)
        except Exception as exc:
            error = {"message": str(exc), "type": exc.__class__.__name__, "traceback": traceback.format_exc()}
            self.store.append_log(run.id, "error", "Worker failed run", error)
            self.store.append_event(run.id, "run.failed", payload=error)
            self.store.update_run(run.id, "failed", error=error, completed=True)
            self.store.mark_job(job.id, "failed", {"error": error})
        return True

    def run_forever(self, poll_interval_seconds: float = 2.0) -> None:
        while True:
            worked = self.run_once()
            if not worked:
                time.sleep(poll_interval_seconds)


def create_postgres_worker(database_url: Optional[str] = None) -> Worker:
    url = database_url or os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is required to start the ADK worker runtime")
    return Worker(PostgresRunStore(url))
