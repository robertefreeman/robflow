import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { WORKFLOW_IR_SCHEMA_VERSION, type WorkflowDefinition } from "@robflow/workflow-ir";
import { compileWorkflowToAdk, createAdkExportBundle } from "../src/index.js";

const objectSchema = { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } as const;
const answerSchema = { type: "object", properties: { answer: { type: "string" }, approved: { type: "boolean" } }, required: ["answer"] } as const;

function baseWorkflow(id: string, nodes: WorkflowDefinition["nodes"], edges: WorkflowDefinition["edges"]): WorkflowDefinition {
  return { schemaVersion: WORKFLOW_IR_SCHEMA_VERSION, id, name: id.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" "), version: "1", nodes, edges };
}

function startNode() {
  return { id: "start", type: "trigger.manual", category: "start", name: "Start", outputSchema: objectSchema, outputs: [{ id: "out", schema: objectSchema }] } as const;
}

function endNode(id = "end") {
  return { id, type: "terminal.success", category: "terminal", name: "End", inputSchema: answerSchema, inputs: [{ id: "in", schema: answerSchema }] } as const;
}

function agentNode(id = "agent", model = "gemini-2.0-flash") {
  return {
    id,
    type: "action.adk-agent",
    category: "action",
    name: id,
    inputSchema: objectSchema,
    outputSchema: answerSchema,
    inputs: [{ id: "in", schema: objectSchema }],
    outputs: [{ id: "out", schema: answerSchema }],
    runtime: {
      kind: "adk",
      entrypoint: `${id}.run`,
      model: { provider: "google", model, instructions: `Run ${id}` },
      retry: { maxAttempts: 2, backoff: "fixed", initialDelayMs: 100 }
    }
  } as const;
}

const sequentialWorkflow = baseWorkflow("sequential-workflow", [startNode(), agentNode(), endNode()], [
  { id: "start-agent", source: "start", sourceHandle: "out", target: "agent", targetHandle: "in" },
  { id: "agent-end", source: "agent", sourceHandle: "out", target: "end", targetHandle: "in" }
]);

const branchWorkflow = baseWorkflow("branch-workflow", [
  startNode(),
  agentNode(),
  {
    id: "router",
    type: "router.condition",
    category: "router",
    name: "Router",
    inputSchema: answerSchema,
    inputs: [{ id: "in", schema: answerSchema }],
    outputs: [{ id: "approved" }, { id: "default" }],
    router: { requireDefault: true, branches: [{ handle: "approved", condition: "approved === true" }, { handle: "default", isDefault: true }] }
  },
  { ...endNode("approved-end"), name: "Approved" },
  { ...endNode("default-end"), name: "Default" }
], [
  { id: "start-agent", source: "start", sourceHandle: "out", target: "agent", targetHandle: "in" },
  { id: "agent-router", source: "agent", sourceHandle: "out", target: "router", targetHandle: "in" },
  { id: "router-approved", source: "router", sourceHandle: "approved", target: "approved-end", targetHandle: "in" },
  { id: "router-default", source: "router", sourceHandle: "default", target: "default-end", targetHandle: "in" }
]);

const loopWorkflow = baseWorkflow("loop-workflow", [
  startNode(),
  { id: "loop", type: "loop.each", category: "loop", name: "Loop", inputs: [{ id: "in", schema: objectSchema }], outputs: [{ id: "again" }, { id: "done" }], loop: { allowCycles: true, condition: "state.hasMore", maxIterations: 3, exitHandle: "done" } },
  endNode()
], [
  { id: "start-loop", source: "start", sourceHandle: "out", target: "loop", targetHandle: "in" },
  { id: "loop-again", source: "loop", sourceHandle: "again", target: "loop", targetHandle: "in" },
  { id: "loop-end", source: "loop", sourceHandle: "done", target: "end", targetHandle: "in" }
]);

const hitlWorkflow = baseWorkflow("hitl-workflow", [
  startNode(),
  agentNode(),
  { id: "review", type: "human.approval", category: "human-input", name: "Review", inputSchema: answerSchema, outputSchema: answerSchema, inputs: [{ id: "in", schema: answerSchema }], outputs: [{ id: "out", schema: answerSchema }], humanInput: { prompt: "Approve answer", resumable: true, resumeTokenPath: "$.resume.token", assignedRole: "reviewer" } },
  endNode()
], [
  { id: "start-agent", source: "start", sourceHandle: "out", target: "agent", targetHandle: "in" },
  { id: "agent-review", source: "agent", sourceHandle: "out", target: "review", targetHandle: "in" },
  { id: "review-end", source: "review", sourceHandle: "out", target: "end", targetHandle: "in" }
]);

const collaborativeWorkflow = baseWorkflow("collaborative-workflow", [startNode(), agentNode("researcher"), agentNode("writer", "gemini-2.0-pro"), endNode()], [
  { id: "start-researcher", source: "start", sourceHandle: "out", target: "researcher", targetHandle: "in" },
  { id: "researcher-writer", source: "researcher", sourceHandle: "out", target: "writer", targetHandle: "in" },
  { id: "writer-end", source: "writer", sourceHandle: "out", target: "end", targetHandle: "in" }
]);

const reusableWorkflow = baseWorkflow("reusable-custom-node-workflow", [
  startNode(),
  { id: "custom-tool", type: "reusable.crm-lookup", category: "action", name: "CRM Lookup", inputSchema: objectSchema, outputSchema: answerSchema, inputs: [{ id: "in", schema: objectSchema }], outputs: [{ id: "out", schema: answerSchema }], runtime: { kind: "external", entrypoint: "crm.lookup", tool: { name: "crmLookup", version: "1" } } },
  endNode()
], [
  { id: "start-custom", source: "start", sourceHandle: "out", target: "custom-tool", targetHandle: "in" },
  { id: "custom-end", source: "custom-tool", sourceHandle: "out", target: "end", targetHandle: "in" }
]);

const workflows = [
  ["sequential", sequentialWorkflow],
  ["branch", branchWorkflow],
  ["loop", loopWorkflow],
  ["hitl", hitlWorkflow],
  ["collaborative", collaborativeWorkflow],
  ["reusable", reusableWorkflow]
] as const;

function pythonCheck(source: string) {
  const script = [
    "import json",
    `source = ${JSON.stringify(source)}`,
    "code = compile(source, 'robflow_adk/workflow.py', 'exec')",
    "namespace = {}",
    "exec(code, namespace)",
    "assert 'root_agent' in namespace",
    "assert callable(namespace['build_workflow'])",
    "assert namespace['ROUTE_MAP']['startNodeId'] == 'start'"
  ].join("\n");
  return spawnSync("python3", ["-c", script], { encoding: "utf8" });
}

describe("compileWorkflowToAdk", () => {
  it.each(workflows)("matches the golden ADK export snapshot for %s", (_name, workflow) => {
    const compiled = compileWorkflowToAdk(workflow);
    expect(compiled).toMatchSnapshot();
  });

  it("creates a deterministic directory export bundle", () => {
    const bundle = createAdkExportBundle(branchWorkflow, "branch-export");
    expect(bundle.format).toBe("directory");
    expect(bundle.rootName).toBe("branch-export");
    expect(bundle.files.map((file) => file.path)).toEqual(["robflow_adk/workflow.py", "robflow_adk/route_map.json", "robflow_adk/manifest.json", "robflow_adk/diagnostics.json", "README.md"]);
  });

  it.each(workflows)("generates Python that passes syntax and import checks for %s", (_name, workflow) => {
    const compiled = compileWorkflowToAdk(workflow);
    const source = compiled.files.find((file) => file.path === "robflow_adk/workflow.py")?.content;
    expect(source).toBeDefined();
    const result = pythonCheck(source ?? "");
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("surfaces unsupported custom and external mappings as diagnostics", () => {
    const compiled = compileWorkflowToAdk(reusableWorkflow);
    expect(compiled.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining(["runtime-kind-annotated", "custom-node-placeholder"]));
    expect(compiled.manifest.diagnostics.warnings).toBeGreaterThanOrEqual(2);
  });
});
