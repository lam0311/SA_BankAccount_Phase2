import { Money } from '@src/common/domain/value-objects/money.value-object';
import type { BankAccount } from '../../domain/entities/bank-account.entity';
import type { AccountType } from '../../domain/enums/account-type';

export const ACCOUNT_COMMAND_REPOSITORY = Symbol('ACCOUNT_COMMAND_REPOSITORY');

export interface CreateAccountInput {
  readonly userId: string;
  readonly accountName: string;
  readonly accountType: AccountType;
  readonly initialDeposit: Money;
}

/**
 * Write-side Repository Port (CQRS Command).
 * Luôn thao tác trực tiếp trên Primary Database (không đọc qua Cache)
 * để đảm bảo Strong Consistency cho các ràng buộc mở/đóng tài khoản.
 */
export interface AccountCommandRepositoryPort {
  createWithOpeningDeposit(input: CreateAccountInput): Promise<BankAccount>;
  findById(id: string): Promise<BankAccount | null>;
  closeIfZeroBalance(id: string, userId: string): Promise<boolean>;
}
