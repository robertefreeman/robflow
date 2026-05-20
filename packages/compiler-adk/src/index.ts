import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateWorkflowDefinition, type EdgeDefinition, type NodeDefinition, type RetryPolicy, type ValidationIssue, type WorkflowDefinition } from "@robflow/workflow-ir";

export type AdkCompileDiagnosticSeverity = "error" | "warning" | "info";

export type AdkCompileDiagnosticCode =
  | "validation-error"
  | "validation-warning"
  | "runtime-noop-placeholder"
  | "runtime-kind-annotated"
  | "dynamic-route-annotated"
  | "loop-annotated"
  | "hitl-placeholder"
  | "retry-annotated"
  | "collaboration-annotated"
  | "custom-node-placeholder";

export interface AdkCompileDiagnostic {
  readonly severity: AdkCompileDiagnosticSeverity;
  readonly code: AdkCompileDiagnosticCode;
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly handleId?: string;
}

export interface AdkArtifactFile {
  readonly path: string;
  readonly content: string;
  readonly mediaType: string;
}

export interface AdkManifestArtifact {
  readonly path: string;
  readonly kind: "python" | "json" | "markdown";
  readonly sha256: string;
}

export interface AdkCompileManifest {
  readonly compiler: {
    readonly name: "@robflow/compiler-adk";
    readonly version: "0.1.0";
    readonly target: "adk-python-2.0";
  };
  readonly workflow: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly schemaVersion: string;
    readonly nodeCount: number;
    readonly edgeCount: number;
  };
  readonly entrypoint: string;
  readonly routeMap: string;
  readonly diagnostics: {
    readonly errors: number;
    readonly warnings: number;
    readonly infos: number;
  };
  readonly artifacts: readonly AdkManifestArtifact[];
}

export interface AdkCompileResult {
  readonly manifest: AdkCompileManifest;
  readonly diagnostics: readonly AdkCompileDiagnostic[];
  readonly files: readonly AdkArtifactFile[];
}

export interface AdkExportBundle {
  readonly format: "directory";
  readonly rootName: string;
  readonly files: readonly AdkArtifactFile[];
  readonly manifest: AdkCompileManifest;
  readonly diagnostics: readonly AdkCompileDiagnostic[];
}

interface RuntimeNodeDeclaration {
  readonly id: string;
  readonly identifier: string;
  readonly name: string;
  readonly type: string;
  readonly category: NodeDefinition["category"];
  readonly entrypoint?: string;
  readonly runtimeKind?: string;
  readonly model?: unknown;
  readonly tool?: unknown;
  readonly memory?: unknown;
  readonly retry?: RetryPolicy;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly humanInput?: unknown;
}

interface RouteMap {
  readonly startNodeId?: string;
  readonly terminalNodeIds: readonly string[];
  readonly edges: readonly RouteEdge[];
  readonly outgoing: Readonly<Record<string, readonly RouteEdge[]>>;
  readonly routers: Readonly<Record<string, unknown>>;
  readonly loops: Readonly<Record<string, unknown>>;
}

interface RouteEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: string;
  readonly targetHandle?: string;
  readonly label?: string;
}

const PYTHON_SOURCE_PATH = "robflow_adk/workflow.py";
const ROUTE_MAP_PATH = "robflow_adk/route_map.json";
const MANIFEST_PATH = "robflow_adk/manifest.json";
const DIAGNOSTICS_PATH = "robflow_adk/diagnostics.json";
const README_PATH = "README.md";

export function compileWorkflowToAdk(workflow: WorkflowDefinition): AdkCompileResult {
  const validation = validateWorkflowDefinition(workflow);
  const diagnostics: AdkCompileDiagnostic[] = [
    ...validation.errors.map((entry) => fromValidationIssue("error", entry)),
    ...validation.warnings.map((entry) => fromValidationIssue("warning", entry))
  ];

  for (const node of workflow.nodes) collectNodeDiagnostics(node, diagnostics);
  if (workflow.nodes.filter((node) => node.runtime?.kind === "adk" && node.runtime.model !== undefined).length > 1) {
    diagnostics.push({ severity: "info", code: "collaboration-annotated", message: "Multiple ADK model nodes were exported as a collaborative ParallelAgent team declaration." });
  }

  const declarations = workflow.nodes.map(toNodeDeclaration);
  const routeMap = buildRouteMap(workflow);
  const python = renderPythonWorkflow(workflow, declarations, routeMap, diagnostics);
  const routeMapJson = stableJson(routeMap);
  const diagnosticsJson = stableJson(diagnostics);

  const initialFiles: readonly AdkArtifactFile[] = [
    { path: PYTHON_SOURCE_PATH, content: python, mediaType: "text/x-python" },
    { path: ROUTE_MAP_PATH, content: `${routeMapJson}\n`, mediaType: "application/json" },
    { path: DIAGNOSTICS_PATH, content: `${diagnosticsJson}\n`, mediaType: "application/json" },
    { path: README_PATH, content: renderReadme(workflow, diagnostics), mediaType: "text/markdown" }
  ];
  const manifestWithoutArtifacts = buildManifest(workflow, diagnostics, []);
  const manifestFile: AdkArtifactFile = { path: MANIFEST_PATH, content: `${stableJson(manifestWithoutArtifacts)}\n`, mediaType: "application/json" };
  const manifest = buildManifest(workflow, diagnostics, [...initialFiles, manifestFile].map(toManifestArtifact));
  const files = initialFiles.map((file) => file.path === MANIFEST_PATH ? { ...file, content: `${stableJson(manifest)}\n` } : file);

  return {
    manifest,
    diagnostics,
    files: [
      files[0] as AdkArtifactFile,
      files[1] as AdkArtifactFile,
      { path: MANIFEST_PATH, content: `${stableJson(manifest)}\n`, mediaType: "application/json" },
      files[2] as AdkArtifactFile,
      files[3] as AdkArtifactFile
    ]
  };
}

export function createAdkExportBundle(workflow: WorkflowDefinition, rootName = safeSlug(workflow.id)): AdkExportBundle {
  const compiled = compileWorkflowToAdk(workflow);
  return {
    format: "directory",
    rootName,
    files: compiled.files,
    manifest: compiled.manifest,
    diagnostics: compiled.diagnostics
  };
}

export async function writeAdkExportDirectory(bundle: AdkExportBundle, directory: string): Promise<readonly string[]> {
  const written: string[] = [];
  for (const file of bundle.files) {
    const fullPath = path.join(directory, bundle.rootName, file.path);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, file.content, "utf8");
    written.push(fullPath);
  }
  return written;
}

function fromValidationIssue(severity: AdkCompileDiagnosticSeverity, entry: ValidationIssue): AdkCompileDiagnostic {
  return {
    severity,
    code: severity === "error" ? "validation-error" : "validation-warning",
    message: `${entry.code}: ${entry.message}`,
    nodeId: entry.nodeId,
    edgeId: entry.edgeId,
    handleId: entry.handleId
  };
}

function collectNodeDiagnostics(node: NodeDefinition, diagnostics: AdkCompileDiagnostic[]): void {
  if (node.category === "action" && node.runtime === undefined) {
    diagnostics.push({ severity: "warning", code: "runtime-noop-placeholder", nodeId: node.id, message: `Action node '${node.id}' has no runtime binding; generated code will use a noop placeholder.` });
  }
  if (node.runtime !== undefined && node.runtime.kind !== "adk" && node.runtime.kind !== "noop") {
    diagnostics.push({ severity: "warning", code: "runtime-kind-annotated", nodeId: node.id, message: `Runtime kind '${node.runtime.kind}' on node '${node.id}' is represented as metadata only in the ADK export.` });
  }
  if (node.category === "router") {
    diagnostics.push({ severity: "info", code: "dynamic-route-annotated", nodeId: node.id, message: `Router '${node.id}' was exported as deterministic route metadata and runtime branch placeholders.` });
  }
  if (node.category === "loop") {
    diagnostics.push({ severity: "info", code: "loop-annotated", nodeId: node.id, message: `Loop '${node.id}' was exported with condition and iteration guard metadata.` });
  }
  if (node.category === "human-input" || node.humanInput !== undefined || node.runtime?.humanInput !== undefined) {
    diagnostics.push({ severity: "info", code: "hitl-placeholder", nodeId: node.id, message: `Human-in-the-loop node '${node.id}' was exported with a resumable placeholder marker.` });
  }
  if (node.runtime?.retry !== undefined) {
    diagnostics.push({ severity: "info", code: "retry-annotated", nodeId: node.id, message: `Retry policy for '${node.id}' was exported as metadata for the worker runtime.` });
  }
  if (node.type.startsWith("custom.") || node.type.startsWith("reusable.")) {
    diagnostics.push({ severity: "warning", code: "custom-node-placeholder", nodeId: node.id, message: `Custom/reusable node '${node.id}' requires a worker-side implementation hook.` });
  }
}

function toNodeDeclaration(node: NodeDefinition): RuntimeNodeDeclaration {
  return {
    id: node.id,
    identifier: safeIdentifier(node.id),
    name: node.name,
    type: node.type,
    category: node.category,
    entrypoint: node.runtime?.entrypoint,
    runtimeKind: node.runtime?.kind,
    model: node.runtime?.model,
    tool: node.runtime?.tool,
    memory: node.runtime?.memory,
    retry: node.runtime?.retry,
    config: node.config,
    humanInput: node.humanInput ?? node.runtime?.humanInput
  };
}

function buildRouteMap(workflow: WorkflowDefinition): RouteMap {
  const edges = workflow.edges.map(toRouteEdge).sort(compareRouteEdges);
  const outgoingEntries = workflow.nodes.map((node) => [node.id, edges.filter((edge) => edge.source === node.id)] as const);
  const routers = Object.fromEntries(workflow.nodes.filter((node) => node.category === "router").map((node) => [node.id, node.router ?? {}]));
  const loops = Object.fromEntries(workflow.nodes.filter((node) => node.category === "loop").map((node) => [node.id, node.loop ?? {}]));
  return {
    startNodeId: workflow.nodes.find((node) => node.category === "start")?.id,
    terminalNodeIds: workflow.nodes.filter((node) => node.category === "terminal").map((node) => node.id).sort(),
    edges,
    outgoing: Object.fromEntries(outgoingEntries),
    routers,
    loops
  };
}

function toRouteEdge(edge: EdgeDefinition): RouteEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    label: edge.label
  };
}

function compareRouteEdges(left: RouteEdge, right: RouteEdge): number {
  return `${left.source}:${left.sourceHandle ?? ""}:${left.target}:${left.targetHandle ?? ""}:${left.id}`.localeCompare(`${right.source}:${right.sourceHandle ?? ""}:${right.target}:${right.targetHandle ?? ""}:${right.id}`);
}

function renderPythonWorkflow(workflow: WorkflowDefinition, declarations: readonly RuntimeNodeDeclaration[], routeMap: RouteMap, diagnostics: readonly AdkCompileDiagnostic[]): string {
  const adkAgents = declarations.filter((node) => node.runtimeKind === "adk" && node.model !== undefined);
  const hasCollaborativeTeam = adkAgents.length > 1;
  const lines = [
    '"""Generated Robflow ADK 2.0 workflow artifact.',
    "",
    "This module is deterministic and side-effect free on import. It declares ADK",
    "agents where possible and leaves actual model/tool execution to the worker runtime.",
    '"""',
    "from __future__ import annotations",
    "",
    "import json",
    "from dataclasses import dataclass",
    "from typing import Any",
    "",
    "try:",
    "    from google.adk.agents import Agent, SequentialAgent, LoopAgent, ParallelAgent",
    "except Exception:",
    "    class _AdkFallback:",
    "        def __init__(self, **kwargs: Any) -> None:",
    "            self.kwargs = kwargs",
    "",
    "        def __repr__(self) -> str:",
    "            return f\"{self.__class__.__name__}({self.kwargs!r})\"",
    "",
    "    class Agent(_AdkFallback):",
    "        pass",
    "",
    "    class SequentialAgent(_AdkFallback):",
    "        pass",
    "",
    "    class LoopAgent(_AdkFallback):",
    "        pass",
    "",
    "    class ParallelAgent(_AdkFallback):",
    "        pass",
    "",
    "",
    "WORKFLOW = json.loads(" + pythonTripleJson(workflow) + ")",
    "NODE_DECLARATIONS = json.loads(" + pythonTripleJson(declarations) + ")",
    "ROUTE_MAP = json.loads(" + pythonTripleJson(routeMap) + ")",
    "COMPILE_DIAGNOSTICS = json.loads(" + pythonTripleJson(diagnostics) + ")",
    "",
    "",
    "class HumanInputRequired(RuntimeError):",
    "    def __init__(self, node_id: str, policy: dict[str, Any]) -> None:",
    "        super().__init__(f\"Human input required for {node_id}\")",
    "        self.node_id = node_id",
    "        self.policy = policy",
    "",
    "",
    "@dataclass(frozen=True)",
    "class RuntimeNode:",
    "    id: str",
    "    declaration: dict[str, Any]",
    "    adk_agent: Any | None = None",
    "",
    "",
    "def _agent_kwargs(declaration: dict[str, Any]) -> dict[str, Any]:",
    "    model = declaration.get('model') or {}",
    "    kwargs: dict[str, Any] = {",
    "        'name': declaration['identifier'],",
    "        'description': declaration.get('name', declaration['id']),",
    "    }",
    "    if model.get('model'):",
    "        kwargs['model'] = model['model']",
    "    if model.get('instructions'):",
    "        kwargs['instruction'] = model['instructions']",
    "    return kwargs",
    "",
    "",
    "def create_node(declaration: dict[str, Any]) -> RuntimeNode:",
    "    adk_agent = Agent(**_agent_kwargs(declaration)) if declaration.get('runtimeKind') == 'adk' and declaration.get('model') else None",
    "    return RuntimeNode(id=declaration['id'], declaration=declaration, adk_agent=adk_agent)",
    "",
    "",
    "RUNTIME_NODES = {declaration['id']: create_node(declaration) for declaration in NODE_DECLARATIONS}",
    "AGENT_DECLARATIONS = [node.adk_agent for node in RUNTIME_NODES.values() if node.adk_agent is not None]",
    "",
    renderTeamDeclaration(workflow, hasCollaborativeTeam),
    "",
    "def build_workflow() -> Any:",
    "    if TEAM_AGENT is not None:",
    "        return TEAM_AGENT",
    "    if AGENT_DECLARATIONS:",
    `        return SequentialAgent(name=${JSON.stringify(safeIdentifier(workflow.id + "_workflow"))}, sub_agents=AGENT_DECLARATIONS)`,
    "    return {'workflow': WORKFLOW, 'route_map': ROUTE_MAP}",
    "",
    "",
    "root_agent = build_workflow()",
    "",
    "",
    "async def run_workflow(input_payload: dict[str, Any]) -> dict[str, Any]:",
    "    state: dict[str, Any] = {'input': input_payload, 'visited': []}",
    "    current = ROUTE_MAP.get('startNodeId')",
    "    iteration_counts: dict[str, int] = {}",
    "    while current is not None:",
    "        node = RUNTIME_NODES[current]",
    "        state['visited'].append(current)",
    "        declaration = node.declaration",
    "        if declaration.get('humanInput'):",
    "            raise HumanInputRequired(current, declaration['humanInput'])",
    "        if declaration.get('category') == 'loop':",
    "            iteration_counts[current] = iteration_counts.get(current, 0) + 1",
    "            loop_meta = ROUTE_MAP.get('loops', {}).get(current, {})",
    "            max_iterations = loop_meta.get('maxIterations') or 1",
    "            if iteration_counts[current] >= max_iterations:",
    "                exit_handle = loop_meta.get('exitHandle')",
    "                candidates = [edge for edge in ROUTE_MAP['outgoing'].get(current, []) if edge.get('sourceHandle') == exit_handle] if exit_handle else ROUTE_MAP['outgoing'].get(current, [])",
    "            else:",
    "                candidates = ROUTE_MAP['outgoing'].get(current, [])",
    "        else:",
    "            candidates = ROUTE_MAP['outgoing'].get(current, [])",
    "        current = candidates[0]['target'] if candidates else None",
    "        if current in ROUTE_MAP.get('terminalNodeIds', []):",
    "            state['visited'].append(current)",
    "            current = None",
    "    return state",
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function renderTeamDeclaration(workflow: WorkflowDefinition, enabled: boolean): string {
  if (!enabled) return "TEAM_AGENT = None";
  return [
    "# Collaborative agent team declaration synthesized from multiple ADK model nodes.",
    `TEAM_AGENT = ParallelAgent(name=${JSON.stringify(safeIdentifier(workflow.id + "_team"))}, sub_agents=AGENT_DECLARATIONS) if len(AGENT_DECLARATIONS) > 1 else None`
  ].join("\n");
}

function renderReadme(workflow: WorkflowDefinition, diagnostics: readonly AdkCompileDiagnostic[]): string {
  const errorCount = diagnostics.filter((entry) => entry.severity === "error").length;
  const warningCount = diagnostics.filter((entry) => entry.severity === "warning").length;
  return [
    `# ${workflow.name} ADK Export`,
    "",
    `Workflow \`${workflow.id}\` version \`${workflow.version}\` compiled for ADK Python 2.0-compatible workers.`,
    "",
    "## Entrypoint",
    "",
    "`robflow_adk.workflow:root_agent` declares the import-safe ADK artifact. `run_workflow` is a deterministic placeholder executor for syntax/import validation and worker integration tests.",
    "",
    "## Diagnostics",
    "",
    `- errors: ${errorCount}`,
    `- warnings: ${warningCount}`,
    `- infos: ${diagnostics.length - errorCount - warningCount}`,
    ""
  ].join("\n");
}

function buildManifest(workflow: WorkflowDefinition, diagnostics: readonly AdkCompileDiagnostic[], artifacts: readonly AdkManifestArtifact[]): AdkCompileManifest {
  return {
    compiler: { name: "@robflow/compiler-adk", version: "0.1.0", target: "adk-python-2.0" },
    workflow: {
      id: workflow.id,
      name: workflow.name,
      version: workflow.version,
      schemaVersion: workflow.schemaVersion,
      nodeCount: workflow.nodes.length,
      edgeCount: workflow.edges.length
    },
    entrypoint: "robflow_adk.workflow:root_agent",
    routeMap: ROUTE_MAP_PATH,
    diagnostics: {
      errors: diagnostics.filter((entry) => entry.severity === "error").length,
      warnings: diagnostics.filter((entry) => entry.severity === "warning").length,
      infos: diagnostics.filter((entry) => entry.severity === "info").length
    },
    artifacts
  };
}

function toManifestArtifact(file: AdkArtifactFile): AdkManifestArtifact {
  const kind = file.path.endsWith(".py") ? "python" : file.path.endsWith(".md") ? "markdown" : "json";
  return { path: file.path, kind, sha256: createHash("sha256").update(file.content).digest("hex") };
}

function pythonTripleJson(value: unknown): string {
  return `r'''${stableJson(value).replaceAll("'''", "'\\\"'\\\"'") }'''`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForJson(value), null, 2);
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortForJson(entry)]));
  }
  return value;
}

function safeIdentifier(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([0-9])/, "_$1");
  return normalized.length > 0 ? normalized : "robflow_node";
}

function safeSlug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "robflow-adk-export";
}
