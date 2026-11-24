import { Money } from '@src/common/domain/value-objects/money.value-object';
import type { AccountCachePort } from '../ports/account-cache.port';
import type { AccountCommandRepositoryPort } from '../ports/account-command.repository.port';
import { AccountHasBalanceError } from '../../domain/errors/account-has-balance.error';
import { AccountNotFoundError } from '../../domain/errors/account-not-found.error';

export interface CloseAccountCommand {
  currentUserId: string;
  accountId: string;
}

export class CloseAccountHandler {
  constructor(
    private readonly commandRepo: AccountCommandRepositoryPort,
    private readonly accountCache?: AccountCachePort,
  ) {}

  async execute(currentUserId: string, accountId: string): Promise<void> {
    // Luôn đọc trực tiếp từ Primary DB qua Command Repository (không qua Cache)
    const account = await this.commandRepo.findById(accountId);

    if (account === null || account.userId !== currentUserId) {
      throw new AccountNotFoundError();
    }

    // Chọn cách xử lý DELETE lặp lại: account đã đóng trả 204.
    if (account.status === 'CLOSED') {
      return;
    }

    if (!account.currentBalance.equals(Money.zero())) {
      throw new AccountHasBalanceError();
    }

    const closed = await this.commandRepo.closeIfZeroBalance(
      accountId,
      currentUserId,
    );

    if (closed) {
      await this.accountCache?.invalidateAccount({
        id: account.id,
        userId: account.userId,
        accountNumber: account.accountNumber,
      });
      return;
    }

    // Dữ liệu có thể đổi sau findById() (VD: request khác vừa nạp tiền hoặc vừa đóng account).
    // Đọc lại trực tiếp từ Primary DB để trả đúng mã lỗi nghiệp vụ.
    const latest = await this.commandRepo.findById(accountId);

    if (latest === null || latest.userId !== currentUserId) {
      throw new AccountNotFoundError();
    }

    if (latest.status === 'CLOSED') {
      await this.accountCache?.invalidateAccount({
        id: latest.id,
        userId: latest.userId,
        accountNumber: latest.accountNumber,
      });
      return;
    }

    if (!latest.currentBalance.equals(Money.zero())) {
      throw new AccountHasBalanceError();
    }

    throw new Error('Account close condition changed unexpectedly');
  }
}
