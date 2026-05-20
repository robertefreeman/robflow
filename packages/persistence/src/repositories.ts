import { and, asc, desc, eq, lt, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  agentVersions,
  agents,
  appConfig,
  evaluationTestCases,
  evaluationTestRuns,
  humanApprovals,
  nodeTypeVersions,
  nodeTypes,
  runEvents,
  runnerRegistrations,
  runJobs,
  runLogs,
  runs,
  scheduledRuns,
  schema,
  secretRecords,
  webhookTriggers,
  workflowGraphs,
  workflowIr,
  type Agent,
  type AgentVersion,
  type AppConfig,
  type EvaluationTestCase,
  type EvaluationTestRun,
  type HumanApproval,
  type NodeType,
  type NodeTypeVersion,
  type Run,
  type RunEvent,
  type RunJob,
  type RunLog,
  type RunnerRegistration,
  type ScheduledRun,
  type SecretRecord,
  type WebhookTrigger,
  type WorkflowGraph,
  type WorkflowIr
} from "./schema.js";

type Database = Pick<PgDatabase<PgQueryResultHKT, typeof schema>, "insert" | "select" | "update" | "delete">;
type JsonObject = Record<string, unknown>;

function first<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}

function nowFields() {
  return { updatedAt: new Date() };
}

export function createPersistenceRepositories(db: Database) {
  return {
    appConfig: createAppConfigRepository(db),
    secrets: createSecretRepository(db),
    agents: createAgentRepository(db),
    workflows: createWorkflowRepository(db),
    nodeTypes: createNodeTypeRepository(db),
    runners: createRunnerRepository(db),
    runs: createRunRepository(db),
    approvals: createApprovalRepository(db),
    schedules: createScheduleRepository(db),
    webhooks: createWebhookRepository(db),
    evaluations: createEvaluationRepository(db)
  };
}

export function createAppConfigRepository(db: Database) {
  return {
    async get(key: string): Promise<AppConfig | null> {
      return first(await db.select().from(appConfig).where(eq(appConfig.key, key)).limit(1));
    },
    async upsert(input: { key: string; value: JsonObject; description?: string | null }): Promise<AppConfig> {
      return first(
        await db
          .insert(appConfig)
          .values(input)
          .onConflictDoUpdate({
            target: appConfig.key,
            set: { value: input.value, description: input.description, ...nowFields() }
          })
          .returning()
      ) as AppConfig;
    },
    async list(): Promise<AppConfig[]> {
      return db.select().from(appConfig).orderBy(asc(appConfig.key));
    }
  };
}

export function createSecretRepository(db: Database) {
  return {
    async create(input: typeof secretRecords.$inferInsert): Promise<SecretRecord> {
      return first(await db.insert(secretRecords).values(input).returning()) as SecretRecord;
    },
    async get(id: string): Promise<SecretRecord | null> {
      return first(await db.select().from(secretRecords).where(eq(secretRecords.id, id)).limit(1));
    },
    async getByScopeName(scope: string, name: string): Promise<SecretRecord | null> {
      return first(
        await db.select().from(secretRecords).where(and(eq(secretRecords.scope, scope), eq(secretRecords.name, name))).limit(1)
      );
    },
    async updateCiphertext(id: string, input: { ciphertext: string; encryptionKeyRef: string; metadata?: JsonObject }): Promise<SecretRecord | null> {
      return first(
        await db
          .update(secretRecords)
          .set({ ciphertext: input.ciphertext, encryptionKeyRef: input.encryptionKeyRef, metadata: input.metadata, ...nowFields() })
          .where(eq(secretRecords.id, id))
          .returning()
      );
    }
  };
}

export function createAgentRepository(db: Database) {
  return {
    async createAgent(input: typeof agents.$inferInsert): Promise<Agent> {
      return first(await db.insert(agents).values(input).returning()) as Agent;
    },
    async getAgent(id: string): Promise<Agent | null> {
      return first(await db.select().from(agents).where(eq(agents.id, id)).limit(1));
    },
    async getAgentBySlug(slug: string): Promise<Agent | null> {
      return first(await db.select().from(agents).where(eq(agents.slug, slug)).limit(1));
    },
    async listAgents(): Promise<Agent[]> {
      return db.select().from(agents).orderBy(asc(agents.slug));
    },
    async updateAgent(id: string, input: Partial<Pick<Agent, "name" | "description" | "metadata" | "currentVersionId">>): Promise<Agent | null> {
      return first(await db.update(agents).set({ ...input, ...nowFields() }).where(eq(agents.id, id)).returning());
    },
    async createVersion(input: typeof agentVersions.$inferInsert): Promise<AgentVersion> {
      return first(await db.insert(agentVersions).values(input).returning()) as AgentVersion;
    },
    async listVersions(agentId: string): Promise<AgentVersion[]> {
      return db.select().from(agentVersions).where(eq(agentVersions.agentId, agentId)).orderBy(desc(agentVersions.version));
    },
    async getVersion(id: string): Promise<AgentVersion | null> {
      return first(await db.select().from(agentVersions).where(eq(agentVersions.id, id)).limit(1));
    },
    async setCurrentVersion(agentId: string, agentVersionId: string): Promise<Agent | null> {
      return first(await db.update(agents).set({ currentVersionId: agentVersionId, ...nowFields() }).where(eq(agents.id, agentId)).returning());
    }
  };
}

export function createWorkflowRepository(db: Database) {
  return {
    async createGraph(input: typeof workflowGraphs.$inferInsert): Promise<WorkflowGraph> {
      return first(await db.insert(workflowGraphs).values(input).returning()) as WorkflowGraph;
    },
    async latestGraph(agentVersionId: string): Promise<WorkflowGraph | null> {
      return first(
        await db.select().from(workflowGraphs).where(eq(workflowGraphs.agentVersionId, agentVersionId)).orderBy(desc(workflowGraphs.createdAt)).limit(1)
      );
    },
    async createIr(input: typeof workflowIr.$inferInsert): Promise<WorkflowIr> {
      return first(await db.insert(workflowIr).values(input).returning()) as WorkflowIr;
    },
    async latestIr(agentVersionId: string): Promise<WorkflowIr | null> {
      return first(await db.select().from(workflowIr).where(eq(workflowIr.agentVersionId, agentVersionId)).orderBy(desc(workflowIr.createdAt)).limit(1));
    }
  };
}

export function createNodeTypeRepository(db: Database) {
  return {
    async createNodeType(input: typeof nodeTypes.$inferInsert): Promise<NodeType> {
      return first(await db.insert(nodeTypes).values(input).returning()) as NodeType;
    },
    async getNodeType(id: string): Promise<NodeType | null> {
      return first(await db.select().from(nodeTypes).where(eq(nodeTypes.id, id)).limit(1));
    },
    async getBySlug(slug: string): Promise<NodeType | null> {
      return first(await db.select().from(nodeTypes).where(eq(nodeTypes.slug, slug)).limit(1));
    },
    async updateNodeType(id: string, input: Partial<typeof nodeTypes.$inferInsert>): Promise<NodeType | null> {
      return first(await db.update(nodeTypes).set({ ...input, ...nowFields() }).where(eq(nodeTypes.id, id)).returning());
    },
    async listNodeTypes(): Promise<NodeType[]> {
      return db.select().from(nodeTypes).orderBy(asc(nodeTypes.slug));
    },
    async createVersion(input: typeof nodeTypeVersions.$inferInsert): Promise<NodeTypeVersion> {
      return first(await db.insert(nodeTypeVersions).values(input).returning()) as NodeTypeVersion;
    },
    async getVersion(id: string): Promise<NodeTypeVersion | null> {
      return first(await db.select().from(nodeTypeVersions).where(eq(nodeTypeVersions.id, id)).limit(1));
    },
    async getVersionByNumber(nodeTypeId: string, version: number): Promise<NodeTypeVersion | null> {
      return first(await db.select().from(nodeTypeVersions).where(and(eq(nodeTypeVersions.nodeTypeId, nodeTypeId), eq(nodeTypeVersions.version, version))).limit(1));
    },
    async listVersions(nodeTypeId: string): Promise<NodeTypeVersion[]> {
      return db.select().from(nodeTypeVersions).where(eq(nodeTypeVersions.nodeTypeId, nodeTypeId)).orderBy(desc(nodeTypeVersions.version));
    },
    async latestVersion(nodeTypeId: string): Promise<NodeTypeVersion | null> {
      return first(
        await db.select().from(nodeTypeVersions).where(eq(nodeTypeVersions.nodeTypeId, nodeTypeId)).orderBy(desc(nodeTypeVersions.version)).limit(1)
      );
    }
  };
}

export function createRunnerRepository(db: Database) {
  return {
    async register(input: { runnerId: string; displayName?: string | null; capabilities?: JsonObject; metadata?: JsonObject; status?: RunnerRegistration["status"] }): Promise<RunnerRegistration> {
      return first(
        await db
          .insert(runnerRegistrations)
          .values({
            runnerId: input.runnerId,
            displayName: input.displayName,
            status: input.status ?? "online",
            capabilities: input.capabilities ?? {},
            metadata: input.metadata ?? {},
            lastHeartbeatAt: new Date()
          })
          .onConflictDoUpdate({
            target: runnerRegistrations.runnerId,
            set: {
              displayName: input.displayName,
              status: input.status ?? "online",
              capabilities: input.capabilities ?? {},
              metadata: input.metadata ?? {},
              lastHeartbeatAt: new Date(),
              ...nowFields()
            }
          })
          .returning()
      ) as RunnerRegistration;
    },
    async heartbeat(runnerId: string, input: { status?: RunnerRegistration["status"]; metadata?: JsonObject } = {}): Promise<RunnerRegistration | null> {
      return first(
        await db
          .update(runnerRegistrations)
          .set({ status: input.status ?? "online", metadata: input.metadata ?? {}, lastHeartbeatAt: new Date(), ...nowFields() })
          .where(eq(runnerRegistrations.runnerId, runnerId))
          .returning()
      );
    },
    async list(): Promise<RunnerRegistration[]> {
      return db.select().from(runnerRegistrations).orderBy(desc(runnerRegistrations.lastHeartbeatAt));
    },
    async listStale(cutoff: Date): Promise<RunnerRegistration[]> {
      return db.select().from(runnerRegistrations).where(lt(runnerRegistrations.lastHeartbeatAt, cutoff)).orderBy(asc(runnerRegistrations.lastHeartbeatAt));
    }
  };
}

export function createRunRepository(db: Database) {
  return {
    async enqueueJob(input: typeof runJobs.$inferInsert): Promise<RunJob> {
      return first(await db.insert(runJobs).values(input).returning()) as RunJob;
    },
    async getJob(id: string): Promise<RunJob | null> {
      return first(await db.select().from(runJobs).where(eq(runJobs.id, id)).limit(1));
    },
    async markJobHeartbeat(id: string, heartbeat: JsonObject = {}): Promise<RunJob | null> {
      const job = await first(await db.select().from(runJobs).where(eq(runJobs.id, id)).limit(1));
      if (!job) return null;
      return first(await db.update(runJobs).set({ payload: { ...job.payload, heartbeat: { ...heartbeat, touchedAt: new Date().toISOString() } }, lockedAt: new Date(), ...nowFields() }).where(eq(runJobs.id, id)).returning());
    },
    async reclaimExpiredRunningJobs(cutoff: Date): Promise<RunJob[]> {
      return db.update(runJobs).set({ status: "queued", lockedAt: null, ...nowFields() }).where(and(eq(runJobs.status, "running"), lt(runJobs.lockedAt, cutoff))).returning();
    },
    async markDeadLetter(id: string, deadLetter: JsonObject): Promise<RunJob | null> {
      const job = await first(await db.select().from(runJobs).where(eq(runJobs.id, id)).limit(1));
      if (!job) return null;
      return first(await db.update(runJobs).set({ status: "failed", payload: { ...job.payload, deadLetter: { ...deadLetter, recordedAt: new Date().toISOString() } }, ...nowFields() }).where(eq(runJobs.id, id)).returning());
    },
    async updateJobStatus(id: string, status: RunJob["status"]): Promise<RunJob | null> {
      return first(await db.update(runJobs).set({ status, ...nowFields() }).where(eq(runJobs.id, id)).returning());
    },
    async createRun(input: typeof runs.$inferInsert): Promise<Run> {
      return first(await db.insert(runs).values(input).returning()) as Run;
    },
    async updateRunStatus(id: string, input: { status: Run["status"]; output?: JsonObject | null; error?: JsonObject | null; completedAt?: Date | null }): Promise<Run | null> {
      return first(await db.update(runs).set({ ...input, ...nowFields() }).where(eq(runs.id, id)).returning());
    },
    async getRun(id: string): Promise<Run | null> {
      return first(await db.select().from(runs).where(eq(runs.id, id)).limit(1));
    },
    async listRunsForAgent(agentId: string): Promise<Run[]> {
      return db.select().from(runs).where(eq(runs.agentId, agentId)).orderBy(desc(runs.createdAt));
    },
    async listRunsForVersion(agentVersionId: string): Promise<Run[]> {
      return db.select().from(runs).where(eq(runs.agentVersionId, agentVersionId)).orderBy(desc(runs.createdAt));
    },
    async appendEvent(input: typeof runEvents.$inferInsert): Promise<RunEvent> {
      return first(await db.insert(runEvents).values(input).returning()) as RunEvent;
    },
    async appendLog(input: typeof runLogs.$inferInsert): Promise<RunLog> {
      return first(await db.insert(runLogs).values(input).returning()) as RunLog;
    },
    async listEvents(runId: string): Promise<RunEvent[]> {
      return db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.sequence));
    },
    async listLogs(runId: string): Promise<RunLog[]> {
      return db.select().from(runLogs).where(eq(runLogs.runId, runId)).orderBy(asc(runLogs.sequence));
    }
  };
}

export function createApprovalRepository(db: Database) {
  return {
    async create(input: typeof humanApprovals.$inferInsert): Promise<HumanApproval> {
      return first(await db.insert(humanApprovals).values(input).returning()) as HumanApproval;
    },
    async resolve(id: string, input: { status: HumanApproval["status"]; response?: JsonObject; resolvedBy?: string }): Promise<HumanApproval | null> {
      return first(
        await db
          .update(humanApprovals)
          .set({ ...input, resolvedAt: new Date() })
          .where(eq(humanApprovals.id, id))
          .returning()
      );
    },
    async pendingForRun(runId: string): Promise<HumanApproval[]> {
      return db.select().from(humanApprovals).where(and(eq(humanApprovals.runId, runId), eq(humanApprovals.status, "pending"))).orderBy(asc(humanApprovals.requestedAt));
    }
  };
}

export function createScheduleRepository(db: Database) {
  return {
    async create(input: typeof scheduledRuns.$inferInsert): Promise<ScheduledRun> {
      return first(await db.insert(scheduledRuns).values(input).returning()) as ScheduledRun;
    },
    async update(id: string, input: Partial<typeof scheduledRuns.$inferInsert>): Promise<ScheduledRun | null> {
      return first(await db.update(scheduledRuns).set({ ...input, ...nowFields() }).where(eq(scheduledRuns.id, id)).returning());
    },
    async listEnabled(): Promise<ScheduledRun[]> {
      return db.select().from(scheduledRuns).where(eq(scheduledRuns.enabled, true)).orderBy(asc(scheduledRuns.nextRunAt));
    },
    async listForAgent(agentId: string): Promise<ScheduledRun[]> {
      return db.select().from(scheduledRuns).where(eq(scheduledRuns.agentId, agentId)).orderBy(desc(scheduledRuns.createdAt));
    },
    async get(id: string): Promise<ScheduledRun | null> {
      return first(await db.select().from(scheduledRuns).where(eq(scheduledRuns.id, id)).limit(1));
    },
    async delete(id: string): Promise<ScheduledRun | null> {
      return first(await db.delete(scheduledRuns).where(eq(scheduledRuns.id, id)).returning());
    }
  };
}

export function createWebhookRepository(db: Database) {
  return {
    async create(input: typeof webhookTriggers.$inferInsert): Promise<WebhookTrigger> {
      return first(await db.insert(webhookTriggers).values(input).returning()) as WebhookTrigger;
    },
    async getBySlug(slug: string): Promise<WebhookTrigger | null> {
      return first(await db.select().from(webhookTriggers).where(eq(webhookTriggers.slug, slug)).limit(1));
    },
    async listForAgent(agentId: string): Promise<WebhookTrigger[]> {
      return db.select().from(webhookTriggers).where(eq(webhookTriggers.agentId, agentId)).orderBy(desc(webhookTriggers.createdAt));
    },
    async setEnabled(id: string, enabled: boolean): Promise<WebhookTrigger | null> {
      return first(await db.update(webhookTriggers).set({ enabled, ...nowFields() }).where(eq(webhookTriggers.id, id)).returning());
    },
    async update(id: string, input: Partial<typeof webhookTriggers.$inferInsert>): Promise<WebhookTrigger | null> {
      return first(await db.update(webhookTriggers).set({ ...input, ...nowFields() }).where(eq(webhookTriggers.id, id)).returning());
    }
  };
}

export function createEvaluationRepository(db: Database) {
  return {
    async createTestCase(input: typeof evaluationTestCases.$inferInsert): Promise<EvaluationTestCase> {
      return first(await db.insert(evaluationTestCases).values(input).returning()) as EvaluationTestCase;
    },
    async getTestCase(id: string): Promise<EvaluationTestCase | null> {
      return first(await db.select().from(evaluationTestCases).where(eq(evaluationTestCases.id, id)).limit(1));
    },
    async listTestCases(agentId: string): Promise<EvaluationTestCase[]> {
      return db.select().from(evaluationTestCases).where(eq(evaluationTestCases.agentId, agentId)).orderBy(asc(evaluationTestCases.name));
    },
    async updateTestCase(id: string, input: Partial<Pick<EvaluationTestCase, "name" | "input" | "expected" | "metadata">>): Promise<EvaluationTestCase | null> {
      return first(await db.update(evaluationTestCases).set({ ...input, ...nowFields() }).where(eq(evaluationTestCases.id, id)).returning());
    },
    async deleteTestCase(id: string): Promise<EvaluationTestCase | null> {
      return first(await db.delete(evaluationTestCases).where(eq(evaluationTestCases.id, id)).returning());
    },
    async createTestRun(input: typeof evaluationTestRuns.$inferInsert): Promise<EvaluationTestRun> {
      return first(await db.insert(evaluationTestRuns).values(input).returning()) as EvaluationTestRun;
    },
    async getTestRun(id: string): Promise<EvaluationTestRun | null> {
      return first(await db.select().from(evaluationTestRuns).where(eq(evaluationTestRuns.id, id)).limit(1));
    },
    async listTestRuns(testCaseId: string, limit = 20): Promise<EvaluationTestRun[]> {
      return db.select().from(evaluationTestRuns).where(eq(evaluationTestRuns.testCaseId, testCaseId)).orderBy(desc(evaluationTestRuns.createdAt)).limit(limit);
    },
    async updateTestRun(id: string, input: Partial<Pick<EvaluationTestRun, "status" | "result" | "runId" | "startedAt" | "completedAt">>): Promise<EvaluationTestRun | null> {
      return first(await db.update(evaluationTestRuns).set({ ...input, ...nowFields() }).where(eq(evaluationTestRuns.id, id)).returning());
    }
  };
}

export function andWhere(...conditions: Array<SQL | undefined>): SQL | undefined {
  const defined = conditions.filter((condition): condition is SQL => Boolean(condition));
  return defined.length === 0 ? undefined : and(...defined);
}
