import { Injectable } from '@nestjs/common';
import { MultiLevelCacheService } from '@src/infrastructure/cache/multi-level-cache.service';
import type {
  AccountQueryRepositoryPort,
  ListAccountsByOwnerOptions,
} from '../../application/ports/account-query.repository.port';
import type {
  AccountPageReadModel,
  AccountReadModel,
} from '../../application/queries/account.read-model';
import { accountCacheKeys } from './account-cache.invalidator';
import { PrismaAccountQueryRepository } from './prisma-account-query.repository';

/**
 * Cache-Aside Decorator CHỈ dành cho nhánh Query (CQRS).
 * Lưu trữ trực tiếp AccountReadModel phẳng trong L1 LRU + L2 Redis,
 * loại bỏ hoàn toàn bước serialize/deserialize Domain Entity & Money.
 */
@Injectable()
export class CachedAccountQueryRepository
  implements AccountQueryRepositoryPort
{
  constructor(
    private readonly prismaQueryRepo: PrismaAccountQueryRepository,
    private readonly cache: MultiLevelCacheService,
  ) {}

  async findById(id: string): Promise<AccountReadModel | null> {
    const cacheKey = accountCacheKeys.byId(id);
    const cached = await this.cache.get<AccountReadModel>(cacheKey);

    if (cached) {
      return cached;
    }

    const account = await this.prismaQueryRepo.findById(id);
    if (account) {
      await this.cache.set(cacheKey, account, 60);
    }
    return account;
  }

  async findByAccountNumber(
    accountNumber: string,
  ): Promise<AccountReadModel | null> {
    const cacheKey = accountCacheKeys.byAccountNumber(accountNumber);
    const cached = await this.cache.get<AccountReadModel>(cacheKey);

    if (cached) {
      return cached;
    }

    const account = await this.prismaQueryRepo.findByAccountNumber(
      accountNumber,
    );
    if (account) {
      await this.cache.set(cacheKey, account, 60);
    }
    return account;
  }

  async listByOwner(
    userId: string,
    options: ListAccountsByOwnerOptions,
  ): Promise<AccountPageReadModel> {
    const cacheKey = accountCacheKeys.userList(
      userId,
      options.status,
      options.page,
      options.limit,
    );
    const cached = await this.cache.get<AccountPageReadModel>(cacheKey);

    if (cached) {
      return cached;
    }

    const page = await this.prismaQueryRepo.listByOwner(userId, options);
    await this.cache.set(cacheKey, page, 30);
    return page;
  }
}
