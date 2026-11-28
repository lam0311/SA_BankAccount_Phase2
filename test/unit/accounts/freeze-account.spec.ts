import { describe, it, expect, jest } from '@jest/globals';
import { FreezeAccountHandler } from '@src/modules/accounts/application/commands/freeze-account.command';
import { UnfreezeAccountHandler } from '@src/modules/accounts/application/commands/unfreeze-account.command';
import { AccountAlreadyClosedError } from '@src/modules/accounts/domain/errors/account-closed.error';
import { AccountNotFoundError } from '@src/modules/accounts/domain/errors/account-not-found.error';
import type {
  BalanceReservationPort,
  WithdrawSettlementPort,
} from '@src/modules/money-movement/application/ports/balance-reservation.port';
import {
  fakeAccountCommandRepository,
  makeAccount,
} from '../../helpers/fake-account-repository';

describe('dong bang va mo khoa tai khoan', () => {
  it('chuyen trang thai active sang frozen, xoa cache redis va xa hang doi rut', async () => {
    const repo = fakeAccountCommandRepository();
    const active = makeAccount({ id: 'acc-1', userId: 'u-1', status: 'ACTIVE' });
    const frozen = makeAccount({ id: 'acc-1', userId: 'u-1', status: 'FROZEN' });
    repo.findById.mockResolvedValueOnce(active);
    repo.updateStatus.mockResolvedValueOnce(frozen);

    const calls: string[] = [];
    const reservation = {
      invalidate: jest.fn(async (id: string) => {
        calls.push(`inv:${id}`);
      }),
    } as unknown as BalanceReservationPort;
    const settlement: WithdrawSettlementPort = {
      flush: jest.fn(async () => {
        calls.push('flush');
        return 0;
      }),
    };

    const handler = new FreezeAccountHandler(repo, reservation, settlement);
    const result = await handler.execute('u-1', 'acc-1');

    expect(result.status).toBe('FROZEN');
    expect(repo.updateStatus).toHaveBeenCalledWith('acc-1', 'u-1', 'ACTIVE', 'FROZEN');
    expect(calls).toEqual(['inv:acc-1', 'flush', 'inv:acc-1']);
  });

  it('tra ve luon neu tai khoan da o trang thai frozen va chan tai khoan da dong', async () => {
    const repo = fakeAccountCommandRepository();
    const frozen = makeAccount({ id: 'acc-1', userId: 'u-1', status: 'FROZEN' });
    const closed = makeAccount({ id: 'acc-2', userId: 'u-1', status: 'CLOSED' });
    repo.findById.mockResolvedValueOnce(frozen).mockResolvedValueOnce(closed);

    const handler = new FreezeAccountHandler(repo);
    const same = await handler.execute('u-1', 'acc-1');
    expect(same.status).toBe('FROZEN');
    expect(repo.updateStatus).not.toHaveBeenCalled();

    await expect(handler.execute('u-1', 'acc-2')).rejects.toThrow(AccountAlreadyClosedError);
  });

  it('chuyen frozen ve active khi mo khoa va chan nguoi khong so huu', async () => {
    const repo = fakeAccountCommandRepository();
    const frozen = makeAccount({ id: 'acc-1', userId: 'u-1', status: 'FROZEN' });
    const active = makeAccount({ id: 'acc-1', userId: 'u-1', status: 'ACTIVE' });
    repo.findById.mockResolvedValueOnce(frozen).mockResolvedValueOnce(frozen);
    repo.updateStatus.mockResolvedValueOnce(active);

    const handler = new UnfreezeAccountHandler(repo);
    const result = await handler.execute('u-1', 'acc-1');
    expect(result.status).toBe('ACTIVE');

    await expect(handler.execute('u-other', 'acc-1')).rejects.toThrow(AccountNotFoundError);
  });
});
