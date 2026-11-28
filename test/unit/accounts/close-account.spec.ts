import { Money } from '@src/common/domain/value-objects/money.value-object';
import { CloseAccountHandler } from '@src/modules/accounts/application/commands/close-account.command';
import {
  fakeAccountCommandRepository,
  makeAccount,
} from '../../helpers/fake-account-repository';

describe('CloseAccountHandler (CQRS Command)', () => {
  test('chủ tài khoản đóng được account có số dư 0 (sự kiện xóa cache do Command Repo + Outbox phát)', async () => {
    const commandRepo = fakeAccountCommandRepository();
    const account = makeAccount();
    commandRepo.findById.mockResolvedValue(account);
    commandRepo.closeIfZeroBalance.mockResolvedValue(true);

    await expect(
      new CloseAccountHandler(commandRepo).execute('user-A', account.id),
    ).resolves.toBeUndefined();

    expect(commandRepo.closeIfZeroBalance).toHaveBeenCalledWith(
      account.id,
      'user-A',
    );
  });

  test('account không tồn tại trả 404', async () => {
    const commandRepo = fakeAccountCommandRepository();
    commandRepo.findById.mockResolvedValue(null);

    await expect(
      new CloseAccountHandler(commandRepo).execute('user-A', 'missing-id'),
    ).rejects.toMatchObject({
      errorCode: 'ACCOUNT_NOT_FOUND',
      httpStatus: 404,
    });

    expect(commandRepo.closeIfZeroBalance).not.toHaveBeenCalled();
  });

  test('user A không đóng được account của B', async () => {
    const commandRepo = fakeAccountCommandRepository();
    const accountB = makeAccount({ userId: 'user-B' });
    commandRepo.findById.mockResolvedValue(accountB);

    await expect(
      new CloseAccountHandler(commandRepo).execute('user-A', accountB.id),
    ).rejects.toMatchObject({
      errorCode: 'ACCOUNT_NOT_FOUND',
      httpStatus: 404,
    });

    expect(commandRepo.closeIfZeroBalance).not.toHaveBeenCalled();
  });

  test('account còn tiền trả 409', async () => {
    const commandRepo = fakeAccountCommandRepository();
    const account = makeAccount({
      currentBalance: Money.fromString('500000'),
    });
    commandRepo.findById.mockResolvedValue(account);

    await expect(
      new CloseAccountHandler(commandRepo).execute('user-A', account.id),
    ).rejects.toMatchObject({
      errorCode: 'ACCOUNT_HAS_BALANCE',
      httpStatus: 409,
    });

    expect(commandRepo.closeIfZeroBalance).not.toHaveBeenCalled();
  });

  test('DELETE lặp lại trên account đã CLOSED trả thành công', async () => {
    const commandRepo = fakeAccountCommandRepository();
    const account = makeAccount({
      status: 'CLOSED',
      closedAt: new Date(),
    });
    commandRepo.findById.mockResolvedValue(account);

    await expect(
      new CloseAccountHandler(commandRepo).execute('user-A', account.id),
    ).resolves.toBeUndefined();

    expect(commandRepo.closeIfZeroBalance).not.toHaveBeenCalled();
  });

  test('nếu số dư đổi sau lần đọc đầu, đọc lại trực tiếp từ Command Repo (Primary DB) và trả đúng 409', async () => {
    const commandRepo = fakeAccountCommandRepository();
    const account = makeAccount();

    commandRepo.findById
      .mockResolvedValueOnce(account)
      .mockResolvedValueOnce(
        makeAccount({
          currentBalance: Money.fromString('1000'),
        }),
      );
    commandRepo.closeIfZeroBalance.mockResolvedValue(false);

    await expect(
      new CloseAccountHandler(commandRepo).execute('user-A', account.id),
    ).rejects.toMatchObject({
      errorCode: 'ACCOUNT_HAS_BALANCE',
      httpStatus: 409,
    });
  });
});
