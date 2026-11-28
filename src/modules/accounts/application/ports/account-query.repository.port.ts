import type { AccountStatus } from '../../domain/enums/account-status';
import type {
  AccountPageReadModel,
  AccountReadModel,
} from '../queries/account.read-model';

export const ACCOUNT_QUERY_REPOSITORY = Symbol('ACCOUNT_QUERY_REPOSITORY');

export interface ListAccountsByOwnerOptions {
  readonly status?: AccountStatus;
  readonly page: number;
  readonly limit: number;
}

/**
 * Read-side Repository Port (CQRS Query).
 * Trả trực tiếp AccountReadModel phẳng, cho phép bọc Multi-level Cache (L1 LRU + L2 Redis)
 * hoặc điều hướng sang Read Replica độc lập hoàn toàn với nhánh Command.
 */
export interface AccountQueryRepositoryPort {
  findById(id: string): Promise<AccountReadModel | null>;
  findByAccountNumber(accountNumber: string): Promise<AccountReadModel | null>;
  listByOwner(
    userId: string,
    options: ListAccountsByOwnerOptions,
  ): Promise<AccountPageReadModel>;
}
