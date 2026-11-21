import { Money } from '../../../../common/domain/value-objects/money.value-object';
import {
  UnitOfWorkPort,
  TransactionExecutionResult,
} from '../ports/unit-of-work.port';
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

export class WithdrawMoneyUseCase {
  constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  async execute(command: WithdrawMoneyCommand): Promise<TransactionExecutionResult> {
    return this.unitOfWork.execute(async (ctx) => {
      const account = await ctx.accounts.lockForUpdate(command.accountId);
      if (!account || account.userId !== command.userId) {
        throw new AccountNotFoundError();
      }

      const withdrawMoney = Money.fromString(command.amount, { allowZero: false });
      const normalizedDescription = command.description ?? null;

      if (command.idempotencyKey) {
        const existingTx = await ctx.transactions.findByAccountAndIdempotencyKey(
          command.accountId,
          command.idempotencyKey,
        );
        if (existingTx) {
          const isSamePayload =
            existingTx.transactionType === 'DEBIT' &&
            Money.fromString(String(existingTx.amount)).equals(withdrawMoney) &&
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
      if (!currentMoney.isGreaterThanOrEqual(withdrawMoney)) {
        throw new InsufficientFundsError();
      }

      const newBalance = currentMoney.subtract(withdrawMoney).toDecimalString();
      await ctx.accounts.updateBalance(account.id, newBalance);
      const transactionRecord = await ctx.transactions.create({
        accountId: account.id,
        transactionType: 'DEBIT',
        referenceType: 'CASH_WITHDRAWAL',
        amount: command.amount,
        balanceAfter: newBalance,
        description: normalizedDescription,
        idempotencyKey: command.idempotencyKey ?? null,
      });

      return { transaction: transactionRecord, isReplay: false };
    });
  }
}
