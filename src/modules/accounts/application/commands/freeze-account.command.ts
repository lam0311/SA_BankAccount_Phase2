import type {
  BalanceReservationPort,
  WithdrawSettlementPort,
} from '@src/modules/money-movement/application/ports/balance-reservation.port';
import type { AccountCommandRepositoryPort } from '../ports/account-command.repository.port';
import type { BankAccount } from '../../domain/entities/bank-account.entity';
import { AccountAlreadyClosedError } from '../../domain/errors/account-closed.error';
import { AccountNotFoundError } from '../../domain/errors/account-not-found.error';

export class FreezeAccountHandler {
  constructor(
    private readonly commandRepo: AccountCommandRepositoryPort,
    private readonly reservation?: BalanceReservationPort,
    private readonly settlement?: WithdrawSettlementPort,
  ) {}

  async execute(currentUserId: string, accountId: string): Promise<BankAccount> {
    const account = await this.commandRepo.findById(accountId);
    if (account === null || account.userId !== currentUserId) {
      throw new AccountNotFoundError();
    }

    if (account.status === 'CLOSED') {
      throw new AccountAlreadyClosedError();
    }

    if (account.status === 'FROZEN') {
      await this.reservation?.invalidate(accountId);
      return account;
    }

    // xoa cache redis va xa hang doi rut tien truoc khi khoa tai khoan
    await this.reservation?.invalidate(accountId);
    await this.settlement?.flush();

    const updated = await this.commandRepo.updateStatus(
      accountId,
      currentUserId,
      'ACTIVE',
      'FROZEN',
    );

    if (updated) {
      await this.reservation?.invalidate(accountId);
      return updated;
    }

    const latest = await this.commandRepo.findById(accountId);
    if (latest === null || latest.userId !== currentUserId) {
      throw new AccountNotFoundError();
    }
    if (latest.status === 'CLOSED') {
      throw new AccountAlreadyClosedError();
    }
    await this.reservation?.invalidate(accountId);
    return latest;
  }
}
