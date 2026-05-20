export type HealthStatus = "ok" | "degraded" | "down";

export interface ServiceHealth {
  readonly service: string;
  readonly status: HealthStatus;
}

export function createHealth(service: string, status: HealthStatus = "ok"): ServiceHealth {
  return { service, status };
}
