import { Module } from "@nestjs/common";
import { OutboxService } from "@src/infrastructure/outbox";
import { PrismaModule } from "@src/infrastructure/prisma/prisma.module";
import { PrismaService } from "@src/infrastructure/prisma/prisma.service";
import { TransactionController } from "./presentation/http/transactions.controller";
import { TransfersController } from "./presentation/http/transfers.controller";
import { DepositMoneyUseCase } from "./application/use-cases/deposit-money.use-case";
import { WithdrawMoneyUseCase } from "./application/use-cases/withdraw-money.use-case";
import { TransferMoneyUseCase } from "./application/use-cases/transfer-money.use-case";
import { GetTransactionHistoryUseCase } from "./application/use-cases/get-transaction-history.use-case";
import { UNIT_OF_WORK, UnitOfWorkPort } from "./application/ports/unit-of-work.port";
import { TRANSACTION_QUERY, TransactionQueryPort } from "./application/ports/transaction-query.port";
import {
  BALANCE_RESERVATION,
  WITHDRAW_SETTLEMENT,
  type BalanceReservationPort,
  type WithdrawSettlementPort,
} from "./application/ports/balance-reservation.port";
import {
  RISK_CONTROL,
  type RiskControlPort,
} from "./application/ports/risk-control.port";
import { PrismaUnitOfWork } from "./infrastructure/persistence/prisma-unit-of-work";
import { PrismaTransactionQuery } from "./infrastructure/persistence/prisma-transaction-query";
import { RedisAtomicReservationService } from "./infrastructure/cache/redis-atomic-reservation.service";
import { RedisRiskControlService } from "./infrastructure/risk/redis-risk-control.service";
import { WithdrawSettlementWorker } from "./infrastructure/workers/withdraw-settlement.worker";

@Module({
  imports: [PrismaModule],
  controllers: [
    TransactionController,
    TransfersController,
  ],
  providers: [
    RedisAtomicReservationService,
    {
      provide: BALANCE_RESERVATION,
      useExisting: RedisAtomicReservationService,
    },
    RedisRiskControlService,
    {
      provide: RISK_CONTROL,
      useExisting: RedisRiskControlService,
    },
    WithdrawSettlementWorker,
    {
      provide: WITHDRAW_SETTLEMENT,
      useExisting: WithdrawSettlementWorker,
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (prisma: PrismaService, outbox: OutboxService) =>
        new PrismaUnitOfWork(prisma, outbox),
      inject: [PrismaService, OutboxService],
    },
    {
      provide: TRANSACTION_QUERY,
      useClass: PrismaTransactionQuery,
    },
    {
      provide: DepositMoneyUseCase,
      useFactory: (
        uow: UnitOfWorkPort,
        reservation: BalanceReservationPort,
        settlement: WithdrawSettlementPort,
      ) => new DepositMoneyUseCase(uow, reservation, settlement),
      inject: [UNIT_OF_WORK, BALANCE_RESERVATION, WITHDRAW_SETTLEMENT],
    },
    {
      provide: WithdrawMoneyUseCase,
      useFactory: (
        uow: UnitOfWorkPort,
        reservation: BalanceReservationPort,
        settlement: WithdrawSettlementPort,
        riskControl: RiskControlPort,
      ) => new WithdrawMoneyUseCase(uow, reservation, settlement, riskControl),
      inject: [UNIT_OF_WORK, BALANCE_RESERVATION, WITHDRAW_SETTLEMENT, RISK_CONTROL],
    },
    {
      provide: TransferMoneyUseCase,
      useFactory: (
        uow: UnitOfWorkPort,
        reservation: BalanceReservationPort,
        settlement: WithdrawSettlementPort,
        riskControl: RiskControlPort,
      ) => new TransferMoneyUseCase(uow, reservation, settlement, riskControl),
      inject: [UNIT_OF_WORK, BALANCE_RESERVATION, WITHDRAW_SETTLEMENT, RISK_CONTROL],
    },
    {
      provide: GetTransactionHistoryUseCase,
      useFactory: (query: TransactionQueryPort) => new GetTransactionHistoryUseCase(query),
      inject: [TRANSACTION_QUERY],
    },
  ],
  exports: [BALANCE_RESERVATION, WITHDRAW_SETTLEMENT, RISK_CONTROL],
})
export class MoneyMovementModule {}
