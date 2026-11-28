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

  // --- LUỒNG GHI: Ghi DB xong thì xóa cache (tự động Pub/Sub xóa L1 các Node khác) ---
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

  // --- LUỒNG ĐỌC: Single-Flight (TSK-17) -> Đọc L1/L2, nếu miss đồng loạt chỉ 1 query DB ---
  async findById(id: string): Promise<BankAccount | null> {
    const cacheKey = `accounts:id:${id}`;
    const result = await this.cache.getOrSet<BankAccount | null>(
      cacheKey,
      60, // Cache 60s
      () => this.prismaRepo.findById(id),
    );

    return result ? this.deserialize(result) : null;
  }

  async findByAccountNumber(accountNumber: string): Promise<BankAccount | null> {
    const cacheKey = `accounts:acc_no:${accountNumber}`;
    const result = await this.cache.getOrSet<BankAccount | null>(
      cacheKey,
      60,
      () => this.prismaRepo.findByAccountNumber(accountNumber),
    );

    return result ? this.deserialize(result) : null;
  }

  async listByOwner(
    userId: string,
    options: { status?: AccountStatus; page: number; limit: number },
  ): Promise<AccountPage> {
    const statusKey = options.status ?? 'ALL';
    const cacheKey = `accounts:user:${userId}:list:${statusKey}:p${options.page}:l${options.limit}`;

    const page = await this.cache.getOrSet<AccountPage>(
      cacheKey,
      30, // Cache danh sách 30s
      () => this.prismaRepo.listByOwner(userId, options),
    );

    return {
      items: page.items.map((item) => this.deserialize(item)),
      total: page.total,
    };
  }

  // Khôi phục Value Object Money và Date (an toàn cho cả object JSON từ Cache lẫn Entity từ Prisma)
  private deserialize(raw: any): BankAccount {
    return {
      ...raw,
      currentBalance:
        raw.currentBalance instanceof Money
          ? raw.currentBalance
          : Money.fromString(
              typeof raw.currentBalance === 'object' && raw.currentBalance?.amountMinor
                ? raw.currentBalance.amountMinor.toString()
                : raw.currentBalance.toString(),
            ),
      createdAt: raw.createdAt instanceof Date ? raw.createdAt : new Date(raw.createdAt),
      closedAt: raw.closedAt
        ? raw.closedAt instanceof Date
          ? raw.closedAt
          : new Date(raw.closedAt)
        : null,
    };
  }
}
