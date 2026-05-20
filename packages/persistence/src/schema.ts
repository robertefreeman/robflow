import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const agentVersionStatus = pgEnum("agent_version_status", ["draft", "active", "archived"]);
export const runJobStatus = pgEnum("run_job_status", ["queued", "running", "succeeded", "failed", "canceled"]);
export const runStatus = pgEnum("run_status", ["queued", "running", "succeeded", "failed", "canceled", "awaiting_approval"]);
export const logLevel = pgEnum("log_level", ["debug", "info", "warn", "error"]);
export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected", "canceled", "expired"]);
export const evalRunStatus = pgEnum("eval_run_status", ["queued", "running", "passed", "failed", "errored", "canceled"]);
export const runnerStatus = pgEnum("runner_status", ["starting", "online", "draining", "offline"]);

const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const appConfig = pgTable("app_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull().$type<Record<string, unknown>>(),
  description: text("description"),
  createdAt: now(),
  updatedAt: updatedAt()
});

export const secretRecords = pgTable(
  "secret_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    encryptionKeyRef: text("encryption_key_ref").notNull(),
    metadata: jsonb("metadata").notNull().default({}).$type<Record<string, unknown>>(),
    createdAt: now(),
    updatedAt: updatedAt()
  },
  (table) => [uniqueIndex("secret_records_scope_name_idx").on(table.scope, table.name)]
);

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  currentVersionId: uuid("current_version_id"),
  metadata: jsonb("metadata").notNull().default({}).$type<Record<string, unknown>>(),
  createdAt: now(),
  updatedAt: updatedAt()
});

export const agentVersions = pgTable(
  "agent_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: agentVersionStatus("status").notNull().default("draft"),
    definition: jsonb("definition").notNull().$type<Record<string, unknown>>(),
    createdBy: text("created_by"),
    createdAt: now()
  },
  (table) => [
    uniqueIndex("agent_versions_agent_version_idx").on(table.agentId, table.version),
    index("agent_versions_agent_id_idx").on(table.agentId)
  ]
);

export const workflowGraphs = pgTable(
  "workflow_graphs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentVersionId: uuid("agent_version_id").notNull().references(() => agentVersions.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("default"),
    xyflow: jsonb("xyflow").notNull().$type<Record<string, unknown>>(),
    createdAt: now()
  },
  (table) => [index("workflow_graphs_agent_version_id_idx").on(table.agentVersionId)]
);

export const workflowIr = pgTable(
  "workflow_ir",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentVersionId: uuid("agent_version_id").notNull().references(() => agentVersions.id, { onDelete: "cascade" }),
    schemaVersion: text("schema_version").notNull(),
    ir: jsonb("ir").notNull().$type<Record<string, unknown>>(),
    createdAt: now()
  },
  (table) => [index("workflow_ir_agent_version_id_idx").on(table.agentVersionId)]
);

export const nodeTypes = pgTable("node_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  category: text("category").notNull().default("custom"),
  builtIn: boolean("built_in").notNull().default(false),
  createdAt: now(),
  updatedAt: updatedAt()
});

export const nodeTypeVersions = pgTable(
  "node_type_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeTypeId: uuid("node_type_id").notNull().references(() => nodeTypes.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definition: jsonb("definition").notNull().$type<Record<string, unknown>>(),
    inputSchema: jsonb("input_schema").notNull().default({}).$type<Record<string, unknown>>(),
    outputSchema: jsonb("output_schema").notNull().default({}).$type<Record<string, unknown>>(),
    runtime: jsonb("runtime").notNull().default({}).$type<Record<string, unknown>>(),
    createdAt: now(),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("node_type_versions_node_type_version_idx").on(table.nodeTypeId, table.version),
    index("node_type_versions_node_type_id_idx").on(table.nodeTypeId)
  ]
);

export const scheduledRuns = pgTable(
  "scheduled_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    agentVersionId: uuid("agent_version_id").references(() => agentVersions.id, { onDelete: "set null" }),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    input: jsonb("input").notNull().default({}).$type<Record<string, unknown>>(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt()
  },
  (table) => [index("scheduled_runs_next_run_at_idx").on(table.enabled, table.nextRunAt)]
);

export const webhookTriggers = pgTable(
  "webhook_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    agentVersionId: uuid("agent_version_id").references(() => agentVersions.id, { onDelete: "set null" }),
    slug: text("slug").notNull().unique(),
    secretRecordId: uuid("secret_record_id").references(() => secretRecords.id, { onDelete: "set null" }),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonb("config").notNull().default({}).$type<Record<string, unknown>>(),
    createdAt: now(),
    updatedAt: updatedAt()
  },
  (table) => [index("webhook_triggers_agent_id_idx").on(table.agentId)]
);

export const runnerRegistrations = pgTable("runner_registrations", {
  runnerId: text("runner_id").primaryKey(),
  displayName: text("display_name"),
  status: runnerStatus("status").notNull().default("online"),
  capabilities: jsonb("capabilities").notNull().default({}).$type<Record<string, unknown>>(),
  metadata: jsonb("metadata").notNull().default({}).$type<Record<string, unknown>>(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: now(),
  updatedAt: updatedAt()
}, (table) => [index("runner_registrations_status_heartbeat_idx").on(table.status, table.lastHeartbeatAt)]);

export const runJobs = pgTable(
  "run_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    status: runJobStatus("status").notNull().default("queued"),
    scheduledRunId: uuid("scheduled_run_id").references(() => scheduledRuns.id, { onDelete: "set null" }),
    webhookTriggerId: uuid("webhook_trigger_id").references(() => webhookTriggers.id, { onDelete: "set null" }),
    payload: jsonb("payload").notNull().default({}).$type<Record<string, unknown>>(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt()
  },
  (table) => [index("run_jobs_status_available_at_idx").on(table.status, table.availableAt)]
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    agentVersionId: uuid("agent_version_id").references(() => agentVersions.id, { onDelete: "set null" }),
    runJobId: uuid("run_job_id").references(() => runJobs.id, { onDelete: "set null" }),
    status: runStatus("status").notNull().default("queued"),
    input: jsonb("input").notNull().default({}).$type<Record<string, unknown>>(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("runs_agent_id_idx").on(table.agentId),
    index("runs_status_created_at_idx").on(table.status, table.createdAt)
  ]
);

export const runEvents = pgTable(
  "run_events",
  {
    id: serial("id").primaryKey(),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    nodeId: text("node_id"),
    nodeInfo: jsonb("node_info").notNull().default({}).$type<Record<string, unknown>>(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    payload: jsonb("payload").notNull().default({}).$type<Record<string, unknown>>(),
    createdAt: now()
  },
  (table) => [
    uniqueIndex("run_events_run_sequence_idx").on(table.runId, table.sequence),
    index("run_events_run_id_idx").on(table.runId)
  ]
);

export const runLogs = pgTable(
  "run_logs",
  {
    id: serial("id").primaryKey(),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    level: logLevel("level").notNull().default("info"),
    message: text("message").notNull(),
    metadata: jsonb("metadata").notNull().default({}).$type<Record<string, unknown>>(),
    createdAt: now()
  },
  (table) => [
    uniqueIndex("run_logs_run_sequence_idx").on(table.runId, table.sequence),
    index("run_logs_run_id_idx").on(table.runId)
  ]
);

export const humanApprovals = pgTable(
  "human_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    nodeId: text("node_id"),
    status: approvalStatus("status").notNull().default("pending"),
    prompt: jsonb("prompt").notNull().$type<Record<string, unknown>>(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by")
  },
  (table) => [index("human_approvals_run_id_idx").on(table.runId), index("human_approvals_status_idx").on(table.status)]
);

export const evaluationTestCases = pgTable(
  "evaluation_test_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    input: jsonb("input").notNull().$type<Record<string, unknown>>(),
    expected: jsonb("expected").notNull().default({}).$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").notNull().default({}).$type<Record<string, unknown>>(),
    createdAt: now(),
    updatedAt: updatedAt()
  },
  (table) => [index("evaluation_test_cases_agent_id_idx").on(table.agentId)]
);

export const evaluationTestRuns = pgTable(
  "evaluation_test_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    testCaseId: uuid("test_case_id").notNull().references(() => evaluationTestCases.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    status: evalRunStatus("status").notNull().default("queued"),
    result: jsonb("result").notNull().default({}).$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: updatedAt()
  },
  (table) => [index("evaluation_test_runs_test_case_id_idx").on(table.testCaseId)]
);

export const schema = {
  appConfig,
  secretRecords,
  agents,
  agentVersions,
  workflowGraphs,
  workflowIr,
  nodeTypes,
  nodeTypeVersions,
  scheduledRuns,
  webhookTriggers,
  runnerRegistrations,
  runJobs,
  runs,
  runEvents,
  runLogs,
  humanApprovals,
  evaluationTestCases,
  evaluationTestRuns
};

export type AppConfig = typeof appConfig.$inferSelect;
export type SecretRecord = typeof secretRecords.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type WorkflowGraph = typeof workflowGraphs.$inferSelect;
export type WorkflowIr = typeof workflowIr.$inferSelect;
export type NodeType = typeof nodeTypes.$inferSelect;
export type NodeTypeVersion = typeof nodeTypeVersions.$inferSelect;
export type RunJob = typeof runJobs.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
export type RunLog = typeof runLogs.$inferSelect;
export type HumanApproval = typeof humanApprovals.$inferSelect;
export type ScheduledRun = typeof scheduledRuns.$inferSelect;
export type WebhookTrigger = typeof webhookTriggers.$inferSelect;
export type RunnerRegistration = typeof runnerRegistrations.$inferSelect;
export type EvaluationTestCase = typeof evaluationTestCases.$inferSelect;
export type EvaluationTestRun = typeof evaluationTestRuns.$inferSelect;
