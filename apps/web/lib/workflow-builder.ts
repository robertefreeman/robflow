import { normalizeReusableNodeDefinition, type ReusableNodeTypeVersion } from "@robflow/node-registry";
import {
  WORKFLOW_IR_SCHEMA_VERSION,
  graphToWorkflowDefinition,
  validateWorkflowDefinition,
  type NodeCategory,
  type ReactFlowGraph,
  type ValidationResult,
  type ViewportDefinition,
  type WorkflowDefinition
} from "@robflow/workflow-ir";

export type BuiltInBuilderNodeKind = "start" | "end" | "llm" | "tool" | "router" | "approval";
export type BuilderNodeKind = BuiltInBuilderNodeKind | "custom";

export interface BuilderNodeTypePin {
  slug: string;
  version: number;
  versionId?: string;
}

export interface BuilderNodeData extends Record<string, unknown> {
  kind: BuilderNodeKind;
  type?: string;
  label: string;
  name: string;
  description?: string;
  category: NodeCategory;
  config?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  model?: Record<string, unknown>;
  tool?: Record<string, unknown>;
  router?: { branches: Array<{ handle: string; condition?: string; isDefault?: boolean }>; requireDefault?: boolean };
  humanInput?: { prompt: string; resumable: boolean; resumeTokenPath?: string; timeoutSeconds?: number; assignedRole?: string };
  inputs?: Array<{ id: string; required?: boolean; description?: string; schema?: Record<string, unknown> }>;
  outputs?: Array<{ id: string; description?: string; schema?: Record<string, unknown> }>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredConfig?: string[];
  nodeType?: BuilderNodeTypePin;
  compatibility?: Record<string, unknown>;
}

export interface BuilderGraph extends ReactFlowGraph {
  id: string;
  name: string;
  version: string;
  nodes: Array<{ id: string; type: "robflowNode"; position: { x: number; y: number }; data: BuilderNodeData }>;
  edges: Array<{ id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null; label?: string }>;
  viewport: ViewportDefinition;
}

export const NODE_PALETTE: Array<{ kind: BuiltInBuilderNodeKind; label: string; description: string }> = [
  { kind: "start", label: "Start", description: "Workflow entry point" },
  { kind: "end", label: "End", description: "Terminal completion node" },
  { kind: "llm", label: "LLM agent", description: "Model-backed reasoning step" },
  { kind: "tool", label: "Function/tool", description: "External or inline tool call" },
  { kind: "router", label: "Branch/router", description: "Route by branch handles" },
  { kind: "approval", label: "Human approval", description: "Pause for resumable human input" }
];

export function createNodeData(kind: BuiltInBuilderNodeKind, label = NODE_PALETTE.find((node) => node.kind === kind)?.label ?? "Node"): BuilderNodeData {
  const base = { kind, label, name: label };
  switch (kind) {
    case "start":
      return { ...base, type: "start", category: "start", runtime: { kind: "noop" }, outputs: [{ id: "out" }] };
    case "end":
      return { ...base, type: "end", category: "terminal", runtime: { kind: "noop" }, inputs: [{ id: "in" }] };
    case "llm":
      return {
        ...base,
        type: "action.llm",
        category: "action",
        runtime: { kind: "external" },
        model: { provider: "openai-compatible", model: "" },
        config: { model: "" },
        inputs: [{ id: "in" }],
        outputs: [{ id: "out" }],
        requiredConfig: ["model"]
      };
    case "tool":
      return {
        ...base,
        type: "action.tool",
        category: "action",
        runtime: { kind: "external" },
        tool: { name: "" },
        config: { toolName: "" },
        inputs: [{ id: "in" }],
        outputs: [{ id: "out" }],
        requiredConfig: ["toolName"]
      };
    case "router":
      return {
        ...base,
        type: "router.branch",
        category: "router",
        runtime: { kind: "noop" },
        inputs: [{ id: "in" }],
        outputs: [{ id: "yes" }, { id: "no" }],
        router: { branches: [{ handle: "yes", condition: "true" }, { handle: "no", isDefault: true }], requireDefault: true }
      };
    case "approval":
      return {
        ...base,
        type: "human.approval",
        category: "human-input",
        runtime: { kind: "noop" },
        inputs: [{ id: "in" }],
        outputs: [{ id: "approved" }, { id: "rejected" }],
        humanInput: { prompt: "Approve this workflow step?", resumable: true, resumeTokenPath: "$.approvalToken" }
      };
  }
}

export function createCustomNodeData(nodeType: ReusableNodeTypeVersion): BuilderNodeData {
  const definition = normalizeReusableNodeDefinition(nodeType.definition, nodeType.displayName);
  const codeBacked = "workerOnly" in definition && definition.workerOnly;
  const config = { ...(definition.config ?? {}) } as Record<string, unknown>;
  if ("promptTemplate" in definition && definition.promptTemplate) config.promptTemplate = definition.promptTemplate;
  if ("transform" in definition && definition.transform) config.transform = definition.transform;
  if ("modelPreset" in definition && definition.modelPreset) config.modelPreset = definition.modelPreset;
  if ("agentPreset" in definition && definition.agentPreset) config.agentPreset = definition.agentPreset;
  if (codeBacked) {
    config.codeBacked = true;
    config.code = definition.code;
  }
  return {
    kind: "custom",
    type: `custom.${nodeType.slug}`,
    label: definition.label,
    name: definition.label,
    description: definition.description ?? nodeType.description ?? undefined,
    category: definition.category,
    config,
    runtime: { ...(nodeType.runtime ?? {}), kind: "external" },
    inputs: definition.inputs as BuilderNodeData["inputs"],
    outputs: definition.outputs as BuilderNodeData["outputs"],
    inputSchema: nodeType.inputSchema as Record<string, unknown> | undefined,
    outputSchema: nodeType.outputSchema as Record<string, unknown> | undefined,
    router: "router" in definition && definition.router ? { branches: [...definition.router.branches], requireDefault: definition.router.requireDefault } : undefined,
    model: "modelPreset" in definition && definition.modelPreset ? { ...definition.modelPreset } : undefined,
    requiredConfig: definition.requiredConfig ? [...definition.requiredConfig] : undefined,
    nodeType: { slug: nodeType.slug, version: nodeType.version, versionId: nodeType.id },
    compatibility: { checkedAgainstVersion: nodeType.version, codeBacked }
  };
}

export function createInitialBuilderGraph(agentId: string, name = "Untitled agent", version = "1"): BuilderGraph {
  return {
    id: agentId,
    name,
    version,
    nodes: [
      { id: "start", type: "robflowNode", position: { x: 80, y: 180 }, data: createNodeData("start") },
      { id: "end", type: "robflowNode", position: { x: 520, y: 180 }, data: createNodeData("end") }
    ],
    edges: [{ id: "start-out-end-in", source: "start", sourceHandle: "out", target: "end", targetHandle: "in" }],
    viewport: { x: 0, y: 0, zoom: 1 },
    metadata: { schemaVersion: WORKFLOW_IR_SCHEMA_VERSION }
  };
}

export function normalizeBuilderGraph(value: unknown, agentId: string, name: string, version = "1"): BuilderGraph {
  if (typeof value !== "object" || value === null || !Array.isArray((value as ReactFlowGraph).nodes) || !Array.isArray((value as ReactFlowGraph).edges)) {
    return createInitialBuilderGraph(agentId, name, version);
  }
  const graph = value as ReactFlowGraph;
  return {
    id: typeof graph.id === "string" ? graph.id : agentId,
    name: typeof graph.name === "string" ? graph.name : name,
    version: typeof graph.version === "string" ? graph.version : version,
    nodes: graph.nodes as BuilderGraph["nodes"],
    edges: graph.edges as BuilderGraph["edges"],
    viewport: graph.viewport ?? { x: 0, y: 0, zoom: 1 },
    metadata: graph.metadata
  };
}

export function builderGraphToWorkflow(graph: BuilderGraph): WorkflowDefinition {
  return graphToWorkflowDefinition(graph);
}

export function validateBuilderGraph(graph: BuilderGraph): ValidationResult {
  return validateWorkflowDefinition(builderGraphToWorkflow(graph));
}
