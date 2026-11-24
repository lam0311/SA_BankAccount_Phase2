import { Injectable } from '@nestjs/common';
import { MultiLevelCacheService } from '@src/infrastructure/cache/multi-level-cache.service';
import type {
  AccountCachePort,
  InvalidateAccountCacheInput,
} from '../../application/ports/account-cache.port';
import type { AccountStatus } from '../../domain/enums/account-status';

export const accountCacheKeys = {
  byId: (id: string) => `accounts:id:${id}`,
  byAccountNumber: (accountNumber: string) =>
    `accounts:acc_no:${accountNumber}`,
  userList: (
    userId: string,
    status: AccountStatus | undefined,
    page: number,
    limit: number,
  ) => `accounts:user:${userId}:list:${status ?? 'ALL'}:p${page}:l${limit}`,
  userListPattern: (userId: string) => `accounts:user:${userId}:*`,
};

@Injectable()
export class AccountCacheInvalidator implements AccountCachePort {
  constructor(private readonly cache: MultiLevelCacheService) {}

  async invalidateAccount(input: InvalidateAccountCacheInput): Promise<void> {
    const tasks: Promise<void>[] = [
      this.cache.del(accountCacheKeys.byId(input.id)),
    ];

    if (input.accountNumber) {
      tasks.push(
        this.cache.del(accountCacheKeys.byAccountNumber(input.accountNumber)),
      );
    }

    if (input.userId) {
      tasks.push(
        this.cache.delByPattern(accountCacheKeys.userListPattern(input.userId)),
      );
    }

    await Promise.all(tasks);
  }

  async invalidateUserLists(userId: string): Promise<void> {
    await this.cache.delByPattern(accountCacheKeys.userListPattern(userId));
  }
}
