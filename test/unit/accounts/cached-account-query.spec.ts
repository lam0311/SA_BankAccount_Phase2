import { Money } from '@src/common/domain/value-objects/money.value-object';
import { Paginated } from '@src/common/http/interceptors/response-envelope.interceptor';
import { OpenAccountHandler } from '@src/modules/accounts/application/commands/open-account.command';
import { CloseAccountHandler } from '@src/modules/accounts/application/commands/close-account.command';
import { GetAccountQueryHandler } from '@src/modules/accounts/application/queries/get-account.query';
import { ListAccountsQueryHandler } from '@src/modules/accounts/application/queries/list-accounts.query';
import { AccountLookupFacade } from '@src/modules/accounts/infrastructure/adapters/account-lookup.facade';
import { AccountCacheInvalidator } from '@src/modules/accounts/infrastructure/persistence/account-cache.invalidator';
import { CachedAccountQueryRepository } from '@src/modules/accounts/infrastructure/persistence/cached-account-query.repository';
import { AccountsController } from '@src/modules/accounts/presentation/http/accounts.controller';
import { PrismaUnitOfWork } from '@src/modules/money-movement/infrastructure/persistence/prisma-unit-of-work';
import {
  fakeAccountCache,
  fakeAccountCommandRepository,
  fakeAccountQueryRepository,
  makeAccount,
  makeAccountReadModel,
} from '../../helpers/fake-account-repository';

describe('CQRS Query Cache, Invalidator & Controller Contract', () => {
  describe('CachedAccountQueryRepository', () => {
    const makeMockCache = () => ({
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      delByPattern: jest.fn().mockResolvedValue(undefined),
    });

    test('findById: cache hit trả thẳng AccountReadModel không truy vấn DB', async () => {
      const prismaQueryRepo = fakeAccountQueryRepository();
      const cache = makeMockCache();
      const readModel = makeAccountReadModel({ currentBalance: '900000' });
      cache.get.mockResolvedValue(readModel);

      const repo = new CachedAccountQueryRepository(
        prismaQueryRepo as any,
        cache as any,
      );
      const result = await repo.findById(readModel.id);

      expect(result).toEqual(readModel);
      expect(prismaQueryRepo.findById).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    });

    test('findById & findByAccountNumber: cache miss đọc DB và lưu cache TTL 60s', async () => {
      const prismaQueryRepo = fakeAccountQueryRepository();
      const cache = makeMockCache();
      const readModel = makeAccountReadModel({ currentBalance: '150000' });
      cache.get.mockResolvedValue(null);
      prismaQueryRepo.findById.mockResolvedValue(readModel);
      prismaQueryRepo.findByAccountNumber.mockResolvedValue(readModel);

      const repo = new CachedAccountQueryRepository(
        prismaQueryRepo as any,
        cache as any,
      );

      await expect(repo.findById(readModel.id)).resolves.toEqual(readModel);
      expect(cache.set).toHaveBeenCalledWith(
        `accounts:id:${readModel.id}`,
        readModel,
        60,
      );

      await expect(
        repo.findByAccountNumber(readModel.accountNumber),
      ).resolves.toEqual(readModel);
      expect(cache.set).toHaveBeenCalledWith(
        `accounts:acc_no:${readModel.accountNumber}`,
        readModel,
        60,
      );
    });

    test('listByOwner: cache miss lưu cache TTL 30s theo user/status/page/limit', async () => {
      const prismaQueryRepo = fakeAccountQueryRepository();
      const cache = makeMockCache();
      const page = { items: [makeAccountReadModel()], total: 1 };
      cache.get.mockResolvedValue(null);
      prismaQueryRepo.listByOwner.mockResolvedValue(page);

      const repo = new CachedAccountQueryRepository(
        prismaQueryRepo as any,
        cache as any,
      );

      await expect(
        repo.listByOwner('user-A', { status: 'ACTIVE', page: 1, limit: 20 }),
      ).resolves.toEqual(page);

      expect(cache.set).toHaveBeenCalledWith(
        'accounts:user:user-A:list:ACTIVE:p1:l20',
        page,
        30,
      );
    });
  });

  describe('AccountCacheInvalidator & PrismaUnitOfWork cache sync', () => {
    test('invalidateAccount xóa đủ cả 3 nhóm key (id, acc_no, user list)', async () => {
      const cache = {
        del: jest.fn().mockResolvedValue(undefined),
        delByPattern: jest.fn().mockResolvedValue(undefined),
      };
      const invalidator = new AccountCacheInvalidator(cache as any);

      await invalidator.invalidateAccount({
        id: 'acc-1',
        userId: 'user-A',
        accountNumber: '001234567890',
      });

      expect(cache.del).toHaveBeenCalledWith('accounts:id:acc-1');
      expect(cache.del).toHaveBeenCalledWith('accounts:acc_no:001234567890');
      expect(cache.delByPattern).toHaveBeenCalledWith('accounts:user:user-A:*');
    });

    test('PrismaUnitOfWork chỉ xóa cache SAU KHI transaction commit thành công, không xóa khi rollback', async () => {
      const accountCache = fakeAccountCache();
      const mockTx = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'acc-1',
            userId: 'user-A',
            accountNumber: '001234567890',
            currentBalance: '100000',
            status: 'ACTIVE',
          },
        ]),
        bankAccount: {
          update: jest.fn().mockResolvedValue({}),
        },
      };
      const mockPrisma = {
        $transaction: jest.fn((cb: any) => cb(mockTx)),
      };

      const uow = new PrismaUnitOfWork(mockPrisma as any, accountCache);

      // 1. Thành công -> xóa cache
      await uow.execute(async (ctx) => {
        await ctx.accounts.lockForUpdate('acc-1');
        await ctx.accounts.updateBalance('acc-1', '200000');
      });
      expect(accountCache.invalidateAccount).toHaveBeenCalledWith({
        id: 'acc-1',
        userId: 'user-A',
        accountNumber: '001234567890',
      });

      // 2. Rollback (throw giữa chừng) -> KHÔNG xóa cache
      accountCache.invalidateAccount.mockClear();
      await expect(
        uow.execute(async (ctx) => {
          await ctx.accounts.lockForUpdate('acc-1');
          await ctx.accounts.updateBalance('acc-1', '300000');
          throw new Error('DB failure before commit');
        }),
      ).rejects.toThrow('DB failure before commit');
      expect(accountCache.invalidateAccount).not.toHaveBeenCalled();
    });
  });

  describe('AccountsController & AccountLookupFacade backward compatibility', () => {
    test('AccountsController bảo toàn 100% cấu trúc response của cả Command và Query (ẩn userId nội bộ)', async () => {
      const commandRepo = fakeAccountCommandRepository();
      const queryRepo = fakeAccountQueryRepository();
      const cache = fakeAccountCache();

      const controller = new AccountsController(
        new OpenAccountHandler(commandRepo, cache),
        new ListAccountsQueryHandler(queryRepo),
        new GetAccountQueryHandler(queryRepo),
        new CloseAccountHandler(commandRepo, cache),
      );

      const domainAcc = makeAccount({
        currentBalance: Money.fromString('500000'),
      });
      const readModel = makeAccountReadModel({ currentBalance: '500000' });

      commandRepo.createWithOpeningDeposit.mockResolvedValue(domainAcc);
      queryRepo.findById.mockResolvedValue(readModel);
      queryRepo.listByOwner.mockResolvedValue({ items: [readModel], total: 1 });
      commandRepo.findById.mockResolvedValue(makeAccount());
      commandRepo.closeIfZeroBalance.mockResolvedValue(true);

      const created = await controller.create({ sub: 'user-A' } as any, {
        accountName: 'Tài khoản chính',
        accountType: 'PAYMENT',
        initialDeposit: '500000',
      });
      const fetched = await controller.get({ sub: 'user-A' } as any, {
        accountId: readModel.id,
      });
      const listed = await controller.list({ sub: 'user-A' } as any, {});

      // Command response và Query response phải khớp nhau tuyệt đối và KHÔNG lộ userId
      expect(created).toEqual(fetched);
      expect((fetched as any).userId).toBeUndefined();
      expect(listed).toBeInstanceOf(Paginated);
      expect(listed.items[0]).toEqual(fetched);

      await expect(
        controller.close({ sub: 'user-A' } as any, { accountId: domainAcc.id }),
      ).resolves.toBeUndefined();
    });

    test('AccountLookupFacade đọc qua Query Repository và trả đúng AccountLookupResult', async () => {
      const queryRepo = fakeAccountQueryRepository();
      const readModel = makeAccountReadModel();
      queryRepo.findByAccountNumber.mockResolvedValue(readModel);

      const facade = new AccountLookupFacade(queryRepo);
      await expect(
        facade.findByAccountNumber(readModel.accountNumber),
      ).resolves.toEqual({
        id: readModel.id,
        accountNumber: readModel.accountNumber,
        currency: 'VND',
        status: 'ACTIVE',
      });
    });
  });
});
