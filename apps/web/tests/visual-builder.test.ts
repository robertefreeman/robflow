import { describe, expect, it } from "vitest";
import { createCustomNodeData, createInitialBuilderGraph, createNodeData, validateBuilderGraph, builderGraphToWorkflow, type BuilderGraph } from "../lib/workflow-builder";

describe("visual builder graph helpers", () => {
  it("creates a valid start-to-end graph", () => {
    const graph = createInitialBuilderGraph("agent-1", "Demo");
    expect(validateBuilderGraph(graph).valid).toBe(true);
    expect(builderGraphToWorkflow(graph)).toMatchObject({ name: "Demo", nodes: [{ id: "start" }, { id: "end" }] });
  });

  it("validates missing LLM model configuration", () => {
    const graph: BuilderGraph = {
      ...createInitialBuilderGraph("agent-1", "Demo"),
      nodes: [
        { id: "start", type: "robflowNode", position: { x: 0, y: 0 }, data: createNodeData("start") },
        { id: "llm", type: "robflowNode", position: { x: 200, y: 0 }, data: createNodeData("llm") },
        { id: "end", type: "robflowNode", position: { x: 400, y: 0 }, data: createNodeData("end") }
      ],
      edges: [
        { id: "start-llm", source: "start", sourceHandle: "out", target: "llm", targetHandle: "in" },
        { id: "llm-end", source: "llm", sourceHandle: "out", target: "end", targetHandle: "in" }
      ]
    };
    expect(validateBuilderGraph(graph).errors.some((issue) => issue.code === "missing-required-config")).toBe(true);
  });

  it("pins reusable custom node versions in workflow IR", () => {
    const custom = createCustomNodeData({
      id: "version-1",
      slug: "summarizer",
      displayName: "Summarizer",
      category: "action",
      version: 2,
      definition: { kind: "prompt-template", label: "Summarizer", category: "action", inputs: [{ id: "in" }], outputs: [{ id: "out" }], promptTemplate: "Summarize {{input}}" }
    });
    const graph: BuilderGraph = {
      ...createInitialBuilderGraph("agent-1", "Demo"),
      nodes: [
        { id: "start", type: "robflowNode", position: { x: 0, y: 0 }, data: createNodeData("start") },
        { id: "custom", type: "robflowNode", position: { x: 200, y: 0 }, data: custom },
        { id: "end", type: "robflowNode", position: { x: 400, y: 0 }, data: createNodeData("end") }
      ],
      edges: [
        { id: "start-custom", source: "start", sourceHandle: "out", target: "custom", targetHandle: "in" },
        { id: "custom-end", source: "custom", sourceHandle: "out", target: "end", targetHandle: "in" }
      ]
    };

    const workflow = builderGraphToWorkflow(graph);

    expect(workflow.nodes[1]).toMatchObject({ type: "custom.summarizer", nodeType: { slug: "summarizer", version: 2, versionId: "version-1" } });
    expect(validateBuilderGraph(graph).warnings.some((issue) => String(issue.code) === "code-node-worker-only")).toBe(false);
  });
});
