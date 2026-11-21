import { Money } from '../../../../common/domain/value-objects/money.value-object';
import { ValidationError } from '../../../../common/domain/errors/common.errors';
import {
  UnitOfWorkPort,
  TransactionExecutionResult,
} from '../ports/unit-of-work.port';
import {
  AccountNotFoundError,
  AccountClosedError,
  IdempotencyKeyReusedError,
} from '../../domain/errors';

export interface DepositMoneyCommand {
  accountId: string;
  userId: string;
  amount: string;
  idempotencyKey?: string;
  description?: string;
}

const MAX_VND = 999_999_999_999_999_999n;

export class DepositMoneyUseCase {
  constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  async execute(command: DepositMoneyCommand): Promise<TransactionExecutionResult> {
    return this.unitOfWork.execute(async (ctx) => {
      const account = await ctx.accounts.lockForUpdate(command.accountId);
      if (!account || account.userId !== command.userId) {
        throw new AccountNotFoundError();
      }

      const depositMoney = Money.fromString(command.amount, { allowZero: false });
      const normalizedDescription = command.description ?? null;

      if (command.idempotencyKey) {
        const existingTx = await ctx.transactions.findByAccountAndIdempotencyKey(
          command.accountId,
          command.idempotencyKey,
        );
        if (existingTx) {
          const isSamePayload =
            existingTx.transactionType === 'CREDIT' &&
            Money.fromString(String(existingTx.amount)).equals(depositMoney) &&
            (existingTx.description ?? null) === normalizedDescription;

          if (!isSamePayload) {
            throw new IdempotencyKeyReusedError();
          }
          return { transaction: existingTx, isReplay: true };
        }
      }

      if (account.status === 'CLOSED') {
        throw new AccountClosedError();
      }

      const currentMoney = Money.fromString(account.currentBalance);
      const newBalanceMoney = currentMoney.add(depositMoney);
      if (BigInt(newBalanceMoney.toDecimalString()) > MAX_VND) {
        throw new ValidationError([
          { field: 'amount', reason: 'amount_out_of_range' },
        ]);
      }
      const newBalance = newBalanceMoney.toDecimalString();

      await ctx.accounts.updateBalance(account.id, newBalance);
      const transactionRecord = await ctx.transactions.create({
        accountId: account.id,
        transactionType: 'CREDIT',
        referenceType: 'CASH_DEPOSIT',
        amount: command.amount,
        balanceAfter: newBalance,
        description: normalizedDescription,
        idempotencyKey: command.idempotencyKey ?? null,
      });

      return { transaction: transactionRecord, isReplay: false };
    });
  }
}
