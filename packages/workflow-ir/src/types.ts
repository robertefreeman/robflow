export const WORKFLOW_IR_SCHEMA_VERSION = "2025-01";

export type NodeCategory =
  | "start"
  | "terminal"
  | "action"
  | "router"
  | "transform"
  | "human-input"
  | "memory"
  | "loop";

export const BUILT_IN_NODE_CATEGORIES = [
  "start",
  "terminal",
  "action",
  "router",
  "transform",
  "human-input",
  "memory",
  "loop"
] as const satisfies readonly NodeCategory[];

export type PrimitiveSchemaType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

export interface SchemaDefinition {
  readonly type: PrimitiveSchemaType | readonly PrimitiveSchemaType[];
  readonly description?: string;
  readonly properties?: Readonly<Record<string, SchemaDefinition>>;
  readonly required?: readonly string[];
  readonly items?: SchemaDefinition;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly additionalProperties?: boolean | SchemaDefinition;
}

export type RuntimeBindingKind = "inline" | "adk" | "webhook" | "external" | "noop";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoff: "fixed" | "exponential";
  readonly initialDelayMs: number;
  readonly maxDelayMs?: number;
  readonly retryOn?: readonly string[];
}

export interface HumanInputPolicy {
  readonly prompt: string;
  readonly resumable: boolean;
  readonly resumeTokenPath?: string;
  readonly timeoutSeconds?: number;
  readonly assignedRole?: string;
}

export interface InferenceModelOverride {
  readonly model?: string;
  readonly endpointConfigKey?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export interface ModelBinding {
  readonly provider: string;
  readonly model: string;
  readonly instructions?: string;
  readonly temperature?: number;
  readonly responseSchema?: SchemaDefinition;
  readonly stream?: boolean;
  readonly override?: InferenceModelOverride;
}

export interface ToolBinding {
  readonly name: string;
  readonly version?: string;
  readonly inputSchema?: SchemaDefinition;
  readonly outputSchema?: SchemaDefinition;
  readonly secrets?: readonly string[];
}

export interface MemoryBinding {
  readonly namespace: string;
  readonly mode: "read" | "write" | "read-write";
  readonly keyPath?: string;
}

export interface RuntimeBinding {
  readonly kind: RuntimeBindingKind;
  readonly entrypoint?: string;
  readonly model?: ModelBinding;
  readonly tool?: ToolBinding;
  readonly memory?: MemoryBinding;
  readonly retry?: RetryPolicy;
  readonly humanInput?: HumanInputPolicy;
  readonly taskMode?: boolean;
  readonly supportsGraph?: boolean;
  readonly supportsLiveStreaming?: boolean;
}

export interface NodeHandleDefinition {
  readonly id: string;
  readonly schema?: SchemaDefinition;
  readonly required?: boolean;
  readonly description?: string;
}

export interface RouterBranchDefinition {
  readonly handle: string;
  readonly condition?: string;
  readonly isDefault?: boolean;
}

export interface LoopDefinition {
  readonly allowCycles: true;
  readonly condition: string;
  readonly maxIterations?: number;
  readonly exitHandle?: string;
}

export interface PinnedNodeTypeVersion {
  readonly slug: string;
  readonly version: number;
  readonly versionId?: string;
}

export interface NodeDefinition {
  readonly id: string;
  readonly type: string;
  readonly category: NodeCategory;
  readonly name: string;
  readonly description?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly inputSchema?: SchemaDefinition;
  readonly outputSchema?: SchemaDefinition;
  readonly inputs?: readonly NodeHandleDefinition[];
  readonly outputs?: readonly NodeHandleDefinition[];
  readonly runtime?: RuntimeBinding;
  readonly inference?: InferenceModelOverride;
  readonly router?: {
    readonly branches: readonly RouterBranchDefinition[];
    readonly requireDefault?: boolean;
  };
  readonly loop?: LoopDefinition;
  readonly humanInput?: HumanInputPolicy;
  readonly requiredConfig?: readonly string[];
  readonly nodeType?: PinnedNodeTypeVersion;
  readonly compatibility?: Readonly<Record<string, unknown>>;
  readonly position?: { readonly x: number; readonly y: number };
}

export interface EdgeDefinition {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: string;
  readonly targetHandle?: string;
  readonly schema?: SchemaDefinition;
  readonly label?: string;
}

export interface WorkflowDefinition {
  readonly schemaVersion: typeof WORKFLOW_IR_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly nodes: readonly NodeDefinition[];
  readonly edges: readonly EdgeDefinition[];
  readonly viewport?: ViewportDefinition;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly defaultInference?: InferenceModelOverride;
}

export interface ViewportDefinition {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface ReactFlowNode<Data extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  readonly id: string;
  readonly type?: string;
  readonly position?: { readonly x: number; readonly y: number };
  readonly data?: Data;
}

export interface ReactFlowEdge<Data extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  readonly id?: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
  readonly label?: string;
  readonly data?: Data;
}

export interface ReactFlowGraph {
  readonly id?: string;
  readonly name?: string;
  readonly version?: string;
  readonly nodes: readonly ReactFlowNode[];
  readonly edges: readonly ReactFlowEdge[];
  readonly viewport?: ViewportDefinition;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly defaultInference?: InferenceModelOverride;
}

export type ValidationSeverity = "error" | "warning";

export type ValidationCode =
  | "duplicate-node-id"
  | "duplicate-edge-id"
  | "missing-start"
  | "multiple-starts"
  | "missing-terminal"
  | "missing-required-config"
  | "invalid-endpoint"
  | "invalid-source-handle"
  | "invalid-target-handle"
  | "unreachable-node"
  | "terminal-unreachable"
  | "schema-incompatible"
  | "cycle-detected"
  | "router-branch-missing-edge"
  | "router-default-missing"
  | "hitl-not-resumable"
  | "adk-graph-unsupported"
  | "adk-live-streaming-unsupported"
  | "adk-task-mode-limited"
  | "custom-node-version-unpinned"
  | "code-node-worker-only";

export interface ValidationIssue {
  readonly severity: ValidationSeverity;
  readonly code: ValidationCode;
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly handleId?: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
}
