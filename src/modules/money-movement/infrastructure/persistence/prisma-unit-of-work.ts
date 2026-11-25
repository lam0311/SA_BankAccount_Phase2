import { Injectable, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  ACCOUNT_EVENTS,
  type AccountBalanceChangedEventPayload,
  type AccountIdentityPayload,
} from "@src/common/events";
import { OutboxService } from "@src/infrastructure/outbox";
import { PrismaService } from "@src/infrastructure/prisma";
import {
  AccountSnapshot,
  CreateTransactionEntryInput,
  CreateTransferInput,
  MoneyMovementTransactionContext,
  TransactionEntryRecord,
  TransferRecord,
  UnitOfWorkPort,
} from "../../application/ports/unit-of-work.port";

type PrismaTx = Prisma.TransactionClient;

interface RawAccountLockRow {
  id: string;
  userId: string;
  accountNumber: string;
  currentBalance: string;
  status: "ACTIVE" | "CLOSED";
}

@Injectable()
export class PrismaUnitOfWork implements UnitOfWorkPort {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly outbox?: OutboxService,
  ) {}

  async execute<T>(
    work: (ctx: MoneyMovementTransactionContext) => Promise<T>,
  ): Promise<T> {
    const knownAccounts = new Map<string, AccountIdentityPayload>();
    const touchedAccountIds = new Set<string>();

    const { data, outboxEvent } = await this.prisma.$transaction(async (tx) => {
      const ctx = this.buildContext(tx, knownAccounts, touchedAccountIds);
      const result = await work(ctx);

      if (touchedAccountIds.size === 0) {
        return { data: result, outboxEvent: null };
      }

      const accounts = await this.resolveTouchedAccounts(
        tx,
        touchedAccountIds,
        knownAccounts,
      );

      const eventRecord =
        await OutboxService.recordInTransaction<AccountBalanceChangedEventPayload>(
          tx,
          {
            aggregateType: "BankAccount",
            aggregateId: accounts[0].accountId,
            eventType: ACCOUNT_EVENTS.BALANCE_CHANGED,
            payload: { accounts },
          },
        );

      return { data: result, outboxEvent: eventRecord };
    });

    if (outboxEvent && this.outbox) {
      await this.outbox.dispatchCommitted([outboxEvent]);
    }

    return data;
  }

  private async resolveTouchedAccounts(
    tx: PrismaTx,
    touchedAccountIds: Set<string>,
    knownAccounts: Map<string, AccountIdentityPayload>,
  ): Promise<AccountIdentityPayload[]> {
    const missingIds = Array.from(touchedAccountIds).filter(
      (id) => !knownAccounts.has(id),
    );

    if (
      missingIds.length > 0 &&
      typeof tx.bankAccount?.findMany === "function"
    ) {
      const rows = await tx.bankAccount.findMany({
        where: { id: { in: missingIds } },
        select: { id: true, userId: true, accountNumber: true },
      });
      for (const row of rows) {
        knownAccounts.set(row.id, {
          accountId: row.id,
          userId: row.userId,
          accountNumber: row.accountNumber,
        });
      }
    }

    return Array.from(touchedAccountIds).map(
      (accountId) =>
        knownAccounts.get(accountId) ?? {
          accountId,
          userId: "",
          accountNumber: "",
        },
    );
  }

  private buildContext(
    tx: PrismaTx,
    knownAccounts: Map<string, AccountIdentityPayload>,
    touchedAccountIds: Set<string>,
  ): MoneyMovementTransactionContext {
    return {
      accounts: {
        lockForUpdate: async (
          accountId: string,
        ): Promise<AccountSnapshot | null> => {
          const rows = await tx.$queryRaw<RawAccountLockRow[]>(
            Prisma.sql`
              SELECT
                id,
                user_id AS "userId",
                account_number AS "accountNumber",
                current_balance::text AS "currentBalance",
                status
              FROM bank_accounts
              WHERE id = ${accountId}
              FOR UPDATE
            `,
          );
          const row = rows[0] ?? null;
          if (row) {
            knownAccounts.set(row.id, {
              accountId: row.id,
              userId: row.userId,
              accountNumber: row.accountNumber,
            });
          }
          return row;
        },

        findByAccountNumber: async (
          accountNumber: string,
        ): Promise<AccountSnapshot | null> => {
          const acc = await tx.bankAccount.findUnique({
            where: { accountNumber },
            select: {
              id: true,
              userId: true,
              currentBalance: true,
              status: true,
              accountNumber: true,
            },
          });
          if (!acc) return null;
          knownAccounts.set(acc.id, {
            accountId: acc.id,
            userId: acc.userId,
            accountNumber: acc.accountNumber,
          });
          return {
            id: acc.id,
            userId: acc.userId,
            currentBalance: acc.currentBalance.toString(),
            status: acc.status as "ACTIVE" | "CLOSED",
            accountNumber: acc.accountNumber,
          };
        },

        updateBalance: async (
          accountId: string,
          newBalance: string,
        ): Promise<void> => {
          await tx.bankAccount.update({
            where: { id: accountId },
            data: { currentBalance: newBalance },
          });
          touchedAccountIds.add(accountId);
        },
      },

      transactions: {
        findByAccountAndIdempotencyKey: async (
          accountId: string,
          idempotencyKey: string,
        ): Promise<TransactionEntryRecord | null> => {
          const record = await tx.financialTransaction.findUnique({
            where: {
              uq_transaction_idempotency: {
                accountId,
                idempotencyKey,
              },
            },
          });
          if (!record) return null;
          return {
            ...(record as unknown as TransactionEntryRecord),
            amount: record.amount.toString(),
            balanceAfter: record.balanceAfter.toString(),
          };
        },
        create: async (
          input: CreateTransactionEntryInput,
        ): Promise<TransactionEntryRecord> => {
          const record = await tx.financialTransaction.create({
            data: {
              accountId: input.accountId,
              transferId: input.transferId ?? null,
              transactionType: input.transactionType,
              referenceType: input.referenceType,
              amount: input.amount,
              balanceAfter: input.balanceAfter,
              description: input.description ?? null,
              idempotencyKey: input.idempotencyKey ?? null,
            },
          });
          return {
            ...(record as unknown as TransactionEntryRecord),
            amount: record.amount.toString(),
            balanceAfter: record.balanceAfter.toString(),
          };
        },
      },

      transfers: {
        findBySourceAndIdempotencyKey: async (
          sourceAccountId: string,
          idempotencyKey: string,
        ): Promise<TransferRecord | null> => {
          const record = await tx.transfer.findUnique({
            where: {
              uq_transfer_idempotency: {
                sourceAccountId,
                idempotencyKey,
              },
            },
          });
          return record ? (record as unknown as TransferRecord) : null;
        },

        create: async (input: CreateTransferInput): Promise<TransferRecord> => {
          const record = await tx.transfer.create({
            data: {
              sourceAccountId: input.sourceAccountId,
              destinationAccountId: input.destinationAccountId,
              initiatedByUserId: input.initiatedByUserId,
              amount: input.amount,
              description: input.description ?? null,
              idempotencyKey: input.idempotencyKey,
            },
          });
          return record as unknown as TransferRecord;
        },
      },
    };
  }
}
