import { checkNodeTypeCompatibility, normalizeReusableNodeDefinition, type CompatibilityIssue, type ReusableNodeDefinition, type ReusableNodeTypeVersion } from "@robflow/node-registry";
import type { NodeType, NodeTypeVersion } from "@robflow/persistence";
import type { BuilderNodeData } from "./workflow-builder";
import { getServerRepositories, type PersistenceRepositories } from "./inference-store";

function slugify(value: string): string {
  const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || `custom-node-${Date.now().toString(36)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function serializeNodeType(nodeType: NodeType) {
  return { ...nodeType, createdAt: nodeType.createdAt.toISOString(), updatedAt: nodeType.updatedAt.toISOString() };
}

function serializeNodeTypeVersion(version: NodeTypeVersion) {
  return {
    ...version,
    createdAt: version.createdAt.toISOString(),
    deprecatedAt: version.deprecatedAt?.toISOString() ?? null
  };
}

export function toReusableNodeTypeVersion(nodeType: NodeType, version: NodeTypeVersion): ReusableNodeTypeVersion {
  return {
    id: version.id,
    nodeTypeId: nodeType.id,
    slug: nodeType.slug,
    displayName: nodeType.displayName,
    description: nodeType.description,
    category: nodeType.category,
    builtIn: nodeType.builtIn,
    version: version.version,
    definition: normalizeReusableNodeDefinition(version.definition, nodeType.displayName),
    inputSchema: version.inputSchema,
    outputSchema: version.outputSchema,
    runtime: version.runtime
  };
}

export async function listNodeTypeLibrary(repos: PersistenceRepositories = getServerRepositories()) {
  const nodeTypes = await repos.nodeTypes.listNodeTypes();
  const entries = await Promise.all(nodeTypes.map(async (nodeType) => {
    const latest = await repos.nodeTypes.latestVersion(nodeType.id);
    return { nodeType: serializeNodeType(nodeType), latestVersion: latest ? serializeNodeTypeVersion(latest) : null, palette: latest ? toReusableNodeTypeVersion(nodeType, latest) : null };
  }));
  return entries;
}

export async function getNodeTypeLibraryEntry(slug: string, repos: PersistenceRepositories = getServerRepositories()) {
  const nodeType = await repos.nodeTypes.getBySlug(slug);
  if (!nodeType) throw new Error("Node type not found");
  const versions = await repos.nodeTypes.listVersions(nodeType.id);
  return {
    nodeType: serializeNodeType(nodeType),
    versions: versions.map(serializeNodeTypeVersion),
    palette: versions[0] ? toReusableNodeTypeVersion(nodeType, versions[0]) : null
  };
}

export async function createNodeType(input: Record<string, unknown>, repos: PersistenceRepositories = getServerRepositories()) {
  const displayName = asString(input.displayName) ?? "Custom node";
  const slug = slugify(asString(input.slug) ?? displayName);
  const existing = await repos.nodeTypes.getBySlug(slug);
  if (existing) throw new Error("Node type slug already exists");
  const definition = normalizeReusableNodeDefinition(input.definition, displayName);
  const nodeType = await repos.nodeTypes.createNodeType({
    slug,
    displayName,
    description: asString(input.description) ?? definition.description ?? null,
    category: asString(input.category) ?? definition.category,
    builtIn: false
  });
  const version = await repos.nodeTypes.createVersion({
    nodeTypeId: nodeType.id,
    version: 1,
    definition: definition as unknown as Record<string, unknown>,
    inputSchema: asRecord(input.inputSchema),
    outputSchema: asRecord(input.outputSchema),
    runtime: asRecord(input.runtime)
  });
  return { nodeType: serializeNodeType(nodeType), version: serializeNodeTypeVersion(version), palette: toReusableNodeTypeVersion(nodeType, version) };
}

export async function updateNodeTypeMetadata(slug: string, input: Record<string, unknown>, repos: PersistenceRepositories = getServerRepositories()) {
  const nodeType = await repos.nodeTypes.getBySlug(slug);
  if (!nodeType) throw new Error("Node type not found");
  const updated = await repos.nodeTypes.updateNodeType(nodeType.id, {
    displayName: asString(input.displayName) ?? nodeType.displayName,
    description: Object.prototype.hasOwnProperty.call(input, "description") ? asString(input.description) ?? null : nodeType.description,
    category: asString(input.category) ?? nodeType.category
  });
  if (!updated) throw new Error("Node type not found");
  return serializeNodeType(updated);
}

export async function createNodeTypeVersion(slug: string, input: Record<string, unknown>, repos: PersistenceRepositories = getServerRepositories()) {
  const nodeType = await repos.nodeTypes.getBySlug(slug);
  if (!nodeType) throw new Error("Node type not found");
  const latest = await repos.nodeTypes.latestVersion(nodeType.id);
  const definition = normalizeReusableNodeDefinition(input.definition ?? latest?.definition, nodeType.displayName);
  const compatibility = latest ? checkNodeTypeCompatibility(normalizeReusableNodeDefinition(latest.definition, nodeType.displayName), definition) : [];
  const requestedVersion = asNumber(input.version);
  const version = await repos.nodeTypes.createVersion({
    nodeTypeId: nodeType.id,
    version: requestedVersion ?? ((latest?.version ?? 0) + 1),
    definition: definition as unknown as Record<string, unknown>,
    inputSchema: Object.keys(asRecord(input.inputSchema)).length ? asRecord(input.inputSchema) : latest?.inputSchema ?? {},
    outputSchema: Object.keys(asRecord(input.outputSchema)).length ? asRecord(input.outputSchema) : latest?.outputSchema ?? {},
    runtime: Object.keys(asRecord(input.runtime)).length ? asRecord(input.runtime) : latest?.runtime ?? {}
  });
  return { version: serializeNodeTypeVersion(version), compatibility, palette: toReusableNodeTypeVersion(nodeType, version) };
}

export async function promoteBuilderNodeToNodeType(input: { slug?: string; displayName?: string; node: BuilderNodeData }, repos: PersistenceRepositories = getServerRepositories()) {
  const node = input.node;
  const displayName = input.displayName?.trim() || node.label || node.name || "Promoted node";
  const definition: ReusableNodeDefinition = normalizeReusableNodeDefinition({
    kind: node.kind === "router" ? "router-rules" : node.kind === "llm" ? "model-preset" : node.kind === "tool" ? "adk-tool-wrapper" : "agent-preset",
    label: displayName,
    description: node.description,
    category: node.category,
    inputs: node.inputs,
    outputs: node.outputs,
    config: node.config,
    requiredConfig: node.requiredConfig,
    router: node.router,
    modelPreset: node.model,
    agentPreset: node.kind === "custom" ? node.config : undefined,
    code: node.config?.code,
    workerOnly: node.config?.codeBacked === true
  }, displayName);
  return createNodeType({
    slug: input.slug,
    displayName,
    description: node.description,
    category: node.category,
    definition,
    inputSchema: node.inputSchema,
    outputSchema: node.outputSchema,
    runtime: node.runtime
  }, repos);
}

export function summarizeCompatibility(issues: readonly CompatibilityIssue[]) {
  return { errors: issues.filter((issue) => issue.severity === "error"), warnings: issues.filter((issue) => issue.severity === "warning") };
}
