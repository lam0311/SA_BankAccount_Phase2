import { Money } from '@src/common/domain/value-objects/money.value-object';
import type { AccountCachePort } from '@src/modules/accounts/application/ports/account-cache.port';
import type { AccountCommandRepositoryPort } from '@src/modules/accounts/application/ports/account-command.repository.port';
import type { AccountQueryRepositoryPort } from '@src/modules/accounts/application/ports/account-query.repository.port';
import type { AccountReadModel } from '@src/modules/accounts/application/queries/account.read-model';
import type { BankAccount } from '@src/modules/accounts/domain/entities/bank-account.entity';

export function fakeAccountCommandRepository(): jest.Mocked<AccountCommandRepositoryPort> {
  return {
    createWithOpeningDeposit: jest.fn(),
    findById: jest.fn(),
    closeIfZeroBalance: jest.fn(),
    updateStatus: jest.fn(),
  };
}

export function fakeAccountQueryRepository(): jest.Mocked<AccountQueryRepositoryPort> {
  return {
    findById: jest.fn(),
    findByAccountNumber: jest.fn(),
    listByOwner: jest.fn(),
  };
}

export function fakeAccountCache(): jest.Mocked<AccountCachePort> {
  return {
    invalidateAccount: jest.fn().mockResolvedValue(undefined),
    invalidateUserLists: jest.fn().mockResolvedValue(undefined),
  };
}

export function makeAccount(
  overrides: Partial<BankAccount> = {},
): BankAccount {
  return {
    id: '550e8400-e29b-41d4-a716-446655440010',
    userId: 'user-A',
    accountNumber: '001234567890',
    accountName: 'Tài khoản chính',
    accountType: 'PAYMENT',
    currentBalance: Money.zero(),
    currency: 'VND',
    status: 'ACTIVE',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    closedAt: null,
    ...overrides,
  };
}

export function makeAccountReadModel(
  overrides: Partial<AccountReadModel> = {},
): AccountReadModel {
  return {
    id: '550e8400-e29b-41d4-a716-446655440010',
    userId: 'user-A',
    accountNumber: '001234567890',
    accountName: 'Tài khoản chính',
    accountType: 'PAYMENT',
    currentBalance: '0',
    currency: 'VND',
    status: 'ACTIVE',
    createdAt: '2026-10-01T00:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}
