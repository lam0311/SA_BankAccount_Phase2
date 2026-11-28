import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorDetail, ServiceUnavailableError } from '@src/common/domain/errors';
import { MultiLevelCacheService } from '@src/infrastructure/cache/multi-level-cache.service';
import { PrismaService } from '@src/infrastructure/prisma';
import { BcryptPasswordHasher } from '@src/modules/identity/infrastructure/security/bcrypt-password-hasher';
import {
  type ComponentHealthStatus,
  OUTBOX_HEALTH_INDICATOR,
  type OutboxHealthIndicatorPort,
  type OutboxHealthStatus,
} from './ports/outbox-health.port';

export interface LatencyComponentHealth {
  readonly status: ComponentHealthStatus;
  readonly latencyMs: number;
}

export interface PiscinaComponentHealth {
  readonly status: ComponentHealthStatus;
  readonly inFlight: number;
  readonly queued: number;
  readonly maxThreads: number;
  readonly maxQueue: number;
  readonly currentLimit: number;
}

export interface HealthCheckReport {
  readonly status: 'OK' | 'DEGRADED';
  readonly timestamp: string;
  readonly uptimeSeconds: number;
  readonly checks: {
    readonly postgres: LatencyComponentHealth;
    readonly redis: LatencyComponentHealth;
    readonly piscina: PiscinaComponentHealth;
    readonly outbox: OutboxHealthStatus;
  };
}

const DEFAULT_DB_TIMEOUT_MS = 2000;
const DEFAULT_REDIS_TIMEOUT_MS = 1500;
const DEFAULT_OUTBOX_TIMEOUT_MS = 1500;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: MultiLevelCacheService,
    private readonly bcryptHasher: BcryptPasswordHasher,
    @Inject(OUTBOX_HEALTH_INDICATOR)
    private readonly outboxIndicator: OutboxHealthIndicatorPort,
  ) {}

  async check(): Promise<HealthCheckReport> {
    const [postgres, redis, piscina, outbox] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
      Promise.resolve(this.checkPiscina()),
      this.outboxIndicator.check(DEFAULT_OUTBOX_TIMEOUT_MS),
    ]);

    if (postgres.status === 'DOWN' || piscina.status === 'DOWN') {
      const details: ErrorDetail[] = [];
      if (postgres.status === 'DOWN') {
        details.push({ field: 'postgres', reason: 'down' });
      }
      if (piscina.status === 'DOWN') {
        details.push({ field: 'piscina', reason: 'down' });
      }
      if (redis.status !== 'OK') {
        details.push({ field: 'redis', reason: redis.status.toLowerCase() });
      }
      if (outbox.status !== 'OK') {
        details.push({ field: 'outbox', reason: outbox.status.toLowerCase() });
      }

      this.logger.error(
        `Health check CRITICAL failure: postgres=${postgres.status}, piscina=${piscina.status}, redis=${redis.status}, outbox=${outbox.status}`,
      );
      throw new ServiceUnavailableError('System health check failed', details);
    }

    const isDegraded =
      redis.status !== 'OK' ||
      piscina.status !== 'OK' ||
      outbox.status !== 'OK';

    return {
      status: isDegraded ? 'DEGRADED' : 'OK',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      checks: {
        postgres,
        redis,
        piscina,
        outbox,
      },
    };
  }

  private async checkPostgres(): Promise<LatencyComponentHealth> {
    const start = performance.now();
    let timer: NodeJS.Timeout | null = null;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('PostgreSQL ping timeout')),
          DEFAULT_DB_TIMEOUT_MS,
        );
        timer.unref();
      });

      await Promise.race([
        this.prisma.$queryRaw(Prisma.sql`SELECT 1`),
        timeoutPromise,
      ]);

      return {
        status: 'OK',
        latencyMs: Number((performance.now() - start).toFixed(2)),
      };
    } catch (error) {
      this.logger.warn(
        `PostgreSQL health check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return {
        status: 'DOWN',
        latencyMs: Number((performance.now() - start).toFixed(2)),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async checkRedis(): Promise<LatencyComponentHealth> {
    const result = await this.cache.ping(DEFAULT_REDIS_TIMEOUT_MS);
    return {
      status: result.ok ? 'OK' : 'DEGRADED',
      latencyMs: result.latencyMs,
    };
  }

  private checkPiscina(): PiscinaComponentHealth {
    const metrics = this.bcryptHasher.getMetrics();

    let status: ComponentHealthStatus = 'OK';
    if (metrics.isDestroyed) {
      status = 'DOWN';
    } else if (metrics.queued >= metrics.maxQueue) {
      status = 'DEGRADED';
    }

    return {
      status,
      inFlight: metrics.inFlight,
      queued: metrics.queued,
      maxThreads: metrics.maxThreads,
      maxQueue: metrics.maxQueue,
      currentLimit: metrics.currentLimit,
    };
  }
}
