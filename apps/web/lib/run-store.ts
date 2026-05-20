import { type HumanApproval, type Run, type RunEvent, type RunLog } from "@robflow/persistence";
import { isWorkflowDefinition } from "@robflow/workflow-ir";
import { compileAgentVersionAdkExport } from "./adk-compiler";
import { getServerRepositories, type PersistenceRepositories } from "./inference-store";

export interface SerializedRun extends Omit<Run, "createdAt" | "updatedAt" | "startedAt" | "completedAt"> {
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function serializeRun(run: Run): SerializedRun {
  return {
    ...run,
    input: asRecord(run.input),
    output: run.output ? asRecord(run.output) : null,
    error: run.error ? asRecord(run.error) : null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null
  };
}

export function serializeEvent(event: RunEvent) {
  return { ...event, createdAt: event.createdAt.toISOString(), nodeInfo: asRecord(event.nodeInfo), payload: asRecord(event.payload), output: event.output ? asRecord(event.output) : null };
}

export function serializeLog(log: RunLog) {
  return { ...log, createdAt: log.createdAt.toISOString(), metadata: asRecord(log.metadata) };
}

export function serializeApproval(approval: HumanApproval) {
  return {
    ...approval,
    prompt: asRecord(approval.prompt),
    response: approval.response ? asRecord(approval.response) : null,
    requestedAt: approval.requestedAt.toISOString(),
    resolvedAt: approval.resolvedAt?.toISOString() ?? null
  };
}

export async function createRunForAgentVersion(agentVersionId: string, input: unknown, repos: PersistenceRepositories = getServerRepositories()): Promise<Run> {
  const version = await repos.agents.getVersion(agentVersionId);
  if (!version) throw new Error("Agent version not found");
  const agent = await repos.agents.getAgent(version.agentId);
  if (!agent) throw new Error("Agent not found");
  const latestIr = await repos.workflows.latestIr(agentVersionId);
  if (!latestIr || !isWorkflowDefinition(latestIr.ir)) throw new Error("Agent version has no compiled workflow IR");
  const adk = await compileAgentVersionAdkExport(agentVersionId, repos);
  const normalizedInput = asRecord(input);
  const job = await repos.runs.enqueueJob({
    kind: "manual",
    payload: {
      schemaVersion: "2025-01",
      agentId: agent.id,
      agentVersionId,
      input: normalizedInput,
      workflowIr: latestIr.ir,
      adkBundle: { manifest: adk.manifest, diagnostics: adk.diagnostics, files: adk.files },
      retry: { source: "workflow-runtime-metadata" }
    }
  });
  return repos.runs.createRun({ agentId: agent.id, agentVersionId, runJobId: job.id, status: "queued", input: normalizedInput });
}

export async function getRunSnapshot(runId: string, repos: PersistenceRepositories = getServerRepositories()) {
  const run = await repos.runs.getRun(runId);
  if (!run) throw new Error("Run not found");
  const [events, logs, approvals] = await Promise.all([repos.runs.listEvents(runId), repos.runs.listLogs(runId), repos.approvals.pendingForRun(runId)]);
  return { run, events, logs, approvals };
}

export async function cancelRun(runId: string, repos: PersistenceRepositories = getServerRepositories()): Promise<Run> {
  const run = await repos.runs.updateRunStatus(runId, { status: "canceled", completedAt: new Date(), error: { canceled: true, canceledAt: new Date().toISOString() } });
  if (!run) throw new Error("Run not found");
  if (run.runJobId) await repos.runs.updateJobStatus(run.runJobId, "canceled");
  await repos.runs.appendLog({ runId, sequence: (await repos.runs.listLogs(runId)).length + 1, level: "warn", message: "Run canceled by API", metadata: {} });
  return run;
}

export async function resumeRun(runId: string, input: { approvalId?: string; response?: unknown; resolvedBy?: string }, repos: PersistenceRepositories = getServerRepositories()): Promise<{ run: Run; approval: HumanApproval }> {
  const run = await repos.runs.getRun(runId);
  if (!run) throw new Error("Run not found");
  if (!run.agentVersionId) throw new Error("Run has no agent version to resume");
  const pending = await repos.approvals.pendingForRun(runId);
  const target = input.approvalId ? pending.find((entry) => entry.id === input.approvalId) : pending[0];
  if (!target) throw new Error("No pending approval found for run");
  const approval = await repos.approvals.resolve(target.id, { status: "approved", response: asRecord(input.response), resolvedBy: input.resolvedBy });
  if (!approval) throw new Error("Approval could not be resolved");
  const latestIr = await repos.workflows.latestIr(run.agentVersionId);
  if (!latestIr || !isWorkflowDefinition(latestIr.ir)) throw new Error("Agent version has no compiled workflow IR");
  const adk = await compileAgentVersionAdkExport(run.agentVersionId, repos);
  await repos.runs.enqueueJob({
    kind: "resume",
    payload: {
      schemaVersion: "2025-01",
      runId,
      agentId: run.agentId,
      agentVersionId: run.agentVersionId,
      input: asRecord(run.input),
      workflowIr: latestIr.ir,
      adkBundle: { manifest: adk.manifest, diagnostics: adk.diagnostics, files: adk.files },
      resume: { approvalId: approval.id, nodeId: approval.nodeId, response: asRecord(input.response) }
    }
  });
  const updated = await repos.runs.updateRunStatus(runId, { status: "queued" });
  return { run: updated ?? run, approval };
}
