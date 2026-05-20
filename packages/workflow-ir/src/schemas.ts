import type { NodeCategory, RuntimeBindingKind, SchemaDefinition, WorkflowDefinition } from "./types.js";

export interface FieldSchema {
  readonly type: "string" | "number" | "boolean" | "object" | "array";
  readonly required?: boolean;
}

export interface ObjectSchema<TName extends string> {
  readonly name: TName;
  readonly fields: Readonly<Record<string, FieldSchema>>;
}

export const workflowDefinitionSchema = {
  name: "WorkflowDefinition",
  fields: {
    schemaVersion: { type: "string", required: true },
    id: { type: "string", required: true },
    name: { type: "string", required: true },
    version: { type: "string", required: true },
    nodes: { type: "array", required: true },
    edges: { type: "array", required: true },
    viewport: { type: "object" },
    metadata: { type: "object" }
  }
} as const satisfies ObjectSchema<"WorkflowDefinition">;

export const nodeCategories = ["start", "terminal", "action", "router", "transform", "human-input", "memory", "loop"] as const satisfies readonly NodeCategory[];
export const runtimeBindingKinds = ["inline", "adk", "webhook", "external", "noop"] as const satisfies readonly RuntimeBindingKind[];

export function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSchemaDefinition(value: unknown): value is SchemaDefinition {
  if (!isObjectRecord(value)) return false;
  const type = value.type;
  return typeof type === "string" || (Array.isArray(type) && type.every((entry) => typeof entry === "string"));
}

export function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (!isObjectRecord(value)) return false;
  return (
    value.schemaVersion === "2025-01" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges)
  );
}
