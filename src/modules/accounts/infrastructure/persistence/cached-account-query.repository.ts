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
 * Cache-Aside + Single-Flight (TSK-17) Decorator CHỈ dành cho nhánh Query (CQRS).
 * Lưu trữ trực tiếp AccountReadModel phẳng trong L1 LRU + L2 Redis,
 * loại bỏ hoàn toàn bước serialize/deserialize Domain Entity & Money,
 * đồng thời gom các request cache-miss đồng thời thành đúng 1 truy vấn DB.
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
    return this.cache.getOrSet<AccountReadModel | null>(
      cacheKey,
      60,
      () => this.prismaQueryRepo.findById(id),
    );
  }

  async findByAccountNumber(
    accountNumber: string,
  ): Promise<AccountReadModel | null> {
    const cacheKey = accountCacheKeys.byAccountNumber(accountNumber);
    return this.cache.getOrSet<AccountReadModel | null>(
      cacheKey,
      60,
      () => this.prismaQueryRepo.findByAccountNumber(accountNumber),
    );
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
    return this.cache.getOrSet<AccountPageReadModel>(
      cacheKey,
      30,
      () => this.prismaQueryRepo.listByOwner(userId, options),
    );
  }
}
