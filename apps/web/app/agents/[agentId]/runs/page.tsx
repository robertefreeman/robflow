"use client";

import { Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps } from "@xyflow/react";
import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { buildNodeHeatmap } from "../../../../lib/workflow-assist";

type Primitive = string | number | boolean | null;
type JsonValue = Primitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type Schema = { type?: string | string[]; description?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: Primitive[] };
type Version = { id: string; version: number; status: string; createdAt: string };
type ConsoleRun = { id: string; agentVersionId: string | null; status: string; input: JsonObject; output: JsonObject | null; error: JsonObject | null; createdAt: string; updatedAt: string; startedAt: string | null; completedAt: string | null };
type RunEvent = { id: number; sequence: number; eventType: string; nodeId: string | null; nodeInfo: JsonObject; output: JsonObject | null; payload: JsonObject; createdAt: string };
type RunLog = { id: number; sequence: number; level: string; message: string; metadata: JsonObject; createdAt: string };
type Approval = { id: string; runId: string; nodeId: string | null; status: string; prompt: JsonObject; response: JsonObject | null; requestedAt: string; resolvedAt: string | null; resolvedBy: string | null };
type RunSnapshot = { run: ConsoleRun; events: RunEvent[]; logs: RunLog[]; pendingApprovals: Approval[] };
type Schedule = { id: string; agentVersionId: string | null; cron: string; timezone: string; enabled: boolean; input: JsonObject; nextRunAt: string | null; lastRunAt: string | null; createdAt: string; updatedAt: string };
type Webhook = { id: string; agentVersionId: string | null; slug: string; secretRecordId: string | null; enabled: boolean; config: JsonObject; createdAt: string; updatedAt: string };
type BuilderGraph = { nodes?: Array<{ id: string; type?: string; position?: { x: number; y: number }; data?: Record<string, unknown> }>; edges?: Array<{ id?: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null; label?: string }> };
type ConsoleData = { agent: { id: string; name: string; slug: string }; versions: Version[]; currentVersionId: string | null; graph: { xyflow: BuilderGraph } | null; inputSchema: Schema | null; runs: ConsoleRun[]; schedules: Schedule[]; webhooks: Webhook[] };
type FlowData = Record<string, unknown> & { label?: string; name?: string; kind?: string; executionStatus?: string; heatIntensity?: number; failures?: number; totalDurationMs?: number };
type FlowNode = Node<FlowData, "robflowNode">;
type FlowEdge = Edge<Record<string, unknown>>;

const statusRank: Record<string, number> = { queued: 0, running: 1, awaiting_approval: 2, succeeded: 3, failed: 4, canceled: 5 };

function stringify(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseObject(text: string, label: string): JsonObject {
  const parsed = text.trim() ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as JsonObject;
}

function nodeExecutionStatuses(events: RunEvent[], run: ConsoleRun | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const event of events) {
    if (!event.nodeId) continue;
    if (event.eventType === "node.started") map.set(event.nodeId, "running");
    if (event.eventType === "node.completed") map.set(event.nodeId, "succeeded");
    if (event.eventType === "hitl.paused") map.set(event.nodeId, "paused");
    if (event.eventType === "run.failed") map.set(event.nodeId, "failed");
  }
  if (run?.status === "canceled") for (const [nodeId, status] of map) if (status === "running") map.set(nodeId, "canceled");
  return map;
}

function RobflowRunNode({ data }: NodeProps<FlowNode>) {
  const outputs = Array.isArray(data.outputs) ? data.outputs as Array<{ id?: string }> : data.kind === "end" ? [] : [{ id: "out" }];
  const kind = String(data.kind ?? data.type ?? "node");
  return (
    <div className={`flow-node run-flow-node node-${kind} exec-${data.executionStatus ?? "idle"} heat-${Math.ceil(Number(data.heatIntensity ?? 0) * 3)}`}>
      {kind !== "start" ? <Handle type="target" id="in" position={Position.Left} /> : null}
      <div className="node-type">{data.executionStatus ?? kind}</div>
      <strong>{data.label ?? data.name ?? "Node"}</strong>
      {Number(data.totalDurationMs ?? 0) > 0 || Number(data.failures ?? 0) > 0 ? <small>{Number(data.failures ?? 0)} failures · {Number(data.totalDurationMs ?? 0)}ms</small> : null}
      {outputs.map((output, index) => <Handle key={output.id ?? index} type="source" id={output.id ?? "out"} position={Position.Right} style={{ top: `${((index + 1) / (outputs.length + 1)) * 100}%` }} />)}
    </div>
  );
}

const nodeTypes = { robflowNode: RobflowRunNode };

function flowNodes(graph: BuilderGraph | null | undefined, statuses: Map<string, string>, heatmap: Map<string, { intensity: number; failures: number; totalDurationMs: number }>): FlowNode[] {
  return (graph?.nodes ?? []).map((node) => {
    const heat = heatmap.get(node.id);
    return { id: node.id, type: "robflowNode", position: node.position ?? { x: 0, y: 0 }, data: { ...(node.data ?? {}), executionStatus: statuses.get(node.id) ?? "idle", heatIntensity: heat?.intensity ?? 0, failures: heat?.failures ?? 0, totalDurationMs: heat?.totalDurationMs ?? 0 } };
  });
}

function flowEdges(graph: BuilderGraph | null | undefined): FlowEdge[] {
  return (graph?.edges ?? []).map((edge, index) => ({ id: edge.id ?? `${edge.source}-${edge.target}-${index}`, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle ?? undefined, targetHandle: edge.targetHandle ?? undefined, label: edge.label }));
}

function emptyValue(schema: Schema): JsonValue {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (schema.enum?.length) return schema.enum[0];
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object") return {};
  return "";
}

function inputFromSchema(schema: Schema | null): JsonObject {
  if (!schema?.properties) return {};
  return Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, emptyValue(child)]));
}

function textInputKey(schema: Schema | null): string {
  const properties = schema?.properties ?? {};
  const preferred = ["userRequest", "user_request", "request", "prompt", "message", "input", "query"];
  const stringKeys = Object.entries(properties)
    .filter(([, child]) => {
      const type = Array.isArray(child.type) ? child.type[0] : child.type;
      return !type || type === "string";
    })
    .map(([key]) => key);
  return preferred.find((key) => stringKeys.includes(key)) ?? stringKeys[0] ?? "userRequest";
}

function inputFromTextRequest(text: string, schema: Schema | null): JsonObject {
  return { [textInputKey(schema)]: text };
}

function SchemaInputForm({ schema, value, onChange }: { schema: Schema | null; value: JsonObject; onChange: (value: JsonObject) => void }) {
  if (!schema?.properties) return <p className="empty-state">No workflow input schema is available. Use JSON input below.</p>;
  return (
    <div className="form-grid schema-form-grid">
      {Object.entries(schema.properties).map(([key, child]) => {
        const type = Array.isArray(child.type) ? child.type[0] : child.type;
        const required = schema.required?.includes(key) ? " *" : "";
        const current = value[key];
        if (child.enum?.length) {
          return <label key={key}>{key}{required}<select value={String(current ?? "")} onChange={(event) => onChange({ ...value, [key]: event.target.value })}>{child.enum.map((entry) => <option key={String(entry)} value={String(entry)}>{String(entry)}</option>)}</select><small>{child.description}</small></label>;
        }
        if (type === "boolean") return <label key={key} className="checkbox-label"><input type="checkbox" checked={Boolean(current)} onChange={(event) => onChange({ ...value, [key]: event.target.checked })} />{key}{required}</label>;
        if (type === "number" || type === "integer") return <label key={key}>{key}{required}<input type="number" value={Number(current ?? 0)} onChange={(event) => onChange({ ...value, [key]: Number(event.target.value) })} /><small>{child.description}</small></label>;
        if (type === "object" || type === "array") return <label key={key}>{key}{required}<textarea rows={3} value={stringify(current)} onChange={(event) => { try { onChange({ ...value, [key]: JSON.parse(event.target.value) as JsonValue }); } catch { onChange(value); } }} /><small>{child.description}</small></label>;
        return <label key={key}>{key}{required}<input value={String(current ?? "")} onChange={(event) => onChange({ ...value, [key]: event.target.value })} /><small>{child.description}</small></label>;
      })}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="run-section"><h2>{title}</h2>{children}</section>;
}

export default function RunConsolePage({ params }: { params: Promise<{ agentId: string }> }) {
  const [agentId, setAgentId] = useState("");
  const [data, setData] = useState<ConsoleData | null>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [compareRunId, setCompareRunId] = useState("");
  const [input, setInput] = useState<JsonObject>({});
  const [jsonInput, setJsonInput] = useState("{}");
  const [inputMode, setInputMode] = useState<"text" | "form" | "json">("text");
  const [textInput, setTextInput] = useState("");
  const [versionId, setVersionId] = useState("");
  const [scheduleCron, setScheduleCron] = useState("*/15 * * * *");
  const [scheduleInput, setScheduleInput] = useState("{}");
  const [webhookSlug, setWebhookSlug] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [approvalResponse, setApprovalResponse] = useState("{\n  \"approved\": true\n}");
  const [status, setStatus] = useState("Loading run console…");

  useEffect(() => { void params.then((value) => setAgentId(value.agentId)); }, [params]);

  async function loadConsole(id = agentId) {
    if (!id) return;
    const response = await fetch(`/api/agents/${id}/run-console`, { cache: "no-store" });
    const next = await response.json();
    if (!response.ok) throw new Error(next.error ?? "Unable to load run console");
    setData(next);
    const nextVersion = versionId || next.currentVersionId || next.versions[0]?.id || "";
    setVersionId(nextVersion);
    const schemaInput = inputFromSchema(next.inputSchema);
    if (!Object.keys(input).length) {
      setInput(schemaInput);
      setJsonInput(stringify(schemaInput));
    }
    const firstRun = selectedRunId || next.runs[0]?.id || "";
    setSelectedRunId(firstRun);
    setStatus("");
  }

  async function loadRun(runId = selectedRunId) {
    if (!runId) { setSnapshot(null); return; }
    const response = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
    const next = await response.json();
    if (!response.ok) throw new Error(next.error ?? "Unable to load run");
    setSnapshot(next);
  }

  useEffect(() => { loadConsole(agentId).catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Unable to load run console")); }, [agentId]);
  useEffect(() => { loadRun(selectedRunId).catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Unable to load run")); }, [selectedRunId]);
  useEffect(() => {
    if (!snapshot || ["succeeded", "failed", "canceled"].includes(snapshot.run.status)) return;
    const timer = window.setInterval(() => { void loadRun(); void loadConsole(); }, 2500);
    return () => window.clearInterval(timer);
  }, [snapshot, selectedRunId, agentId]);

  const graph = data?.graph?.xyflow ?? null;
  const statuses = useMemo(() => nodeExecutionStatuses(snapshot?.events ?? [], snapshot?.run ?? null), [snapshot]);
  const heatmap = useMemo(() => new Map(buildNodeHeatmap(snapshot?.events ?? []).map((entry) => [entry.nodeId, entry])), [snapshot]);
  const nodes = useMemo(() => flowNodes(graph, statuses, heatmap), [graph, statuses, heatmap]);
  const edges = useMemo(() => flowEdges(graph), [graph]);
  const retryLogs = snapshot?.logs.filter((log) => /retry|attempt/i.test(`${log.message} ${stringify(log.metadata)}`)) ?? [];
  const toolEvents = snapshot?.events.filter((event) => /tool/i.test(`${event.eventType} ${stringify(event.nodeInfo)} ${stringify(event.payload)}`)) ?? [];
  const modelEvents = snapshot?.events.filter((event) => /model|llm/i.test(`${event.eventType} ${stringify(event.nodeInfo)} ${stringify(event.payload)}`)) ?? [];
  const errorLogs = snapshot?.logs.filter((log) => log.level === "error") ?? [];
  const compareRun = data?.runs.find((run) => run.id === compareRunId) ?? null;

  async function createRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const payload = inputMode === "text"
        ? inputFromTextRequest(textInput, data?.inputSchema ?? null)
        : inputMode === "json"
          ? parseObject(jsonInput, "Run input")
          : input;
      const response = await fetch(`/api/agent-versions/${versionId}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: payload }) });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error ?? "Unable to create run");
      setSelectedRunId(next.run.id);
      await loadConsole();
      setStatus(`Queued run ${next.run.id}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to create run");
    }
  }

  async function cancelRun() {
    if (!snapshot) return;
    const response = await fetch(`/api/runs/${snapshot.run.id}/cancel`, { method: "POST" });
    const next = await response.json();
    if (!response.ok) return setStatus(next.error ?? "Unable to cancel run");
    setSnapshot({ ...snapshot, run: next.run });
    await loadConsole();
  }

  async function resumeApproval(approvalId: string) {
    try {
      const response = await fetch(`/api/runs/${snapshot?.run.id}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalId, response: parseObject(approvalResponse, "Approval response"), resolvedBy: "run-console" }) });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error ?? "Unable to resume run");
      setSnapshot(snapshot ? { ...snapshot, run: next.run, pendingApprovals: snapshot.pendingApprovals.filter((approval) => approval.id !== approvalId) } : null);
      await loadConsole();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to resume run");
    }
  }

  async function createScheduleFromForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const response = await fetch(`/api/agents/${agentId}/schedules`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentVersionId: versionId, cron: scheduleCron, input: parseObject(scheduleInput, "Schedule input") }) });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error ?? "Unable to create schedule");
      await loadConsole();
      setStatus("Schedule created.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to create schedule");
    }
  }

  async function toggleSchedule(schedule: Schedule) {
    const response = await fetch(`/api/schedules/${schedule.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !schedule.enabled }) });
    const next = await response.json();
    if (!response.ok) setStatus(next.error ?? "Unable to update schedule"); else await loadConsole();
  }

  async function createWebhookFromForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const response = await fetch(`/api/agents/${agentId}/webhooks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentVersionId: versionId, slug: webhookSlug, secret: webhookSecret }) });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error ?? "Unable to create webhook");
      setWebhookSecret("");
      await loadConsole();
      setStatus("Webhook created. Store the secret now; it will not be shown again.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to create webhook");
    }
  }

  return (
    <ReactFlowProvider>
      <main className="page run-console-page">
        <section className="panel run-console-panel">
          <div className="page-heading">
            <div><p className="eyebrow">run console</p><h1>{data?.agent.name ?? "Runs"}</h1></div>
            <div className="version-actions"><Link className="secondary-link" href={`/agents/${agentId}`}>Agent detail</Link><Link className="secondary-link" href={`/agents/${agentId}/builder`}>Builder</Link></div>
          </div>
          {status ? <p className="status-output">{status}</p> : null}
          <div className="run-console-grid">
            <aside className="run-sidebar">
              <Section title="Start run">
                <form className="settings-form" onSubmit={createRun}>
                  <label>Version<select value={versionId} onChange={(event) => setVersionId(event.target.value)}>{data?.versions.map((version) => <option key={version.id} value={version.id}>v{version.version} {version.status}</option>)}</select></label>
                  <div className="input-mode-tabs" role="tablist" aria-label="Run input mode">
                    <button type="button" className={inputMode === "text" ? "selected-tab" : ""} onClick={() => setInputMode("text")}>User request</button>
                    <button type="button" className={inputMode === "form" ? "selected-tab" : ""} onClick={() => setInputMode("form")}>Schema form</button>
                    <button type="button" className={inputMode === "json" ? "selected-tab" : ""} onClick={() => setInputMode("json")}>JSON</button>
                  </div>
                  {inputMode === "text" ? (
                    <label>User request
                      <textarea rows={6} value={textInput} onChange={(event) => setTextInput(event.target.value)} placeholder="Ask the agent what you want it to do..." />
                      <small className="field-help">This is sent as <code>{textInputKey(data?.inputSchema ?? null)}</code>. Use JSON only when you need structured inputs.</small>
                    </label>
                  ) : null}
                  {inputMode === "form" ? <SchemaInputForm schema={data?.inputSchema ?? null} value={input} onChange={(next) => { setInput(next); setJsonInput(stringify(next)); }} /> : null}
                  {inputMode === "json" ? <label>JSON input<textarea rows={6} value={jsonInput} onChange={(event) => { setJsonInput(event.target.value); try { setInput(parseObject(event.target.value, "Run input")); } catch { setInput({}); } }} /></label> : null}
                  <button type="submit" disabled={!versionId}>Queue run</button>
                </form>
              </Section>
              <Section title="Runs">
                {data?.runs.length ? <div className="run-list">{data.runs.map((run) => <button type="button" key={run.id} className={run.id === selectedRunId ? "selected-run" : ""} onClick={() => setSelectedRunId(run.id)}><strong>{run.status}</strong><span>{new Date(run.createdAt).toLocaleString()}</span><code>{run.id.slice(0, 8)}</code></button>)}</div> : <p className="empty-state">No runs yet. Queue a run to see status, events, logs, and output.</p>}
              </Section>
            </aside>
            <section className="run-main">
              <Section title="Execution overlay"><p className="note">Heat tint highlights slow or failing nodes from persisted run events.</p>
                <div className="run-canvas">{nodes.length ? <ReactFlow<FlowNode, FlowEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} fitView><MiniMap pannable zoomable /><Controls /><Background /></ReactFlow> : <p className="empty-state">No persisted builder graph is available for this version.</p>}</div>
              </Section>
              {snapshot ? <RunDetails snapshot={snapshot} onCancel={cancelRun} retryLogs={retryLogs} toolEvents={toolEvents} modelEvents={modelEvents} errorLogs={errorLogs} approvalResponse={approvalResponse} setApprovalResponse={setApprovalResponse} onResume={resumeApproval} /> : <p className="empty-state">Select a run to inspect execution data.</p>}
              <Section title="Run comparison">
                {data && data.runs.length > 1 ? <><select value={compareRunId} onChange={(event) => setCompareRunId(event.target.value)}><option value="">Choose run to compare</option>{data.runs.filter((run) => run.id !== selectedRunId).map((run) => <option key={run.id} value={run.id}>{run.status} · {run.id.slice(0, 8)}</option>)}</select>{compareRun && snapshot ? <div className="compare-summary"><p>Selected status rank delta: {(statusRank[snapshot.run.status] ?? 0) - (statusRank[compareRun.status] ?? 0)}</p><pre>{stringify({ selected: { status: snapshot.run.status, output: snapshot.run.output, error: snapshot.run.error }, compared: { status: compareRun.status, output: compareRun.output, error: compareRun.error } })}</pre></div> : <p className="empty-state">Choose another run to compare status, output, and error payloads.</p>}</> : <p className="empty-state">Run comparison needs at least two runs.</p>}
              </Section>
              <Section title="Schedules">
                <form className="settings-form compact-inline" onSubmit={createScheduleFromForm}><label>Cron<input value={scheduleCron} onChange={(event) => setScheduleCron(event.target.value)} /></label><label>Input JSON<textarea rows={3} value={scheduleInput} onChange={(event) => setScheduleInput(event.target.value)} /></label><button type="submit">Create schedule</button></form>
                {data?.schedules.length ? <div className="data-table">{data.schedules.map((schedule) => <article key={schedule.id}><strong>{schedule.cron}</strong><span>{schedule.timezone} · {schedule.enabled ? "enabled" : "disabled"}</span><button type="button" onClick={() => void toggleSchedule(schedule)}>{schedule.enabled ? "Disable" : "Enable"}</button></article>)}</div> : <p className="empty-state">No schedules configured.</p>}
              </Section>
              <Section title="Webhook triggers">
                <form className="settings-form compact-inline" onSubmit={createWebhookFromForm}><label>Slug<input value={webhookSlug} onChange={(event) => setWebhookSlug(event.target.value)} placeholder={data?.agent.slug} /></label><label>Secret<input type="password" value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} /></label><button type="submit">Create webhook</button></form>
                {data?.webhooks.length ? <div className="data-table">{data.webhooks.map((hook) => <article key={hook.id}><strong>/api/webhooks/{hook.slug}</strong><span>{hook.enabled ? "enabled" : "disabled"} · secret {hook.secretRecordId ?? "missing"}</span></article>)}</div> : <p className="empty-state">No webhook triggers configured.</p>}
              </Section>
            </section>
          </div>
        </section>
      </main>
    </ReactFlowProvider>
  );
}

function RunDetails({ snapshot, onCancel, retryLogs, toolEvents, modelEvents, errorLogs, approvalResponse, setApprovalResponse, onResume }: { snapshot: RunSnapshot; onCancel: () => void; retryLogs: RunLog[]; toolEvents: RunEvent[]; modelEvents: RunEvent[]; errorLogs: RunLog[]; approvalResponse: string; setApprovalResponse: (value: string) => void; onResume: (approvalId: string) => void }) {
  return (
    <>
      <Section title="Run status"><div className="status-card"><strong>{snapshot.run.status}</strong><span>Created {new Date(snapshot.run.createdAt).toLocaleString()}</span>{!["succeeded", "failed", "canceled"].includes(snapshot.run.status) ? <button type="button" onClick={onCancel}>Cancel run</button> : null}</div></Section>
      <Section title="Event timeline">{snapshot.events.length ? <ol className="timeline">{snapshot.events.map((event) => <li key={event.id}><strong>#{event.sequence} {event.eventType}</strong><span>{event.nodeId ?? "run"} · {new Date(event.createdAt).toLocaleTimeString()}</span><pre>{stringify({ payload: event.payload, output: event.output })}</pre></li>)}</ol> : <p className="empty-state">No run events have been persisted yet.</p>}</Section>
      <Section title="Structured logs">{snapshot.logs.length ? <div className="log-table">{snapshot.logs.map((log) => <article key={log.id} className={`log-${log.level}`}><strong>{log.level}</strong><span>{log.message}</span><code>{new Date(log.createdAt).toLocaleTimeString()}</code><pre>{stringify(log.metadata)}</pre></article>)}</div> : <p className="empty-state">No structured logs have been persisted yet.</p>}</Section>
      <Section title="Tool calls">{toolEvents.length ? toolEvents.map((event) => <pre key={event.id}>{stringify(event)}</pre>) : <p className="empty-state">No tool call events are available for this run.</p>}</Section>
      <Section title="Model calls">{modelEvents.length ? modelEvents.map((event) => <pre key={event.id}>{stringify(event)}</pre>) : <p className="empty-state">No model call metadata is available for this run.</p>}</Section>
      <Section title="Errors and retries"><div className="diff-grid"><div><h3>Errors</h3>{snapshot.run.error ? <pre>{stringify(snapshot.run.error)}</pre> : errorLogs.length ? errorLogs.map((log) => <pre key={log.id}>{stringify(log)}</pre>) : <p className="empty-state">No error payloads.</p>}</div><div><h3>Retry attempts</h3>{retryLogs.length ? retryLogs.map((log) => <pre key={log.id}>{stringify(log)}</pre>) : <p className="empty-state">No retry attempts recorded.</p>}</div></div></Section>
      <Section title="Human input / approval">{snapshot.pendingApprovals.length ? <div className="approval-list">{snapshot.pendingApprovals.map((approval) => <article key={approval.id}><strong>{approval.nodeId ?? "approval"}</strong><pre>{stringify(approval.prompt)}</pre><textarea rows={4} value={approvalResponse} onChange={(event) => setApprovalResponse(event.target.value)} /><button type="button" onClick={() => onResume(approval.id)}>Approve and resume</button></article>)}</div> : <p className="empty-state">No pending HITL approvals for this run.</p>}</Section>
      <Section title="Final output">{snapshot.run.output ? <pre>{stringify(snapshot.run.output)}</pre> : <p className="empty-state">No final output has been persisted yet.</p>}</Section>
    </>
  );
}
