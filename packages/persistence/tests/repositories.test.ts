import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistenceRepositories } from "../src/repositories.js";
import { buildDeadLetterPayload, createLeaseMetadata, nextRetryDelayMs, shouldReclaimLease, touchLease } from "../src/runner-protocol.js";
import { schema } from "../src/schema.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("persistence repositories", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
  });

  afterEach(async () => {
    await client.close();
  });

  it("upserts app config and keeps encrypted secrets addressable by scope/name", async () => {
    const repos = createPersistenceRepositories(db);

    await repos.appConfig.upsert({ key: "global", value: { appName: "robflow" }, description: "Global app config" });
    const updated = await repos.appConfig.upsert({ key: "global", value: { appName: "robflow-dev" } });
    const secret = await repos.secrets.create({
      scope: "global",
      name: "demo-api-key",
      ciphertext: "encrypted:placeholder",
      encryptionKeyRef: "local-dev-key",
      metadata: { provider: "demo" }
    });

    expect(updated.value).toEqual({ appName: "robflow-dev" });
    await expect(repos.secrets.getByScopeName("global", "demo-api-key")).resolves.toMatchObject({ id: secret.id });
  });

  it("creates immutable agent versions with graph and IR snapshots", async () => {
    const repos = createPersistenceRepositories(db);

    const agent = await repos.agents.createAgent({ slug: "support-agent", name: "Support Agent" });
    const version = await repos.agents.createVersion({
      agentId: agent.id,
      version: 1,
      status: "active",
      definition: { model: "demo", instructions: "Help users." }
    });
    await repos.agents.setCurrentVersion(agent.id, version.id);
    await repos.workflows.createGraph({
      agentVersionId: version.id,
      xyflow: { nodes: [{ id: "n1", type: "action.adk-agent" }], edges: [] }
    });
    await repos.workflows.createIr({
      agentVersionId: version.id,
      schemaVersion: "2025-01",
      ir: { nodes: [{ id: "n1", kind: "adk" }], edges: [] }
    });

    await expect(repos.agents.listVersions(agent.id)).resolves.toHaveLength(1);
    await expect(repos.workflows.latestGraph(version.id)).resolves.toMatchObject({ xyflow: { edges: [] } });
    await expect(repos.workflows.latestIr(version.id)).resolves.toMatchObject({ schemaVersion: "2025-01" });
  });

  it("appends run events and logs without mutating prior entries", async () => {
    const repos = createPersistenceRepositories(db);
    const agent = await repos.agents.createAgent({ slug: "runner", name: "Runner" });
    const version = await repos.agents.createVersion({ agentId: agent.id, version: 1, definition: { name: "Runner" } });
    const job = await repos.runs.enqueueJob({ kind: "manual", payload: { source: "test" } });
    const run = await repos.runs.createRun({ agentId: agent.id, agentVersionId: version.id, runJobId: job.id, input: { prompt: "hello" } });

    await repos.runs.appendEvent({
      runId: run.id,
      sequence: 1,
      eventType: "node.started",
      nodeId: "n1",
      nodeInfo: { label: "Start" },
      payload: { adkEventId: "evt_1" }
    });
    await repos.runs.appendEvent({
      runId: run.id,
      sequence: 2,
      eventType: "node.completed",
      nodeId: "n1",
      nodeInfo: { label: "Start" },
      output: { text: "done" }
    });
    await repos.runs.appendLog({ runId: run.id, sequence: 1, level: "info", message: "run started" });

    await expect(repos.runs.listEvents(run.id)).resolves.toMatchObject([
      { sequence: 1, eventType: "node.started" },
      { sequence: 2, eventType: "node.completed", output: { text: "done" } }
    ]);
    await expect(repos.runs.listLogs(run.id)).resolves.toMatchObject([{ sequence: 1, message: "run started" }]);
    await expect(
      repos.runs.appendEvent({ runId: run.id, sequence: 2, eventType: "duplicate.sequence" })
    ).rejects.toThrow();
  });

  it("supports reusable node types, approvals, schedules, webhooks, and evaluations", async () => {
    const repos = createPersistenceRepositories(db);
    const nodeType = await repos.nodeTypes.createNodeType({ slug: "action.test", displayName: "Test Action" });
    await repos.nodeTypes.createVersion({ nodeTypeId: nodeType.id, version: 1, definition: { type: "action.test" } });

    const agent = await repos.agents.createAgent({ slug: "ops", name: "Ops" });
    const version = await repos.agents.createVersion({ agentId: agent.id, version: 1, definition: { name: "Ops" } });
    const run = await repos.runs.createRun({ agentId: agent.id, agentVersionId: version.id, input: {} });
    const approval = await repos.approvals.create({ runId: run.id, status: "pending", prompt: { message: "Approve?" } });
    const schedule = await repos.schedules.create({ agentId: agent.id, agentVersionId: version.id, cron: "*/15 * * * *" });
    const secret = await repos.secrets.create({ scope: "webhook", name: "ops", ciphertext: "encrypted:placeholder", encryptionKeyRef: "local-dev-key" });
    const webhook = await repos.webhooks.create({ agentId: agent.id, agentVersionId: version.id, slug: "ops-hook", secretRecordId: secret.id });
    const testCase = await repos.evaluations.createTestCase({ agentId: agent.id, name: "Smoke", input: { prompt: "ping" } });
    const testRun = await repos.evaluations.createTestRun({ testCaseId: testCase.id, runId: run.id, status: "passed", result: { score: 1 } });
    const updatedCase = await repos.evaluations.updateTestCase(testCase.id, { name: "Smoke updated", expected: { status: "succeeded" } });

    await expect(repos.nodeTypes.latestVersion(nodeType.id)).resolves.toMatchObject({ version: 1 });
    await expect(repos.approvals.resolve(approval.id, { status: "approved", response: { approved: true }, resolvedBy: "tester" })).resolves.toMatchObject({ status: "approved" });
    await expect(repos.schedules.listEnabled()).resolves.toMatchObject([{ id: schedule.id }]);
    await expect(repos.webhooks.getBySlug("ops-hook")).resolves.toMatchObject({ id: webhook.id });
    expect(updatedCase).toMatchObject({ id: testCase.id, name: "Smoke updated", expected: { status: "succeeded" } });
    await expect(repos.evaluations.getTestCase(testCase.id)).resolves.toMatchObject({ id: testCase.id });
    await expect(repos.evaluations.listTestCases(agent.id)).resolves.toMatchObject([{ id: testCase.id, name: "Smoke updated" }]);
    await expect(repos.evaluations.listTestRuns(testCase.id)).resolves.toMatchObject([{ id: testRun.id }]);
    await expect(repos.evaluations.updateTestRun(testRun.id, { status: "passed", completedAt: new Date() })).resolves.toMatchObject({ status: "passed" });
    await expect(repos.evaluations.deleteTestCase(testCase.id)).resolves.toMatchObject({ id: testCase.id });
    await expect(repos.evaluations.listTestCases(agent.id)).resolves.toHaveLength(0);
  });

  it("registers runners and supports job heartbeat, reclaim, and dead-letter metadata", async () => {
    const repos = createPersistenceRepositories(db);
    const runner = await repos.runners.register({ runnerId: "local-1", displayName: "Local worker", capabilities: { runtime: "deterministic-adk-simulator", labels: ["local"] } });
    const job = await repos.runs.enqueueJob({ kind: "manual", status: "running", lockedAt: new Date(Date.now() - 120_000), payload: { source: "test" } });

    expect(runner.capabilities).toMatchObject({ runtime: "deterministic-adk-simulator" });
    await expect(repos.runners.heartbeat("local-1", { metadata: { pid: 123 } })).resolves.toMatchObject({ runnerId: "local-1", status: "online", metadata: { pid: 123 } });

    const touched = await repos.runs.markJobHeartbeat(job.id, { runnerId: "local-1" });
    expect(touched?.payload).toMatchObject({ source: "test", heartbeat: { runnerId: "local-1" } });

    await repos.runs.updateJobStatus(job.id, "running");
    const reclaimed = await repos.runs.reclaimExpiredRunningJobs(new Date(Date.now() + 1));
    expect(reclaimed.map((entry) => entry.id)).toContain(job.id);
    await expect(repos.runs.getJob(job.id)).resolves.toMatchObject({ status: "queued" });

    const dead = await repos.runs.markDeadLetter(job.id, buildDeadLetterPayload({ reason: "max-attempts", attempts: 3, runnerId: "local-1", now: new Date("2025-01-01T00:00:00Z") }));
    expect(dead).toMatchObject({ status: "failed" });
    expect(dead?.payload.deadLetter).toMatchObject({ reason: "max-attempts", attempts: 3, runnerId: "local-1" });
  });

  it("runner protocol utilities calculate leases and retry backoff deterministically", () => {
    const now = new Date("2025-01-01T00:00:00Z");
    const lease = createLeaseMetadata("runner-1", 30, now);
    expect(lease.leaseExpiresAt).toBe("2025-01-01T00:00:30.000Z");
    expect(shouldReclaimLease(lease, new Date("2025-01-01T00:00:29Z"))).toBe(false);
    expect(shouldReclaimLease(lease, new Date("2025-01-01T00:00:30Z"))).toBe(true);
    expect(touchLease(lease, 60, new Date("2025-01-01T00:00:10Z")).leaseExpiresAt).toBe("2025-01-01T00:01:10.000Z");
    expect(nextRetryDelayMs(3, { maxAttempts: 4, initialDelayMs: 500, multiplier: 2, maxDelayMs: 2_000 })).toBe(2_000);
  });

});
