import { describe, it, expect, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { RedisRiskControlService } from '@src/modules/money-movement/infrastructure/risk/redis-risk-control.service';
import { WithdrawMoneyUseCase } from '@src/modules/money-movement/application/use-cases/withdraw-money.use-case';
import { TransferMoneyUseCase } from '@src/modules/money-movement/application/use-cases/transfer-money.use-case';
import type { RiskControlPort } from '@src/modules/money-movement/application/ports/risk-control.port';
import type { BalanceReservationPort } from '@src/modules/money-movement/application/ports/balance-reservation.port';
import {
  AccountFrozenError,
  DailyLimitExceededError,
  InsufficientFundsError,
  VelocityLimitExceededError,
} from '@src/modules/money-movement/domain/errors';
import { FakeUnitOfWork } from '../../helpers/fakes/fake-unit-of-work';

type AnyAsyncFn = (...args: any[]) => Promise<any>;

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('kiem soat han muc ngay, velocity va trang thai frozen', () => {
  describe('RedisRiskControlService', () => {
    it('bo qua kiem tra khi RISK_CONTROL_ENABLED=false', async () => {
      const service = new RedisRiskControlService(
        undefined,
        makeConfig({ RISK_CONTROL_ENABLED: 'false' }),
      );
      const res = await service.checkAndConsumeOutflow('acc-1', '100000');
      expect(res.status).toBe('SKIPPED');
    });

    it('tra ve OK, DAILY_LIMIT_EXCEEDED va VELOCITY_LIMIT_EXCEEDED tu ket qua lua', async () => {
      const service = new RedisRiskControlService(
        undefined,
        makeConfig({
          RISK_CONTROL_ENABLED: 'true',
          DAILY_OUTFLOW_LIMIT_VND: '100000',
          VELOCITY_MAX_TX: 2,
          VELOCITY_WINDOW_SECONDS: 60,
        }),
      );

      const evalMock = jest
        .fn<AnyAsyncFn>()
        .mockResolvedValueOnce(['OK', '50000'])
        .mockResolvedValueOnce(['DAILY_LIMIT_EXCEEDED', '50000'])
        .mockResolvedValueOnce(['VELOCITY_LIMIT_EXCEEDED', '2']);

      (service as any).redis = { status: 'ready', eval: evalMock };

      const ok = await service.checkAndConsumeOutflow('acc-1', '50000');
      expect(ok.status).toBe('OK');
      expect(ok.dailySpent).toBe('50000');
      expect(ok.memberId).toBeTruthy();

      const daily = await service.checkAndConsumeOutflow('acc-1', '60000');
      expect(daily.status).toBe('DAILY_LIMIT_EXCEEDED');

      const vel = await service.checkAndConsumeOutflow('acc-1', '1000');
      expect(vel.status).toBe('VELOCITY_LIMIT_EXCEEDED');
      expect(vel.velocityCount).toBe(2);
    });

    it('goi lua hoan tac khi releaseOutflow duoc goi', async () => {
      const service = new RedisRiskControlService(undefined, makeConfig({}));
      const evalMock = jest.fn<AnyAsyncFn>().mockResolvedValue(1);
      (service as any).redis = { status: 'ready', eval: evalMock };

      await service.releaseOutflow('acc-1', '50000', 'member-1');
      expect(evalMock).toHaveBeenCalledTimes(1);
      expect(evalMock.mock.calls[0]).toContain('50000');
      expect(evalMock.mock.calls[0]).toContain('member-1');
    });
  });

  describe('WithdrawMoneyUseCase voi risk control va frozen', () => {
    it('chan rut tien khi vuot han muc ngay hoac vuot velocity', async () => {
      const uow = new FakeUnitOfWork();
      const riskControl: RiskControlPort = {
        checkAndConsumeOutflow: jest
          .fn<RiskControlPort['checkAndConsumeOutflow']>()
          .mockResolvedValueOnce({ status: 'DAILY_LIMIT_EXCEEDED', dailySpent: '500000000' })
          .mockResolvedValueOnce({ status: 'VELOCITY_LIMIT_EXCEEDED', velocityCount: 10 }),
        releaseOutflow: jest.fn<RiskControlPort['releaseOutflow']>(),
      };

      const useCase = new WithdrawMoneyUseCase(uow, undefined, undefined, riskControl);

      await expect(
        useCase.execute({ accountId: 'A', userId: 'U1', amount: '10000' }),
      ).rejects.toThrow(DailyLimitExceededError);

      await expect(
        useCase.execute({ accountId: 'A', userId: 'U1', amount: '10000' }),
      ).rejects.toThrow(VelocityLimitExceededError);
    });

    it('tu choi rut tien tren tai khoan frozen, giu nguyen so du va hoan tac han muc', async () => {
      const uow = new FakeUnitOfWork();
      uow.accountsDb.set('A', {
        id: 'A',
        userId: 'U1',
        accountNumber: '111111111111',
        currentBalance: '100000',
        status: 'FROZEN',
      });

      const releaseOutflow = jest.fn<RiskControlPort['releaseOutflow']>();
      const riskControl: RiskControlPort = {
        checkAndConsumeOutflow: jest
          .fn<RiskControlPort['checkAndConsumeOutflow']>()
          .mockResolvedValue({ status: 'OK', memberId: 'm-1' }),
        releaseOutflow,
      };

      const useCase = new WithdrawMoneyUseCase(uow, undefined, undefined, riskControl);

      await expect(
        useCase.execute({ accountId: 'A', userId: 'U1', amount: '20000' }),
      ).rejects.toThrow(AccountFrozenError);

      expect(uow.accountsDb.get('A')?.currentBalance).toBe('100000');
      expect(releaseOutflow).toHaveBeenCalledWith('A', '20000', 'm-1');
    });

    it('hoan tac han muc khi gap loi thieu so du hoac replay tren redis', async () => {
      const uow = new FakeUnitOfWork();
      const releaseOutflow = jest.fn<RiskControlPort['releaseOutflow']>();
      const riskControl: RiskControlPort = {
        checkAndConsumeOutflow: jest
          .fn<RiskControlPort['checkAndConsumeOutflow']>()
          .mockResolvedValueOnce({ status: 'OK', memberId: 'm-insuff' })
          .mockResolvedValueOnce({ status: 'OK', memberId: 'm-replay' }),
        releaseOutflow,
      };

      const cachedTx = {
        id: 'tx-1',
        accountId: 'A',
        transferId: null,
        transactionType: 'DEBIT' as const,
        referenceType: 'CASH_WITHDRAWAL' as const,
        amount: '10000',
        balanceAfter: '90000',
        status: 'COMPLETED',
        description: null,
        idempotencyKey: 'k-1',
        createdAt: new Date(),
      };

      const reservation: BalanceReservationPort = {
        seedAccount: jest.fn<BalanceReservationPort['seedAccount']>(),
        syncAccount: jest.fn<BalanceReservationPort['syncAccount']>(),
        reserveDebit: jest
          .fn<BalanceReservationPort['reserveDebit']>()
          .mockResolvedValueOnce({ status: 'INSUFFICIENT_FUNDS' })
          .mockResolvedValueOnce({ status: 'REPLAY', replayedTransaction: cachedTx }),
        releaseDebit: jest.fn<BalanceReservationPort['releaseDebit']>(),
        markIdempotencyKey: jest.fn<BalanceReservationPort['markIdempotencyKey']>(),
        invalidate: jest.fn<BalanceReservationPort['invalidate']>(),
      };

      const useCase = new WithdrawMoneyUseCase(uow, reservation, undefined, riskControl);

      await expect(
        useCase.execute({ accountId: 'A', userId: 'U1', amount: '999999' }),
      ).rejects.toThrow(InsufficientFundsError);
      expect(releaseOutflow).toHaveBeenCalledWith('A', '999999', 'm-insuff');

      const replay = await useCase.execute({
        accountId: 'A',
        userId: 'U1',
        amount: '10000',
        idempotencyKey: 'k-1',
      });
      expect(replay.isReplay).toBe(true);
      expect(releaseOutflow).toHaveBeenCalledWith('A', '10000', 'm-replay');
    });
  });

  describe('TransferMoneyUseCase voi risk control va frozen', () => {
    it('chan chuyen khoan khi tai khoan nguon bi frozen va bao toan so du', async () => {
      const uow = new FakeUnitOfWork();
      uow.accountsDb.set('A', {
        id: 'A',
        userId: 'U1',
        accountNumber: '111111111111',
        currentBalance: '500000',
        status: 'FROZEN',
      });
      uow.accountsDb.set('B', {
        id: 'B',
        userId: 'U2',
        accountNumber: '222222222222',
        currentBalance: '100000',
        status: 'ACTIVE',
      });

      const riskControl: RiskControlPort = {
        checkAndConsumeOutflow: jest.fn<RiskControlPort['checkAndConsumeOutflow']>(),
        releaseOutflow: jest.fn<RiskControlPort['releaseOutflow']>(),
      };

      const useCase = new TransferMoneyUseCase(uow, undefined, undefined, riskControl);

      await expect(
        useCase.execute({
          sourceAccountId: 'A',
          destinationAccountNumber: '222222222222',
          initiatedByUserId: 'U1',
          amount: '50000',
          idempotencyKey: 'tf-frozen-0001',
        }),
      ).rejects.toThrow(AccountFrozenError);

      expect(uow.accountsDb.get('A')?.currentBalance).toBe('500000');
      expect(uow.accountsDb.get('B')?.currentBalance).toBe('100000');
      expect(riskControl.checkAndConsumeOutflow).not.toHaveBeenCalled();
    });

    it('chan chuyen khoan khi vuot han muc ngay hoac velocity', async () => {
      const uow = new FakeUnitOfWork();
      uow.accountsDb.set('A', {
        id: 'A',
        userId: 'U1',
        accountNumber: '111111111111',
        currentBalance: '500000',
        status: 'ACTIVE',
      });
      uow.accountsDb.set('B', {
        id: 'B',
        userId: 'U2',
        accountNumber: '222222222222',
        currentBalance: '0',
        status: 'ACTIVE',
      });

      const riskControl: RiskControlPort = {
        checkAndConsumeOutflow: jest
          .fn<RiskControlPort['checkAndConsumeOutflow']>()
          .mockResolvedValueOnce({ status: 'DAILY_LIMIT_EXCEEDED' })
          .mockResolvedValueOnce({ status: 'VELOCITY_LIMIT_EXCEEDED' }),
        releaseOutflow: jest.fn<RiskControlPort['releaseOutflow']>(),
      };

      const useCase = new TransferMoneyUseCase(uow, undefined, undefined, riskControl);

      await expect(
        useCase.execute({
          sourceAccountId: 'A',
          destinationAccountNumber: '222222222222',
          initiatedByUserId: 'U1',
          amount: '50000',
          idempotencyKey: 'tf-limit-0001',
        }),
      ).rejects.toThrow(DailyLimitExceededError);

      await expect(
        useCase.execute({
          sourceAccountId: 'A',
          destinationAccountNumber: '222222222222',
          initiatedByUserId: 'U1',
          amount: '50000',
          idempotencyKey: 'tf-vel-0001',
        }),
      ).rejects.toThrow(VelocityLimitExceededError);

      expect(uow.accountsDb.get('A')?.currentBalance).toBe('500000');
    });
  });
});
