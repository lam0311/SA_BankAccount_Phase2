import { Injectable } from '@nestjs/common';
import { MultiLevelCacheService } from '@src/infrastructure/cache/multi-level-cache.service';
import type {
  AccountCacheInvalidateOptions,
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

  async invalidateAccount(
    input: InvalidateAccountCacheInput,
    options?: AccountCacheInvalidateOptions,
  ): Promise<void> {
    const tasks: Promise<void>[] = [
      options
        ? this.cache.del(accountCacheKeys.byId(input.id), options)
        : this.cache.del(accountCacheKeys.byId(input.id)),
    ];

    if (input.accountNumber) {
      const accNoKey = accountCacheKeys.byAccountNumber(input.accountNumber);
      tasks.push(
        options ? this.cache.del(accNoKey, options) : this.cache.del(accNoKey),
      );
    }

    if (input.userId) {
      const listPattern = accountCacheKeys.userListPattern(input.userId);
      tasks.push(
        options
          ? this.cache.delByPattern(listPattern, options)
          : this.cache.delByPattern(listPattern),
      );
    }

    await Promise.all(tasks);
  }

  async invalidateUserLists(
    userId: string,
    options?: AccountCacheInvalidateOptions,
  ): Promise<void> {
    const pattern = accountCacheKeys.userListPattern(userId);
    if (options) {
      await this.cache.delByPattern(pattern, options);
      return;
    }
    await this.cache.delByPattern(pattern);
  }
}
