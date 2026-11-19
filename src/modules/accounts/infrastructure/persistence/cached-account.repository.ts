import { Injectable } from '@nestjs/common';
import { Money } from '@src/common/domain/value-objects/money.value-object';
import { MultiLevelCacheService } from '@src/infrastructure/cache/multi-level-cache.service';
import {
  AccountPage,
  AccountRepositoryPort,
  CreateAccountInput,
} from '../../application/ports/account.repository.port';
import { BankAccount } from '../../domain/entities/bank-account.entity';
import { AccountStatus } from '../../domain/enums/account-status';
import { PrismaAccountRepository } from './prisma-account.repository';

@Injectable()
export class CachedAccountRepository implements AccountRepositoryPort {
  constructor(
    private readonly prismaRepo: PrismaAccountRepository,
    private readonly cache: MultiLevelCacheService,
  ) {}

  // --- LUỒNG GHI: Ghi DB xong thì xóa cache ---
  async createWithOpeningDeposit(input: CreateAccountInput): Promise<BankAccount> {
    const account = await this.prismaRepo.createWithOpeningDeposit(input);
    // Xóa cache danh sách của user để lần sau lấy được tài khoản mới
    await this.cache.delByPattern(`accounts:user:${input.userId}:*`);
    return account;
  }

  async closeIfZeroBalance(id: string, userId: string): Promise<boolean> {
    const closed = await this.prismaRepo.closeIfZeroBalance(id, userId);
    if (closed) {
      await Promise.all([
        this.cache.del(`accounts:id:${id}`),
        this.cache.delByPattern(`accounts:user:${userId}:*`),
      ]);
    }
    return closed;
  }

  // --- LUỒNG ĐỌC: Đọc Cache trước, Miss mới vào DB ---
  async findById(id: string): Promise<BankAccount | null> {
    const cacheKey = `accounts:id:${id}`;
    const cached = await this.cache.get<any>(cacheKey);

    if (cached) {
      return this.deserialize(cached);
    }

    const account = await this.prismaRepo.findById(id);
    if (account) {
      await this.cache.set(cacheKey, account, 60); // Cache 60s
    }
    return account;
  }

  async findByAccountNumber(accountNumber: string): Promise<BankAccount | null> {
    const cacheKey = `accounts:acc_no:${accountNumber}`;
    const cached = await this.cache.get<any>(cacheKey);

    if (cached) {
      return this.deserialize(cached);
    }

    const account = await this.prismaRepo.findByAccountNumber(accountNumber);
    if (account) {
      await this.cache.set(cacheKey, account, 60);
    }
    return account;
  }

  async listByOwner(
    userId: string,
    options: { status?: AccountStatus; page: number; limit: number },
  ): Promise<AccountPage> {
    const statusKey = options.status ?? 'ALL';
    const cacheKey = `accounts:user:${userId}:list:${statusKey}:p${options.page}:l${options.limit}`;

    const cached = await this.cache.get<{ items: any[]; total: number }>(cacheKey);
    if (cached) {
      return {
        items: cached.items.map((item) => this.deserialize(item)),
        total: cached.total,
      };
    }

    const page = await this.prismaRepo.listByOwner(userId, options);
    await this.cache.set(cacheKey, page, 30); // Cache danh sách 30s
    return page;
  }

  // Khôi phục Value Object Money và Date từ JSON
  private deserialize(raw: any): BankAccount {
    return {
      ...raw,
      currentBalance: Money.fromString(
        typeof raw.currentBalance === 'object' && raw.currentBalance?.amountMinor
          ? raw.currentBalance.amountMinor.toString()
          : raw.currentBalance.toString(),
      ),
      createdAt: new Date(raw.createdAt),
      closedAt: raw.closedAt ? new Date(raw.closedAt) : null,
    };
  }
}
