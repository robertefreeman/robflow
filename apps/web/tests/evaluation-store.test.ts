import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistenceRepositories, schema } from "@robflow/persistence";
import { WORKFLOW_IR_SCHEMA_VERSION, type WorkflowDefinition } from "@robflow/workflow-ir";
import {
  exportAdkEvaluationSet,
  importAdkEvaluationSet,
  listEvaluationTestCases,
  runAllEvaluationTestCases,
  runEvaluationTestCase,
  saveEvaluationTestCase,
  updateEvaluationTestCase
} from "../lib/evaluation-store";

const migrationsFolder = fileURLToPath(new URL("../../../packages/persistence/drizzle", import.meta.url));

const workflow: WorkflowDefinition = {
  schemaVersion: WORKFLOW_IR_SCHEMA_VERSION,
  id: "eval-test",
  name: "Eval Test",
  version: "1",
  nodes: [
    { id: "start", type: "trigger.manual", category: "start", name: "Start" },
    { id: "tool", type: "tool.search", category: "action", name: "Search Tool", runtime: { kind: "external" } },
    { id: "end", type: "terminal.success", category: "terminal", name: "End" }
  ],
  edges: [{ id: "start-tool", source: "start", target: "tool" }, { id: "tool-end", source: "tool", target: "end" }]
};

describe("evaluation store", () => {
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
    const agent = await repos.agents.createAgent({ slug: `eval-agent-${Date.now()}`, name: "Eval Agent" });
    const version = await repos.agents.createVersion({ agentId: agent.id, version: 1, status: "active", definition: {} });
    await repos.workflows.createIr({ agentVersionId: version.id, schemaVersion: WORKFLOW_IR_SCHEMA_VERSION, ir: workflow as unknown as Record<string, unknown> });
    return { agent, version };
  }

  it("creates, edits, runs, and records deterministic assertion history", async () => {
    const { agent, version } = await createVersion();
    const testCase = await saveEvaluationTestCase(agent.id, {
      name: "Tool path",
      input: { prompt: "ping" },
      expected: {
        status: "succeeded",
        containsText: "ping",
        nodePath: ["start", "tool", "end"],
        toolCalls: ["tool.search"],
        jsonSchema: { type: "object", required: ["adapter", "visited"], properties: { adapter: { const: "robflow-deterministic-evaluator" } } }
      }
    }, repos);

    await updateEvaluationTestCase(agent.id, testCase.id, { name: "Updated path" }, repos);
    const result = await runEvaluationTestCase(version.id, testCase.id, repos);
    const cases = await listEvaluationTestCases(agent.id, repos);

    expect(result.testRun.status).toBe("passed");
    expect(result.assertions.every((entry) => entry.pass)).toBe(true);
    expect(result.run?.output).toMatchObject({ visited: ["start", "tool", "end"] });
    expect(cases[0]?.testCase.name).toBe("Updated path");
    expect(cases[0]?.runs).toHaveLength(1);
  });

  it("runs all test cases for a version and round-trips ADK eval sets", async () => {
    const { agent, version } = await createVersion();
    await saveEvaluationTestCase(agent.id, { name: "Smoke", input: { prompt: "ping" }, expected: { status: "succeeded" } }, repos);

    const results = await runAllEvaluationTestCases(version.id, repos);
    const adk = exportAdkEvaluationSet(agent, await repos.evaluations.listTestCases(agent.id));
    const imported = importAdkEvaluationSet(adk);

    expect(results).toHaveLength(1);
    expect(results[0]?.testRun.status).toBe("passed");
    expect(adk).toMatchObject({ format: "adk-evaluation-set", testCases: expect.any(Array) });
    expect(imported[0]).toMatchObject({ name: "Smoke", input: { prompt: "ping" } });
  });
});
