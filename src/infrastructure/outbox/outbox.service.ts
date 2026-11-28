import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  EVENT_BUS,
  type EventBusPort,
  type IntegrationEvent,
} from '@src/common/events';
import { PrismaService } from '@src/infrastructure/prisma/prisma.service';

export interface EnqueueOutboxEventInput<TPayload = unknown> {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: TPayload;
}

export interface OutboxEventRecord<TPayload = unknown> {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: TPayload;
  readonly createdAt: Date;
}

type OutboxCapableTx = Prisma.TransactionClient & {
  outboxEvent?: {
    create: Prisma.OutboxEventDelegate['create'];
  };
};

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS)
    private readonly eventBus: EventBusPort,
  ) {}

  /**
   * Ghi sự kiện vào bảng `outbox_events` trong cùng một PostgreSQL transaction
   * với thay đổi dữ liệu nghiệp vụ (loại bỏ hoàn toàn lỗi Dual-Write).
   */
  static async recordInTransaction<TPayload>(
    tx: Prisma.TransactionClient,
    input: EnqueueOutboxEventInput<TPayload>,
  ): Promise<OutboxEventRecord<TPayload> | null> {
    const candidate = tx as OutboxCapableTx;
    if (!candidate.outboxEvent?.create) {
      return null;
    }

    const created = await candidate.outboxEvent.create({
      data: {
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        payload: input.payload as Prisma.InputJsonValue,
      },
    });

    return {
      id: created.id,
      aggregateType: created.aggregateType,
      aggregateId: created.aggregateId,
      eventType: created.eventType,
      payload: created.payload as TPayload,
      createdAt: created.createdAt,
    };
  }

  async enqueue<TPayload>(
    tx: Prisma.TransactionClient,
    input: EnqueueOutboxEventInput<TPayload>,
  ): Promise<OutboxEventRecord<TPayload> | null> {
    return OutboxService.recordInTransaction(tx, input);
  }

  /**
   * Phát nhanh sự kiện ngay sau khi transaction đã COMMIT để giảm độ trễ xuống ~ms.
   * Nếu Subscriber/Redis gặp lỗi tạm thời, KHÔNG làm hỏng response của giao dịch chính:
   * bản ghi vẫn giữ `processed_at = NULL` để `OutboxRelayWorker` tự động retry ở nền.
   */
  async dispatchCommitted(
    events: readonly (OutboxEventRecord | null | undefined)[],
  ): Promise<void> {
    for (const record of events) {
      if (!record) continue;
      await this.deliverRecord(record);
    }
  }

  async deliverRecord(record: OutboxEventRecord): Promise<boolean> {
    const integrationEvent: IntegrationEvent = {
      id: record.id,
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: record.createdAt.toISOString(),
    };

    try {
      await this.eventBus.publish(integrationEvent);
      await this.prisma.outboxEvent.updateMany({
        where: { id: record.id, processedAt: null },
        data: { processedAt: new Date(), lastError: null },
      });
      return true;
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : String(error ?? 'Unknown error');
      this.logger.warn(
        `Immediate outbox delivery deferred for event ${record.id} (${record.eventType}): ${reason}`,
      );

      try {
        await this.prisma.outboxEvent.updateMany({
          where: { id: record.id, processedAt: null },
          data: {
            retryCount: { increment: 1 },
            lastError: reason.slice(0, 1000),
          },
        });
      } catch (updateErr) {
        this.logger.error(
          `Failed to record retry metadata for outbox event ${record.id}: ${updateErr}`,
        );
      }
      return false;
    }
  }
}
