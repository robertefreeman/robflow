import { describe, expect, it } from "vitest";
import {
  graphToWorkflowDefinition,
  invalidWorkflowFixtures,
  isWorkflowDefinition,
  validateWorkflowDefinition,
  validWorkflowFixture,
  workflowDefinitionSchema,
  type ReactFlowGraph,
  type WorkflowDefinition
} from "../src/index.js";

const stringSchema = { type: "string" } as const;
const numberSchema = { type: "number" } as const;

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schemaVersion: "2025-01",
    id: "test",
    name: "Test",
    version: "1",
    nodes: [
      { id: "start", type: "trigger.manual", category: "start", name: "Start", outputSchema: stringSchema, outputs: [{ id: "out", schema: stringSchema }] },
      { id: "end", type: "terminal.success", category: "terminal", name: "End", inputSchema: stringSchema, inputs: [{ id: "in", schema: stringSchema }] }
    ],
    edges: [{ id: "start-end", source: "start", sourceHandle: "out", target: "end", targetHandle: "in" }],
    ...overrides
  };
}

describe("workflow IR fixtures", () => {
  it("exports a strict schema marker and valid golden fixture", () => {
    expect(workflowDefinitionSchema.name).toBe("WorkflowDefinition");
    expect(isWorkflowDefinition(validWorkflowFixture)).toBe(true);
    expect(validateWorkflowDefinition(validWorkflowFixture)).toMatchObject({ valid: true, errors: [] });
  });

  it("exports invalid golden fixtures that exercise validation errors", () => {
    for (const fixture of invalidWorkflowFixtures) {
      const result = validateWorkflowDefinition(fixture);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("graphToWorkflowDefinition", () => {
  it("converts React Flow-style graph data into executable IR deterministically", () => {
    const graph: ReactFlowGraph = {
      id: "converted",
      name: "Converted",
      version: "7",
      viewport: { x: 10, y: 20, zoom: 0.5 },
      nodes: [
        {
          id: "n1",
          type: "trigger.manual",
          position: { x: 1, y: 2 },
          data: {
            label: "Manual Start",
            outputSchema: stringSchema,
            outputs: [{ id: "out", schema: stringSchema }]
          }
        },
        {
          id: "n2",
          type: "action.adk-agent",
          data: {
            name: "Agent",
            inputSchema: stringSchema,
            inputs: [{ id: "in", schema: stringSchema }],
            outputSchema: stringSchema,
            outputs: [{ id: "out", schema: stringSchema }],
            runtime: { kind: "adk", entrypoint: "agent.run", supportsLiveStreaming: true },
            model: { provider: "google", model: "gemini", stream: true }
          }
        },
        {
          id: "n3",
          type: "terminal.success",
          data: { inputSchema: stringSchema, inputs: [{ id: "in", schema: stringSchema }] }
        }
      ],
      edges: [
        { source: "n1", sourceHandle: "out", target: "n2", targetHandle: "in" },
        { id: "agent-end", source: "n2", sourceHandle: "out", target: "n3", targetHandle: "in" }
      ]
    };

    const ir = graphToWorkflowDefinition(graph);

    expect(ir).toMatchObject({ id: "converted", name: "Converted", version: "7", schemaVersion: "2025-01" });
    expect(ir.nodes.map((node) => [node.id, node.category])).toEqual([
      ["n1", "start"],
      ["n2", "action"],
      ["n3", "terminal"]
    ]);
    expect(ir.edges[0]?.id).toBe("n1:out->n2:in");
    expect(validateWorkflowDefinition(ir).valid).toBe(true);
  });
});

describe("validateWorkflowDefinition", () => {
  it("requires exactly one start node", () => {
    expect(validateWorkflowDefinition(workflow({ nodes: workflow().nodes.filter((node) => node.category !== "start") })).errors.map((entry) => entry.code)).toContain("missing-start");
    expect(validateWorkflowDefinition(workflow({ nodes: [...workflow().nodes, { id: "start-2", type: "trigger.manual", category: "start", name: "Start 2" }] })).errors.map((entry) => entry.code)).toContain("multiple-starts");
  });

  it("rejects dangling endpoints and invalid handles", () => {
    const result = validateWorkflowDefinition(workflow({
      edges: [
        { id: "bad-target", source: "start", target: "missing" },
        { id: "bad-source-handle", source: "start", sourceHandle: "missing", target: "end", targetHandle: "in" },
        { id: "bad-target-handle", source: "start", sourceHandle: "out", target: "end", targetHandle: "missing" }
      ]
    }));

    expect(result.errors.map((entry) => entry.code)).toEqual(expect.arrayContaining(["invalid-endpoint", "invalid-source-handle", "invalid-target-handle"]));
  });

  it("checks required config and schema compatibility", () => {
    const result = validateWorkflowDefinition(workflow({
      nodes: [
        { id: "start", type: "trigger.manual", category: "start", name: "Start", outputSchema: stringSchema },
        { id: "action", type: "action.http", category: "action", name: "Action", requiredConfig: ["url"], config: {}, outputSchema: stringSchema },
        { id: "end", type: "terminal.success", category: "terminal", name: "End", inputSchema: numberSchema }
      ],
      edges: [
        { id: "start-action", source: "start", target: "action" },
        { id: "action-end", source: "action", target: "end" }
      ]
    }));

    expect(result.errors.map((entry) => entry.code)).toEqual(expect.arrayContaining(["missing-required-config", "schema-incompatible"]));
  });

  it("requires reachability from start to a terminal node", () => {
    const result = validateWorkflowDefinition(workflow({
      nodes: [
        { id: "start", type: "trigger.manual", category: "start", name: "Start" },
        { id: "orphan", type: "action.noop", category: "action", name: "Orphan" },
        { id: "end", type: "terminal.success", category: "terminal", name: "End" }
      ],
      edges: []
    }));

    expect(result.errors.map((entry) => entry.code)).toEqual(expect.arrayContaining(["unreachable-node", "terminal-unreachable"]));
  });

  it("detects cycles unless an explicit loop node allows them", () => {
    const cyclic = workflow({
      nodes: [
        { id: "start", type: "trigger.manual", category: "start", name: "Start" },
        { id: "a", type: "action.noop", category: "action", name: "A" },
        { id: "end", type: "terminal.success", category: "terminal", name: "End" }
      ],
      edges: [
        { id: "start-a", source: "start", target: "a" },
        { id: "a-a", source: "a", target: "a" },
        { id: "a-end", source: "a", target: "end" }
      ]
    });
    expect(validateWorkflowDefinition(cyclic).errors.map((entry) => entry.code)).toContain("cycle-detected");

    const loop = workflow({
      nodes: [
        { id: "start", type: "trigger.manual", category: "start", name: "Start" },
        { id: "loop", type: "loop.each", category: "loop", name: "Loop", loop: { allowCycles: true, condition: "hasMore" } },
        { id: "end", type: "terminal.success", category: "terminal", name: "End" }
      ],
      edges: [
        { id: "start-loop", source: "start", target: "loop" },
        { id: "loop-loop", source: "loop", target: "loop" },
        { id: "loop-end", source: "loop", target: "end" }
      ]
    });
    expect(validateWorkflowDefinition(loop).errors.map((entry) => entry.code)).not.toContain("cycle-detected");
  });

  it("checks router branch completeness and default handling", () => {
    const result = validateWorkflowDefinition(workflow({
      nodes: [
        { id: "start", type: "trigger.manual", category: "start", name: "Start" },
        {
          id: "router",
          type: "router.condition",
          category: "router",
          name: "Router",
          router: { requireDefault: true, branches: [{ handle: "yes", condition: "ok" }] }
        },
        { id: "end", type: "terminal.success", category: "terminal", name: "End" }
      ],
      edges: [
        { id: "start-router", source: "start", target: "router" },
        { id: "router-end", source: "router", sourceHandle: "default", target: "end" }
      ]
    }));

    expect(result.errors.map((entry) => entry.code)).toEqual(expect.arrayContaining(["router-branch-missing-edge", "router-default-missing"]));
  });

  it("checks HITL resumability metadata", () => {
    const result = validateWorkflowDefinition(workflow({
      nodes: [
        { id: "start", type: "trigger.manual", category: "start", name: "Start" },
        { id: "human", type: "human.input", category: "human-input", name: "Human", humanInput: { prompt: "Input", resumable: true } },
        { id: "end", type: "terminal.success", category: "terminal", name: "End" }
      ],
      edges: [
        { id: "start-human", source: "start", target: "human" },
        { id: "human-end", source: "human", target: "end" }
      ]
    }));

    expect(result.errors.map((entry) => entry.code)).toContain("hitl-not-resumable");
  });

  it("emits ADK compatibility warnings without failing otherwise valid graphs", () => {
    const result = validateWorkflowDefinition(workflow({
      nodes: [
        { id: "start", type: "trigger.manual", category: "start", name: "Start" },
        {
          id: "router",
          type: "router.condition",
          category: "router",
          name: "Router",
          runtime: { kind: "adk", entrypoint: "router.run", model: { provider: "google", model: "gemini", stream: true }, taskMode: true },
          router: { requireDefault: true, branches: [{ handle: "default", isDefault: true }] }
        },
        { id: "end", type: "terminal.success", category: "terminal", name: "End" }
      ],
      edges: [
        { id: "start-router", source: "start", target: "router" },
        { id: "router-end", source: "router", sourceHandle: "default", target: "end" }
      ]
    }));

    expect(result.valid).toBe(true);
    expect(result.warnings.map((entry) => entry.code)).toEqual(expect.arrayContaining(["adk-graph-unsupported", "adk-live-streaming-unsupported", "adk-task-mode-limited"]));
  });
});
