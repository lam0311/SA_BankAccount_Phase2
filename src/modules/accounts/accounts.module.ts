import { Module } from '@nestjs/common';
import { MoneyMovementModule } from '@src/modules/money-movement/money-movement.module';
import {
  BALANCE_RESERVATION,
  WITHDRAW_SETTLEMENT,
  type BalanceReservationPort,
  type WithdrawSettlementPort,
} from '@src/modules/money-movement/application/ports/balance-reservation.port';

import { ACCOUNT_CACHE } from './application/ports/account-cache.port';
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
import { FreezeAccountHandler } from './application/commands/freeze-account.command';
import { UnfreezeAccountHandler } from './application/commands/unfreeze-account.command';
import { GetAccountQueryHandler } from './application/queries/get-account.query';
import { ListAccountsQueryHandler } from './application/queries/list-accounts.query';
import { AccountLookupFacade } from './infrastructure/adapters/account-lookup.facade';
import { AccountCacheInvalidationSubscriber } from './infrastructure/events/account-cache-invalidation.subscriber';
import { AccountCacheInvalidator } from './infrastructure/persistence/account-cache.invalidator';
import { CachedAccountQueryRepository } from './infrastructure/persistence/cached-account-query.repository';
import { PrismaAccountCommandRepository } from './infrastructure/persistence/prisma-account-command.repository';
import { PrismaAccountQueryRepository } from './infrastructure/persistence/prisma-account-query.repository';
import { AccountsController } from './presentation/http/accounts.controller';

@Module({
  imports: [MoneyMovementModule],
  controllers: [AccountsController],
  providers: [
    PrismaAccountCommandRepository,
    PrismaAccountQueryRepository,
    CachedAccountQueryRepository,
    AccountCacheInvalidator,
    AccountCacheInvalidationSubscriber,

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

    // --- Command Handlers (Write side: Primary DB + Transactional Outbox) ---
    {
      provide: OpenAccountHandler,
      useFactory: (commandRepo: AccountCommandRepositoryPort) =>
        new OpenAccountHandler(commandRepo),
      inject: [ACCOUNT_COMMAND_REPOSITORY],
    },
    {
      provide: CloseAccountHandler,
      useFactory: (commandRepo: AccountCommandRepositoryPort) =>
        new CloseAccountHandler(commandRepo),
      inject: [ACCOUNT_COMMAND_REPOSITORY],
    },
    {
      provide: FreezeAccountHandler,
      useFactory: (
        commandRepo: AccountCommandRepositoryPort,
        reservation: BalanceReservationPort,
        settlement: WithdrawSettlementPort,
      ) => new FreezeAccountHandler(commandRepo, reservation, settlement),
      inject: [ACCOUNT_COMMAND_REPOSITORY, BALANCE_RESERVATION, WITHDRAW_SETTLEMENT],
    },
    {
      provide: UnfreezeAccountHandler,
      useFactory: (
        commandRepo: AccountCommandRepositoryPort,
        reservation: BalanceReservationPort,
        settlement: WithdrawSettlementPort,
      ) => new UnfreezeAccountHandler(commandRepo, reservation, settlement),
      inject: [ACCOUNT_COMMAND_REPOSITORY, BALANCE_RESERVATION, WITHDRAW_SETTLEMENT],
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
  exports: [ACCOUNTS_FACADE],
})
export class AccountsModule {}
