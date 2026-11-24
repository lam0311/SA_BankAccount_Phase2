import type { AccountQueryRepositoryPort } from '../../application/ports/account-query.repository.port';
import type {
  AccountLookupResult,
  AccountsFacade,
} from '../../application/ports/accounts.facade';

export class AccountLookupFacade implements AccountsFacade {
  constructor(private readonly queryRepo: AccountQueryRepositoryPort) {}

  async findByAccountNumber(
    accountNumber: string,
  ): Promise<AccountLookupResult | null> {
    const account = await this.queryRepo.findByAccountNumber(accountNumber);

    if (account === null) {
      return null;
    }

    return {
      id: account.id,
      accountNumber: account.accountNumber,
      currency: account.currency,
      status: account.status,
    };
  }
}
