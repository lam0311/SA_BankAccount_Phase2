import { Module } from "@nestjs/common";
import { PrismaModule } from "@src/infrastructure/prisma/prisma.module";
import { PrismaService } from "@src/infrastructure/prisma/prisma.service";
import { AccountsModule } from "@src/modules/accounts/accounts.module";
import {
  ACCOUNT_CACHE,
  type AccountCachePort,
} from "@src/modules/accounts/application/ports/account-cache.port";
import { TransactionController } from "./presentation/http/transactions.controller";
import { TransfersController } from "./presentation/http/transfers.controller";
import { DepositMoneyUseCase } from "./application/use-cases/deposit-money.use-case";
import { WithdrawMoneyUseCase } from "./application/use-cases/withdraw-money.use-case";
import { TransferMoneyUseCase } from "./application/use-cases/transfer-money.use-case";
import { GetTransactionHistoryUseCase } from "./application/use-cases/get-transaction-history.use-case";
import { UNIT_OF_WORK, UnitOfWorkPort } from "./application/ports/unit-of-work.port";
import { TRANSACTION_QUERY, TransactionQueryPort } from "./application/ports/transaction-query.port";
import { PrismaUnitOfWork } from "./infrastructure/persistence/prisma-unit-of-work";
import { PrismaTransactionQuery } from "./infrastructure/persistence/prisma-transaction-query";

@Module({
  imports: [PrismaModule, AccountsModule],
  controllers: [
    TransactionController,
    TransfersController,
  ],
  providers: [
    {
      provide: UNIT_OF_WORK,
      useFactory: (prisma: PrismaService, accountCache: AccountCachePort) =>
        new PrismaUnitOfWork(prisma, accountCache),
      inject: [PrismaService, ACCOUNT_CACHE],
    },
    {
      provide: TRANSACTION_QUERY,
      useClass: PrismaTransactionQuery,
    },
    {
      provide: DepositMoneyUseCase,
      useFactory: (uow: UnitOfWorkPort) => new DepositMoneyUseCase(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: WithdrawMoneyUseCase,
      useFactory: (uow: UnitOfWorkPort) => new WithdrawMoneyUseCase(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: TransferMoneyUseCase,
      useFactory: (uow: UnitOfWorkPort) => new TransferMoneyUseCase(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: GetTransactionHistoryUseCase,
      useFactory: (query: TransactionQueryPort) => new GetTransactionHistoryUseCase(query),
      inject: [TRANSACTION_QUERY],
    },
  ],
  exports: [],
})
export class MoneyMovementModule {}
