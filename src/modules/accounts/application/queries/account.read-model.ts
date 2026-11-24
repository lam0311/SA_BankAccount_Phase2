import type { AccountStatus } from '../../domain/enums/account-status';
import type { AccountType } from '../../domain/enums/account-type';

/**
 * Read Model phẳng cho nhánh Query (CQRS).
 * Lưu sẵn chuỗi thập phân và ISO timestamp để đọc/ghi trực tiếp qua
 * Multi-level Cache (L1 LRU + L2 Redis) mà không tốn chi phí bọc/gỡ Money hay Date.
 */
export interface AccountReadModel {
  readonly id: string;
  readonly userId: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly accountType: AccountType;
  readonly currentBalance: string;
  readonly currency: 'VND';
  readonly status: AccountStatus;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

export interface AccountPageReadModel {
  readonly items: AccountReadModel[];
  readonly total: number;
}
