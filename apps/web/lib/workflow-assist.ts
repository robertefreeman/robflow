import type { ValidationResult } from "@robflow/workflow-ir";
import { builderGraphToWorkflow, createInitialBuilderGraph, createNodeData, type BuilderGraph } from "./workflow-builder";

export type WorkflowTemplateId = "support-triage" | "approval-gate" | "tool-enrichment";
export type JsonObject = Record<string, unknown>;

export interface SuggestedTestCase {
  name: string;
  input: JsonObject;
  expected: JsonObject;
}

export interface PatternCandidate {
  signature: string;
  count: number;
  nodeIds: string[];
  suggestedSlug: string;
}

export interface MockRunSimulation {
  status: "succeeded" | "failed";
  visited: string[];
  events: Array<{ eventType: string; nodeId?: string; payload?: JsonObject }>;
}

export interface NodeHeatmapEntry {
  nodeId: string;
  starts: number;
  failures: number;
  totalDurationMs: number;
  intensity: number;
}

export const WORKFLOW_COOKBOOK: Array<{ id: WorkflowTemplateId; title: string; description: string; prompt: string }> = [
  { id: "support-triage", title: "Support triage", description: "Start, classify, route, and respond to a support request.", prompt: "triage support tickets with a classifier and final response" },
  { id: "approval-gate", title: "Human approval gate", description: "Draft work, pause for approval, then finish.", prompt: "draft a response with human approval before final" },
  { id: "tool-enrichment", title: "Tool enrichment", description: "Call a deterministic tool step before final output.", prompt: "lookup account data using a tool and then respond" }
];

function connect(source: string, target: string, sourceHandle = "out", targetHandle = "in") {
  return { id: `${source}-${sourceHandle}-${target}-${targetHandle}`, source, sourceHandle, target, targetHandle };
}

function linearEdges(nodes: BuilderGraph["nodes"]): BuilderGraph["edges"] {
  const edges: BuilderGraph["edges"] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const source = nodes[index];
    const target = nodes[index + 1];
    const handles = source.data.outputs?.map((output) => output.id).filter(Boolean) ?? ["out"];
    if (source.data.kind === "router") {
      for (const handle of handles) edges.push(connect(source.id, target.id, handle));
    } else {
      edges.push(connect(source.id, target.id, handles[0] ?? "out"));
    }
  }
  return edges;
}

export function draftWorkflowFromPrompt(prompt: string, agentId = "draft", name = "Draft workflow"): BuilderGraph {
  const graph = createInitialBuilderGraph(agentId, name);
  const lower = prompt.toLowerCase();
  const wantsApproval = /approve|approval|human|review/.test(lower);
  const wantsTool = /tool|lookup|http|api|search|fetch/.test(lower);
  const wantsRouter = /route|triage|classif|branch/.test(lower);
  const nodes = [graph.nodes[0]];
  let x = 260;

  if (wantsTool) {
    const id = "tool-enrichment";
    nodes.push({ id, type: "robflowNode", position: { x, y: 120 }, data: { ...createNodeData("tool", "Tool enrichment"), config: { toolName: "deterministic.lookup" }, tool: { name: "deterministic.lookup" } } });
    x += 220;
  }
  if (wantsRouter) {
    const id = "router-triage";
    nodes.push({ id, type: "robflowNode", position: { x, y: 120 }, data: createNodeData("router", "Triage router") });
    x += 220;
  }
  nodes.push({ id: "llm-draft", type: "robflowNode", position: { x, y: 120 }, data: { ...createNodeData("llm", "Draft response"), model: { provider: "openai-compatible", model: "configure-me", instructions: prompt }, config: { model: "configure-me" } } });
  x += 220;
  if (wantsApproval) {
    const id = "approval-review";
    nodes.push({ id, type: "robflowNode", position: { x, y: 120 }, data: createNodeData("approval", "Review draft") });
    x += 220;
  }
  nodes.push({ ...graph.nodes[1], position: { x, y: 120 } });
  const edges = linearEdges(nodes);
  return { ...graph, name, nodes, edges, metadata: { ...graph.metadata, generatedBy: "deterministic-workflow-assist", prompt } };
}

export function explainValidation(result: ValidationResult): string[] {
  const issues = [...result.errors, ...result.warnings];
  if (!issues.length) return ["Workflow is valid. Start, terminal, handles, schemas, and reachability checks passed."];
  return issues.map((issue) => `${issue.severity.toUpperCase()} ${issue.code}${issue.nodeId ? ` at node ${issue.nodeId}` : issue.edgeId ? ` at edge ${issue.edgeId}` : ""}: ${issue.message}`);
}

export function findBrokenPaths(result: ValidationResult): Array<{ nodeId?: string; edgeId?: string; reason: string }> {
  return [...result.errors, ...result.warnings]
    .filter((issue) => ["invalid-endpoint", "invalid-source-handle", "invalid-target-handle", "unreachable-node", "terminal-unreachable", "router-branch-missing-edge"].includes(issue.code))
    .map((issue) => ({ nodeId: issue.nodeId, edgeId: issue.edgeId, reason: issue.message }));
}

export function suggestTestCases(graph: BuilderGraph): SuggestedTestCase[] {
  const workflow = builderGraphToWorkflow(graph);
  const hasApproval = workflow.nodes.some((node) => node.category === "human-input");
  const hasRouter = workflow.nodes.some((node) => node.category === "router");
  return [
    { name: "Smoke path succeeds", input: { prompt: "hello" }, expected: { status: "succeeded", nodePath: workflow.nodes.map((node) => node.id) } },
    ...(hasRouter ? [{ name: "Default branch path", input: { prompt: "route default" }, expected: { status: "succeeded", nodePath: ["start"] } }] : []),
    ...(hasApproval ? [{ name: "Human approval pauses", input: { prompt: "needs review" }, expected: { status: "awaiting_approval" } }] : [])
  ];
}

export function findRepeatedPatternCandidates(graph: BuilderGraph): PatternCandidate[] {
  const groups = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.data.kind === "start" || node.data.kind === "end") continue;
    const signature = `${node.data.kind}:${node.data.type ?? "unknown"}:${JSON.stringify(node.data.config ?? {})}`;
    groups.set(signature, [...(groups.get(signature) ?? []), node.id]);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([signature, nodeIds]) => ({ signature, count: nodeIds.length, nodeIds, suggestedSlug: signature.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "reusable-pattern" }));
}

export function simulateMockRun(graph: BuilderGraph): MockRunSimulation {
  const workflow = builderGraphToWorkflow(graph);
  const bySource = new Map<string, string>();
  for (const edge of workflow.edges) if (!bySource.has(edge.source)) bySource.set(edge.source, edge.target);
  const start = workflow.nodes.find((node) => node.category === "start")?.id;
  const visited: string[] = [];
  const events: MockRunSimulation["events"] = [];
  let current = start;
  const guard = workflow.nodes.length + 1;
  while (current && visited.length < guard) {
    visited.push(current);
    events.push({ eventType: "node.started", nodeId: current });
    events.push({ eventType: "node.completed", nodeId: current, payload: { deterministic: true } });
    current = bySource.get(current);
  }
  const status = workflow.nodes.some((node) => node.category === "terminal" && visited.includes(node.id)) ? "succeeded" : "failed";
  events.push({ eventType: status === "succeeded" ? "run.completed" : "run.failed", payload: { visited } });
  return { status, visited, events };
}

export function buildNodeHeatmap(events: Array<{ eventType: string; nodeId: string | null; createdAt: string }>): NodeHeatmapEntry[] {
  const starts = new Map<string, Date[]>();
  const totals = new Map<string, { starts: number; failures: number; totalDurationMs: number }>();
  for (const event of events) {
    if (!event.nodeId) continue;
    const entry = totals.get(event.nodeId) ?? { starts: 0, failures: 0, totalDurationMs: 0 };
    if (event.eventType === "node.started") {
      entry.starts += 1;
      starts.set(event.nodeId, [...(starts.get(event.nodeId) ?? []), new Date(event.createdAt)]);
    } else if (event.eventType === "node.completed") {
      const start = starts.get(event.nodeId)?.shift();
      if (start) entry.totalDurationMs += Math.max(0, new Date(event.createdAt).getTime() - start.getTime());
    } else if (/failed|error/.test(event.eventType)) {
      entry.failures += 1;
    }
    totals.set(event.nodeId, entry);
  }
  const max = Math.max(1, ...[...totals.values()].map((entry) => entry.totalDurationMs + entry.failures * 10_000));
  return [...totals.entries()].map(([nodeId, entry]) => ({ nodeId, ...entry, intensity: Math.min(1, (entry.totalDurationMs + entry.failures * 10_000) / max) }));
}
