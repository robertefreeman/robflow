# robflow-worker-adk

Python ADK worker runtime for robflow. The worker leases queued `run_jobs` from Postgres, loads the compiled ADK bundle/workflow IR stored in the job payload, and persists run events, logs, status transitions, final output, failures, cancellations, retries, and HITL pauses.

Live Google ADK model/tool execution is not required for local tests. Until the distributed live runner is wired in, workflows execute through a deterministic `deterministic-adk-simulator` adapter that preserves runtime boundaries and records an explicit diagnostic in run output.

## Run

```sh
python -m pip install -e '.[dev]'
DATABASE_URL=postgresql://robflow:robflow_dev_password@localhost:5432/robflow python -m robflow_worker_adk --once
```

Omit `--once` to poll continuously. Useful environment variables:

- `DATABASE_URL` - Postgres connection string. Required for polling.
- `WORKER_ADK_POLL_INTERVAL_SECONDS` - idle polling delay, default `2`.
- `WORKER_ADK_LEASE_SECONDS` - lease diagnostic duration, default `60`.
- `WORKER_ADK_RUN_ONCE=true` - process one available job then exit.

## Runner protocol notes

At startup and before each poll, the worker registers/heartbeats a `runner_registrations` row with deterministic ADK simulator capabilities. Each leased job receives heartbeat metadata in `run_jobs.payload.heartbeat`; expired `running` jobs are reclaimed to `queued` when their lock is older than the recorded lease duration. API cancellation sets run/job status to `canceled`; the executor checks between nodes and exits without deleting logs or events.

Failures remain inspectable: exhausted retries update the run as `failed` and jobs can carry `payload.deadLetter` metadata for later replay tooling. The TypeScript persistence package exposes a queue adapter interface for a future Redis/managed queue runner while the local worker continues to use Postgres polling.
