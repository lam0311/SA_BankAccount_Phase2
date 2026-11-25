export const ACCOUNT_CACHE = Symbol('ACCOUNT_CACHE');

export interface InvalidateAccountCacheInput {
  readonly id: string;
  readonly userId?: string;
  readonly accountNumber?: string;
}

export interface AccountCacheInvalidateOptions {
  readonly throwOnError?: boolean;
}

export interface AccountCachePort {
  invalidateAccount(
    input: InvalidateAccountCacheInput,
    options?: AccountCacheInvalidateOptions,
  ): Promise<void>;
  invalidateUserLists(
    userId: string,
    options?: AccountCacheInvalidateOptions,
  ): Promise<void>;
}
