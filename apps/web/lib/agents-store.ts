import { type Agent, type AgentVersion, type WorkflowGraph, type WorkflowIr } from "@robflow/persistence";
import { WORKFLOW_IR_SCHEMA_VERSION, isWorkflowDefinition, type WorkflowDefinition } from "@robflow/workflow-ir";
import { builderGraphToWorkflow, createInitialBuilderGraph, normalizeBuilderGraph, type BuilderGraph } from "./workflow-builder";
import { getServerRepositories, type PersistenceRepositories } from "./inference-store";

function slugify(value: string): string {
  const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || `agent-${Date.now()}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function nextVersionNumber(repos: PersistenceRepositories, agentId: string): Promise<number> {
  const versions = await repos.agents.listVersions(agentId);
  return Math.max(0, ...versions.map((entry) => entry.version)) + 1;
}

async function latestEditableVersion(repos: PersistenceRepositories, agent: Agent): Promise<AgentVersion | null> {
  const versions = await repos.agents.listVersions(agent.id);
  const current = agent.currentVersionId ? versions.find((entry) => entry.id === agent.currentVersionId) ?? await repos.agents.getVersion(agent.currentVersionId) : null;
  const draft = versions.find((entry) => entry.status === "draft" && (!current || entry.version > current.version));
  return draft ?? current ?? versions[0] ?? null;
}

function matchesSearch(agent: Agent, search?: string | null): boolean {
  const query = search?.trim().toLowerCase();
  if (!query) return true;
  return [agent.name, agent.slug, agent.description ?? ""].some((value) => value.toLowerCase().includes(query));
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortForJson(entry)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForJson(value), null, 2);
}

function parseImportedStatus(value: unknown): AgentVersion["status"] {
  return value === "draft" || value === "archived" || value === "active" ? value : "active";
}

function projectFormatError(message: string): Error {
  return new Error(`Invalid robflow project: ${message}`);
}

export async function listAgents(search?: string | null, repos = getServerRepositories()): Promise<Agent[]> {
  return (await repos.agents.listAgents()).filter((agent) => matchesSearch(agent, search));
}

export async function listAgentSummaries(search?: string | null, repos = getServerRepositories()) {
  const agents = await listAgents(search, repos);
  return Promise.all(agents.map(async (agent) => {
    const versions = await repos.agents.listVersions(agent.id);
    const current = agent.currentVersionId ? versions.find((version) => version.id === agent.currentVersionId) ?? null : null;
    return {
      agent,
      latestVersion: versions[0] ?? null,
      currentVersion: current,
      draftVersion: versions.find((version) => version.status === "draft") ?? null,
      versionCount: versions.length,
      publishedCount: versions.filter((version) => version.status === "active").length
    };
  }));
}

export async function createAgent(input: { name: string; description?: string | null }, repos = getServerRepositories()): Promise<{ agent: Agent; version: AgentVersion; graph: WorkflowGraph }> {
  const agent = await repos.agents.createAgent({ slug: `${slugify(input.name)}-${Date.now().toString(36)}`, name: input.name.trim() || "Untitled agent", description: input.description?.trim() || null });
  const version = await repos.agents.createVersion({ agentId: agent.id, version: 1, status: "draft", definition: { schemaVersion: WORKFLOW_IR_SCHEMA_VERSION } });
  const graph = createInitialBuilderGraph(agent.id, agent.name, String(version.version));
  const savedGraph = await repos.workflows.createGraph({ agentVersionId: version.id, name: "default", xyflow: graph as unknown as Record<string, unknown> });
  return { agent, version, graph: savedGraph };
}

export async function getAgentDetail(agentId: string, repos = getServerRepositories()) {
  const agent = await repos.agents.getAgent(agentId);
  if (!agent) throw new Error("Agent not found");
  const versions = await repos.agents.listVersions(agent.id);
  const versionDetails = await Promise.all(versions.map(async (version) => {
    const graph = await repos.workflows.latestGraph(version.id);
    const ir = await repos.workflows.latestIr(version.id);
    const workflow = isWorkflowDefinition(ir?.ir) ? ir.ir : graph ? builderGraphToWorkflow(normalizeBuilderGraph(graph.xyflow, agent.id, agent.name, String(version.version))) : null;
    return {
      version,
      graph,
      ir,
      metadata: workflow ? {
        nodeCount: workflow.nodes.length,
        edgeCount: workflow.edges.length,
        nodeTypes: [...new Set(workflow.nodes.map((node) => node.type))].sort(),
        categories: [...new Set(workflow.nodes.map((node) => node.category))].sort()
      } : { nodeCount: 0, edgeCount: 0, nodeTypes: [], categories: [] }
    };
  }));
  return {
    agent,
    versions: versionDetails,
    currentVersion: agent.currentVersionId ? versionDetails.find((entry) => entry.version.id === agent.currentVersionId)?.version ?? null : null,
    draftVersion: versionDetails.find((entry) => entry.version.status === "draft")?.version ?? null
  };
}

export async function getAgentBuilderState(agentId: string, repos = getServerRepositories()): Promise<{ agent: Agent; version: AgentVersion | null; graph: BuilderGraph }> {
  const agent = await repos.agents.getAgent(agentId);
  if (!agent) throw new Error("Agent not found");
  const version = await latestEditableVersion(repos, agent);
  const latestGraph = version ? await repos.workflows.latestGraph(version.id) : null;
  return {
    agent,
    version,
    graph: normalizeBuilderGraph(latestGraph?.xyflow, agent.id, agent.name, version ? String(version.version) : "1")
  };
}

export async function updateAgentDetails(agentId: string, input: { name?: string; description?: string | null }, repos = getServerRepositories()): Promise<Agent> {
  const updated = await repos.agents.updateAgent(agentId, { name: input.name?.trim(), description: input.description?.trim() || null });
  if (!updated) throw new Error("Agent not found");
  return updated;
}

async function ensureDraftVersion(agent: Agent, repos: PersistenceRepositories): Promise<AgentVersion> {
  const versions = await repos.agents.listVersions(agent.id);
  const current = agent.currentVersionId ? versions.find((entry) => entry.id === agent.currentVersionId) ?? await repos.agents.getVersion(agent.currentVersionId) : null;
  const draft = versions.find((entry) => entry.status === "draft" && (!current || entry.version > current.version));
  if (draft) return draft;
  return repos.agents.createVersion({ agentId: agent.id, version: await nextVersionNumber(repos, agent.id), status: "draft", definition: { schemaVersion: WORKFLOW_IR_SCHEMA_VERSION } });
}

export async function saveBuilderGraph(agentId: string, inputGraph: unknown, mode: "draft" | "version", repos = getServerRepositories()): Promise<{ version: AgentVersion; graph: WorkflowGraph; ir: WorkflowIr; validationErrors: number }> {
  const agent = await repos.agents.getAgent(agentId);
  if (!agent) throw new Error("Agent not found");
  const version = mode === "draft"
    ? await ensureDraftVersion(agent, repos)
    : await repos.agents.createVersion({ agentId, version: await nextVersionNumber(repos, agentId), status: "active", definition: { schemaVersion: WORKFLOW_IR_SCHEMA_VERSION } });
  const graph = normalizeBuilderGraph(inputGraph, agent.id, agent.name, String(version.version));
  const workflow = builderGraphToWorkflow(graph);
  const savedGraph = await repos.workflows.createGraph({ agentVersionId: version.id, name: "default", xyflow: graph as unknown as Record<string, unknown> });
  const ir = await repos.workflows.createIr({ agentVersionId: version.id, schemaVersion: workflow.schemaVersion, ir: workflow as unknown as Record<string, unknown> });
  if (mode === "version") await repos.agents.setCurrentVersion(agent.id, version.id);
  return { version, graph: savedGraph, ir, validationErrors: 0 };
}

async function snapshotForVersion(agent: Agent, version: AgentVersion, repos: PersistenceRepositories) {
  const graph = await repos.workflows.latestGraph(version.id);
  const ir = await repos.workflows.latestIr(version.id);
  const normalizedGraph = normalizeBuilderGraph(graph?.xyflow, agent.id, agent.name, String(version.version));
  const workflow = isWorkflowDefinition(ir?.ir) ? ir.ir : builderGraphToWorkflow(normalizedGraph);
  return { graph: normalizedGraph, ir: workflow };
}

export async function cloneAgent(agentId: string, repos = getServerRepositories()) {
  const source = await repos.agents.getAgent(agentId);
  if (!source) throw new Error("Agent not found");
  const sourceVersion = await latestEditableVersion(repos, source);
  const clone = await repos.agents.createAgent({
    slug: `${slugify(source.name)}-copy-${Date.now().toString(36)}`,
    name: `${source.name} copy`,
    description: source.description,
    metadata: { clonedFromAgentId: source.id, clonedFromVersionId: sourceVersion?.id ?? null }
  });
  const version = await repos.agents.createVersion({ agentId: clone.id, version: 1, status: "draft", definition: { schemaVersion: WORKFLOW_IR_SCHEMA_VERSION, clonedFromVersionId: sourceVersion?.id ?? null } });
  const snapshot = sourceVersion ? await snapshotForVersion(source, sourceVersion, repos) : { graph: createInitialBuilderGraph(clone.id, clone.name, "1"), ir: builderGraphToWorkflow(createInitialBuilderGraph(clone.id, clone.name, "1")) };
  const graph = normalizeBuilderGraph({ ...snapshot.graph, id: clone.id, name: clone.name, version: "1" }, clone.id, clone.name, "1");
  const workflow = builderGraphToWorkflow(graph);
  await repos.workflows.createGraph({ agentVersionId: version.id, name: "default", xyflow: graph as unknown as Record<string, unknown> });
  await repos.workflows.createIr({ agentVersionId: version.id, schemaVersion: workflow.schemaVersion, ir: workflow as unknown as Record<string, unknown> });
  return { agent: clone, version };
}

export async function rollbackVersion(agentId: string, versionId: string, repos = getServerRepositories()) {
  const agent = await repos.agents.getAgent(agentId);
  if (!agent) throw new Error("Agent not found");
  const sourceVersion = await repos.agents.getVersion(versionId);
  if (!sourceVersion || sourceVersion.agentId !== agent.id) throw new Error("Agent version not found");
  const nextVersion = await repos.agents.createVersion({
    agentId: agent.id,
    version: await nextVersionNumber(repos, agent.id),
    status: "draft",
    definition: { ...asRecord(sourceVersion.definition), rolledBackFromVersionId: sourceVersion.id, rolledBackFromVersion: sourceVersion.version }
  });
  const snapshot = await snapshotForVersion(agent, sourceVersion, repos);
  const graph = normalizeBuilderGraph({ ...snapshot.graph, version: String(nextVersion.version) }, agent.id, agent.name, String(nextVersion.version));
  const workflow = builderGraphToWorkflow(graph);
  await repos.workflows.createGraph({ agentVersionId: nextVersion.id, name: "default", xyflow: graph as unknown as Record<string, unknown> });
  await repos.workflows.createIr({ agentVersionId: nextVersion.id, schemaVersion: workflow.schemaVersion, ir: workflow as unknown as Record<string, unknown> });
  return nextVersion;
}

function summarizeWorkflow(workflow: WorkflowDefinition) {
  return {
    id: workflow.id,
    name: workflow.name,
    version: workflow.version,
    nodeCount: workflow.nodes.length,
    edgeCount: workflow.edges.length,
    nodes: workflow.nodes.map((node) => ({ id: node.id, type: node.type, category: node.category, name: node.name })).sort((left, right) => left.id.localeCompare(right.id)),
    edges: workflow.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle })).sort((left, right) => left.id.localeCompare(right.id))
  };
}

function idDiff<T extends { id: string }>(left: readonly T[], right: readonly T[]) {
  const leftMap = new Map(left.map((entry) => [entry.id, entry]));
  const rightMap = new Map(right.map((entry) => [entry.id, entry]));
  const added = right.filter((entry) => !leftMap.has(entry.id));
  const removed = left.filter((entry) => !rightMap.has(entry.id));
  const changed = right.filter((entry) => leftMap.has(entry.id) && stableJson(leftMap.get(entry.id)) !== stableJson(entry));
  return { added, removed, changed };
}

export async function compareVersions(agentId: string, leftVersionId: string, rightVersionId: string, repos = getServerRepositories()) {
  const agent = await repos.agents.getAgent(agentId);
  if (!agent) throw new Error("Agent not found");
  const leftVersion = await repos.agents.getVersion(leftVersionId);
  const rightVersion = await repos.agents.getVersion(rightVersionId);
  if (!leftVersion || !rightVersion || leftVersion.agentId !== agent.id || rightVersion.agentId !== agent.id) throw new Error("Agent version not found");
  const left = await snapshotForVersion(agent, leftVersion, repos);
  const right = await snapshotForVersion(agent, rightVersion, repos);
  const leftSummary = summarizeWorkflow(left.ir);
  const rightSummary = summarizeWorkflow(right.ir);
  return {
    left: { version: leftVersion, summary: leftSummary },
    right: { version: rightVersion, summary: rightSummary },
    graph: {
      nodeCountDelta: rightSummary.nodeCount - leftSummary.nodeCount,
      edgeCountDelta: rightSummary.edgeCount - leftSummary.edgeCount,
      nodes: idDiff(leftSummary.nodes, rightSummary.nodes),
      edges: idDiff(leftSummary.edges, rightSummary.edges)
    },
    irChanged: stableJson(left.ir) !== stableJson(right.ir)
  };
}

export async function exportWorkflowIr(agentVersionId: string, repos = getServerRepositories()) {
  const version = await repos.agents.getVersion(agentVersionId);
  if (!version) throw new Error("Agent version not found");
  const agent = await repos.agents.getAgent(version.agentId);
  if (!agent) throw new Error("Agent not found");
  return (await snapshotForVersion(agent, version, repos)).ir;
}

export async function exportRobflowProject(agentId: string, repos = getServerRepositories()) {
  const detail = await getAgentDetail(agentId, repos);
  return {
    format: "robflow-project",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    agent: serializeAgent(detail.agent),
    currentVersionId: detail.agent.currentVersionId,
    versions: detail.versions.map((entry) => ({
      version: serializeVersion(entry.version),
      graph: entry.graph?.xyflow ?? null,
      ir: entry.ir?.ir ?? null,
      metadata: entry.metadata
    }))
  };
}

export async function importRobflowProject(project: unknown, repos = getServerRepositories()) {
  const projectRecord = asRecord(project);
  if (projectRecord.format !== "robflow-project") throw projectFormatError("format must be robflow-project");
  const sourceAgent = asRecord(projectRecord.agent);
  if (typeof sourceAgent.name !== "string") throw projectFormatError("agent.name is required");
  const entries = Array.isArray(projectRecord.versions) ? projectRecord.versions : [];
  if (entries.length === 0) throw projectFormatError("at least one version is required");
  const agent = await repos.agents.createAgent({
    slug: `${slugify(sourceAgent.name)}-import-${Date.now().toString(36)}`,
    name: `${sourceAgent.name} import`,
    description: typeof sourceAgent.description === "string" ? sourceAgent.description : null,
    metadata: { importedFromAgentId: typeof sourceAgent.id === "string" ? sourceAgent.id : null }
  });
  const versionIdMap = new Map<string, string>();
  let currentVersionId: string | null = null;
  for (const entry of entries) {
    const record = asRecord(entry);
    const sourceVersion = asRecord(record.version);
    const sourceVersionId = typeof sourceVersion.id === "string" ? sourceVersion.id : undefined;
    const versionNumber = typeof sourceVersion.version === "number" ? sourceVersion.version : await nextVersionNumber(repos, agent.id);
    const version = await repos.agents.createVersion({
      agentId: agent.id,
      version: versionNumber,
      status: parseImportedStatus(sourceVersion.status),
      definition: { ...asRecord(sourceVersion.definition), importedFromVersionId: sourceVersionId ?? null }
    });
    if (sourceVersionId) versionIdMap.set(sourceVersionId, version.id);
    const graph = normalizeBuilderGraph(record.graph, agent.id, agent.name, String(version.version));
    const workflow = isWorkflowDefinition(record.ir) ? { ...record.ir, id: agent.id, name: agent.name, version: String(version.version) } : builderGraphToWorkflow(graph);
    await repos.workflows.createGraph({ agentVersionId: version.id, name: "default", xyflow: graph as unknown as Record<string, unknown> });
    await repos.workflows.createIr({ agentVersionId: version.id, schemaVersion: workflow.schemaVersion, ir: workflow as unknown as Record<string, unknown> });
    if (version.status === "active") currentVersionId = version.id;
  }
  const importedCurrent = typeof projectRecord.currentVersionId === "string" ? versionIdMap.get(projectRecord.currentVersionId) : undefined;
  const nextCurrent = importedCurrent ?? currentVersionId;
  if (nextCurrent) await repos.agents.setCurrentVersion(agent.id, nextCurrent);
  return { agent: await repos.agents.getAgent(agent.id) ?? agent, importedVersions: entries.length };
}

export function serializeAgent(agent: Agent) {
  return { ...agent, createdAt: agent.createdAt.toISOString(), updatedAt: agent.updatedAt.toISOString(), metadata: asRecord(agent.metadata) };
}

export function serializeVersion(version: AgentVersion | null) {
  return version ? { ...version, createdAt: version.createdAt.toISOString() } : null;
}

export function serializeSummary(summary: Awaited<ReturnType<typeof listAgentSummaries>>[number]) {
  return {
    agent: serializeAgent(summary.agent),
    latestVersion: serializeVersion(summary.latestVersion),
    currentVersion: serializeVersion(summary.currentVersion),
    draftVersion: serializeVersion(summary.draftVersion),
    versionCount: summary.versionCount,
    publishedCount: summary.publishedCount
  };
}

export function serializeDetail(detail: Awaited<ReturnType<typeof getAgentDetail>>) {
  return {
    agent: serializeAgent(detail.agent),
    currentVersion: serializeVersion(detail.currentVersion),
    draftVersion: serializeVersion(detail.draftVersion),
    versions: detail.versions.map((entry) => ({
      version: serializeVersion(entry.version),
      graphId: entry.graph?.id ?? null,
      irId: entry.ir?.id ?? null,
      metadata: entry.metadata
    }))
  };
}
