import { Module } from '@nestjs/common';

import {
  ACCOUNT_CACHE,
  type AccountCachePort,
} from './application/ports/account-cache.port';
import {
  ACCOUNT_COMMAND_REPOSITORY,
  type AccountCommandRepositoryPort,
} from './application/ports/account-command.repository.port';
import {
  ACCOUNT_QUERY_REPOSITORY,
  type AccountQueryRepositoryPort,
} from './application/ports/account-query.repository.port';
import {
  ACCOUNTS_FACADE,
  type AccountsFacade,
} from './application/ports/accounts.facade';
import { OpenAccountHandler } from './application/commands/open-account.command';
import { CloseAccountHandler } from './application/commands/close-account.command';
import { GetAccountQueryHandler } from './application/queries/get-account.query';
import { ListAccountsQueryHandler } from './application/queries/list-accounts.query';
import { AccountLookupFacade } from './infrastructure/adapters/account-lookup.facade';
import { AccountCacheInvalidator } from './infrastructure/persistence/account-cache.invalidator';
import { CachedAccountQueryRepository } from './infrastructure/persistence/cached-account-query.repository';
import { PrismaAccountCommandRepository } from './infrastructure/persistence/prisma-account-command.repository';
import { PrismaAccountQueryRepository } from './infrastructure/persistence/prisma-account-query.repository';
import { AccountsController } from './presentation/http/accounts.controller';

@Module({
  controllers: [AccountsController],
  providers: [
    PrismaAccountCommandRepository,
    PrismaAccountQueryRepository,
    CachedAccountQueryRepository,
    AccountCacheInvalidator,

    {
      provide: ACCOUNT_COMMAND_REPOSITORY,
      useExisting: PrismaAccountCommandRepository,
    },
    {
      provide: ACCOUNT_QUERY_REPOSITORY,
      useExisting: CachedAccountQueryRepository,
    },
    {
      provide: ACCOUNT_CACHE,
      useExisting: AccountCacheInvalidator,
    },

    // --- Command Handlers (Write side: Primary DB + Cache Invalidation) ---
    {
      provide: OpenAccountHandler,
      useFactory: (
        commandRepo: AccountCommandRepositoryPort,
        cache: AccountCachePort,
      ) => new OpenAccountHandler(commandRepo, cache),
      inject: [ACCOUNT_COMMAND_REPOSITORY, ACCOUNT_CACHE],
    },
    {
      provide: CloseAccountHandler,
      useFactory: (
        commandRepo: AccountCommandRepositoryPort,
        cache: AccountCachePort,
      ) => new CloseAccountHandler(commandRepo, cache),
      inject: [ACCOUNT_COMMAND_REPOSITORY, ACCOUNT_CACHE],
    },

    // --- Query Handlers & Read Facade (Read side: Multi-level Cache -> DB) ---
    {
      provide: ListAccountsQueryHandler,
      useFactory: (queryRepo: AccountQueryRepositoryPort) =>
        new ListAccountsQueryHandler(queryRepo),
      inject: [ACCOUNT_QUERY_REPOSITORY],
    },
    {
      provide: GetAccountQueryHandler,
      useFactory: (queryRepo: AccountQueryRepositoryPort) =>
        new GetAccountQueryHandler(queryRepo),
      inject: [ACCOUNT_QUERY_REPOSITORY],
    },
    {
      provide: ACCOUNTS_FACADE,
      useFactory: (queryRepo: AccountQueryRepositoryPort): AccountsFacade =>
        new AccountLookupFacade(queryRepo),
      inject: [ACCOUNT_QUERY_REPOSITORY],
    },
  ],
  exports: [ACCOUNTS_FACADE, ACCOUNT_CACHE],
})
export class AccountsModule {}
