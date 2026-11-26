import { describe, beforeEach, it, expect, jest } from '@jest/globals';
import { FakeUnitOfWork } from '../../helpers/fakes/fake-unit-of-work';
import { WithdrawMoneyUseCase } from '@src/modules/money-movement/application/use-cases/withdraw-money.use-case';
import { DepositMoneyUseCase } from '@src/modules/money-movement/application/use-cases/deposit-money.use-case';
import { TransferMoneyUseCase } from '@src/modules/money-movement/application/use-cases/transfer-money.use-case';
import {
  BalanceReservationPort,
  ReserveResult,
} from '@src/modules/money-movement/application/ports/balance-reservation.port';
import { RedisAtomicReservationService } from '@src/modules/money-movement/infrastructure/cache/redis-atomic-reservation.service';
import {
  AccountClosedError,
  AccountNotFoundError,
  InsufficientFundsError,
} from '@src/modules/money-movement/domain/errors';

describe('redis atomic reservation va money movement', () => {
  describe('che do fallback cua redis atomic reservation', () => {
    it('tra ve FALLBACK khi khong co cau hinh redis', async () => {
      const service = new RedisAtomicReservationService();
      const res = await service.reserveDebit('acc-1', 'user-1', '50000');
      expect(res.status).toBe('FALLBACK');
    });

    it('tra ve FALLBACK khi so tien vuot qua gioi han so hoc an toan cua lua', async () => {
      const service = new RedisAtomicReservationService();
      const res = await service.reserveDebit('acc-1', 'user-1', '999999999999999999');
      expect(res.status).toBe('FALLBACK');
    });
  });

  describe('rut tien co lop giu tien redis', () => {
    let uow: FakeUnitOfWork;
    let reservation: jest.Mocked<BalanceReservationPort>;
    let withdrawUseCase: WithdrawMoneyUseCase;

    beforeEach(() => {
      uow = new FakeUnitOfWork();
      uow.accountsDb.set('ACC_1', {
        id: 'ACC_1',
        userId: 'USER_1',
        accountNumber: '100000000001',
        currentBalance: '100000',
        status: 'ACTIVE',
      });

      reservation = {
        seedAccount: jest.fn<BalanceReservationPort['seedAccount']>().mockResolvedValue(undefined),
        syncAccount: jest.fn<BalanceReservationPort['syncAccount']>().mockResolvedValue(undefined),
        reserveDebit: jest.fn<BalanceReservationPort['reserveDebit']>(),
        releaseDebit: jest.fn<BalanceReservationPort['releaseDebit']>().mockResolvedValue(undefined),
        markIdempotencyKey: jest.fn<BalanceReservationPort['markIdempotencyKey']>().mockResolvedValue(undefined),
        invalidate: jest.fn<BalanceReservationPort['invalidate']>().mockResolvedValue(undefined),
      };

      withdrawUseCase = new WithdrawMoneyUseCase(uow, reservation);
    });

    it('chan ngay InsufficientFundsError khi redis bao khong du tien va khong goi db', async () => {
      reservation.reserveDebit.mockResolvedValue({ status: 'INSUFFICIENT_FUNDS', remainingBalance: '20000' });
      const dbSpy = jest.spyOn(uow, 'execute');

      await expect(
        withdrawUseCase.execute({
          accountId: 'ACC_1',
          userId: 'USER_1',
          amount: '50000',
          idempotencyKey: 'wd-key-0000000001',
        }),
      ).rejects.toThrow(InsufficientFundsError);

      expect(dbSpy).not.toHaveBeenCalled();
    });

    it('chan ngay AccountNotFoundError khi redis bao sai chu tai khoan', async () => {
      reservation.reserveDebit.mockResolvedValue({ status: 'NOT_OWNER' });
      const dbSpy = jest.spyOn(uow, 'execute');

      await expect(
        withdrawUseCase.execute({
          accountId: 'ACC_1',
          userId: 'OTHER_USER',
          amount: '10000',
        }),
      ).rejects.toThrow(AccountNotFoundError);

      expect(dbSpy).not.toHaveBeenCalled();
    });

    it('chan ngay AccountClosedError khi redis bao tai khoan da dong', async () => {
      reservation.reserveDebit.mockResolvedValue({ status: 'CLOSED' });
      const dbSpy = jest.spyOn(uow, 'execute');

      await expect(
        withdrawUseCase.execute({
          accountId: 'ACC_1',
          userId: 'USER_1',
          amount: '10000',
        }),
      ).rejects.toThrow(AccountClosedError);

      expect(dbSpy).not.toHaveBeenCalled();
    });

    it('dong bo so du len redis sau khi db chay xong neu truoc do redis bi miss', async () => {
      reservation.reserveDebit.mockResolvedValue({ status: 'MISS' });

      const result = await withdrawUseCase.execute({
        accountId: 'ACC_1',
        userId: 'USER_1',
        amount: '30000',
        idempotencyKey: 'wd-key-0000000002',
      });

      expect(result.transaction.balanceAfter).toBe('70000');
      expect(reservation.markIdempotencyKey).toHaveBeenCalledWith('ACC_1', 'wd-key-0000000002');
      expect(reservation.seedAccount).toHaveBeenCalledWith({
        accountId: 'ACC_1',
        userId: 'USER_1',
        status: 'ACTIVE',
        balance: '70000',
      });
    });

    it('hoan tra tien tren redis neu luu db gap loi sau khi redis da tru', async () => {
      reservation.reserveDebit.mockResolvedValue({ status: 'OK', remainingBalance: '50000' });
      jest.spyOn(uow, 'execute').mockRejectedValue(new Error('db connection lost'));

      await expect(
        withdrawUseCase.execute({
          accountId: 'ACC_1',
          userId: 'USER_1',
          amount: '50000',
        }),
      ).rejects.toThrow('db connection lost');

      expect(reservation.releaseDebit).toHaveBeenCalledWith('ACC_1', '50000');
    });

    it('hoan tra tien tren redis neu db phat hien giao dich la replay', async () => {
      reservation.reserveDebit.mockResolvedValue({ status: 'OK', remainingBalance: '60000' });
      await withdrawUseCase.execute({
        accountId: 'ACC_1',
        userId: 'USER_1',
        amount: '40000',
        idempotencyKey: 'wd-replay-00000001',
      });

      // lan 2 gia lap redis chua co idem key nhung db da co san giao dich nay
      const replay = await withdrawUseCase.execute({
        accountId: 'ACC_1',
        userId: 'USER_1',
        amount: '40000',
        idempotencyKey: 'wd-replay-00000001',
      });

      expect(replay.isReplay).toBe(true);
      expect(reservation.releaseDebit).toHaveBeenCalledWith('ACC_1', '40000');
    });
  });

  describe('nap tien va chuyen khoan xoa cache so du cu tren redis', () => {
    it('xoa cache sau khi nap tien va chuyen khoan thanh cong', async () => {
      const uow = new FakeUnitOfWork();
      uow.accountsDb.set('ACC_A', {
        id: 'ACC_A',
        userId: 'USER_1',
        accountNumber: '100000000001',
        currentBalance: '100000',
        status: 'ACTIVE',
      });
      uow.accountsDb.set('ACC_B', {
        id: 'ACC_B',
        userId: 'USER_2',
        accountNumber: '100000000002',
        currentBalance: '0',
        status: 'ACTIVE',
      });

      const invalidate = jest.fn<BalanceReservationPort['invalidate']>().mockResolvedValue(undefined);
      const mockReservation: BalanceReservationPort = {
        seedAccount: jest.fn<BalanceReservationPort['seedAccount']>(),
        syncAccount: jest.fn<BalanceReservationPort['syncAccount']>(),
        reserveDebit: jest.fn<BalanceReservationPort['reserveDebit']>().mockResolvedValue({ status: 'FALLBACK' } as ReserveResult),
        releaseDebit: jest.fn<BalanceReservationPort['releaseDebit']>(),
        markIdempotencyKey: jest.fn<BalanceReservationPort['markIdempotencyKey']>(),
        invalidate,
      };

      const deposit = new DepositMoneyUseCase(uow, mockReservation);
      await deposit.execute({ accountId: 'ACC_A', userId: 'USER_1', amount: '50000' });
      expect(invalidate).toHaveBeenCalledWith('ACC_A');

      invalidate.mockClear();
      const transfer = new TransferMoneyUseCase(uow, mockReservation);
      await transfer.execute({
        sourceAccountId: 'ACC_A',
        destinationAccountNumber: '100000000002',
        initiatedByUserId: 'USER_1',
        amount: '30000',
        idempotencyKey: 'tf-idem-0000000001',
      });

      expect(invalidate).toHaveBeenCalledWith('ACC_A');
      expect(invalidate).toHaveBeenCalledWith('ACC_B');
    });
  });
});
