from __future__ import annotations

import json
import os
import base64
import time
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib import request, error, parse
from typing import Any, Dict, Iterable, Mapping, Optional, Protocol

JsonObject = Dict[str, Any]
INFERENCE_CONFIG_KEY = "inference.global"
INFERENCE_SECRET_PREFIX = "aes-256-gcm:"
INFERENCE_ENCRYPTION_KEY_ENV = "INFERENCE_CONFIG_ENCRYPTION_KEY"
DEFAULT_SEARXNG_BASE_URL = "http://192.168.6.17:8088"
DEFAULT_FIRECRAWL_BASE_URL = "http://192.168.6.17:3002"


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


class HttpJsonRequestError(RuntimeError):
    def __init__(self, url: str, status: Optional[int], body: str, message: str) -> None:
        super().__init__(message)
        self.url = url
        self.status = status
        self.body = body


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
    def resolve_inference_config(self) -> JsonObject: ...


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _decode_inference_key() -> bytes:
    raw = os.getenv(INFERENCE_ENCRYPTION_KEY_ENV)
    if not raw:
        raise RuntimeError(f"{INFERENCE_ENCRYPTION_KEY_ENV} is required to run live inference")
    encoded = raw[7:] if raw.startswith("base64:") else raw
    try:
        key = bytes.fromhex(encoded) if len(encoded) == 64 and all(char in "0123456789abcdefABCDEF" for char in encoded) else base64.b64decode(encoded)
    except Exception as exc:
        raise RuntimeError(f"{INFERENCE_ENCRYPTION_KEY_ENV} must be base64 or 64 hex characters") from exc
    if len(key) != 32:
        raise RuntimeError(f"{INFERENCE_ENCRYPTION_KEY_ENV} must decode to 32 bytes")
    return key


def _decrypt_inference_secret(ciphertext: str) -> str:
    if not ciphertext.startswith(INFERENCE_SECRET_PREFIX):
        raise RuntimeError("Unsupported inference secret ciphertext format")
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except Exception as exc:  # pragma: no cover - dependency install failure
        raise RuntimeError("cryptography is required to decrypt saved inference API keys") from exc
    payload = base64.b64decode(ciphertext[len(INFERENCE_SECRET_PREFIX):])
    if len(payload) <= 28:
        raise RuntimeError("Inference secret ciphertext is malformed")
    iv = payload[:12]
    tag = payload[12:28]
    encrypted = payload[28:]
    return AESGCM(_decode_inference_key()).decrypt(iv, encrypted + tag, None).decode("utf-8")


def _as_text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value.strip() else None


def _as_int(value: Any, default: int, *, minimum: int = 1, maximum: int = 100) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        normalized = default
    return max(minimum, min(maximum, normalized))


def _extract_json_object(text: str) -> Optional[JsonObject]:
    stripped = text.strip()
    candidates = [stripped]
    if "```" in stripped:
        parts = stripped.split("```")
        candidates.extend(part.removeprefix("json").strip() for part in parts if part.strip())
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start >= 0 and end > start:
        candidates.append(stripped[start:end + 1])
    for candidate in candidates:
        try:
            loaded = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(loaded, dict):
            return dict(loaded)
    return None


def _extract_string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [entry.strip() for entry in value if isinstance(entry, str) and entry.strip()]
    return []


def _truncate(value: str, limit: int) -> str:
    return value if len(value) <= limit else f"{value[:limit].rstrip()}..."


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

    def resolve_inference_config(self) -> JsonObject:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM app_config WHERE key = %s LIMIT 1", (INFERENCE_CONFIG_KEY,))
                row = cur.fetchone()
                config = self._json(row["value"]) if row else {}
                secret_id = config.get("apiKeySecretId")
                if isinstance(secret_id, str) and secret_id:
                    cur.execute("SELECT ciphertext FROM secret_records WHERE id = %s LIMIT 1", (secret_id,))
                    secret = cur.fetchone()
                    if not secret:
                        raise RuntimeError("Configured inference API key secret is missing")
                    config["apiKey"] = _decrypt_inference_secret(str(secret["ciphertext"]))
                return config


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
        loop_counts: dict[str, int] = {}

        self.store.update_run(run.id, "running", started=True)
        self.store.append_log(run.id, "info", "Worker started run", {"jobId": job.id, "kind": job.kind, "adapter": "robflow-live-openai-compatible"})
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
            current = self._select_next(node, edges, last_output, loop_counts)

        output = {"result": last_output, "visited": visited, "adapter": "robflow-live-openai-compatible"}
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
                return self._execute_node(run_id, node_id, node, input_payload, attempt)
            except Exception as exc:
                if attempt >= max_attempts:
                    self.store.append_log(run_id, "error", "Node failed after retry policy was exhausted", {"nodeId": node_id, "attempt": attempt, "error": str(exc)})
                    raise
                self.store.append_log(run_id, "warn", "Node execution failed; retrying", {"nodeId": node_id, "attempt": attempt, "maxAttempts": max_attempts, "error": str(exc)})
        return input_payload

    def _execute_node(self, run_id: str, node_id: str, node: Mapping[str, Any], input_payload: JsonObject, attempt: int) -> JsonObject:
        category = node.get("category")
        if category in {"start", "router", "loop", "memory", "transform"}:
            return dict(input_payload)
        if category == "terminal":
            return dict(input_payload)
        runtime = node.get("runtime") if isinstance(node.get("runtime"), dict) else {}
        if category == "action" and isinstance(runtime.get("tool"), dict):
            return self._execute_tool_node(run_id, node_id, node, input_payload, attempt)
        if category == "action" and isinstance(runtime.get("model"), dict):
            return self._execute_llm_node(run_id, node_id, node, input_payload, attempt)
        return {
            **input_payload,
            "nodeId": node.get("id"),
            "nodeName": node.get("name"),
            "simulated": True,
            "attempt": attempt,
            "runtimeKind": runtime.get("kind", "noop"),
        }

    def _execute_llm_node(self, run_id: str, node_id: str, node: Mapping[str, Any], input_payload: JsonObject, attempt: int) -> JsonObject:
        runtime = node.get("runtime") if isinstance(node.get("runtime"), dict) else {}
        model_binding = runtime.get("model") if isinstance(runtime.get("model"), dict) else {}
        config = self.store.resolve_inference_config()
        base_url = _as_text(config.get("baseUrl"))
        if not base_url:
            raise RuntimeError("Inference endpoint base URL is not configured")
        model = _as_text(model_binding.get("model"))
        if model in {"unknown", "configure-me"}:
            model = None
        model = model or _as_text(config.get("defaultModel"))
        if not model:
            raise RuntimeError("No model is configured for this LLM node or global inference settings")
        node_config = node.get("config") if isinstance(node.get("config"), dict) else {}
        deep_research = node_config.get("deepResearch") if isinstance(node_config.get("deepResearch"), dict) else None
        if deep_research is not None:
            return self._execute_deep_research_node(run_id, node_id, node, input_payload, config, model, deep_research)
        instructions = _as_text(model_binding.get("instructions"))
        request_body: JsonObject = {
            "model": model,
            "messages": self._messages_for_request(instructions, input_payload),
        }
        if isinstance(model_binding.get("temperature"), (int, float)):
            request_body["temperature"] = model_binding.get("temperature")
        self.store.append_event(run_id, "model.requested", node_id=node_id, node_info={"model": model, "provider": model_binding.get("provider")}, payload={"attempt": attempt})
        response_body = self._post_chat_completion(config, request_body)
        content = self._extract_message_content(response_body)
        usage = response_body.get("usage") if isinstance(response_body.get("usage"), dict) else {}
        parsed = _extract_json_object(content) if node_config.get("parseJson") is True or node_config.get("mergeJsonOutput") is True else None
        output = {
            **input_payload,
            "response": content,
            "model": model,
            "usage": usage,
            "nodeId": node.get("id"),
            "nodeName": node.get("name"),
        }
        if parsed is not None and node_config.get("mergeJsonOutput") is True:
            output.update(parsed)
        elif parsed is not None:
            output["parsedResponse"] = parsed
        self.store.append_event(run_id, "model.completed", node_id=node_id, node_info={"model": model}, output={"response": content}, payload={"usage": usage})
        return output

    def _execute_tool_node(self, run_id: str, node_id: str, node: Mapping[str, Any], input_payload: JsonObject, attempt: int) -> JsonObject:
        runtime = node.get("runtime") if isinstance(node.get("runtime"), dict) else {}
        tool = runtime.get("tool") if isinstance(runtime.get("tool"), dict) else {}
        config = node.get("config") if isinstance(node.get("config"), dict) else {}
        tool_name = _as_text(tool.get("name")) or _as_text(config.get("toolName")) or "unknown"
        self.store.append_event(run_id, "tool.called", node_id=node_id, node_info={"toolName": tool_name}, payload={"input": input_payload, "attempt": attempt})
        if tool_name == "searxng.search":
            output = self._execute_searxng_tool(input_payload, config)
        elif tool_name in {"firecrawl.research", "firecrawl.scrape", "firecrawl.map", "firecrawl.crawl"}:
            output = self._execute_firecrawl_tool(run_id, node_id, input_payload, config, tool_name)
        else:
            output = {
                **input_payload,
                "nodeId": node.get("id"),
                "nodeName": node.get("name"),
                "simulated": True,
                "attempt": attempt,
                "toolName": tool_name,
            }
        self.store.append_event(run_id, "tool.completed", node_id=node_id, node_info={"toolName": tool_name}, output=output)
        return output

    def _execute_searxng_tool(self, input_payload: JsonObject, config: Mapping[str, Any]) -> JsonObject:
        base_url = (_as_text(config.get("baseUrl")) or DEFAULT_SEARXNG_BASE_URL).rstrip("/")
        max_queries = _as_int(config.get("maxQueries"), 3, minimum=1, maximum=10)
        max_results = _as_int(config.get("maxResults"), 5, minimum=1, maximum=20)
        queries = self._extract_search_queries(input_payload)[:max_queries]
        results: list[JsonObject] = []
        for query in queries:
            results.extend(self._search_searxng(base_url, query, max_results))
        existing = input_payload.get("searchResults") if isinstance(input_payload.get("searchResults"), list) else []
        return {
            **input_payload,
            "searchQueries": queries,
            "searchResults": self._dedupe_results([*existing, *results])[:100],
            "searxng": {"baseUrl": base_url, "maxResults": max_results},
        }

    def _execute_firecrawl_tool(self, run_id: str, node_id: str, input_payload: JsonObject, config: Mapping[str, Any], tool_name: str) -> JsonObject:
        base_url = (_as_text(config.get("baseUrl")) or DEFAULT_FIRECRAWL_BASE_URL).rstrip("/")
        max_pages = _as_int(config.get("maxPages"), 6, minimum=1, maximum=30)
        operation = _as_text(config.get("operation")) or tool_name.removeprefix("firecrawl.")
        enforce_allowlist = config.get("enforceUrlAllowlist") is not False
        fail_soft = config.get("failSoft") is not False
        selected_urls = self._extract_urls(input_payload)
        allowed_urls = self._allowed_firecrawl_urls(input_payload)
        rejected_urls: list[str] = []
        if enforce_allowlist and allowed_urls:
            allowed = set(allowed_urls)
            rejected_urls = [url for url in selected_urls if url not in allowed]
            urls = [url for url in selected_urls if url in allowed]
            if len(urls) < max_pages:
                urls.extend([url for url in allowed_urls if url not in urls])
        else:
            urls = selected_urls or allowed_urls
        urls = list(dict.fromkeys(urls))[:max_pages]
        if rejected_urls:
            self.store.append_log(run_id, "warn", "Rejected Firecrawl URLs not present in search/map evidence", {"nodeId": node_id, "operation": operation, "rejectedUrls": rejected_urls[:20]})
            self.store.append_event(run_id, "tool.url_rejected", node_id=node_id, node_info={"toolName": tool_name}, payload={"operation": operation, "rejectedUrls": rejected_urls[:20]})
        documents: list[JsonObject] = []
        failures: list[JsonObject] = []
        for url in urls:
            try:
                if operation == "map":
                    documents.append(self._firecrawl_map(base_url, url))
                elif operation == "crawl":
                    documents.append(self._firecrawl_crawl(base_url, url, config))
                else:
                    documents.append(self._firecrawl_scrape(base_url, url))
            except Exception as exc:
                failure = self._firecrawl_failure(url, operation, exc)
                failures.append(failure)
                self.store.append_log(run_id, "warn", "Firecrawl URL failed; continuing with remaining URLs", {"nodeId": node_id, **failure})
                self.store.append_event(run_id, "tool.url_failed", node_id=node_id, node_info={"toolName": tool_name}, payload=failure)
                if not fail_soft:
                    raise
        existing = input_payload.get("firecrawlDocuments") if isinstance(input_payload.get("firecrawlDocuments"), list) else []
        if not documents and not existing and failures:
            self.store.append_log(run_id, "error", "Firecrawl failed for every URL and no prior documents are available", {"nodeId": node_id, "operation": operation, "failures": failures[:10]})
            raise RuntimeError(f"Firecrawl failed for every {operation} URL")
        return {
            **input_payload,
            "firecrawlDocuments": [*existing, *documents],
            "firecrawlFailures": [*(input_payload.get("firecrawlFailures") if isinstance(input_payload.get("firecrawlFailures"), list) else []), *failures],
            "firecrawlRejectedUrls": [*(input_payload.get("firecrawlRejectedUrls") if isinstance(input_payload.get("firecrawlRejectedUrls"), list) else []), *rejected_urls],
            "firecrawl": {"baseUrl": base_url, "operation": operation, "maxPages": max_pages, "failSoft": fail_soft, "enforceUrlAllowlist": enforce_allowlist},
        }

    def _execute_deep_research_node(self, run_id: str, node_id: str, node: Mapping[str, Any], input_payload: JsonObject, inference_config: Mapping[str, Any], model: str, research_config: Mapping[str, Any]) -> JsonObject:
        user_request = self._user_request(input_payload)
        searxng_base_url = (_as_text(research_config.get("searxngBaseUrl")) or DEFAULT_SEARXNG_BASE_URL).rstrip("/")
        firecrawl_base_url = (_as_text(research_config.get("firecrawlBaseUrl")) or DEFAULT_FIRECRAWL_BASE_URL).rstrip("/")
        max_iterations = _as_int(input_payload.get("maxIterations") if input_payload.get("maxIterations") is not None else research_config.get("maxIterations"), 3, minimum=1, maximum=10)
        max_queries = _as_int(research_config.get("maxQueriesPerIteration"), 3, minimum=1, maximum=10)
        max_results = _as_int(research_config.get("maxResultsPerQuery"), 5, minimum=1, maximum=20)
        max_pages = _as_int(research_config.get("maxPagesPerIteration"), 5, minimum=1, maximum=20)
        all_results = list(input_payload.get("searchResults")) if isinstance(input_payload.get("searchResults"), list) else []
        documents = list(input_payload.get("firecrawlDocuments")) if isinstance(input_payload.get("firecrawlDocuments"), list) else []
        scraped_urls = {str(doc.get("url")) for doc in documents if isinstance(doc, dict) and doc.get("url")}
        gaps = ""
        report_markdown = ""
        sufficient = False
        iterations: list[JsonObject] = []

        for iteration in range(1, max_iterations + 1):
            queries = self._plan_research_queries(inference_config, model, user_request, gaps, max_queries)
            iteration_results: list[JsonObject] = []
            for query in queries:
                iteration_results.extend(self._search_searxng(searxng_base_url, query, max_results))
            all_results = self._dedupe_results([*all_results, *iteration_results])
            urls = [entry["url"] for entry in all_results if isinstance(entry, dict) and isinstance(entry.get("url"), str) and entry["url"] not in scraped_urls][:max_pages]
            iteration_docs: list[JsonObject] = []
            for url in urls:
                doc = self._firecrawl_scrape(firecrawl_base_url, url)
                iteration_docs.append(doc)
                scraped_urls.add(url)
            documents.extend(iteration_docs)
            review = self._draft_and_review_report(inference_config, model, user_request, documents, iteration, max_iterations, gaps)
            report_markdown = _as_text(review.get("reportMarkdown")) or _as_text(review.get("report")) or report_markdown
            sufficient = bool(review.get("sufficient"))
            gaps = _as_text(review.get("gaps")) or ""
            iterations.append({"iteration": iteration, "queries": queries, "resultCount": len(iteration_results), "scrapedUrls": urls, "sufficient": sufficient, "gaps": gaps})
            self.store.append_event(run_id, "research.iteration", node_id=node_id, node_info={"model": model}, payload=iterations[-1])
            if sufficient:
                break

        sources = [{"title": doc.get("title"), "url": doc.get("url")} for doc in documents if isinstance(doc, dict) and doc.get("url")]
        output = {
            **input_payload,
            "response": report_markdown,
            "reportMarkdown": report_markdown,
            "sufficient": sufficient,
            "gaps": gaps,
            "iterations": iterations,
            "sources": sources,
            "searchResults": all_results,
            "firecrawlDocuments": documents,
            "model": model,
            "nodeId": node.get("id"),
            "nodeName": node.get("name"),
        }
        self.store.append_event(run_id, "model.completed", node_id=node_id, node_info={"model": model, "mode": "deep-research"}, output={"reportMarkdown": report_markdown}, payload={"iterations": iterations, "sufficient": sufficient, "sourceCount": len(sources)})
        return output

    def _extract_search_queries(self, input_payload: Mapping[str, Any]) -> list[str]:
        response = _as_text(input_payload.get("response")) or _as_text(input_payload.get("reportMarkdown"))
        parsed = _extract_json_object(response) if response else None
        for source in [parsed, input_payload]:
            if isinstance(source, dict):
                for key in ["searchQueries", "queries", "searches"]:
                    queries = _extract_string_list(source.get(key))
                    if queries:
                        return queries
        return [self._user_request(input_payload)]

    def _extract_urls(self, input_payload: Mapping[str, Any]) -> list[str]:
        explicit = _extract_string_list(input_payload.get("urls"))
        if explicit:
            return explicit
        results = input_payload.get("searchResults")
        if not isinstance(results, list):
            return []
        urls = []
        for result in results:
            if isinstance(result, dict) and isinstance(result.get("url"), str):
                urls.append(result["url"])
        return list(dict.fromkeys(urls))

    def _allowed_firecrawl_urls(self, input_payload: Mapping[str, Any]) -> list[str]:
        urls: list[str] = []

        def append_url(value: Any) -> None:
            text = _as_text(value)
            if text:
                urls.append(text)

        results = input_payload.get("searchResults")
        if isinstance(results, list):
            for result in results:
                if isinstance(result, Mapping):
                    append_url(result.get("url"))
                    append_url(result.get("link"))
        documents = input_payload.get("firecrawlDocuments")
        if isinstance(documents, list):
            for document in documents:
                if not isinstance(document, Mapping):
                    continue
                append_url(document.get("url"))
                links = document.get("links")
                if isinstance(links, list):
                    urls.extend(_extract_string_list(links))
                raw = document.get("raw")
                if isinstance(raw, Mapping):
                    urls.extend(_extract_string_list(raw.get("links")))
                    data = raw.get("data")
                    if isinstance(data, list):
                        urls.extend(_extract_string_list(data))
                    elif isinstance(data, Mapping):
                        urls.extend(_extract_string_list(data.get("links")))
        return [url for url in dict.fromkeys(urls) if url.startswith(("http://", "https://"))]

    def _firecrawl_failure(self, url: str, operation: str, exc: Exception) -> JsonObject:
        if isinstance(exc, HttpJsonRequestError):
            return {"operation": operation, "url": url, "status": exc.status, "error": str(exc), "body": _truncate(exc.body, 1000)}
        return {"operation": operation, "url": url, "status": None, "error": str(exc), "body": ""}

    def _user_request(self, input_payload: Mapping[str, Any]) -> str:
        return next((_as_text(input_payload.get(key)) for key in ["userRequest", "user_request", "request", "prompt", "message", "input", "query"] if _as_text(input_payload.get(key))), None) or json.dumps(input_payload, ensure_ascii=False)

    def _search_searxng(self, base_url: str, query: str, max_results: int) -> list[JsonObject]:
        params = parse.urlencode({"q": query, "format": "json", "language": "en", "safesearch": "0"})
        with request.urlopen(f"{base_url}/search?{params}", timeout=30) as response:
            body = json.loads(response.read().decode("utf-8"))
        raw_results = body.get("results") if isinstance(body, dict) else []
        results: list[JsonObject] = []
        if isinstance(raw_results, list):
            for entry in raw_results[:max_results]:
                if not isinstance(entry, dict):
                    continue
                url = _as_text(entry.get("url"))
                if not url:
                    continue
                results.append({
                    "query": query,
                    "title": _as_text(entry.get("title")) or url,
                    "url": url,
                    "snippet": _as_text(entry.get("content")) or _as_text(entry.get("snippet")) or "",
                    "engine": _as_text(entry.get("engine")),
                    "score": entry.get("score") if isinstance(entry.get("score"), (int, float)) else None,
                })
        return results

    def _dedupe_results(self, results: Iterable[Any]) -> list[JsonObject]:
        seen: set[str] = set()
        deduped: list[JsonObject] = []
        for result in results:
            if not isinstance(result, dict) or not isinstance(result.get("url"), str):
                continue
            if result["url"] in seen:
                continue
            seen.add(result["url"])
            deduped.append(dict(result))
        return deduped

    def _post_json(self, url: str, body: JsonObject, timeout: int = 60) -> JsonObject:
        req = request.Request(url, data=json.dumps(body).encode("utf-8"), headers={"content-type": "application/json"}, method="POST")
        try:
            with request.urlopen(req, timeout=timeout) as response:
                decoded = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            body_text = exc.read().decode("utf-8", errors="replace")
            raise HttpJsonRequestError(url, exc.code, body_text, f"HTTP {exc.code} from {url}") from exc
        if not isinstance(decoded, dict):
            raise RuntimeError(f"{url} returned a non-object JSON response")
        return decoded

    def _firecrawl_scrape(self, base_url: str, url: str) -> JsonObject:
        body = self._post_json(f"{base_url}/v1/scrape", {"url": url, "formats": ["markdown"]}, timeout=90)
        data = body.get("data") if isinstance(body.get("data"), dict) else body
        metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
        return {
            "operation": "scrape",
            "url": _as_text(data.get("url")) or url,
            "title": _as_text(metadata.get("title")) or _as_text(data.get("title")) or url,
            "markdown": _truncate(_as_text(data.get("markdown")) or _as_text(data.get("content")) or "", 16000),
            "metadata": metadata,
        }

    def _firecrawl_map(self, base_url: str, url: str) -> JsonObject:
        body = self._post_json(f"{base_url}/v1/map", {"url": url}, timeout=60)
        links = body.get("links") or (body.get("data") if isinstance(body.get("data"), list) else [])
        return {"operation": "map", "url": url, "links": links if isinstance(links, list) else [], "raw": body}

    def _firecrawl_crawl(self, base_url: str, url: str, config: Mapping[str, Any]) -> JsonObject:
        limit = _as_int(config.get("crawlLimit"), 10, minimum=1, maximum=100)
        body = self._post_json(f"{base_url}/v1/crawl", {"url": url, "limit": limit, "scrapeOptions": {"formats": ["markdown"]}}, timeout=120)
        return {"operation": "crawl", "url": url, "raw": body}

    def _plan_research_queries(self, inference_config: Mapping[str, Any], model: str, user_request: str, gaps: str, max_queries: int) -> list[str]:
        prompt = f"User research request: {user_request}\nKnown gaps to address: {gaps or 'none'}\nReturn only JSON with a 'queries' array of up to {max_queries} precise web search queries."
        body = self._post_chat_completion(inference_config, {"model": model, "messages": [{"role": "system", "content": "You plan concise web searches for deep research. Return strict JSON only."}, {"role": "user", "content": prompt}], "temperature": 0.2})
        parsed = _extract_json_object(self._extract_message_content(body)) or {}
        queries = _extract_string_list(parsed.get("queries"))[:max_queries]
        return queries or [user_request]

    def _draft_and_review_report(self, inference_config: Mapping[str, Any], model: str, user_request: str, documents: list[Any], iteration: int, max_iterations: int, gaps: str) -> JsonObject:
        evidence = []
        for index, doc in enumerate(documents, start=1):
            if not isinstance(doc, dict):
                continue
            evidence.append({"id": index, "title": doc.get("title"), "url": doc.get("url"), "markdown": _truncate(str(doc.get("markdown") or ""), 5000)})
        prompt = {
            "userRequest": user_request,
            "iteration": iteration,
            "maxIterations": max_iterations,
            "priorGaps": gaps,
            "evidence": evidence,
            "instructions": "Write a structured markdown report with source citations linked to URLs. Then judge whether the report fully answers the request.",
        }
        messages = [
            {"role": "system", "content": "You are a rigorous deep research analyst. Return strict JSON with keys: sufficient (boolean), gaps (string), reportMarkdown (markdown string with citations)."},
            {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
        ]
        body = self._post_chat_completion(inference_config, {"model": model, "messages": messages, "temperature": 0.2})
        content = self._extract_message_content(body)
        parsed = _extract_json_object(content)
        if parsed:
            nested_report = parsed.get("reportMarkdown")
            nested = _extract_json_object(nested_report) if isinstance(nested_report, str) else None
            if nested and isinstance(nested.get("reportMarkdown"), str):
                return {**parsed, **nested}
            return parsed
        return {"sufficient": iteration >= max_iterations, "gaps": "Model did not return structured sufficiency JSON.", "reportMarkdown": content}

    def _messages_for_request(self, instructions: Optional[str], input_payload: JsonObject) -> list[JsonObject]:
        messages: list[JsonObject] = []
        if instructions:
            messages.append({"role": "system", "content": instructions})
        user_text = next((_as_text(input_payload.get(key)) for key in ["userRequest", "user_request", "request", "prompt", "message", "input", "query"] if _as_text(input_payload.get(key))), None)
        messages.append({"role": "user", "content": user_text or json.dumps(input_payload, ensure_ascii=False)})
        return messages

    def _post_chat_completion(self, config: Mapping[str, Any], body: JsonObject) -> JsonObject:
        base_url = str(config["baseUrl"]).rstrip("/")
        timeout_ms = int(config.get("timeoutMs") or 30000)
        max_retries = max(0, int(config.get("maxRetries") or 0))
        extra_headers = config.get("headers") if isinstance(config.get("headers"), dict) else {}
        headers = {"content-type": "application/json", **{str(name): value for name, value in extra_headers.items() if isinstance(value, str)}}
        api_key = _as_text(config.get("apiKey"))
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"
        payload = json.dumps(body).encode("utf-8")
        last_error: Optional[Exception] = None
        for attempt in range(max_retries + 1):
            req = request.Request(f"{base_url}/chat/completions", data=payload, headers=headers, method="POST")
            try:
                with request.urlopen(req, timeout=timeout_ms / 1000) as response:
                    decoded = json.loads(response.read().decode("utf-8"))
                    if not isinstance(decoded, dict):
                        raise RuntimeError("Inference response must be a JSON object")
                    return decoded
            except error.HTTPError as exc:
                response_text = exc.read().decode("utf-8", errors="replace")[:1000]
                last_error = RuntimeError(f"Inference request failed with HTTP {exc.code}: {response_text}")
                if exc.code not in {408, 409, 429, 500, 502, 503, 504} or attempt >= max_retries:
                    raise last_error
            except Exception as exc:
                last_error = exc
                if attempt >= max_retries:
                    raise
            time.sleep(min(2 ** attempt, 8))
        raise RuntimeError(str(last_error) if last_error else "Inference request failed")

    def _extract_message_content(self, body: Mapping[str, Any]) -> str:
        choices = body.get("choices")
        if not isinstance(choices, list) or not choices:
            raise RuntimeError("Inference response did not include choices")
        first = choices[0]
        if not isinstance(first, dict):
            raise RuntimeError("Inference choice is malformed")
        message = first.get("message")
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str):
                return content
        text = first.get("text")
        if isinstance(text, str):
            return text
        raise RuntimeError("Inference response did not include message content")

    def _start_node_id(self, workflow: Mapping[str, Any], payload: Mapping[str, Any]) -> Optional[str]:
        if isinstance(payload.get("startNodeId"), str):
            return str(payload["startNodeId"])
        for node in workflow.get("nodes", []):
            if isinstance(node, dict) and node.get("category") == "start":
                return str(node.get("id"))
        return None

    def _select_next(self, node: Mapping[str, Any], edges: Iterable[Mapping[str, Any]], state: Mapping[str, Any], loop_counts: dict[str, int]) -> Optional[str]:
        outgoing = [edge for edge in edges if edge.get("source") == node.get("id")]
        if not outgoing:
            return None
        if node.get("category") == "router":
            default = next((edge for edge in outgoing if edge.get("sourceHandle") == "default"), None)
            return str((default or outgoing[0]).get("target"))
        if node.get("category") == "loop":
            loop = node.get("loop") if isinstance(node.get("loop"), dict) else {}
            loop_id = str(node.get("id"))
            loop_counts[loop_id] = loop_counts.get(loop_id, 0) + 1
            max_iterations = _as_int(state.get("maxIterations") if state.get("maxIterations") is not None else loop.get("maxIterations"), 3, minimum=1, maximum=100)
            if isinstance(state, dict):
                state["iteration"] = loop_counts[loop_id]
                state["maxIterations"] = max_iterations
                state["remainingIterations"] = max(0, max_iterations - loop_counts[loop_id])
            sufficient = state.get("sufficient") is True
            exhausted = loop_counts[loop_id] >= max_iterations
            continue_handle = _as_text(loop.get("continueHandle")) or "continue"
            exit_handle = _as_text(loop.get("exitHandle")) or "done"
            chosen_handle = exit_handle if sufficient or exhausted else continue_handle
            edge = next((candidate for candidate in outgoing if candidate.get("sourceHandle") == chosen_handle), None)
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
