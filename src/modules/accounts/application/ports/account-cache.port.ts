export const ACCOUNT_CACHE = Symbol('ACCOUNT_CACHE');

export interface InvalidateAccountCacheInput {
  readonly id: string;
  readonly userId?: string;
  readonly accountNumber?: string;
}

export interface AccountCachePort {
  invalidateAccount(input: InvalidateAccountCacheInput): Promise<void>;
  invalidateUserLists(userId: string): Promise<void>;
}
