import { type EvaluationTestCase, type EvaluationTestRun, type Run } from "@robflow/persistence";
import { isWorkflowDefinition, type WorkflowDefinition } from "@robflow/workflow-ir";
import { createRunForAgentVersion, getRunSnapshot, serializeRun } from "./run-store";
import { getServerRepositories, type PersistenceRepositories } from "./inference-store";

type JsonObject = Record<string, unknown>;

export type EvaluationExpected = {
  exactOutput?: unknown;
  containsText?: string | string[];
  jsonSchema?: JsonSchema;
  nodePath?: string[];
  toolCalls?: string[];
  status?: Run["status"];
};

type JsonSchema = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
};

export type EvaluationAssertion = { name: string; pass: boolean; message: string; expected?: unknown; actual?: unknown };

function asRecord(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function asExpected(value: unknown): EvaluationExpected {
  return asRecord(value) as EvaluationExpected;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pathText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function checkSchema(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.const !== undefined && stable(value) !== stable(schema.const)) errors.push(`${path} must equal const`);
  if (schema.enum && !schema.enum.some((entry) => stable(entry) === stable(value))) errors.push(`${path} must match enum`);
  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (allowedTypes.length > 0) {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (!allowedTypes.includes(actual)) errors.push(`${path} must be ${allowedTypes.join(" or ")}, got ${actual}`);
  }
  if (schema.properties || schema.required) {
    const object = asRecord(value);
    for (const key of schema.required ?? []) {
      if (!(key in object)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in object) errors.push(...checkSchema(object[key], child, `${path}.${key}`));
    }
  }
  if (schema.items && Array.isArray(value)) value.forEach((entry, index) => errors.push(...checkSchema(entry, schema.items as JsonSchema, `${path}[${index}]`)));
  return errors;
}

export function assertEvaluation(snapshot: Awaited<ReturnType<typeof getRunSnapshot>>, expectedInput: unknown): { status: EvaluationTestRun["status"]; assertions: EvaluationAssertion[] } {
  const expected = asExpected(expectedInput);
  const output = snapshot.run.output ?? null;
  const assertions: EvaluationAssertion[] = [];
  if (expected.status) assertions.push({ name: "expected status", pass: snapshot.run.status === expected.status, message: `run status is ${snapshot.run.status}`, expected: expected.status, actual: snapshot.run.status });
  if (expected.exactOutput !== undefined) assertions.push({ name: "exact output", pass: stable(output) === stable(expected.exactOutput), message: "run output must exactly match", expected: expected.exactOutput, actual: output });
  for (const text of typeof expected.containsText === "string" ? [expected.containsText] : expected.containsText ?? []) {
    assertions.push({ name: "contains text", pass: pathText(output).includes(text), message: `output should contain ${text}`, expected: text, actual: output });
  }
  if (expected.jsonSchema) {
    const errors = checkSchema(output, expected.jsonSchema);
    assertions.push({ name: "json schema", pass: errors.length === 0, message: errors.join("; ") || "output matches schema", expected: expected.jsonSchema, actual: output });
  }
  if (expected.nodePath) {
    const actual = snapshot.events.filter((event) => event.eventType === "node.started").map((event) => event.nodeId).filter((id): id is string => Boolean(id));
    assertions.push({ name: "node path", pass: stable(actual) === stable(expected.nodePath), message: "visited node path should match", expected: expected.nodePath, actual });
  }
  if (expected.toolCalls) {
    const actual = snapshot.events.filter((event) => event.eventType === "tool.called").map((event) => String(asRecord(event.payload).toolName ?? event.nodeId ?? ""));
    assertions.push({ name: "tool calls", pass: stable(actual) === stable(expected.toolCalls), message: "tool call order should match", expected: expected.toolCalls, actual });
  }
  return { status: assertions.every((entry) => entry.pass) ? "passed" : "failed", assertions };
}

function nextNode(nodeId: string, edges: WorkflowDefinition["edges"], node?: WorkflowDefinition["nodes"][number]): string | null {
  const outgoing = edges.filter((edge) => edge.source === nodeId);
  if (node?.category === "router") return outgoing.find((edge) => edge.sourceHandle === "default")?.target ?? outgoing[0]?.target ?? null;
  if (node?.category === "loop" && node.loop?.exitHandle) return outgoing.find((edge) => edge.sourceHandle === node.loop?.exitHandle)?.target ?? outgoing[0]?.target ?? null;
  return outgoing[0]?.target ?? null;
}

async function runDeterministically(run: Run, workflow: WorkflowDefinition, repos: PersistenceRepositories): Promise<Run> {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const start = workflow.nodes.find((node) => node.category === "start")?.id;
  let current = start ?? null;
  let sequence = 1;
  let logSequence = 1;
  let lastOutput: JsonObject = asRecord(run.input);
  const visited: string[] = [];
  await repos.runs.updateRunStatus(run.id, { status: "running" });
  await repos.runs.appendLog({ runId: run.id, sequence: logSequence++, level: "info", message: "Evaluation runner started run", metadata: { adapter: "robflow-deterministic-evaluator" } });
  while (current) {
    const node = nodes.get(current);
    if (!node) throw new Error(`workflow edge points to missing node '${current}'`);
    visited.push(current);
    const nodeInfo = { name: node.name, type: node.type, category: node.category };
    await repos.runs.appendEvent({ runId: run.id, sequence: sequence++, eventType: "node.started", nodeId: current, nodeInfo, payload: { input: lastOutput } });
    if (node.category === "human-input" || node.humanInput) {
      const approval = await repos.approvals.create({ runId: run.id, nodeId: current, prompt: { nodeId: current, input: lastOutput, policy: node.humanInput ?? {} } });
      await repos.runs.appendEvent({ runId: run.id, sequence, eventType: "hitl.paused", nodeId: current, nodeInfo, payload: { approvalId: approval.id } });
      await repos.runs.appendLog({ runId: run.id, sequence: logSequence, level: "info", message: "Evaluation runner paused for human input", metadata: { approvalId: approval.id, nodeId: current } });
      if (run.runJobId) await repos.runs.updateJobStatus(run.runJobId, "succeeded");
      return await repos.runs.updateRunStatus(run.id, { status: "awaiting_approval" }) ?? run;
    }
    if (node.type.includes("tool")) {
      await repos.runs.appendEvent({ runId: run.id, sequence: sequence++, eventType: "tool.called", nodeId: current, nodeInfo, payload: { toolName: node.type, input: lastOutput } });
    }
    lastOutput = node.category === "start" || node.category === "terminal" || node.category === "router" || node.category === "loop"
      ? { ...lastOutput }
      : { ...lastOutput, nodeId: node.id, nodeName: node.name, simulated: true, runtimeKind: node.runtime?.kind ?? "noop" };
    await repos.runs.appendEvent({ runId: run.id, sequence: sequence++, eventType: "node.completed", nodeId: current, nodeInfo, output: lastOutput });
    if (node.category === "terminal") break;
    current = nextNode(current, workflow.edges, node);
  }
  const output = { result: lastOutput, visited, adapter: "robflow-deterministic-evaluator" };
  await repos.runs.appendEvent({ runId: run.id, sequence, eventType: "run.completed", output });
  await repos.runs.appendLog({ runId: run.id, sequence: logSequence, level: "info", message: "Evaluation runner completed run", metadata: { visited } });
  if (run.runJobId) await repos.runs.updateJobStatus(run.runJobId, "succeeded");
  return await repos.runs.updateRunStatus(run.id, { status: "succeeded", output, completedAt: new Date() }) ?? run;
}

export async function listEvaluationTestCases(agentId: string, repos = getServerRepositories()) {
  const cases = await repos.evaluations.listTestCases(agentId);
  return Promise.all(cases.map(async (testCase) => ({ testCase, runs: await repos.evaluations.listTestRuns(testCase.id, 10) })));
}

export async function saveEvaluationTestCase(agentId: string, input: unknown, repos = getServerRepositories()): Promise<EvaluationTestCase> {
  const data = asRecord(input);
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Untitled test";
  return repos.evaluations.createTestCase({ agentId, name, input: asRecord(data.input), expected: asRecord(data.expected), metadata: asRecord(data.metadata) });
}

export async function updateEvaluationTestCase(agentId: string, testCaseId: string, input: unknown, repos = getServerRepositories()): Promise<EvaluationTestCase> {
  const existing = await repos.evaluations.getTestCase(testCaseId);
  if (!existing || existing.agentId !== agentId) throw new Error("Test case not found");
  const data = asRecord(input);
  const updated = await repos.evaluations.updateTestCase(testCaseId, {
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : existing.name,
    input: "input" in data ? asRecord(data.input) : asRecord(existing.input),
    expected: "expected" in data ? asRecord(data.expected) : asRecord(existing.expected),
    metadata: "metadata" in data ? asRecord(data.metadata) : asRecord(existing.metadata)
  });
  if (!updated) throw new Error("Test case not found");
  return updated;
}

export async function deleteEvaluationTestCase(agentId: string, testCaseId: string, repos = getServerRepositories()): Promise<EvaluationTestCase> {
  const existing = await repos.evaluations.getTestCase(testCaseId);
  if (!existing || existing.agentId !== agentId) throw new Error("Test case not found");
  const deleted = await repos.evaluations.deleteTestCase(testCaseId);
  if (!deleted) throw new Error("Test case not found");
  return deleted;
}

export async function runEvaluationTestCase(agentVersionId: string, testCaseId: string, repos = getServerRepositories()): Promise<{ testRun: EvaluationTestRun; run: Run | null; assertions: EvaluationAssertion[] }> {
  const version = await repos.agents.getVersion(agentVersionId);
  if (!version) throw new Error("Agent version not found");
  const testCase = await repos.evaluations.getTestCase(testCaseId);
  if (!testCase || testCase.agentId !== version.agentId) throw new Error("Test case not found for agent version");
  const testRun = await repos.evaluations.createTestRun({ testCaseId, status: "running", result: { adapter: "robflow-deterministic-evaluator" }, startedAt: new Date() });
  try {
    const latestIr = await repos.workflows.latestIr(agentVersionId);
    if (!latestIr || !isWorkflowDefinition(latestIr.ir)) throw new Error("Agent version has no compiled workflow IR");
    const queued = await createRunForAgentVersion(agentVersionId, testCase.input, repos);
    const run = await runDeterministically(queued, latestIr.ir, repos);
    const snapshot = await getRunSnapshot(run.id, repos);
    const { status, assertions } = assertEvaluation(snapshot, testCase.expected);
    const updated = await repos.evaluations.updateTestRun(testRun.id, { status, runId: run.id, completedAt: new Date(), result: { assertions, runStatus: run.status, adapter: "robflow-deterministic-evaluator" } });
    return { testRun: updated ?? testRun, run, assertions };
  } catch (error) {
    const updated = await repos.evaluations.updateTestRun(testRun.id, { status: "errored", completedAt: new Date(), result: { error: error instanceof Error ? error.message : "Evaluation failed" } });
    return { testRun: updated ?? testRun, run: null, assertions: [] };
  }
}

export async function runAllEvaluationTestCases(agentVersionId: string, repos = getServerRepositories()) {
  const version = await repos.agents.getVersion(agentVersionId);
  if (!version) throw new Error("Agent version not found");
  const cases = await repos.evaluations.listTestCases(version.agentId);
  const results = [];
  for (const testCase of cases) results.push(await runEvaluationTestCase(agentVersionId, testCase.id, repos));
  return results;
}

export function serializeTestCase(testCase: EvaluationTestCase) {
  return { ...testCase, input: asRecord(testCase.input), expected: asRecord(testCase.expected), metadata: asRecord(testCase.metadata), createdAt: testCase.createdAt.toISOString(), updatedAt: testCase.updatedAt.toISOString() };
}

export function serializeTestRun(testRun: EvaluationTestRun) {
  return {
    ...testRun,
    result: asRecord(testRun.result),
    startedAt: testRun.startedAt?.toISOString() ?? null,
    completedAt: testRun.completedAt?.toISOString() ?? null,
    createdAt: testRun.createdAt.toISOString(),
    updatedAt: testRun.updatedAt.toISOString()
  };
}

export function serializeEvaluationResult(result: Awaited<ReturnType<typeof runEvaluationTestCase>>) {
  return {
    testRun: serializeTestRun(result.testRun),
    run: result.run ? serializeRun(result.run) : null,
    assertions: result.assertions,
    snapshot: result.run ? (() => null)() : null
  };
}

export function exportAdkEvaluationSet(agent: { id: string; name: string }, cases: EvaluationTestCase[]) {
  return {
    format: "adk-evaluation-set",
    schemaVersion: 1,
    appName: agent.name,
    robflowAgentId: agent.id,
    testCases: cases.map((testCase) => ({
      id: testCase.id,
      name: testCase.name,
      input: testCase.input,
      expected: testCase.expected,
      metadata: { ...asRecord(testCase.metadata), source: "robflow" }
    }))
  };
}

export function importAdkEvaluationSet(payload: unknown): Array<{ name: string; input: JsonObject; expected: JsonObject; metadata: JsonObject }> {
  const root = asRecord(payload);
  const entries = Array.isArray(root.testCases) ? root.testCases : Array.isArray(root.evalCases) ? root.evalCases : [];
  return entries.map((entry, index) => {
    const item = asRecord(entry);
    return {
      name: typeof item.name === "string" ? item.name : `ADK test ${index + 1}`,
      input: asRecord(item.input ?? item.query ?? item.request),
      expected: asRecord(item.expected ?? item.assertions),
      metadata: { ...asRecord(item.metadata), importedFormat: String(root.format ?? "adk-evaluation-set") }
    };
  });
}
