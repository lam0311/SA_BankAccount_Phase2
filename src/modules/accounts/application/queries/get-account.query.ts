import type { AccountQueryRepositoryPort } from '../ports/account-query.repository.port';
import type { AccountReadModel } from './account.read-model';
import { AccountNotFoundError } from '../../domain/errors/account-not-found.error';

export interface GetAccountQuery {
  currentUserId: string;
  accountId: string;
}

export class GetAccountQueryHandler {
  constructor(private readonly queryRepo: AccountQueryRepositoryPort) {}

  async execute(
    currentUserId: string,
    accountId: string,
  ): Promise<AccountReadModel> {
    const account = await this.queryRepo.findById(accountId);

    if (account === null || account.userId !== currentUserId) {
      throw new AccountNotFoundError();
    }

    return account;
  }
}
