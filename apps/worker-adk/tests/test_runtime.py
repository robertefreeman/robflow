import unittest
from typing import Dict, Optional

from robflow_worker_adk.runtime import LeasedJob, RetryBackoff, RunRecord, RunnerProfile, Worker, dead_letter_payload


WORKFLOW = {
    "id": "wf",
    "nodes": [
        {"id": "start", "category": "start", "type": "trigger.manual", "name": "Start"},
        {"id": "action", "category": "action", "type": "action.noop", "name": "Action", "runtime": {"kind": "noop", "retry": {"maxAttempts": 2}}, "config": {"simulateFailures": 1}},
        {"id": "end", "category": "terminal", "type": "terminal.success", "name": "End"},
    ],
    "edges": [
        {"id": "s-a", "source": "start", "target": "action"},
        {"id": "a-e", "source": "action", "target": "end"},
    ],
}


class FakeStore:
    def __init__(self, job: Optional[LeasedJob], workflow=WORKFLOW) -> None:
        self.job = job
        self.workflow = workflow
        self.run = RunRecord(id="run-1", agent_id="agent-1", agent_version_id="version-1", status="queued", input={"prompt": "hello"})
        self.jobs: Dict[str, str] = {}
        self.run_status = "queued"
        self.events = []
        self.logs = []
        self.approvals = []
        self.output = None
        self.error = None
        self.runner_profiles = []
        self.heartbeats = []
        self.reclaims = 0

    def register_runner(self, profile: RunnerProfile) -> None:
        self.runner_profiles.append(profile)

    def heartbeat_runner(self, profile: RunnerProfile) -> None:
        self.heartbeats.append(("runner", profile.runner_id))

    def reclaim_expired_leases(self) -> int:
        self.reclaims += 1
        return 0

    def heartbeat_job(self, job_id: str, worker_id: str, lease_seconds: int) -> None:
        self.heartbeats.append(("job", job_id, worker_id, lease_seconds))

    def lease_job(self, worker_id: str, lease_seconds: int):
        job, self.job = self.job, None
        return job

    def get_run_for_job(self, job: LeasedJob):
        return self.run

    def get_run_status(self, run_id: str) -> str:
        return self.run_status

    def mark_job(self, job_id: str, status: str, payload_patch=None) -> None:
        self.jobs[job_id] = status

    def update_run(self, run_id: str, status: str, **kwargs) -> None:
        self.run_status = status
        self.output = kwargs.get("output", self.output)
        self.error = kwargs.get("error", self.error)

    def append_event(self, run_id: str, event_type: str, **kwargs) -> None:
        self.events.append((event_type, kwargs))

    def append_log(self, run_id: str, level: str, message: str, metadata=None) -> None:
        self.logs.append((level, message, metadata or {}))

    def create_approval(self, run_id: str, node_id: str, prompt):
        self.approvals.append((node_id, prompt))
        return "approval-1"


class WorkerRuntimeTest(unittest.TestCase):
    def test_worker_executes_deterministic_workflow_and_retries(self) -> None:
        job = LeasedJob(id="job-1", kind="manual", payload={"workflowIr": WORKFLOW})
        store = FakeStore(job)

        self.assertTrue(Worker(store, worker_id="test").run_once())

        self.assertEqual(store.run_status, "succeeded")
        self.assertEqual(store.jobs["job-1"], "succeeded")
        self.assertEqual(store.output["visited"], ["start", "action", "end"])
        self.assertTrue(any(log[0] == "warn" and "retrying" in log[1] for log in store.logs))
        self.assertEqual(store.runner_profiles[0].runner_id, "test")
        self.assertIn(("job", "job-1", "test", 60), store.heartbeats)
        self.assertEqual(store.reclaims, 1)

    def test_worker_pauses_for_human_input(self) -> None:
        workflow = {
            "nodes": [
                {"id": "start", "category": "start", "name": "Start"},
                {"id": "review", "category": "human-input", "name": "Review", "humanInput": {"prompt": "Approve?", "resumable": True}},
                {"id": "end", "category": "terminal", "name": "End"},
            ],
            "edges": [{"source": "start", "target": "review"}, {"source": "review", "target": "end"}],
        }
        job = LeasedJob(id="job-2", kind="manual", payload={"workflowIr": workflow})
        store = FakeStore(job, workflow)

        self.assertTrue(Worker(store, worker_id="test").run_once())

        self.assertEqual(store.run_status, "awaiting_approval")
        self.assertEqual(store.jobs["job-2"], "succeeded")
        self.assertEqual(store.approvals[0][0], "review")
        self.assertTrue(any(event[0] == "hitl.paused" for event in store.events))

    def test_worker_persists_failures(self) -> None:
        job = LeasedJob(id="job-3", kind="manual", payload={})
        store = FakeStore(job)

        self.assertTrue(Worker(store, worker_id="test").run_once())

        self.assertEqual(store.run_status, "failed")
        self.assertEqual(store.jobs["job-3"], "failed")
        self.assertIn("workflowIr", store.error["message"])


    def test_runner_protocol_helpers_are_deterministic(self) -> None:
        backoff = RetryBackoff(max_attempts=4, initial_delay_seconds=0.5, multiplier=2, max_delay_seconds=2)
        self.assertEqual(backoff.delay_for_attempt(1), 0.5)
        self.assertEqual(backoff.delay_for_attempt(3), 2)
        payload = dead_letter_payload("max-attempts", 3, runner_id="test", error={"message": "boom"})
        self.assertEqual(payload["deadLetter"]["reason"], "max-attempts")
        self.assertEqual(payload["deadLetter"]["lastError"]["message"], "boom")


if __name__ == "__main__":
    unittest.main()
