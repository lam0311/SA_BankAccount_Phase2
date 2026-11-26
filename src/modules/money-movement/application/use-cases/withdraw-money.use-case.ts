import { Money } from '../../../../common/domain/value-objects/money.value-object';
import {
  UnitOfWorkPort,
  TransactionExecutionResult,
} from '../ports/unit-of-work.port';
import type {
  BalanceReservationPort,
  ReserveResult,
  WithdrawSettlementPort,
} from '../ports/balance-reservation.port';
import {
  AccountNotFoundError,
  AccountClosedError,
  InsufficientFundsError,
  IdempotencyKeyReusedError,
} from '../../domain/errors';

export interface WithdrawMoneyCommand {
  accountId: string;
  userId: string;
  amount: string;
  idempotencyKey?: string;
  description?: string;
}

const MAX_INIT_WAIT_ATTEMPTS = 20;
const INIT_WAIT_MS = 15;

export class WithdrawMoneyUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly reservation?: BalanceReservationPort,
    private readonly settlement?: WithdrawSettlementPort,
  ) {}

  async execute(command: WithdrawMoneyCommand): Promise<TransactionExecutionResult> {
    const withdrawMoney = Money.fromString(command.amount, { allowZero: false });
    const description = command.description ?? null;

    let reserved = false;
    let needSync = false;
    let holdingInitLock = false;

    if (this.reservation) {
      let check = await this.reservation.reserveDebit(
        command.accountId,
        command.userId,
        command.amount,
        command.idempotencyKey,
        description,
      );

      // khi nhieu luong cung gap miss lan dau, chi 1 luong duoc giu khoa de doc db va nap redis
      if (check.status === 'MISS' && this.reservation.acquireInitLock) {
        const waited = await this.waitForCacheInit(command, description);
        check = waited.check;
        holdingInitLock = waited.holdingInitLock;
      }

      if (check.status === 'NOT_OWNER') throw new AccountNotFoundError();
      if (check.status === 'CLOSED') throw new AccountClosedError();
      if (check.status === 'INSUFFICIENT_FUNDS') throw new InsufficientFundsError();

      if (check.status === 'REPLAY' && check.replayedTransaction) {
        const cached = check.replayedTransaction;
        const samePayload =
          Money.fromString(String(cached.amount)).equals(withdrawMoney) &&
          (cached.description ?? null) === description;
        if (!samePayload) throw new IdempotencyKeyReusedError();
        return { transaction: cached, isReplay: true };
      }

      if (check.status === 'OK' && check.queuedTransaction) {
        if (check.queuedTransaction.balanceAfter === '0') {
          await this.settlement?.flush();
        }
        return { transaction: check.queuedTransaction, isReplay: false };
      }

      if (check.status === 'OK') reserved = true;
      if (check.status === 'MISS') needSync = true;
    }

    try {
      const result = await this.unitOfWork.execute(async (ctx) => {
        const account = await ctx.accounts.lockForUpdate(command.accountId);
        if (!account || account.userId !== command.userId) {
          throw new AccountNotFoundError();
        }

        if (command.idempotencyKey) {
          const existingTx = await ctx.transactions.findByAccountAndIdempotencyKey(
            command.accountId,
            command.idempotencyKey,
          );
          if (existingTx) {
            const samePayload =
              existingTx.transactionType === 'DEBIT' &&
              Money.fromString(String(existingTx.amount)).equals(withdrawMoney) &&
              (existingTx.description ?? null) === description;

            if (!samePayload) throw new IdempotencyKeyReusedError();
            return { transaction: existingTx, isReplay: true };
          }
        }

        if (account.status === 'CLOSED') {
          throw new AccountClosedError();
        }

        const currentMoney = Money.fromString(account.currentBalance);
        if (!currentMoney.isGreaterThanOrEqual(withdrawMoney)) {
          throw new InsufficientFundsError();
        }

        const newBalance = currentMoney.subtract(withdrawMoney).toDecimalString();
        await ctx.accounts.updateBalance(account.id, newBalance);
        const transaction = await ctx.transactions.create({
          accountId: account.id,
          transactionType: 'DEBIT',
          referenceType: 'CASH_WITHDRAWAL',
          amount: command.amount,
          balanceAfter: newBalance,
          description,
          idempotencyKey: command.idempotencyKey ?? null,
        });

        return { transaction, isReplay: false };
      });

      if (result.isReplay && reserved) {
        await this.reservation?.releaseDebit(command.accountId, command.amount);
      }

      if (!result.isReplay && this.reservation) {
        if (command.idempotencyKey) {
          await this.reservation.markIdempotencyKey(command.accountId, command.idempotencyKey);
        }
        if (needSync) {
          await this.reservation.seedAccount({
            accountId: command.accountId,
            userId: command.userId,
            status: 'ACTIVE',
            balance: result.transaction.balanceAfter,
          });
        }
      }

      return result;
    } catch (error) {
      if (reserved) {
        await this.reservation?.releaseDebit(command.accountId, command.amount);
      }
      throw error;
    } finally {
      if (holdingInitLock) {
        await this.reservation?.releaseInitLock?.(command.accountId);
      }
    }
  }

  private async waitForCacheInit(
    command: WithdrawMoneyCommand,
    description: string | null,
  ): Promise<{ check: ReserveResult; holdingInitLock: boolean }> {
    let check: ReserveResult = { status: 'MISS' };

    for (let i = 0; i < MAX_INIT_WAIT_ATTEMPTS; i++) {
      const gotLock = await this.reservation!.acquireInitLock!(command.accountId);
      if (gotLock) {
        return { check: { status: 'MISS' }, holdingInitLock: true };
      }

      await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
      check = await this.reservation!.reserveDebit(
        command.accountId,
        command.userId,
        command.amount,
        command.idempotencyKey,
        description,
      );

      if (check.status !== 'MISS') {
        return { check, holdingInitLock: false };
      }
    }

    return { check, holdingInitLock: false };
  }
}
