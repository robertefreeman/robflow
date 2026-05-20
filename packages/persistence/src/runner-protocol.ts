import type { RunJob } from "./schema.js";

export type JsonObject = Record<string, unknown>;

export interface RunnerCapabilities {
  runtime: "deterministic-adk-simulator" | "adk-live" | string;
  workflowSchemaVersions: string[];
  maxConcurrentJobs?: number;
  supportsCancellation?: boolean;
  supportsHeartbeat?: boolean;
  labels?: string[];
}

export interface QueueLease {
  jobId: string;
  runnerId: string;
  leasedAt: string;
  leaseExpiresAt: string;
  heartbeatAt: string;
}

export interface RetryBackoffPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
}

export interface QueueAdapter {
  enqueue(kind: string, payload: JsonObject, availableAt?: Date): Promise<{ id: string }>;
  lease(runnerId: string, leaseSeconds: number): Promise<RunJob | null>;
  heartbeat(jobId: string, runnerId: string): Promise<void>;
  complete(jobId: string): Promise<void>;
  fail(jobId: string, error: JsonObject): Promise<void>;
  cancel(jobId: string, reason?: JsonObject): Promise<void>;
}

export const DEFAULT_RUNNER_CAPABILITIES: RunnerCapabilities = {
  runtime: "deterministic-adk-simulator",
  workflowSchemaVersions: ["2025-01"],
  maxConcurrentJobs: 1,
  supportsCancellation: true,
  supportsHeartbeat: true,
  labels: ["local", "docker-compose"]
};

export const DEFAULT_RETRY_BACKOFF: RetryBackoffPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 30_000
};

function iso(date: Date): string {
  return date.toISOString();
}

export function createLeaseMetadata(runnerId: string, leaseSeconds: number, now = new Date()): QueueLease {
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
  return { jobId: "", runnerId, leasedAt: iso(now), leaseExpiresAt: iso(leaseExpiresAt), heartbeatAt: iso(now) };
}

export function touchLease(lease: QueueLease, leaseSeconds: number, now = new Date()): QueueLease {
  return { ...lease, heartbeatAt: iso(now), leaseExpiresAt: iso(new Date(now.getTime() + leaseSeconds * 1000)) };
}

export function shouldReclaimLease(lease: Pick<QueueLease, "leaseExpiresAt"> | undefined, now = new Date()): boolean {
  if (!lease?.leaseExpiresAt) return true;
  const expires = Date.parse(lease.leaseExpiresAt);
  return Number.isNaN(expires) || expires <= now.getTime();
}

export function nextRetryDelayMs(attempt: number, policy: RetryBackoffPolicy = DEFAULT_RETRY_BACKOFF): number {
  if (attempt < 1) return 0;
  return Math.min(policy.maxDelayMs, Math.round(policy.initialDelayMs * policy.multiplier ** (attempt - 1)));
}

export function buildDeadLetterPayload(input: { reason: string; attempts: number; lastError?: JsonObject; runnerId?: string; now?: Date }): JsonObject {
  return {
    reason: input.reason,
    attempts: input.attempts,
    lastError: input.lastError ?? {},
    runnerId: input.runnerId,
    deadLetteredAt: iso(input.now ?? new Date())
  };
}

export function cancellationRequested(runStatus: string, jobStatus: string): boolean {
  return runStatus === "canceled" || jobStatus === "canceled";
}
