import { ListAccountsQueryHandler } from '@src/modules/accounts/application/queries/list-accounts.query';
import {
  fakeAccountQueryRepository,
  makeAccountReadModel,
} from '../../helpers/fake-account-repository';

describe('ListAccountsQueryHandler (CQRS Query)', () => {
  test('chỉ yêu cầu danh sách của user hiện tại', async () => {
    const queryRepo = fakeAccountQueryRepository();
    queryRepo.listByOwner.mockResolvedValue({
      items: [makeAccountReadModel({ userId: 'user-A' })],
      total: 1,
    });

    const result = await new ListAccountsQueryHandler(queryRepo).execute(
      'user-A',
      { status: 'ACTIVE', page: 2, limit: 10 },
    );

    expect(queryRepo.listByOwner).toHaveBeenCalledWith('user-A', {
      status: 'ACTIVE',
      page: 2,
      limit: 10,
    });
    expect(result.total).toBe(1);
  });

  test('dùng page 1 và limit 20 khi thiếu query', async () => {
    const queryRepo = fakeAccountQueryRepository();
    queryRepo.listByOwner.mockResolvedValue({
      items: [],
      total: 0,
    });

    await new ListAccountsQueryHandler(queryRepo).execute('user-A', {});

    expect(queryRepo.listByOwner).toHaveBeenCalledWith('user-A', {
      status: undefined,
      page: 1,
      limit: 20,
    });
  });

  test('từ chối page hoặc limit ngoài biên hợp lệ', () => {
    const queryRepo = fakeAccountQueryRepository();

    expect(() =>
      new ListAccountsQueryHandler(queryRepo).execute('user-A', {
        page: 0,
        limit: 20,
      }),
    ).toThrow();
    expect(() =>
      new ListAccountsQueryHandler(queryRepo).execute('user-A', {
        page: 1,
        limit: 101,
      }),
    ).toThrow();
    expect(queryRepo.listByOwner).not.toHaveBeenCalled();
  });
});
