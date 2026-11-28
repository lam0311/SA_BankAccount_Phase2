export const OUTBOX_HEALTH_INDICATOR = Symbol('OUTBOX_HEALTH_INDICATOR');

export type ComponentHealthStatus = 'OK' | 'DEGRADED' | 'DOWN';

export interface OutboxHealthStatus {
  readonly status: ComponentHealthStatus;
  readonly pendingCount: number;
  readonly lagMs: number;
}

export interface OutboxHealthIndicatorPort {
  check(timeoutMs?: number): Promise<OutboxHealthStatus>;
}
