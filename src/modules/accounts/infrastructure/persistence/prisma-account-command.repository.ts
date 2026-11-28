import { randomInt } from 'node:crypto';
import { Injectable, Optional } from '@nestjs/common';
import {
  Prisma,
  type BankAccount as PrismaBankAccount,
} from '@prisma/client';
import { Money } from '@src/common/domain/value-objects/money.value-object';
import {
  ACCOUNT_EVENTS,
  type AccountBalanceChangedEventPayload,
  type AccountClosedEventPayload,
  type AccountOpenedEventPayload,
} from '@src/common/events';
import { OutboxService } from '@src/infrastructure/outbox';
import { PrismaService } from '@src/infrastructure/prisma/prisma.service';

import { AccountAlreadyClosedError } from '../../domain/errors/account-closed.error';
import type {
  AccountCommandRepositoryPort,
  CreateAccountInput,
} from '../../application/ports/account-command.repository.port';
import type { BankAccount } from '../../domain/entities/bank-account.entity';

const MAX_NUMBER_ATTEMPTS = 5;

function generateAccountNumber(): string {
  return randomInt(0, 1_000_000_000_000).toString().padStart(12, '0');
}

function isAccountNumberConflict(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return false;
  }

  const target = error.meta?.target;
  const targetText = Array.isArray(target)
    ? target.map(String).join(',')
    : String(target ?? '');

  return (
    targetText.includes('account_number') ||
    targetText.includes('accountNumber')
  );
}

@Injectable()
export class PrismaAccountCommandRepository
  implements AccountCommandRepositoryPort
{
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly outbox?: OutboxService,
  ) {}

  async createWithOpeningDeposit(
    input: CreateAccountInput,
  ): Promise<BankAccount> {
    const amount = input.initialDeposit.toDecimalString();

    for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt += 1) {
      const accountNumber = generateAccountNumber();

      try {
        const { account, outboxEvent } = await this.prisma.$transaction(
          async (tx) => {
            const record = await tx.bankAccount.create({
              data: {
                user: { connect: { id: input.userId } },
                accountNumber,
                accountName: input.accountName,
                accountType: input.accountType,
                currentBalance: amount,
                currency: 'VND',
                status: 'ACTIVE',
              },
            });

            if (input.initialDeposit.isPositive()) {
              await tx.financialTransaction.create({
                data: {
                  account: { connect: { id: record.id } },
                  transactionType: 'CREDIT',
                  referenceType: 'OPENING_DEPOSIT',
                  amount,
                  balanceAfter: amount,
                  status: 'COMPLETED',
                },
              });
            }

            const eventRecord =
              await OutboxService.recordInTransaction<AccountOpenedEventPayload>(
                tx,
                {
                  aggregateType: 'BankAccount',
                  aggregateId: record.id,
                  eventType: ACCOUNT_EVENTS.OPENED,
                  payload: {
                    accountId: record.id,
                    userId: record.userId,
                    accountNumber: record.accountNumber,
                  },
                },
              );

            return {
              account: this.toDomain(record),
              outboxEvent: eventRecord,
            };
          },
        );

        if (outboxEvent && this.outbox) {
          await this.outbox.dispatchCommitted([outboxEvent]);
        }

        return account;
      } catch (error) {
        if (
          isAccountNumberConflict(error) &&
          attempt < MAX_NUMBER_ATTEMPTS - 1
        ) {
          continue;
        }

        throw error;
      }
    }

    throw new Error('Could not generate a unique account number');
  }

  async findById(id: string): Promise<BankAccount | null> {
    const record = await this.prisma.bankAccount.findUnique({
      where: { id },
    });

    return record === null ? null : this.toDomain(record);
  }

  async closeIfZeroBalance(id: string, userId: string): Promise<boolean> {
    const { closed, outboxEvent } = await this.prisma.$transaction(
      async (tx) => {
        const result = await tx.bankAccount.updateMany({
          where: {
            id,
            userId,
            status: 'ACTIVE',
            currentBalance: 0,
          },
          data: {
            status: 'CLOSED',
            closedAt: new Date(),
          },
        });

        if (result.count !== 1) {
          return { closed: false, outboxEvent: null };
        }

        const closedRow = await tx.bankAccount.findUniqueOrThrow({
          where: { id },
          select: {
            id: true,
            userId: true,
            accountNumber: true,
          },
        });

        const eventRecord =
          await OutboxService.recordInTransaction<AccountClosedEventPayload>(
            tx,
            {
              aggregateType: 'BankAccount',
              aggregateId: closedRow.id,
              eventType: ACCOUNT_EVENTS.CLOSED,
              payload: {
                accountId: closedRow.id,
                userId: closedRow.userId,
                accountNumber: closedRow.accountNumber,
              },
            },
          );

        return {
          closed: true,
          outboxEvent: eventRecord,
        };
      },
    );

    if (closed && outboxEvent && this.outbox) {
      await this.outbox.dispatchCommitted([outboxEvent]);
    }

    return closed;
  }

  // doi trang thai tai khoan va ghi outbox de xoa cache doc
  async updateStatus(
    id: string,
    userId: string,
    fromStatus: 'ACTIVE' | 'FROZEN',
    toStatus: 'ACTIVE' | 'FROZEN',
  ): Promise<BankAccount | null> {
    const { account, outboxEvent } = await this.prisma.$transaction(
      async (tx) => {
        const result = await tx.bankAccount.updateMany({
          where: { id, userId, status: fromStatus },
          data: { status: toStatus },
        });

        if (result.count !== 1) {
          return { account: null, outboxEvent: null };
        }

        const updatedRow = await tx.bankAccount.findUniqueOrThrow({
          where: { id },
        });

        // ghi outbox de subscriber tu dong xoa cache L1/L2 sau khi commit
        const eventRecord =
          await OutboxService.recordInTransaction<AccountBalanceChangedEventPayload>(
            tx,
            {
              aggregateType: 'BankAccount',
              aggregateId: updatedRow.id,
              eventType: ACCOUNT_EVENTS.BALANCE_CHANGED,
              payload: {
                accounts: [
                  {
                    accountId: updatedRow.id,
                    userId: updatedRow.userId,
                    accountNumber: updatedRow.accountNumber,
                  },
                ],
              },
            },
          );

        return { account: this.toDomain(updatedRow), outboxEvent: eventRecord };
      },
    );

    if (account && outboxEvent && this.outbox) {
      await this.outbox.dispatchCommitted([outboxEvent]);
    }

    return account;
  }

  private toDomain(record: PrismaBankAccount): BankAccount {
    if (record.currency !== 'VND') {
      throw new Error('Unsupported account currency');
    }

    return {
      id: record.id,
      userId: record.userId,
      accountNumber: record.accountNumber,
      accountName: record.accountName,
      accountType: record.accountType,
      currentBalance: Money.fromString(record.currentBalance.toString()),
      currency: record.currency,
      status: record.status,
      createdAt: record.createdAt,
      closedAt: record.closedAt,
    };
  }
}
