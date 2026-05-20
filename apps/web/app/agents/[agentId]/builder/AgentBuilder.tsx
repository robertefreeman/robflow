"use client";

import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type OnConnect,
  type ReactFlowInstance
} from "@xyflow/react";
import type { ReusableNodeTypeVersion } from "@robflow/node-registry";
import Link from "next/link";
import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NODE_PALETTE, builderGraphToWorkflow, createCustomNodeData, createNodeData, validateBuilderGraph, type BuilderGraph, type BuilderNodeData, type BuilderNodeKind, type BuiltInBuilderNodeKind } from "../../../../lib/workflow-builder";
import { WORKFLOW_COOKBOOK, draftWorkflowFromPrompt, explainValidation, findBrokenPaths, findRepeatedPatternCandidates, simulateMockRun, suggestTestCases } from "../../../../lib/workflow-assist";

type BuilderNode = Node<BuilderNodeData, "robflowNode">;
type BuilderEdge = Edge<Record<string, unknown>>;
type Agent = { id: string; name: string; description: string | null };
type BuilderFlowInstance = ReactFlowInstance<BuilderNode, BuilderEdge>;
type SaveState = "idle" | "saving" | "saved" | "error";
type CustomPaletteNode = ReusableNodeTypeVersion;

const kindClass: Record<BuilderNodeKind, string> = {
  start: "node-start",
  end: "node-end",
  llm: "node-llm",
  tool: "node-tool",
  router: "node-router",
  approval: "node-approval",
  custom: "node-custom"
};

function RobflowNode({ data, selected }: NodeProps<BuilderNode>) {
  const hasInput = data.kind !== "start";
  const outputs = data.outputs?.length ? data.outputs : data.kind === "end" ? [] : [{ id: "out" }];
  return (
    <div className={`flow-node ${kindClass[data.kind]} ${selected ? "selected" : ""}`}>
      {hasInput ? <Handle type="target" id="in" position={Position.Left} /> : null}
      <div className="node-type">{data.kind}</div>
      <strong>{data.label || data.name}</strong>
      {data.description ? <span>{data.description}</span> : null}
      {outputs.map((output, index) => (
        <Handle key={output.id} type="source" id={output.id} position={Position.Right} style={{ top: `${((index + 1) / (outputs.length + 1)) * 100}%` }} />
      ))}
    </div>
  );
}

const nodeTypes = { robflowNode: RobflowNode };

function labelFor(kind: BuiltInBuilderNodeKind) {
  return NODE_PALETTE.find((entry) => entry.kind === kind)?.label ?? "Node";
}

function toNodes(graph: BuilderGraph): BuilderNode[] {
  return graph.nodes.map((node) => ({ ...node, type: "robflowNode" as const }));
}

function toGraph(agent: Agent | null, version: string, nodes: BuilderNode[], edges: BuilderEdge[], instance: BuilderFlowInstance | null): BuilderGraph {
  return {
    id: agent?.id ?? "workflow",
    name: agent?.name ?? "Workflow",
    version,
    nodes: nodes.map((node) => ({ id: node.id, type: "robflowNode", position: node.position, data: node.data })),
    edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle, label: typeof edge.label === "string" ? edge.label : undefined })),
    viewport: instance?.getViewport() ?? { x: 0, y: 0, zoom: 1 },
    metadata: { savedFrom: "visual-builder" }
  };
}

function Field({ label, value, onChange, textarea = false }: { label: string; value: string; onChange: (value: string) => void; textarea?: boolean }) {
  return (
    <label>
      {label}
      {textarea ? <textarea value={value} rows={4} onChange={(event) => onChange(event.target.value)} /> : <input value={value} onChange={(event) => onChange(event.target.value)} />}
    </label>
  );
}

export function AgentBuilder({ agentId }: { agentId: string }) {
  return (
    <ReactFlowProvider>
      <AgentBuilderInner agentId={agentId} />
    </ReactFlowProvider>
  );
}

function AgentBuilderInner({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [version, setVersion] = useState("1");
  const [nodes, setNodes, onNodesChange] = useNodesState<BuilderNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<BuilderEdge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading graph…");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [instance, setInstance] = useState<BuilderFlowInstance | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [customNodeTypes, setCustomNodeTypes] = useState<CustomPaletteNode[]>([]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [assistPrompt, setAssistPrompt] = useState("Draft a support triage workflow with human approval");
  const lastSaved = useRef("");

  useEffect(() => {
    async function load() {
      const [response, nodeTypesResponse, inferenceResponse] = await Promise.all([fetch(`/api/agents/${agentId}`, { cache: "no-store" }), fetch("/api/node-types", { cache: "no-store" }), fetch("/api/settings/inference", { cache: "no-store" })]);
      const data = await response.json();
      const nodeTypesData = await nodeTypesResponse.json().catch(() => ({}));
      const inferenceData = await inferenceResponse.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Unable to load agent");
      setAgent(data.agent);
      setVersion(String(data.version?.version ?? data.graph?.version ?? "1"));
      setNodes(toNodes(data.graph));
      setEdges(data.graph.edges ?? []);
      if (nodeTypesResponse.ok) setCustomNodeTypes((nodeTypesData.nodeTypes ?? []).map((entry: { palette?: CustomPaletteNode | null }) => entry.palette).filter(Boolean));
      if (inferenceResponse.ok && Array.isArray(inferenceData.models)) setAvailableModels(inferenceData.models.filter((model: unknown): model is string => typeof model === "string"));
      if (data.graph.viewport && instance) requestAnimationFrame(() => instance.setViewport(data.graph.viewport));
      lastSaved.current = JSON.stringify(data.graph);
      setStatus("");
      setLoaded(true);
    }
    load().catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Unable to load graph"));
  }, [agentId, instance, setEdges, setNodes]);

  const graph = useMemo(() => toGraph(agent, version, nodes, edges, instance), [agent, version, nodes, edges, instance]);
  const validation = useMemo(() => validateBuilderGraph(graph), [graph]);
  const selectedNode = selectedNodeId ? nodes.find((node) => node.id === selectedNodeId) ?? null : null;
  const selectedEdge = selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) ?? null : null;
  const validationExplanation = useMemo(() => explainValidation(validation), [validation]);
  const brokenPaths = useMemo(() => findBrokenPaths(validation), [validation]);
  const suggestedTests = useMemo(() => suggestTestCases(graph), [graph]);
  const repeatedPatterns = useMemo(() => findRepeatedPatternCandidates(graph), [graph]);
  const mockSimulation = useMemo(() => simulateMockRun(graph), [graph]);

  const saveGraph = useCallback(async (mode: "draft" | "version") => {
    if (!agent) return;
    const nextGraph = toGraph(agent, version, nodes, edges, instance);
    const serialized = JSON.stringify(nextGraph);
    if (mode === "draft" && serialized === lastSaved.current) return;
    setSaveState("saving");
    const response = await fetch(`/api/agents/${agent.id}/graph`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, graph: nextGraph }) });
    const data = await response.json();
    if (!response.ok) {
      setSaveState("error");
      setStatus(data.error ?? "Save failed");
      return;
    }
    lastSaved.current = serialized;
    setVersion(String(data.version?.version ?? version));
    setSaveState("saved");
    setStatus(mode === "version" ? "Saved new version." : "Draft autosaved.");
  }, [agent, version, nodes, edges, instance]);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => void saveGraph("draft"), 1200);
    return () => window.clearTimeout(timer);
  }, [graph, loaded, saveGraph]);

  const onConnect: OnConnect = useCallback((connection: Connection) => {
    setEdges((current) => addEdge({ ...connection, id: `${connection.source}-${connection.sourceHandle ?? "out"}-${connection.target}-${connection.targetHandle ?? "in"}` }, current));
  }, [setEdges]);

  function applyAssistantDraft(prompt = assistPrompt) {
    const draft = draftWorkflowFromPrompt(prompt, agent?.id ?? agentId, agent?.name ? `${agent.name} draft` : "Assistant draft");
    setNodes(toNodes(draft));
    setEdges(draft.edges ?? []);
    setStatus("Applied deterministic workflow-assist draft. Review, configure, and save when ready.");
  }

  function addNode(kind: BuiltInBuilderNodeKind) {
    const id = `${kind}-${Date.now().toString(36)}`;
    const offset = nodes.length * 32;
    setNodes((current) => current.concat({ id, type: "robflowNode", position: { x: 180 + offset, y: 120 + offset }, data: createNodeData(kind, labelFor(kind)) }));
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
  }

  function addCustomNode(nodeType: CustomPaletteNode) {
    const id = `custom-${nodeType.slug}-${Date.now().toString(36)}`;
    const offset = nodes.length * 32;
    setNodes((current) => current.concat({ id, type: "robflowNode", position: { x: 180 + offset, y: 120 + offset }, data: createCustomNodeData(nodeType) }));
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
  }

  async function promoteSelectedNode() {
    if (!selectedNode) return;
    const slug = `${selectedNode.data.label || selectedNode.id}-${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const response = await fetch("/api/node-types/promote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, displayName: selectedNode.data.label, node: selectedNode.data }) });
    const data = await response.json();
    if (!response.ok) {
      setStatus(data.error ?? "Unable to promote node");
      return;
    }
    if (data.palette) setCustomNodeTypes((current) => current.concat(data.palette));
    updateSelectedNode({ nodeType: data.palette ? { slug: data.palette.slug, version: data.palette.version, versionId: data.palette.id } : undefined, kind: "custom", type: data.palette ? `custom.${data.palette.slug}` : selectedNode.data.type, compatibility: { promoted: true } });
    setStatus("Promoted node to reusable type and pinned this node to v1.");
  }

  function updateSelectedNode(patch: Partial<BuilderNodeData>) {
    if (!selectedNodeId) return;
    setNodes((current) => current.map((node) => node.id === selectedNodeId ? { ...node, data: { ...node.data, ...patch } } : node));
  }

  function updateNested(key: "model" | "tool" | "humanInput" | "router", patch: Record<string, unknown>) {
    const current = (selectedNode?.data[key] ?? {}) as Record<string, unknown>;
    const config = { ...(selectedNode?.data.config ?? {}) };
    if (key === "model" && typeof patch.model === "string") config.model = patch.model;
    if (key === "tool" && typeof patch.name === "string") config.toolName = patch.name;
    updateSelectedNode({ [key]: { ...current, ...patch }, config } as Partial<BuilderNodeData>);
  }

  function updateSelectedConfig(patch: Record<string, unknown>) {
    updateSelectedNode({ config: { ...(selectedNode?.data.config ?? {}), ...patch } });
  }

  function updateEdgeLabel(value: string) {
    if (!selectedEdgeId) return;
    setEdges((current) => current.map((edge) => edge.id === selectedEdgeId ? { ...edge, label: value } : edge));
  }

  async function updateAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agent) return;
    const response = await fetch(`/api/agents/${agent.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: agent.name, description: agent.description }) });
    const data = await response.json();
    if (response.ok) setAgent(data.agent);
  }

  return (
    <main className="builder-shell">
      <header className="builder-header">
        <div>
          <Link href="/agents" className="secondary-link">← Agents</Link>
          {agent ? <Link href={`/agents/${agent.id}`} className="secondary-link">Details</Link> : null}
          <h1>{agent?.name ?? "Agent builder"}</h1>
        </div>
        <div className="builder-actions">
          <span className={`save-state ${saveState}`}>{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save error" : "Ready"}</span>
          <button type="button" onClick={() => void saveGraph("draft")}>Save draft</button>
          <button type="button" className="primary" onClick={() => void saveGraph("version")}>Save version</button>
        </div>
      </header>
      <section className="builder-grid">
        <aside className="palette panel-lite">
          <h2>Palette</h2>
          <Link className="secondary-link" href="/node-types">Manage library</Link>
          {NODE_PALETTE.map((entry) => <button key={entry.kind} type="button" onClick={() => addNode(entry.kind)}><strong>{entry.label}</strong><span>{entry.description}</span></button>)}
          {customNodeTypes.length ? <h3>Reusable</h3> : null}
          {customNodeTypes.map((entry) => <button key={`${entry.slug}@${entry.version}`} type="button" onClick={() => addCustomNode(entry)}><strong>{entry.displayName}</strong><span>{entry.slug} v{entry.version}</span></button>)}
        </aside>
        <section className="canvas-panel">
          <ReactFlow<BuilderNode, BuilderEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setInstance}
            onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
            onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}
            onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
            fitView
          >
            <MiniMap pannable zoomable />
            <Controls />
            <Background />
          </ReactFlow>
        </section>
        <aside className="inspector panel-lite">
          <h2>Inspector</h2>
          {agent ? (
            <form className="compact-form" onSubmit={updateAgent}>
              <Field label="Agent name" value={agent.name} onChange={(value) => setAgent({ ...agent, name: value })} />
              <Field label="Description" value={agent.description ?? ""} textarea onChange={(value) => setAgent({ ...agent, description: value })} />
              <button type="submit">Update details</button>
            </form>
          ) : null}
          {selectedNode ? (
            <div className="compact-form">
              <h3>Node: {selectedNode.id}</h3>
              <Field label="Label" value={selectedNode.data.label} onChange={(value) => updateSelectedNode({ label: value, name: value })} />
              <Field label="Description" value={selectedNode.data.description ?? ""} textarea onChange={(value) => updateSelectedNode({ description: value })} />
              {selectedNode.data.nodeType ? <p className="note">Pinned to {selectedNode.data.nodeType.slug} v{selectedNode.data.nodeType.version}</p> : null}
              {selectedNode.data.config?.codeBacked === true ? <p className="status-output">Code-backed node metadata is worker-only; the web app will not execute it.</p> : null}
              <button type="button" onClick={() => void promoteSelectedNode()}>Promote to reusable node type</button>
              {selectedNode.data.kind === "llm" ? <LlmFields data={selectedNode.data} availableModels={availableModels} onChange={(patch) => updateNested("model", patch)} onConfigChange={updateSelectedConfig} /> : null}
              {selectedNode.data.kind === "tool" ? <ToolFields data={selectedNode.data} onChange={(patch) => updateNested("tool", patch)} onConfigChange={updateSelectedConfig} /> : null}
              {selectedNode.data.kind === "router" ? <RouterFields data={selectedNode.data} onChange={(patch) => updateNested("router", patch)} onOutputs={(outputs) => updateSelectedNode({ outputs })} /> : null}
              {selectedNode.data.kind === "approval" ? <ApprovalFields data={selectedNode.data} onChange={(patch) => updateNested("humanInput", patch)} /> : null}
            </div>
          ) : selectedEdge ? (
            <div className="compact-form">
              <h3>Edge: {selectedEdge.id}</h3>
              <p className="note">{selectedEdge.source} → {selectedEdge.target}</p>
              <Field label="Label" value={typeof selectedEdge.label === "string" ? selectedEdge.label : ""} onChange={updateEdgeLabel} />
            </div>
          ) : <p className="note">Select a node or edge to edit configuration.</p>}
        </aside>
        <aside className="validation panel-lite">
          <h2>Workflow assist</h2>
          <label className="assist-prompt">Prompt-to-draft<textarea rows={4} value={assistPrompt} onChange={(event) => setAssistPrompt(event.target.value)} /></label>
          <button type="button" onClick={() => applyAssistantDraft()}>Generate deterministic draft</button>
          <details><summary>Cookbook templates</summary>{WORKFLOW_COOKBOOK.map((template) => <button key={template.id} type="button" onClick={() => { setAssistPrompt(template.prompt); applyAssistantDraft(template.prompt); }}><strong>{template.title}</strong><span>{template.description}</span></button>)}</details>
          <details><summary>Suggested test cases ({suggestedTests.length})</summary><pre>{JSON.stringify(suggestedTests, null, 2)}</pre></details>
          <details><summary>Mock run simulation</summary><pre>{JSON.stringify(mockSimulation, null, 2)}</pre></details>
          <details><summary>Repeated patterns ({repeatedPatterns.length})</summary><pre>{JSON.stringify(repeatedPatterns, null, 2)}</pre></details>
          <h2>Validation</h2>
          <p className={validation.valid ? "valid" : "invalid"}>{validation.valid ? "Workflow is valid" : `${validation.errors.length} errors`}</p>
          {validationExplanation.map((line, index) => <p key={`explain-${index}`} className="note">{line}</p>)}
          {brokenPaths.length ? <details><summary>Broken paths</summary><pre>{JSON.stringify(brokenPaths, null, 2)}</pre></details> : null}
          {[...validation.errors, ...validation.warnings].map((issue, index) => <button type="button" key={`${issue.code}-${index}`} onClick={() => issue.nodeId ? setSelectedNodeId(issue.nodeId) : issue.edgeId ? setSelectedEdgeId(issue.edgeId) : undefined}><strong>{issue.severity}: {issue.code}</strong><span>{issue.message}</span></button>)}
          <details><summary>Workflow IR preview</summary><pre>{JSON.stringify(builderGraphToWorkflow(graph), null, 2)}</pre></details>
          {status ? <p className="status-output">{status}</p> : null}
        </aside>
      </section>
    </main>
  );
}

function LlmFields({ data, availableModels, onChange, onConfigChange }: { data: BuilderNodeData; availableModels: string[]; onChange: (patch: Record<string, unknown>) => void; onConfigChange: (patch: Record<string, unknown>) => void }) {
  const model = data.model ?? {};
  const deepResearch = data.config?.deepResearch && typeof data.config.deepResearch === "object" ? data.config.deepResearch as Record<string, unknown> : null;
  function updateDeepResearch(patch: Record<string, unknown>) {
    onConfigChange({ deepResearch: { ...(deepResearch ?? {}), ...patch } });
  }
  return <><Field label="Provider" value={String(model.provider ?? "")} onChange={(value) => onChange({ provider: value })} /><label>Model{availableModels.length > 0 ? <select value={String(model.model ?? "")} onChange={(event) => onChange({ model: event.target.value })}><option value="">Use global default</option>{availableModels.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select> : <input value={String(model.model ?? "")} onChange={(event) => onChange({ model: event.target.value })} placeholder="Use global default" />}</label><Field label="Instructions" textarea value={String(model.instructions ?? "")} onChange={(value) => onChange({ instructions: value })} />{deepResearch ? <><h4>Deep research</h4><Field label="Max iterations" value={String(deepResearch.maxIterations ?? 3)} onChange={(value) => updateDeepResearch({ maxIterations: Number(value) })} /><Field label="SearXNG base URL" value={String(deepResearch.searxngBaseUrl ?? "")} onChange={(value) => updateDeepResearch({ searxngBaseUrl: value })} /><Field label="Firecrawl base URL" value={String(deepResearch.firecrawlBaseUrl ?? "")} onChange={(value) => updateDeepResearch({ firecrawlBaseUrl: value })} /></> : null}</>;
}

function ToolFields({ data, onChange, onConfigChange }: { data: BuilderNodeData; onChange: (patch: Record<string, unknown>) => void; onConfigChange: (patch: Record<string, unknown>) => void }) {
  const tool = data.tool ?? {};
  const toolName = String(tool.name ?? data.config?.toolName ?? "");
  return <><Field label="Tool name" value={toolName} onChange={(value) => onChange({ name: value })} /><Field label="Version" value={String(tool.version ?? "")} onChange={(value) => onChange({ version: value })} />{toolName === "searxng.search" ? <><h4>SearXNG</h4><Field label="Base URL" value={String(data.config?.baseUrl ?? "")} onChange={(value) => onConfigChange({ baseUrl: value })} /><Field label="Max queries" value={String(data.config?.maxQueries ?? 3)} onChange={(value) => onConfigChange({ maxQueries: Number(value) })} /><Field label="Max results" value={String(data.config?.maxResults ?? 5)} onChange={(value) => onConfigChange({ maxResults: Number(value) })} /></> : null}{toolName.startsWith("firecrawl.") ? <><h4>Firecrawl</h4><Field label="Base URL" value={String(data.config?.baseUrl ?? "")} onChange={(value) => onConfigChange({ baseUrl: value })} /><Field label="Operation" value={String(data.config?.operation ?? "scrape")} onChange={(value) => onConfigChange({ operation: value })} /><Field label="Max pages" value={String(data.config?.maxPages ?? 6)} onChange={(value) => onConfigChange({ maxPages: Number(value) })} /></> : null}</>;
}

function RouterFields({ data, onChange, onOutputs }: { data: BuilderNodeData; onChange: (patch: Record<string, unknown>) => void; onOutputs: (outputs: Array<{ id: string }>) => void }) {
  const branches = data.router?.branches ?? [];
  function edit(index: number, key: "handle" | "condition", value: string) {
    const next = branches.map((branch, branchIndex) => branchIndex === index ? { ...branch, [key]: value } : branch);
    onChange({ branches: next, requireDefault: data.router?.requireDefault ?? true });
    onOutputs(next.map((branch) => ({ id: branch.handle })));
  }
  return <div className="branch-list">{branches.map((branch, index) => <div key={index} className="branch-row"><input aria-label="Branch handle" value={branch.handle} onChange={(event: ChangeEvent<HTMLInputElement>) => edit(index, "handle", event.target.value)} /><input aria-label="Branch condition" value={branch.condition ?? (branch.isDefault ? "default" : "")} onChange={(event) => edit(index, "condition", event.target.value)} /></div>)}</div>;
}

function ApprovalFields({ data, onChange }: { data: BuilderNodeData; onChange: (patch: Record<string, unknown>) => void }) {
  const human = data.humanInput ?? { prompt: "", resumable: true, resumeTokenPath: "" };
  return <><Field label="Prompt" textarea value={human.prompt} onChange={(value) => onChange({ prompt: value })} /><Field label="Resume token path" value={human.resumeTokenPath ?? ""} onChange={(value) => onChange({ resumeTokenPath: value, resumable: true })} /><Field label="Assigned role" value={human.assignedRole ?? ""} onChange={(value) => onChange({ assignedRole: value })} /></>;
}
