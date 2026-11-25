import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  EVENT_BUS,
  type EventBusPort,
  type IntegrationEvent,
} from '@src/common/events';
import { PrismaService } from '@src/infrastructure/prisma/prisma.service';

interface RawPendingOutboxRow {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  retryCount: number;
  createdAt: Date;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_RETRIES = 50;

@Injectable()
export class OutboxRelayWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayWorker.name);
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;

  private timer: NodeJS.Timeout | null = null;
  private activePoll: Promise<number> | null = null;
  private shuttingDown = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS)
    private readonly eventBus: EventBusPort,
  ) {
    this.pollIntervalMs = parseInt(
      process.env.OUTBOX_POLL_INTERVAL_MS ?? String(DEFAULT_POLL_INTERVAL_MS),
      10,
    );
    this.batchSize = parseInt(
      process.env.OUTBOX_BATCH_SIZE ?? String(DEFAULT_BATCH_SIZE),
      10,
    );
    this.maxRetries = parseInt(
      process.env.OUTBOX_MAX_RETRIES ?? String(DEFAULT_MAX_RETRIES),
      10,
    );
  }

  onModuleInit(): void {
    if (this.pollIntervalMs <= 0) {
      return;
    }

    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activePoll) {
      await this.activePoll.catch(() => undefined);
    }
  }

  async pollOnce(): Promise<number> {
    if (this.shuttingDown) {
      return 0;
    }
    if (this.activePoll) {
      return this.activePoll;
    }

    this.activePoll = this.processBatch().finally(() => {
      this.activePoll = null;
    });
    return this.activePoll;
  }

  private async processBatch(): Promise<number> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<RawPendingOutboxRow[]>(
          Prisma.sql`
            SELECT
              id,
              aggregate_type AS "aggregateType",
              aggregate_id AS "aggregateId",
              event_type AS "eventType",
              payload,
              retry_count AS "retryCount",
              created_at AS "createdAt"
            FROM outbox_events
            WHERE processed_at IS NULL
              AND retry_count < ${this.maxRetries}
            ORDER BY created_at ASC
            LIMIT ${this.batchSize}
            FOR UPDATE SKIP LOCKED
          `,
        );

        let processedCount = 0;

        for (const row of rows) {
          if (this.shuttingDown) break;

          const event: IntegrationEvent = {
            id: row.id,
            aggregateType: row.aggregateType,
            aggregateId: row.aggregateId,
            eventType: row.eventType,
            payload: row.payload,
            occurredAt:
              row.createdAt instanceof Date
                ? row.createdAt.toISOString()
                : new Date(String(row.createdAt)).toISOString(),
          };

          try {
            await this.eventBus.publish(event);
            await tx.outboxEvent.update({
              where: { id: row.id },
              data: {
                processedAt: new Date(),
                lastError: null,
              },
            });
            processedCount += 1;
          } catch (error) {
            const reason =
              error instanceof Error
                ? error.message
                : String(error ?? 'Unknown error');
            this.logger.warn(
              `Outbox retry #${row.retryCount + 1} failed for event ${row.id} (${row.eventType}): ${reason}`,
            );
            await tx.outboxEvent.update({
              where: { id: row.id },
              data: {
                retryCount: { increment: 1 },
                lastError: reason.slice(0, 1000),
              },
            });
          }
        }

        return processedCount;
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : String(error ?? 'Unknown');
      this.logger.warn(`Outbox background poll skipped: ${reason}`);
      return 0;
    }
  }
}
