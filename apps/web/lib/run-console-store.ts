import { createHash, timingSafeEqual } from "node:crypto";
import { type AgentVersion, type ScheduledRun, type WebhookTrigger, type WorkflowGraph, type WorkflowIr } from "@robflow/persistence";
import { isWorkflowDefinition, type SchemaDefinition, type WorkflowDefinition } from "@robflow/workflow-ir";
import { createRunForAgentVersion, serializeApproval, serializeEvent, serializeLog, serializeRun } from "./run-store";
import { getServerRepositories, type PersistenceRepositories } from "./inference-store";
import { normalizeBuilderGraph } from "./workflow-builder";

const WEBHOOK_SECRET_SCOPE = "webhook";
const WEBHOOK_SECRET_KEY_REF = "sha256";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isoDate(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || `hook-${Date.now().toString(36)}`;
}

function hashSecret(secret: string): string {
  if (!secret.trim()) throw new Error("Webhook secret is required");
  return `sha256:${createHash("sha256").update(secret).digest("hex")}`;
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function validateWebhookSecret(storedCiphertext: string, provided: string | null): boolean {
  if (!storedCiphertext.startsWith("sha256:") || !provided) return false;
  return secureEqual(storedCiphertext, hashSecret(provided));
}

export function serializeSchedule(schedule: ScheduledRun) {
  return {
    ...schedule,
    input: asRecord(schedule.input),
    nextRunAt: isoDate(schedule.nextRunAt),
    lastRunAt: isoDate(schedule.lastRunAt),
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString()
  };
}

export function serializeWebhook(webhook: WebhookTrigger) {
  return {
    ...webhook,
    config: asRecord(webhook.config),
    secretRecordId: webhook.secretRecordId ? "set" : null,
    createdAt: webhook.createdAt.toISOString(),
    updatedAt: webhook.updatedAt.toISOString()
  };
}

function serializeVersion(version: AgentVersion) {
  return { ...version, createdAt: version.createdAt.toISOString(), definition: asRecord(version.definition) };
}

function serializeGraph(graph: WorkflowGraph | null) {
  return graph ? { ...graph, xyflow: asRecord(graph.xyflow), createdAt: graph.createdAt.toISOString() } : null;
}

function serializeIr(ir: WorkflowIr | null) {
  return ir ? { ...ir, ir: asRecord(ir.ir), createdAt: ir.createdAt.toISOString() } : null;
}

export function extractInputSchema(workflow: WorkflowDefinition | null): SchemaDefinition | null {
  if (!workflow) return null;
  const metadataSchema = asRecord(workflow.metadata).inputSchema;
  if (isSchemaDefinition(metadataSchema)) return metadataSchema;
  const startNode = workflow.nodes.find((node) => node.category === "start") ?? workflow.nodes[0];
  return startNode && isSchemaDefinition(startNode.outputSchema) ? startNode.outputSchema : null;
}

function isSchemaDefinition(value: unknown): value is SchemaDefinition {
  const record = asRecord(value);
  return typeof record.type === "string" || Array.isArray(record.type);
}

export async function getRunConsoleData(agentId: string, repos: PersistenceRepositories = getServerRepositories()) {
  const agent = await repos.agents.getAgent(agentId);
  if (!agent) throw new Error("Agent not found");
  const versions = await repos.agents.listVersions(agent.id);
  const activeVersion = (agent.currentVersionId ? versions.find((version) => version.id === agent.currentVersionId) : null) ?? versions[0] ?? null;
  const [runs, schedules, webhooks] = await Promise.all([
    repos.runs.listRunsForAgent(agent.id),
    repos.schedules.listForAgent(agent.id),
    repos.webhooks.listForAgent(agent.id)
  ]);
  const graph = activeVersion ? await repos.workflows.latestGraph(activeVersion.id) : null;
  const ir = activeVersion ? await repos.workflows.latestIr(activeVersion.id) : null;
  const workflow = isWorkflowDefinition(ir?.ir) ? ir.ir : null;
  return {
    agent: { ...agent, metadata: asRecord(agent.metadata), createdAt: agent.createdAt.toISOString(), updatedAt: agent.updatedAt.toISOString() },
    versions: versions.map(serializeVersion),
    currentVersionId: activeVersion?.id ?? null,
    graph: serializeGraph(graph),
    ir: serializeIr(ir),
    inputSchema: extractInputSchema(workflow),
    runs: runs.map(serializeRun),
    schedules: schedules.map(serializeSchedule),
    webhooks: webhooks.map(serializeWebhook)
  };
}

export async function createSchedule(agentId: string, input: Record<string, unknown>, repos: PersistenceRepositories = getServerRepositories()) {
  const agent = await repos.agents.getAgent(agentId);
  if (!agent) throw new Error("Agent not found");
  const agentVersionId = typeof input.agentVersionId === "string" && input.agentVersionId ? input.agentVersionId : agent.currentVersionId;
  const version = agentVersionId ? await repos.agents.getVersion(agentVersionId) : null;
  if (!version || version.agentId !== agent.id) throw new Error("Agent version not found");
  const cron = typeof input.cron === "string" ? input.cron.trim() : "";
  if (!cron) throw new Error("Cron expression is required");
  return repos.schedules.create({
    agentId: agent.id,
    agentVersionId: version.id,
    cron,
    timezone: typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim() : "UTC",
    enabled: input.enabled !== false,
    input: asRecord(input.input)
  });
}

export async function updateSchedule(scheduleId: string, input: Record<string, unknown>, repos: PersistenceRepositories = getServerRepositories()) {
  const existing = await repos.schedules.get(scheduleId);
  if (!existing) throw new Error("Schedule not found");
  const patch: Partial<ScheduledRun> = {};
  if (typeof input.cron === "string") patch.cron = input.cron.trim();
  if (typeof input.timezone === "string") patch.timezone = input.timezone.trim() || "UTC";
  if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
  if ("input" in input) patch.input = asRecord(input.input);
  const updated = await repos.schedules.update(scheduleId, patch);
  if (!updated) throw new Error("Schedule not found");
  return updated;
}

export async function deleteSchedule(scheduleId: string, repos: PersistenceRepositories = getServerRepositories()) {
  const deleted = await repos.schedules.delete(scheduleId);
  if (!deleted) throw new Error("Schedule not found");
  return deleted;
}

export async function createWebhook(agentId: string, input: Record<string, unknown>, repos: PersistenceRepositories = getServerRepositories()) {
  const agent = await repos.agents.getAgent(agentId);
  if (!agent) throw new Error("Agent not found");
  const agentVersionId = typeof input.agentVersionId === "string" && input.agentVersionId ? input.agentVersionId : agent.currentVersionId;
  const version = agentVersionId ? await repos.agents.getVersion(agentVersionId) : null;
  if (!version || version.agentId !== agent.id) throw new Error("Agent version not found");
  const slug = slugify(typeof input.slug === "string" && input.slug.trim() ? input.slug : `${agent.slug}-${Date.now().toString(36)}`);
  const secret = typeof input.secret === "string" ? input.secret : "";
  const secretRecord = await repos.secrets.create({
    scope: WEBHOOK_SECRET_SCOPE,
    name: slug,
    ciphertext: hashSecret(secret),
    encryptionKeyRef: WEBHOOK_SECRET_KEY_REF,
    metadata: { purpose: "webhook-trigger-secret" }
  });
  return repos.webhooks.create({ agentId: agent.id, agentVersionId: version.id, slug, secretRecordId: secretRecord.id, enabled: input.enabled !== false, config: asRecord(input.config) });
}

export async function triggerWebhook(slug: string, request: Request, repos: PersistenceRepositories = getServerRepositories()) {
  const webhook = await repos.webhooks.getBySlug(slug);
  if (!webhook || !webhook.enabled) throw new Error("Webhook not found");
  const secret = webhook.secretRecordId ? await repos.secrets.get(webhook.secretRecordId) : null;
  const provided = request.headers.get("x-robflow-secret") ?? new URL(request.url).searchParams.get("secret");
  if (!secret || !validateWebhookSecret(secret.ciphertext, provided)) throw new Error("Invalid webhook secret");
  if (!webhook.agentVersionId) throw new Error("Webhook has no agent version");
  const body = await request.json().catch(() => ({}));
  const input = { webhook: { slug: webhook.slug, receivedAt: new Date().toISOString() }, payload: body };
  const run = await createRunForAgentVersion(webhook.agentVersionId, input, repos);
  return run;
}

export function normalizeConsoleGraph(value: unknown, agentId: string, agentName: string, version = "1") {
  return normalizeBuilderGraph(value, agentId, agentName, version);
}

export type SerializedRunConsoleData = Awaited<ReturnType<typeof getRunConsoleData>>;
export type SerializedRunEvent = ReturnType<typeof serializeEvent>;
export type SerializedRunLog = ReturnType<typeof serializeLog>;
export type SerializedHumanApproval = ReturnType<typeof serializeApproval>;
export type SerializedRun = ReturnType<typeof serializeRun>;
