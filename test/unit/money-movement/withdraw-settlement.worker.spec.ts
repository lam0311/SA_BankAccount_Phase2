import { describe, it, expect, jest } from '@jest/globals';
import { WithdrawSettlementWorker } from '@src/modules/money-movement/infrastructure/workers/withdraw-settlement.worker';
import { WithdrawMoneyUseCase } from '@src/modules/money-movement/application/use-cases/withdraw-money.use-case';
import { DepositMoneyUseCase } from '@src/modules/money-movement/application/use-cases/deposit-money.use-case';
import { TransferMoneyUseCase } from '@src/modules/money-movement/application/use-cases/transfer-money.use-case';
import type {
  BalanceReservationPort,
  QueuedWithdrawalItem,
  WithdrawSettlementPort,
} from '@src/modules/money-movement/application/ports/balance-reservation.port';
import type { PrismaService } from '@src/infrastructure/prisma';
import type { OutboxService } from '@src/infrastructure/outbox';
import { FakeUnitOfWork } from '../../helpers/fakes/fake-unit-of-work';
import { IdempotencyKeyReusedError } from '@src/modules/money-movement/domain/errors';

type AnyAsyncFn = (...args: any[]) => Promise<any>;

describe('withdraw settlement worker va luong ghi nen', () => {
  describe('WithdrawSettlementWorker.flush', () => {
    it('gom nhieu lenh rut cung tai khoan thanh 1 lan tru so du va 1 lan createMany', async () => {
      const batch: QueuedWithdrawalItem[] = [
        {
          id: 'tx-1',
          accountId: 'acc-1',
          userId: 'user-1',
          amount: '10000',
          balanceAfter: '90000',
          description: null,
          idempotencyKey: 'k-1',
          createdAt: '2026-11-26T00:00:00.000Z',
        },
        {
          id: 'tx-2',
          accountId: 'acc-1',
          userId: 'user-1',
          amount: '25000',
          balanceAfter: '65000',
          description: 'atm',
          idempotencyKey: 'k-2',
          createdAt: '2026-11-26T00:00:01.000Z',
        },
      ];

      const mockTx = {
        bankAccount: {
          update: jest.fn<AnyAsyncFn>().mockResolvedValue({
            id: 'acc-1',
            userId: 'user-1',
            accountNumber: '100000000001',
          }),
        },
        financialTransaction: {
          createMany: jest.fn<AnyAsyncFn>().mockResolvedValue({ count: 2 }),
        },
        outboxEvent: {
          create: jest.fn<AnyAsyncFn>().mockResolvedValue({
            id: 'evt-1',
            aggregateType: 'BankAccount',
            aggregateId: 'acc-1',
            eventType: 'account.balance.changed',
            payload: { accounts: [] },
            createdAt: new Date(),
          }),
        },
      };

      const prisma = {
        $transaction: jest.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
      } as unknown as PrismaService;

      const reservation: BalanceReservationPort = {
        seedAccount: jest.fn<BalanceReservationPort['seedAccount']>(),
        syncAccount: jest.fn<BalanceReservationPort['syncAccount']>(),
        reserveDebit: jest.fn<BalanceReservationPort['reserveDebit']>(),
        releaseDebit: jest.fn<BalanceReservationPort['releaseDebit']>(),
        markIdempotencyKey: jest.fn<BalanceReservationPort['markIdempotencyKey']>(),
        invalidate: jest.fn<BalanceReservationPort['invalidate']>(),
        popSettlementBatch: jest.fn<AnyAsyncFn>().mockResolvedValueOnce(batch).mockResolvedValue([]),
        requeueSettlementBatch: jest.fn<AnyAsyncFn>(),
      };

      const outbox = {
        dispatchCommitted: jest.fn<AnyAsyncFn>().mockResolvedValue(undefined),
      } as unknown as OutboxService;

      const worker = new WithdrawSettlementWorker(prisma, reservation, outbox);
      const count = await worker.flush();

      expect(count).toBe(2);
      expect(mockTx.bankAccount.update).toHaveBeenCalledTimes(1);
      expect(mockTx.bankAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-1' },
        data: { currentBalance: { decrement: '35000' } },
        select: { id: true, userId: true, accountNumber: true },
      });
      expect(mockTx.financialTransaction.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skipDuplicates: true,
        }),
      );
      expect(outbox.dispatchCommitted).toHaveBeenCalledTimes(1);
    });

    it('tra nguoc lo lenh ve dau hang doi khi transaction db bi loi', async () => {
      const batch: QueuedWithdrawalItem[] = [
        {
          id: 'tx-3',
          accountId: 'acc-1',
          userId: 'user-1',
          amount: '10000',
          balanceAfter: '90000',
          description: null,
          idempotencyKey: null,
          createdAt: '2026-11-26T00:00:00.000Z',
        },
      ];

      const prisma = {
        $transaction: jest.fn<AnyAsyncFn>().mockRejectedValue(new Error('db down')),
      } as unknown as PrismaService;

      const requeue = jest.fn<AnyAsyncFn>().mockResolvedValue(undefined);
      const reservation: BalanceReservationPort = {
        seedAccount: jest.fn<BalanceReservationPort['seedAccount']>(),
        syncAccount: jest.fn<BalanceReservationPort['syncAccount']>(),
        reserveDebit: jest.fn<BalanceReservationPort['reserveDebit']>(),
        releaseDebit: jest.fn<BalanceReservationPort['releaseDebit']>(),
        markIdempotencyKey: jest.fn<BalanceReservationPort['markIdempotencyKey']>(),
        invalidate: jest.fn<BalanceReservationPort['invalidate']>(),
        popSettlementBatch: jest.fn<AnyAsyncFn>().mockResolvedValueOnce(batch).mockResolvedValue([]),
        requeueSettlementBatch: requeue,
      };

      const worker = new WithdrawSettlementWorker(prisma, reservation);
      await expect(worker.flush()).rejects.toThrow('db down');
      expect(requeue).toHaveBeenCalledWith(batch);
    });
  });

  describe('use case phoi hop voi worker', () => {
    it('tra ket qua ngay khi redis tra OK kem queuedTransaction ma khong mo transaction db', async () => {
      const uow = new FakeUnitOfWork();
      const dbSpy = jest.spyOn(uow, 'execute');

      const queuedTx = {
        id: 'tx-queued-1',
        accountId: 'ACC_1',
        transferId: null,
        transactionType: 'DEBIT' as const,
        referenceType: 'CASH_WITHDRAWAL' as const,
        amount: '20000',
        balanceAfter: '80000',
        status: 'COMPLETED',
        description: null,
        idempotencyKey: 'key-q-1',
        createdAt: new Date(),
      };

      const reservation: BalanceReservationPort = {
        seedAccount: jest.fn<BalanceReservationPort['seedAccount']>(),
        syncAccount: jest.fn<BalanceReservationPort['syncAccount']>(),
        reserveDebit: jest.fn<BalanceReservationPort['reserveDebit']>().mockResolvedValue({
          status: 'OK',
          remainingBalance: '80000',
          queuedTransaction: queuedTx,
        }),
        releaseDebit: jest.fn<BalanceReservationPort['releaseDebit']>(),
        markIdempotencyKey: jest.fn<BalanceReservationPort['markIdempotencyKey']>(),
        invalidate: jest.fn<BalanceReservationPort['invalidate']>(),
      };

      const settlement: WithdrawSettlementPort = {
        flush: jest.fn<WithdrawSettlementPort['flush']>().mockResolvedValue(0),
      };

      const useCase = new WithdrawMoneyUseCase(uow, reservation, settlement);
      const res = await useCase.execute({
        accountId: 'ACC_1',
        userId: 'USER_1',
        amount: '20000',
        idempotencyKey: 'key-q-1',
      });

      expect(res.isReplay).toBe(false);
      expect(res.transaction.id).toBe('tx-queued-1');
      expect(dbSpy).not.toHaveBeenCalled();
    });

    it('xu ly replay va chan doi tham so ngay tren redis khi co replayedTransaction', async () => {
      const uow = new FakeUnitOfWork();
      const dbSpy = jest.spyOn(uow, 'execute');

      const cachedTx = {
        id: 'tx-replay-1',
        accountId: 'ACC_1',
        transferId: null,
        transactionType: 'DEBIT' as const,
        referenceType: 'CASH_WITHDRAWAL' as const,
        amount: '20000',
        balanceAfter: '80000',
        status: 'COMPLETED',
        description: null,
        idempotencyKey: 'key-r-1',
        createdAt: new Date(),
      };

      const reservation: BalanceReservationPort = {
        seedAccount: jest.fn<BalanceReservationPort['seedAccount']>(),
        syncAccount: jest.fn<BalanceReservationPort['syncAccount']>(),
        reserveDebit: jest.fn<BalanceReservationPort['reserveDebit']>().mockResolvedValue({
          status: 'REPLAY',
          replayedTransaction: cachedTx,
        }),
        releaseDebit: jest.fn<BalanceReservationPort['releaseDebit']>(),
        markIdempotencyKey: jest.fn<BalanceReservationPort['markIdempotencyKey']>(),
        invalidate: jest.fn<BalanceReservationPort['invalidate']>(),
      };

      const useCase = new WithdrawMoneyUseCase(uow, reservation);
      const okReplay = await useCase.execute({
        accountId: 'ACC_1',
        userId: 'USER_1',
        amount: '20000',
        idempotencyKey: 'key-r-1',
      });
      expect(okReplay.isReplay).toBe(true);
      expect(dbSpy).not.toHaveBeenCalled();

      await expect(
        useCase.execute({
          accountId: 'ACC_1',
          userId: 'USER_1',
          amount: '50000',
          idempotencyKey: 'key-r-1',
        }),
      ).rejects.toThrow(IdempotencyKeyReusedError);
    });

    it('nap tien va chuyen khoan deu xoa cache va xa hang doi truoc khi ghi db', async () => {
      const uow = new FakeUnitOfWork();
      uow.accountsDb.set('A', {
        id: 'A',
        userId: 'U1',
        accountNumber: '111111111111',
        currentBalance: '100000',
        status: 'ACTIVE',
      });
      uow.accountsDb.set('B', {
        id: 'B',
        userId: 'U2',
        accountNumber: '222222222222',
        currentBalance: '0',
        status: 'ACTIVE',
      });

      const calls: string[] = [];
      const reservation: BalanceReservationPort = {
        seedAccount: jest.fn<BalanceReservationPort['seedAccount']>(),
        syncAccount: jest.fn<BalanceReservationPort['syncAccount']>(),
        reserveDebit: jest.fn<BalanceReservationPort['reserveDebit']>(),
        releaseDebit: jest.fn<BalanceReservationPort['releaseDebit']>(),
        markIdempotencyKey: jest.fn<BalanceReservationPort['markIdempotencyKey']>(),
        invalidate: jest.fn<BalanceReservationPort['invalidate']>(async (id: string) => {
          calls.push(`inv:${id}`);
        }),
      };
      const settlement: WithdrawSettlementPort = {
        flush: jest.fn<WithdrawSettlementPort['flush']>(async () => {
          calls.push('flush');
          return 0;
        }),
      };

      const deposit = new DepositMoneyUseCase(uow, reservation, settlement);
      await deposit.execute({ accountId: 'A', userId: 'U1', amount: '10000' });
      expect(calls.slice(0, 2)).toEqual(['inv:A', 'flush']);

      calls.length = 0;
      const transfer = new TransferMoneyUseCase(uow, reservation, settlement);
      await transfer.execute({
        sourceAccountId: 'A',
        destinationAccountNumber: '222222222222',
        initiatedByUserId: 'U1',
        amount: '10000',
        idempotencyKey: 'tf-key-00000000001',
      });
      expect(calls.slice(0, 2)).toEqual(['inv:A', 'flush']);
    });
  });
});
