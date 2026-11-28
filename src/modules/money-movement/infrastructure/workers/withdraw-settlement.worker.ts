import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import {
  ACCOUNT_EVENTS,
  type AccountBalanceChangedEventPayload,
  type AccountIdentityPayload,
} from "@src/common/events";
import { OutboxService } from "@src/infrastructure/outbox";
import { PrismaService } from "@src/infrastructure/prisma";
import {
  BALANCE_RESERVATION,
  type BalanceReservationPort,
  type QueuedWithdrawalItem,
  type WithdrawSettlementPort,
} from "../../application/ports/balance-reservation.port";

const FLUSH_INTERVAL_MS = 50;
const MAX_BATCH_SIZE = 100;

@Injectable()
export class WithdrawSettlementWorker
  implements WithdrawSettlementPort, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WithdrawSettlementWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private activeFlush: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BALANCE_RESERVATION)
    private readonly reservation: BalanceReservationPort,
    @Optional()
    private readonly outbox?: OutboxService,
  ) {}

  onModuleInit(): void {
    // cu moi 50ms tu dong kiem tra va ghi cac lenh rut dang cho xuong postgres
    this.timer = setInterval(() => {
      if (this.activeFlush) return;
      void this.flush().catch((err) => {
        this.logger.error(`loi khi worker ghi so cai nen: ${(err as Error).message}`);
      });
    }, FLUSH_INTERVAL_MS);

    // tranh giu tien trinh node khi chay test
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // xa not cac lenh con trong hang doi truoc khi tat app
    await this.flush();
  }

  async flush(): Promise<number> {
    // doi tuan tu neu dang co dot ghi nen chay, tranh nhieu luong cung chay drainQueue
    while (this.activeFlush) {
      await this.activeFlush.catch(() => undefined);
    }

    const current = this.drainQueue();
    this.activeFlush = current;
    try {
      return await current;
    } finally {
      if (this.activeFlush === current) {
        this.activeFlush = null;
      }
    }
  }

  private async drainQueue(): Promise<number> {
    if (!this.reservation.popSettlementBatch) return 0;

    let totalSettled = 0;

    while (true) {
      const batch = await this.reservation.popSettlementBatch(MAX_BATCH_SIZE);
      if (batch.length === 0) break;

      try {
        await this.persistBatch(batch);
        totalSettled += batch.length;
      } catch (err) {
        this.logger.error(`ghi lo ${batch.length} lenh rut that bai, tra lai hang doi: ${(err as Error).message}`);
        await this.reservation.requeueSettlementBatch?.(batch);
        throw err;
      }

      if (batch.length < MAX_BATCH_SIZE) break;
    }

    return totalSettled;
  }

  private async persistBatch(batch: QueuedWithdrawalItem[]): Promise<void> {
    // gom tong tien can tru theo tung tai khoan
    const debitByAccount = new Map<string, bigint>();
    for (const item of batch) {
      const prev = debitByAccount.get(item.accountId) ?? 0n;
      debitByAccount.set(item.accountId, prev + BigInt(item.amount));
    }

    // sap xep accountId tang dan de tranh deadlock khi cap nhat nhieu tai khoan cung luc
    const sortedAccountIds = Array.from(debitByAccount.keys()).sort();

    const outboxEvent = await this.prisma.$transaction(async (tx) => {
      const touchedAccounts: AccountIdentityPayload[] = [];

      for (const accountId of sortedAccountIds) {
        const totalDebit = debitByAccount.get(accountId)!.toString();
        const updated = await tx.bankAccount.update({
          where: { id: accountId },
          data: {
            currentBalance: {
              decrement: totalDebit,
            },
          },
          select: {
            id: true,
            userId: true,
            accountNumber: true,
          },
        });

        touchedAccounts.push({
          accountId: updated.id,
          userId: updated.userId,
          accountNumber: updated.accountNumber,
        });
      }

      // chen toan bo bang sao ke trong 1 cau sql duy nhat
      await tx.financialTransaction.createMany({
        data: batch.map((item) => ({
          id: item.id,
          accountId: item.accountId,
          transferId: null,
          transactionType: "DEBIT",
          referenceType: "CASH_WITHDRAWAL",
          amount: item.amount,
          balanceAfter: item.balanceAfter,
          status: "COMPLETED",
          description: item.description,
          idempotencyKey: item.idempotencyKey,
          createdAt: new Date(item.createdAt),
        })),
        skipDuplicates: true,
      });

      if (touchedAccounts.length === 0) return null;

      return OutboxService.recordInTransaction<AccountBalanceChangedEventPayload>(tx, {
        aggregateType: "BankAccount",
        aggregateId: touchedAccounts[0].accountId,
        eventType: ACCOUNT_EVENTS.BALANCE_CHANGED,
        payload: { accounts: touchedAccounts },
      });
    });

    if (outboxEvent && this.outbox) {
      await this.outbox.dispatchCommitted([outboxEvent]);
    }
  }
}
