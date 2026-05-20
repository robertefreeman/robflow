import { WORKFLOW_IR_SCHEMA_VERSION, type EdgeDefinition, type NodeCategory, type NodeDefinition, type ReactFlowEdge, type ReactFlowGraph, type ReactFlowNode, type WorkflowDefinition } from "./types.js";
import { isObjectRecord, isSchemaDefinition } from "./schemas.js";

const CATEGORY_BY_TYPE_PREFIX: readonly [string, NodeCategory][] = [
  ["trigger.", "start"],
  ["start", "start"],
  ["terminal", "terminal"],
  ["end", "terminal"],
  ["router", "router"],
  ["condition", "router"],
  ["transform", "transform"],
  ["human", "human-input"],
  ["approval", "human-input"],
  ["memory", "memory"],
  ["loop", "loop"],
  ["action.", "action"]
];

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function detectCategory(type: string, data: Readonly<Record<string, unknown>>): NodeCategory {
  const explicit = stringValue(data.category);
  if (explicit !== undefined && isNodeCategory(explicit)) return explicit;
  const matched = CATEGORY_BY_TYPE_PREFIX.find(([prefix]) => type === prefix || type.startsWith(prefix));
  return matched?.[1] ?? "action";
}

function isNodeCategory(value: string): value is NodeCategory {
  return ["start", "terminal", "action", "router", "transform", "human-input", "memory", "loop"].includes(value);
}

function optionalObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

function normalizeNode(node: ReactFlowNode): NodeDefinition {
  const data = node.data ?? {};
  const type = stringValue(data.type) ?? node.type ?? "action.custom";
  const category = detectCategory(type, data);
  const runtime = optionalObject(data.runtime);
  const nodeType = optionalObject(data.nodeType);
  const model = optionalObject(data.model);
  const tool = optionalObject(data.tool);
  const memory = optionalObject(data.memory);
  const humanInput = optionalObject(data.humanInput);
  const router = optionalObject(data.router);
  const loop = optionalObject(data.loop);

  return {
    id: node.id,
    type,
    category,
    name: stringValue(data.name) ?? stringValue(data.label) ?? node.id,
    description: stringValue(data.description),
    config: optionalObject(data.config),
    inputSchema: isSchemaDefinition(data.inputSchema) ? data.inputSchema : undefined,
    outputSchema: isSchemaDefinition(data.outputSchema) ? data.outputSchema : undefined,
    inputs: parseHandles(data.inputs),
    outputs: parseHandles(data.outputs),
    runtime: runtime === undefined ? undefined : {
      kind: parseRuntimeKind(runtime.kind),
      entrypoint: stringValue(runtime.entrypoint),
      model: model === undefined ? undefined : {
        provider: stringValue(model.provider) ?? "unknown",
        model: stringValue(model.model) ?? "unknown",
        instructions: stringValue(model.instructions),
        temperature: numberValue(model.temperature),
        responseSchema: isSchemaDefinition(model.responseSchema) ? model.responseSchema : undefined,
        stream: booleanValue(model.stream)
      },
      tool: tool === undefined ? undefined : {
        name: stringValue(tool.name) ?? "unknown",
        version: stringValue(tool.version),
        inputSchema: isSchemaDefinition(tool.inputSchema) ? tool.inputSchema : undefined,
        outputSchema: isSchemaDefinition(tool.outputSchema) ? tool.outputSchema : undefined,
        secrets: stringArray(tool.secrets)
      },
      memory: memory === undefined ? undefined : {
        namespace: stringValue(memory.namespace) ?? "default",
        mode: parseMemoryMode(memory.mode),
        keyPath: stringValue(memory.keyPath)
      },
      retry: parseRetry(runtime.retry),
      humanInput: parseHumanInput(runtime.humanInput),
      taskMode: booleanValue(runtime.taskMode),
      supportsGraph: booleanValue(runtime.supportsGraph),
      supportsLiveStreaming: booleanValue(runtime.supportsLiveStreaming)
    },
    router: router === undefined ? undefined : {
      branches: parseBranches(router.branches),
      requireDefault: booleanValue(router.requireDefault)
    },
    loop: loop === undefined ? undefined : parseLoop(loop),
    humanInput: parseHumanInput(humanInput),
    requiredConfig: stringArray(data.requiredConfig),
    nodeType: parsePinnedNodeType(nodeType),
    compatibility: optionalObject(data.compatibility),
    position: node.position
  };
}

function parsePinnedNodeType(value: Readonly<Record<string, unknown>> | undefined) {
  if (value === undefined) return undefined;
  const slug = stringValue(value.slug);
  const version = numberValue(value.version);
  if (slug === undefined || version === undefined) return undefined;
  return { slug, version, versionId: stringValue(value.versionId) };
}

function parseRuntimeKind(value: unknown) {
  return value === "inline" || value === "adk" || value === "webhook" || value === "external" || value === "noop" ? value : "external";
}

function parseMemoryMode(value: unknown) {
  return value === "read" || value === "write" || value === "read-write" ? value : "read-write";
}

function parseHandles(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isObjectRecord).map((handle) => ({
    id: stringValue(handle.id) ?? "default",
    schema: isSchemaDefinition(handle.schema) ? handle.schema : undefined,
    required: booleanValue(handle.required),
    description: stringValue(handle.description)
  }));
}

function parseBranches(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter(isObjectRecord).map((branch) => ({
    handle: stringValue(branch.handle) ?? "default",
    condition: stringValue(branch.condition),
    isDefault: booleanValue(branch.isDefault)
  }));
}

function parseLoop(value: Readonly<Record<string, unknown>>) {
  return {
    allowCycles: true as const,
    condition: stringValue(value.condition) ?? "true",
    maxIterations: numberValue(value.maxIterations),
    exitHandle: stringValue(value.exitHandle)
  };
}

function parseRetry(value: unknown) {
  if (!isObjectRecord(value)) return undefined;
  return {
    maxAttempts: numberValue(value.maxAttempts) ?? 1,
    backoff: value.backoff === "exponential" ? "exponential" as const : "fixed" as const,
    initialDelayMs: numberValue(value.initialDelayMs) ?? 0,
    maxDelayMs: numberValue(value.maxDelayMs),
    retryOn: stringArray(value.retryOn)
  };
}

function parseHumanInput(value: unknown) {
  if (!isObjectRecord(value)) return undefined;
  return {
    prompt: stringValue(value.prompt) ?? "Provide input",
    resumable: booleanValue(value.resumable) ?? false,
    resumeTokenPath: stringValue(value.resumeTokenPath),
    timeoutSeconds: numberValue(value.timeoutSeconds),
    assignedRole: stringValue(value.assignedRole)
  };
}

function normalizeEdge(edge: ReactFlowEdge): EdgeDefinition {
  return {
    id: edge.id ?? `${edge.source}:${edge.sourceHandle ?? "out"}->${edge.target}:${edge.targetHandle ?? "in"}`,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
    label: typeof edge.label === "string" ? edge.label : undefined,
    schema: isObjectRecord(edge.data) && isSchemaDefinition(edge.data.schema) ? edge.data.schema : undefined
  };
}

export function graphToWorkflowDefinition(graph: ReactFlowGraph): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_IR_SCHEMA_VERSION,
    id: graph.id ?? "workflow",
    name: graph.name ?? "Workflow",
    version: graph.version ?? "1",
    nodes: graph.nodes.map(normalizeNode),
    edges: graph.edges.map(normalizeEdge),
    viewport: graph.viewport,
    metadata: graph.metadata
  };
}
