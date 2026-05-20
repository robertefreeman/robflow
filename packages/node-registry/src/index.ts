import type { NodeCategory, SchemaDefinition } from "@robflow/workflow-ir";

export type VisualNodeDefinitionKind = "prompt-template" | "router-rules" | "schema-transform" | "model-preset" | "agent-preset";
export type CodeBackedNodeDefinitionKind = "python-function" | "http-api" | "openapi-operation" | "adk-tool-wrapper";
export type ReusableNodeDefinitionKind = VisualNodeDefinitionKind | CodeBackedNodeDefinitionKind;

export interface NodeHandleSpec {
  readonly id: string;
  readonly schema?: SchemaDefinition;
  readonly required?: boolean;
  readonly description?: string;
}

export interface BaseReusableNodeDefinition {
  readonly kind: ReusableNodeDefinitionKind;
  readonly label: string;
  readonly description?: string;
  readonly category: NodeCategory;
  readonly inputs?: readonly NodeHandleSpec[];
  readonly outputs?: readonly NodeHandleSpec[];
  readonly config?: Readonly<Record<string, unknown>>;
  readonly requiredConfig?: readonly string[];
}

export interface VisualReusableNodeDefinition extends BaseReusableNodeDefinition {
  readonly kind: VisualNodeDefinitionKind;
  readonly promptTemplate?: string;
  readonly router?: { readonly branches: readonly { readonly handle: string; readonly condition?: string; readonly isDefault?: boolean }[]; readonly requireDefault?: boolean };
  readonly transform?: { readonly expression?: string; readonly inputPath?: string; readonly outputPath?: string };
  readonly modelPreset?: Readonly<Record<string, unknown>>;
  readonly agentPreset?: Readonly<Record<string, unknown>>;
}

export interface CodeBackedReusableNodeDefinition extends BaseReusableNodeDefinition {
  readonly kind: CodeBackedNodeDefinitionKind;
  readonly workerOnly: true;
  readonly code?:
    | { readonly kind: "python-function"; readonly module: string; readonly functionName: string; readonly packageRef?: string; readonly template?: string }
    | { readonly kind: "http-api"; readonly method: string; readonly urlTemplate: string; readonly headersTemplate?: Readonly<Record<string, string>> }
    | { readonly kind: "openapi-operation"; readonly documentRef: string; readonly operationId: string; readonly serverUrl?: string }
    | { readonly kind: "adk-tool-wrapper"; readonly toolName: string; readonly toolVersion?: string; readonly configTemplate?: Readonly<Record<string, unknown>> };
}

export type ReusableNodeDefinition = VisualReusableNodeDefinition | CodeBackedReusableNodeDefinition;

export interface NodeTypeVersionRef {
  readonly slug: string;
  readonly version: number;
  readonly versionId?: string;
}

export interface ReusableNodeTypeVersion {
  readonly id?: string;
  readonly nodeTypeId?: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description?: string | null;
  readonly category: string;
  readonly builtIn?: boolean;
  readonly version: number;
  readonly definition: ReusableNodeDefinition;
  readonly inputSchema?: SchemaDefinition | Readonly<Record<string, unknown>>;
  readonly outputSchema?: SchemaDefinition | Readonly<Record<string, unknown>>;
  readonly runtime?: Readonly<Record<string, unknown>>;
}

export interface NodeDefinition {
  readonly type: string;
  readonly displayName: string;
  readonly description?: string;
  readonly version?: number;
  readonly definition?: ReusableNodeDefinition;
}

export interface CompatibilityIssue {
  readonly severity: "error" | "warning";
  readonly code: "category-changed" | "input-removed" | "output-removed" | "schema-narrowed" | "runtime-kind-changed" | "required-config-added" | "code-worker-only";
  readonly message: string;
  readonly handleId?: string;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function asHandleSpecs(value: unknown): readonly NodeHandleSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => asRecord(entry)).filter((entry): entry is Readonly<Record<string, unknown>> => entry !== undefined).map((entry) => ({
    id: asString(entry.id) ?? "default",
    schema: asRecord(entry.schema) as SchemaDefinition | undefined,
    required: typeof entry.required === "boolean" ? entry.required : undefined,
    description: asString(entry.description)
  }));
}

function isNodeCategory(value: unknown): value is NodeCategory {
  return typeof value === "string" && ["start", "terminal", "action", "router", "transform", "human-input", "memory", "loop"].includes(value);
}

function isVisualKind(value: string): value is VisualNodeDefinitionKind {
  return ["prompt-template", "router-rules", "schema-transform", "model-preset", "agent-preset"].includes(value);
}

function isCodeKind(value: string): value is CodeBackedNodeDefinitionKind {
  return ["python-function", "http-api", "openapi-operation", "adk-tool-wrapper"].includes(value);
}

function defaultCategory(kind: ReusableNodeDefinitionKind): NodeCategory {
  if (kind === "router-rules") return "router";
  if (kind === "schema-transform") return "transform";
  return "action";
}

export function normalizeReusableNodeDefinition(value: unknown, fallbackLabel = "Custom node"): ReusableNodeDefinition {
  const record = asRecord(value) ?? {};
  const rawKind = asString(record.kind) ?? "prompt-template";
  const kind: ReusableNodeDefinitionKind = isVisualKind(rawKind) || isCodeKind(rawKind) ? rawKind : "prompt-template";
  const base = {
    kind,
    label: asString(record.label) ?? fallbackLabel,
    description: asString(record.description),
    category: isNodeCategory(record.category) ? record.category : defaultCategory(kind),
    inputs: asHandleSpecs(record.inputs),
    outputs: asHandleSpecs(record.outputs),
    config: asRecord(record.config),
    requiredConfig: asStringArray(record.requiredConfig)
  } satisfies BaseReusableNodeDefinition;

  if (isCodeKind(kind)) {
    return { ...base, kind, workerOnly: true, code: asRecord(record.code) as CodeBackedReusableNodeDefinition["code"] };
  }

  return {
    ...base,
    kind,
    promptTemplate: asString(record.promptTemplate),
    router: asRecord(record.router) as VisualReusableNodeDefinition["router"],
    transform: asRecord(record.transform) as VisualReusableNodeDefinition["transform"],
    modelPreset: asRecord(record.modelPreset),
    agentPreset: asRecord(record.agentPreset)
  };
}

export function createNodeRegistry(definitions: readonly NodeDefinition[] = []) {
  const byType = new Map(definitions.map((definition) => [definition.type, definition]));

  return {
    list: () => [...byType.values()],
    get: (type: string) => byType.get(type),
    register(definition: NodeDefinition) {
      byType.set(definition.type, definition);
      return definition;
    }
  };
}

function handleMap(handles: readonly NodeHandleSpec[] | undefined): ReadonlyMap<string, NodeHandleSpec> {
  return new Map((handles ?? []).map((handle) => [handle.id, handle]));
}

function schemaType(schema: SchemaDefinition | undefined): string | undefined {
  if (schema === undefined) return undefined;
  return Array.isArray(schema.type) ? schema.type.join("|") : String(schema.type);
}

function addedRequiredConfig(previous: readonly string[] | undefined, next: readonly string[] | undefined): readonly string[] {
  const previousSet = new Set(previous ?? []);
  return (next ?? []).filter((path) => !previousSet.has(path));
}

export function checkNodeTypeCompatibility(previous: ReusableNodeDefinition, next: ReusableNodeDefinition): readonly CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (previous.category !== next.category) {
    issues.push({ severity: "error", code: "category-changed", message: `Category changed from ${previous.category} to ${next.category}.` });
  }

  const nextInputs = handleMap(next.inputs);
  for (const input of previous.inputs ?? []) {
    const replacement = nextInputs.get(input.id);
    if (replacement === undefined) issues.push({ severity: "error", code: "input-removed", message: `Input handle '${input.id}' was removed.`, handleId: input.id });
    else if (schemaType(input.schema) !== undefined && schemaType(replacement.schema) !== undefined && schemaType(input.schema) !== schemaType(replacement.schema)) {
      issues.push({ severity: "warning", code: "schema-narrowed", message: `Input handle '${input.id}' schema changed.`, handleId: input.id });
    }
  }

  const nextOutputs = handleMap(next.outputs);
  for (const output of previous.outputs ?? []) {
    const replacement = nextOutputs.get(output.id);
    if (replacement === undefined) issues.push({ severity: "error", code: "output-removed", message: `Output handle '${output.id}' was removed.`, handleId: output.id });
    else if (schemaType(output.schema) !== undefined && schemaType(replacement.schema) !== undefined && schemaType(output.schema) !== schemaType(replacement.schema)) {
      issues.push({ severity: "warning", code: "schema-narrowed", message: `Output handle '${output.id}' schema changed.`, handleId: output.id });
    }
  }

  for (const path of addedRequiredConfig(previous.requiredConfig, next.requiredConfig)) {
    issues.push({ severity: "warning", code: "required-config-added", message: `New required config '${path}' was added.` });
  }

  if ("workerOnly" in next && next.workerOnly) {
    issues.push({ severity: "warning", code: "code-worker-only", message: "Code-backed node metadata is worker-only and must not execute in the web process." });
  }
  return issues;
}
