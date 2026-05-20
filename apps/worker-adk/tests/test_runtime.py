import unittest
import json
from typing import Dict, Optional
from unittest.mock import patch

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
        self.inference_config = {
            "baseUrl": "https://llm.example/v1",
            "apiKey": "sk-test",
            "defaultModel": "demo-model",
            "headers": {},
            "timeoutMs": 30000,
            "maxRetries": 0,
        }

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

    def resolve_inference_config(self):
        return self.inference_config


class FakeResponse:
    def __init__(self, body=None) -> None:
        self.body = body or {"choices": [{"message": {"content": "Hola mundo"}}], "usage": {"total_tokens": 3}}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return json.dumps(self.body).encode("utf-8")


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

    def test_worker_executes_llm_nodes_with_live_openai_compatible_endpoint(self) -> None:
        workflow = {
            "nodes": [
                {"id": "start", "category": "start", "name": "Start"},
                {
                    "id": "translate",
                    "category": "action",
                    "name": "Translate",
                    "runtime": {
                        "kind": "adk",
                        "model": {"provider": "openai-compatible", "model": "demo-model", "instructions": "Translate to Spanish."},
                    },
                },
                {"id": "end", "category": "terminal", "name": "End"},
            ],
            "edges": [{"source": "start", "target": "translate"}, {"source": "translate", "target": "end"}],
        }
        job = LeasedJob(id="job-4", kind="manual", payload={"workflowIr": workflow})
        store = FakeStore(job, workflow)

        with patch("robflow_worker_adk.runtime.request.urlopen", return_value=FakeResponse()) as urlopen:
            self.assertTrue(Worker(store, worker_id="test").run_once())

        self.assertEqual(store.run_status, "succeeded")
        self.assertEqual(store.output["result"]["response"], "Hola mundo")
        self.assertNotIn("diagnostic", store.output)
        self.assertTrue(any(event[0] == "model.completed" for event in store.events))
        request_body = json.loads(urlopen.call_args.args[0].data.decode("utf-8"))
        self.assertEqual(request_body["messages"][-1]["content"], "hello")

    def test_worker_executes_searxng_and_firecrawl_tool_nodes(self) -> None:
        workflow = {
            "nodes": [
                {"id": "start", "category": "start", "name": "Start"},
                {
                    "id": "search",
                    "category": "action",
                    "name": "Search",
                    "runtime": {"kind": "external", "tool": {"name": "searxng.search"}},
                    "config": {"baseUrl": "https://searxng.example", "maxResults": 1},
                },
                {
                    "id": "scrape",
                    "category": "action",
                    "name": "Scrape",
                    "runtime": {"kind": "external", "tool": {"name": "firecrawl.research"}},
                    "config": {"baseUrl": "https://firecrawl.example", "maxPages": 1},
                },
                {"id": "end", "category": "terminal", "name": "End"},
            ],
            "edges": [{"source": "start", "target": "search"}, {"source": "search", "target": "scrape"}, {"source": "scrape", "target": "end"}],
        }
        job = LeasedJob(id="job-5", kind="manual", payload={"workflowIr": workflow})
        store = FakeStore(job, workflow)

        def fake_urlopen(req, timeout=30):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            if "searxng.example" in url:
                return FakeResponse({"results": [{"title": "Result", "url": "https://example.com/article", "content": "Snippet"}]})
            if "firecrawl.example" in url:
                return FakeResponse({"data": {"url": "https://example.com/article", "markdown": "# Article", "metadata": {"title": "Article"}}})
            raise AssertionError(f"unexpected request {url}")

        with patch("robflow_worker_adk.runtime.request.urlopen", side_effect=fake_urlopen):
            self.assertTrue(Worker(store, worker_id="test").run_once())

        self.assertEqual(store.run_status, "succeeded")
        self.assertEqual(store.output["result"]["searchResults"][0]["url"], "https://example.com/article")
        self.assertEqual(store.output["result"]["firecrawlDocuments"][0]["markdown"], "# Article")
        self.assertTrue(any(event[0] == "tool.completed" for event in store.events))

    def test_worker_routes_visible_loop_until_sufficient_or_max_iterations(self) -> None:
        workflow = {
            "nodes": [
                {"id": "start", "category": "start", "name": "Start"},
                {"id": "review", "category": "action", "name": "Review", "runtime": {"kind": "adk", "model": {"provider": "openai-compatible", "model": "demo-model"}}, "config": {"mergeJsonOutput": True}},
                {"id": "loop", "category": "loop", "name": "Loop", "loop": {"allowCycles": True, "condition": "not sufficient", "maxIterations": 3, "continueHandle": "continue", "exitHandle": "done"}},
                {"id": "end", "category": "terminal", "name": "End"},
            ],
            "edges": [
                {"source": "start", "target": "review"},
                {"source": "review", "target": "loop"},
                {"source": "loop", "sourceHandle": "continue", "target": "review"},
                {"source": "loop", "sourceHandle": "done", "target": "end"},
            ],
        }
        job = LeasedJob(id="job-6", kind="manual", payload={"workflowIr": workflow})
        store = FakeStore(job, workflow)
        responses = [
            FakeResponse({"choices": [{"message": {"content": json.dumps({"sufficient": False, "gaps": "need more"})}}]}),
            FakeResponse({"choices": [{"message": {"content": json.dumps({"sufficient": True, "gaps": ""})}}]}),
        ]

        with patch("robflow_worker_adk.runtime.request.urlopen", side_effect=responses):
            self.assertTrue(Worker(store, worker_id="test").run_once())

        self.assertEqual(store.run_status, "succeeded")
        self.assertEqual(store.output["visited"], ["start", "review", "loop", "review", "loop", "end"])
        self.assertTrue(store.output["result"]["sufficient"])

    def test_runner_protocol_helpers_are_deterministic(self) -> None:
        backoff = RetryBackoff(max_attempts=4, initial_delay_seconds=0.5, multiplier=2, max_delay_seconds=2)
        self.assertEqual(backoff.delay_for_attempt(1), 0.5)
        self.assertEqual(backoff.delay_for_attempt(3), 2)
        payload = dead_letter_payload("max-attempts", 3, runner_id="test", error={"message": "boom"})
        self.assertEqual(payload["deadLetter"]["reason"], "max-attempts")
        self.assertEqual(payload["deadLetter"]["lastError"]["message"], "boom")


if __name__ == "__main__":
    unittest.main()
