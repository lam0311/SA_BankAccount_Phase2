import { Money } from '@src/common/domain/value-objects/money.value-object';
import { OpenAccountHandler } from '@src/modules/accounts/application/commands/open-account.command';
import {
  fakeAccountCache,
  fakeAccountCommandRepository,
  makeAccount,
} from '../../helpers/fake-account-repository';

describe('OpenAccountHandler (CQRS Command)', () => {
  test('tạo account cho user hiện tại, giữ nguyên số tiền và xóa cache danh sách của user', async () => {
    const commandRepo = fakeAccountCommandRepository();
    const cache = fakeAccountCache();
    commandRepo.createWithOpeningDeposit.mockResolvedValue(
      makeAccount({
        currentBalance: Money.fromString('500000'),
      }),
    );

    await new OpenAccountHandler(commandRepo, cache).execute('user-A', {
      accountName: '  Tài khoản chính  ',
      accountType: 'PAYMENT',
      initialDeposit: '500000',
    });

    expect(commandRepo.createWithOpeningDeposit).toHaveBeenCalledWith({
      userId: 'user-A',
      accountName: 'Tài khoản chính',
      accountType: 'PAYMENT',
      initialDeposit: Money.fromString('500000'),
    });
    expect(cache.invalidateUserLists).toHaveBeenCalledWith('user-A');
  });

  test.each(['-1', '1.5', '', 'abc'])(
    'từ chối initialDeposit không hợp lệ: %s',
    async (initialDeposit) => {
      const commandRepo = fakeAccountCommandRepository();
      const cache = fakeAccountCache();

      await expect(
        new OpenAccountHandler(commandRepo, cache).execute('user-A', {
          accountName: 'Tài khoản chính',
          accountType: 'PAYMENT',
          initialDeposit,
        }),
      ).rejects.toMatchObject({ httpStatus: 400 });

      expect(commandRepo.createWithOpeningDeposit).not.toHaveBeenCalled();
      expect(cache.invalidateUserLists).not.toHaveBeenCalled();
    },
  );

  test('cho phép initialDeposit bằng 0', async () => {
    const commandRepo = fakeAccountCommandRepository();
    commandRepo.createWithOpeningDeposit.mockResolvedValue(makeAccount());

    await new OpenAccountHandler(commandRepo).execute('user-A', {
      accountName: 'Tài khoản chính',
      accountType: 'PAYMENT',
      initialDeposit: '0',
    });

    expect(commandRepo.createWithOpeningDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        initialDeposit: Money.zero(),
      }),
    );
  });
});
