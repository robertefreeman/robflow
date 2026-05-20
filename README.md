# robflow

Robflow is a monorepo foundation for a TypeScript web app, shared TypeScript packages, and a Python ADK worker.

## Layout

- `apps/web` - Next.js, React, and TypeScript web app.
- `apps/worker-adk` - Python ADK worker runtime with Postgres job polling and deterministic ADK simulation fallback.
- `packages/shared` - shared TypeScript utilities.
- `packages/workflow-ir` - workflow intermediate representation types.
- `packages/node-registry` - node registry primitives.
- `packages/persistence` - Drizzle/Postgres schema, migrations, seed data, and repository helpers.

## Bootstrap

```sh
npm install
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e 'apps/worker-adk[dev]'
cp .env.example .env
cp apps/web/.env.local.example apps/web/.env.local
cp apps/worker-adk/.env.example apps/worker-adk/.env
```

## Persistence

Robflow uses Drizzle ORM for Postgres migrations and TypeScript repository helpers. The Docker Compose database is exposed on `localhost:5432`, and the migration config defaults to:

```sh
postgresql://robflow:robflow_dev_password@localhost:5432/robflow
```

Run migrations and seed starter data after Postgres is available:

```sh
docker compose up -d postgres
npm run db:migrate
npm run db:seed
```

Use `DATABASE_URL=postgresql://... npm run db:migrate` or `npm run db:seed` to target another database. Repository tests use in-memory PGlite, so they do not require Docker:

```sh
npm test -w @robflow/persistence
```



## Run runtime

Manual runs can be created with `POST /api/agent-versions/:agentVersionId/runs` using `{ "input": { ... } }`. Inspect run state with `GET /api/runs/:runId`, cancel with `POST /api/runs/:runId/cancel`, and resume pending HITL approvals with `POST /api/runs/:runId/resume`.

The Python worker leases queued `run_jobs` from Postgres and persists run status transitions, logs, events, final output, failures, cancellations, and HITL approvals. It loads the compiled ADK bundle and workflow IR from each job payload. Live ADK model/tool execution is intentionally bounded behind a deterministic `deterministic-adk-simulator` adapter for now, so tests never make model calls; runtime interfaces and diagnostics are preserved for a future distributed/live runner.

Run one job locally:

```sh
DATABASE_URL=postgresql://robflow:robflow_dev_password@localhost:5432/robflow python -m robflow_worker_adk --once
```

Run continuously (Docker Compose does this for `worker-adk`):

```sh
DATABASE_URL=postgresql://robflow:robflow_dev_password@localhost:5432/robflow python -m robflow_worker_adk
```

## Reusable node type library

Custom node types are managed from `/node-types` and exposed through `/api/node-types`. The library supports visual/config-only definitions (prompt templates, router rules, schema transforms, model presets, and agent presets) plus code-backed metadata for Python functions, HTTP/API calls, OpenAPI operations, and ADK tool wrappers. Code-backed nodes store metadata/templates only in the web app; execution is intentionally worker-only for a later runtime phase.

Visual builder palette entries can be added from saved reusable node types, and workflow nodes pin a concrete `{ slug, version, versionId }` so future node type versions do not silently alter existing workflows. Creating a new reusable node type version reports compatibility issues for handle, schema, category, required-config, and worker-only changes. Existing builder nodes can be promoted to reusable node types from the inspector.

## Inference configuration

Global OpenAI-compatible inference settings live at `/settings/inference` and are served by `/api/settings/inference`. API keys are stored in `secret_records` and encrypted locally with `INFERENCE_CONFIG_ENCRYPTION_KEY`; secret writes and reads fail loudly when that 32-byte base64 or hex key is missing. The connection test and model discovery APIs call the configured endpoint's `/models` route and never make calls during tests.

For the Python worker env fallback, use `ROBFLOW_INFERENCE_BASE_URL`, `ROBFLOW_INFERENCE_API_KEY`, `ROBFLOW_INFERENCE_DEFAULT_MODEL`, `ROBFLOW_INFERENCE_HEADERS_JSON`, `ROBFLOW_INFERENCE_TIMEOUT_SECONDS`, and `ROBFLOW_INFERENCE_MAX_RETRIES`.

## Agent lifecycle

The web app supports agent search at `/agents`, detail pages at `/agents/:id`, draft autosaves, published immutable versions, cloning, version comparison, rollback-to-draft, robflow project JSON export/import, workflow IR export, and ADK bundle export. Published versions are append-only snapshots; rollback creates a new draft instead of mutating history.

## Agent testing and ADK evaluations

Agent detail pages include deterministic test cases for the selected agent. Test cases store input JSON and expected assertions, can be created, edited, deleted, run individually, or run in bulk for a published agent version. Result history is persisted in `evaluation_test_runs` and linked to the generated deterministic run.

Supported assertions are `exactOutput`, `containsText`, `jsonSchema`, `nodePath`, `toolCalls`, and `status`. The built-in evaluation runner uses workflow IR simulation and the run/log/event repositories, so it does not make real model or API calls by default.

Evaluation APIs:

```sh
GET  /api/agents/:agentId/test-cases
POST /api/agents/:agentId/test-cases
PATCH/DELETE /api/agents/:agentId/test-cases/:testCaseId
POST /api/agents/:agentId/test-cases/:testCaseId/run
POST /api/agent-versions/:agentVersionId/test-cases/run-all
GET/POST /api/agents/:agentId/test-cases/adk
```

The ADK endpoint imports/exports a lightweight `adk-evaluation-set` JSON shape for alignment with ADK evaluation fixtures.

There is no dedicated browser e2e runner configured yet. Product testing coverage currently uses deterministic Vitest integration tests with in-memory PGlite plus worker unittest coverage:

```sh
npm test -w @robflow/web -- --run tests/evaluation-store.test.ts
npm test -w @robflow/persistence -- --run tests/repositories.test.ts
npm run test:worker
```

## Run console, schedules, and webhooks

Agent detail pages link to `/agents/:agentId/runs`, which provides a run console for the current or selected version. The console can queue deterministic worker runs from schema-generated or raw JSON input, polls `/api/runs/:runId` for status, overlays node execution state on the persisted builder graph, and exposes timeline events, structured logs, tool/model metadata, errors, retry attempts, HITL resume controls, final output, and basic run comparison.

Schedules can be managed from the same page through `/api/agents/:agentId/schedules` and `/api/schedules/:scheduleId`. Webhook triggers can be created through `/api/agents/:agentId/webhooks`; trigger them with `POST /api/webhooks/:slug` and an `x-robflow-secret` header. Webhook secrets are stored as one-way hashes in `secret_records`, and accepted webhook payloads enqueue normal deterministic runs without making model calls.

## Local development

```sh
npm run dev
```

Or run the full stack with Docker Compose:

```sh
docker compose up --build
```

## Validation

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

## Local operations hardening

Docker Compose includes health checks for Postgres, the Next.js `/api/health` endpoint, and the Python worker health module. Services use `restart: unless-stopped`; the worker is restart-safe because queued jobs are leased from Postgres and expired `running` leases are reclaimed before polling.

Typical local lifecycle:

```sh
docker compose up -d postgres
npm run db:migrate
npm run db:seed
docker compose up --build
```

Tail logs while developing:

```sh
docker compose logs -f web worker-adk postgres
```

Create and restore local database backups:

```sh
scripts/db-backup.sh
scripts/db-restore.sh backups/robflow-YYYYmmddTHHMMSSZ.dump
```

Backups are written under `./backups/` by default; set `BACKUP_DIR=./my-backups` to change the location.

## Runner readiness and queue extension points

Robflow now has a `runner_registrations` table and repository helpers for runner capability metadata, heartbeat updates, stale runner listing, job heartbeat touches, expired lease reclaim, and dead-letter payload marking. The Python worker registers itself with deterministic ADK capabilities, heartbeats the runner/job, observes run cancellation, and reclaims expired Postgres leases before polling.

`@robflow/persistence` exports runner protocol helpers for lease metadata, cancellation checks, retry backoff, dead-letter payloads, and a `QueueAdapter` interface. The current adapter is Postgres polling; Redis or managed queues can implement the same `enqueue/lease/heartbeat/complete/fail/cancel` shape later without changing run-console semantics.

Cancellation protocol: API cancellation marks the run and job `canceled`; workers check run status between nodes and stop safely. Retry/backoff is deterministic and metadata-driven; exhausted work should be marked failed with a `payload.deadLetter` object rather than deleted.

## Workflow assist scaffolding

The builder includes deterministic workflow-assist utilities: prompt-to-workflow drafts, validation explanations, broken-path summaries, suggested test case JSON, repeated-pattern candidates for reusable node promotion, cookbook templates, and mock run simulation. The run console overlays a simple slow/failing-node heatmap from persisted run events. These helpers never call a model or external API.
