import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistenceRepositories, schema } from "@robflow/persistence";
import { WORKFLOW_IR_SCHEMA_VERSION, type WorkflowDefinition } from "@robflow/workflow-ir";
import { cancelRun, createRunForAgentVersion, resumeRun } from "../lib/run-store";
import { createSchedule, createWebhook, getRunConsoleData, triggerWebhook, updateSchedule, validateWebhookSecret } from "../lib/run-console-store";

const migrationsFolder = fileURLToPath(new URL("../../../packages/persistence/drizzle", import.meta.url));

const workflow: WorkflowDefinition = {
  schemaVersion: WORKFLOW_IR_SCHEMA_VERSION,
  id: "runtime-test",
  name: "Runtime Test",
  version: "1",
  nodes: [
    { id: "start", type: "trigger.manual", category: "start", name: "Start" },
    { id: "review", type: "human.approval", category: "human-input", name: "Review", humanInput: { prompt: "Approve?", resumable: true } },
    { id: "end", type: "terminal.success", category: "terminal", name: "End" }
  ],
  edges: [{ id: "start-review", source: "start", target: "review" }, { id: "review-end", source: "review", target: "end" }]
};

describe("run store", () => {
  let client: PGlite;
  let repos: ReturnType<typeof createPersistenceRepositories>;

  beforeEach(async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
    repos = createPersistenceRepositories(db);
  });

  afterEach(async () => {
    await client.close();
  });

  async function createVersion() {
    const agent = await repos.agents.createAgent({ slug: `agent-${Date.now()}`, name: "Runtime Agent" });
    const version = await repos.agents.createVersion({ agentId: agent.id, version: 1, status: "active", definition: {} });
    await repos.workflows.createIr({ agentVersionId: version.id, schemaVersion: WORKFLOW_IR_SCHEMA_VERSION, ir: workflow as unknown as Record<string, unknown> });
    return version;
  }

  it("creates queued runs with compiled ADK artifacts in the job payload", async () => {
    const version = await createVersion();

    const run = await createRunForAgentVersion(version.id, { prompt: "hello" }, repos);

    expect(run.status).toBe("queued");
    expect(run.input).toEqual({ prompt: "hello" });
  });

  it("cancels a queued run and linked job", async () => {
    const version = await createVersion();
    const run = await createRunForAgentVersion(version.id, { prompt: "hello" }, repos);

    const canceled = await cancelRun(run.id, repos);

    expect(canceled.status).toBe("canceled");
    await expect(repos.runs.getRun(run.id)).resolves.toMatchObject({ status: "canceled" });
  });

  it("resolves pending approval and enqueues resume work", async () => {
    const version = await createVersion();
    const run = await createRunForAgentVersion(version.id, { prompt: "hello" }, repos);
    const approval = await repos.approvals.create({ runId: run.id, nodeId: "review", prompt: { prompt: "Approve?" } });
    await repos.runs.updateRunStatus(run.id, { status: "awaiting_approval" });

    const resumed = await resumeRun(run.id, { approvalId: approval.id, response: { approved: true }, resolvedBy: "test" }, repos);

    expect(resumed.run.status).toBe("queued");
    expect(resumed.approval.status).toBe("approved");
  });

  it("loads run console data and manages schedules", async () => {
    const version = await createVersion();
    const agent = await repos.agents.getAgent(version.agentId);
    expect(agent).not.toBeNull();
    await repos.agents.setCurrentVersion(version.agentId, version.id);
    await createRunForAgentVersion(version.id, { prompt: "hello" }, repos);

    const schedule = await createSchedule(version.agentId, { agentVersionId: version.id, cron: "0 * * * *", input: { prompt: "scheduled" } }, repos);
    const updated = await updateSchedule(schedule.id, { enabled: false }, repos);
    const data = await getRunConsoleData(version.agentId, repos);

    expect(updated.enabled).toBe(false);
    expect(data.runs).toHaveLength(1);
    expect(data.schedules).toMatchObject([{ id: schedule.id, enabled: false }]);
    expect(data.inputSchema).toBeNull();
  });

  it("creates webhook triggers and validates secrets before queuing runs", async () => {
    const version = await createVersion();
    await repos.agents.setCurrentVersion(version.agentId, version.id);
    const webhook = await createWebhook(version.agentId, { agentVersionId: version.id, slug: "runtime-hook", secret: "top-secret" }, repos);
    const secret = webhook.secretRecordId ? await repos.secrets.get(webhook.secretRecordId) : null;

    expect(secret).not.toBeNull();
    expect(validateWebhookSecret(secret?.ciphertext ?? "", "top-secret")).toBe(true);
    expect(validateWebhookSecret(secret?.ciphertext ?? "", "wrong")).toBe(false);

    const request = new Request("http://localhost/api/webhooks/runtime-hook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-robflow-secret": "top-secret" },
      body: JSON.stringify({ prompt: "from webhook" })
    });
    const run = await triggerWebhook("runtime-hook", request, repos);

    expect(run.status).toBe("queued");
    expect(run.input).toMatchObject({ payload: { prompt: "from webhook" }, webhook: { slug: "runtime-hook" } });
    await expect(triggerWebhook("runtime-hook", new Request("http://localhost/api/webhooks/runtime-hook", { method: "POST" }), repos)).rejects.toThrow("Invalid webhook secret");
  });
});
