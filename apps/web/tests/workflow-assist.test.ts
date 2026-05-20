import { describe, expect, it } from "vitest";
import { createInitialBuilderGraph, createNodeData, validateBuilderGraph, type BuilderGraph } from "../lib/workflow-builder";
import { buildNodeHeatmap, draftWorkflowFromPrompt, explainValidation, findBrokenPaths, findRepeatedPatternCandidates, simulateMockRun, suggestTestCases } from "../lib/workflow-assist";

describe("workflow assist deterministic utilities", () => {
  it("drafts workflow templates from prompt keywords without model calls", () => {
    const graph = draftWorkflowFromPrompt("lookup account data, triage the request, then ask human approval", "agent-1", "Assist draft");
    expect(graph.nodes.map((node) => node.id)).toEqual(["start", "tool-enrichment", "router-triage", "llm-draft", "approval-review", "end"]);
    expect(validateBuilderGraph(graph).valid).toBe(true);
  });

  it("explains validation and broken path findings", () => {
    const graph: BuilderGraph = { ...createInitialBuilderGraph("agent-1"), edges: [{ id: "missing", source: "start", target: "ghost" }] };
    const validation = validateBuilderGraph(graph);
    expect(explainValidation(validation).some((line) => line.includes("invalid-endpoint"))).toBe(true);
    expect(findBrokenPaths(validation)).toEqual(expect.arrayContaining([expect.objectContaining({ edgeId: "missing" })]));
  });

  it("suggests test cases and repeated custom node candidates", () => {
    const llm = { ...createNodeData("llm", "Responder"), config: { model: "demo" }, model: { provider: "openai-compatible", model: "demo" } };
    const graph: BuilderGraph = {
      ...createInitialBuilderGraph("agent-1"),
      nodes: [
        { id: "start", type: "robflowNode", position: { x: 0, y: 0 }, data: createNodeData("start") },
        { id: "a", type: "robflowNode", position: { x: 100, y: 0 }, data: llm },
        { id: "b", type: "robflowNode", position: { x: 200, y: 0 }, data: llm },
        { id: "end", type: "robflowNode", position: { x: 300, y: 0 }, data: createNodeData("end") }
      ],
      edges: [
        { id: "s-a", source: "start", target: "a" },
        { id: "a-b", source: "a", target: "b" },
        { id: "b-e", source: "b", target: "end" }
      ]
    };
    expect(suggestTestCases(graph)[0]).toMatchObject({ name: "Smoke path succeeds" });
    expect(findRepeatedPatternCandidates(graph)).toMatchObject([{ count: 2, nodeIds: ["a", "b"] }]);
  });

  it("simulates mock runs and builds node heatmap data", () => {
    const graph = createInitialBuilderGraph("agent-1");
    expect(simulateMockRun(graph)).toMatchObject({ status: "succeeded", visited: ["start", "end"] });
    const heatmap = buildNodeHeatmap([
      { eventType: "node.started", nodeId: "start", createdAt: "2025-01-01T00:00:00.000Z" },
      { eventType: "node.completed", nodeId: "start", createdAt: "2025-01-01T00:00:02.000Z" },
      { eventType: "node.failed", nodeId: "llm", createdAt: "2025-01-01T00:00:03.000Z" }
    ]);
    expect(heatmap.find((entry) => entry.nodeId === "llm")?.failures).toBe(1);
    expect(heatmap.find((entry) => entry.nodeId === "start")?.totalDurationMs).toBe(2000);
  });
});
