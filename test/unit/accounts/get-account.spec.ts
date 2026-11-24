import { GetAccountQueryHandler } from '@src/modules/accounts/application/queries/get-account.query';
import {
  fakeAccountQueryRepository,
  makeAccountReadModel,
} from '../../helpers/fake-account-repository';

describe('GetAccountQueryHandler (CQRS Query)', () => {
  test('user A không đọc được account của B', async () => {
    const queryRepo = fakeAccountQueryRepository();
    const accountB = makeAccountReadModel({ userId: 'user-B' });
    queryRepo.findById.mockResolvedValue(accountB);

    await expect(
      new GetAccountQueryHandler(queryRepo).execute('user-A', accountB.id),
    ).rejects.toMatchObject({
      errorCode: 'ACCOUNT_NOT_FOUND',
      httpStatus: 404,
    });
  });

  test('account không tồn tại cũng trả cùng lỗi 404', async () => {
    const queryRepo = fakeAccountQueryRepository();
    queryRepo.findById.mockResolvedValue(null);

    await expect(
      new GetAccountQueryHandler(queryRepo).execute(
        'user-A',
        '550e8400-e29b-41d4-a716-446655440099',
      ),
    ).rejects.toMatchObject({
      errorCode: 'ACCOUNT_NOT_FOUND',
      httpStatus: 404,
    });
  });

  test('chủ account đọc được Read Model của account', async () => {
    const queryRepo = fakeAccountQueryRepository();
    const ownAccount = makeAccountReadModel({
      userId: 'user-A',
      currentBalance: '250000',
    });
    queryRepo.findById.mockResolvedValue(ownAccount);

    await expect(
      new GetAccountQueryHandler(queryRepo).execute('user-A', ownAccount.id),
    ).resolves.toEqual(ownAccount);
  });
});
