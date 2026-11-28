import { Money } from '@src/common/domain/value-objects/money.value-object';
import { ACCOUNT_EVENTS } from '@src/common/events';
import {
  CACHE_INVALIDATION_CHANNEL,
  MultiLevelCacheService,
} from '@src/infrastructure/cache/multi-level-cache.service';
import {
  InProcessEventBus,
  OutboxRelayWorker,
  OutboxService,
} from '@src/infrastructure/outbox';
import { AccountCacheInvalidationSubscriber } from '@src/modules/accounts/infrastructure/events/account-cache-invalidation.subscriber';
import { AccountCacheInvalidator } from '@src/modules/accounts/infrastructure/persistence/account-cache.invalidator';
import { PrismaAccountCommandRepository } from '@src/modules/accounts/infrastructure/persistence/prisma-account-command.repository';
import { PrismaUnitOfWork } from '@src/modules/money-movement/infrastructure/persistence/prisma-unit-of-work';
import { fakeAccountCache } from '../../helpers/fake-account-repository';

const mockRedisFactory = jest.fn();

jest.mock('ioredis', () => ({
  __esModule: true,
  default: function MockRedis(...args: unknown[]) {
    return mockRedisFactory(...args);
  },
}));

function createMockRedisPair() {
  const messageListeners: Array<(channel: string, message: string) => void> = [];

  const subscriber: Record<string, any> = {
    status: 'ready',
    on: jest.fn((event: string, listener: any): any => {
      if (event === 'message') {
        messageListeners.push(listener);
      }
      return subscriber;
    }),
    connect: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
  };

  const client = {
    status: 'ready',
    on: jest.fn().mockReturnThis(),
    connect: jest.fn().mockResolvedValue(undefined),
    duplicate: jest.fn(() => subscriber),
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    scan: jest.fn().mockResolvedValue(['0', []]),
    unlink: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
  };

  return { client, subscriber, messageListeners };
}

describe('Event-Driven Cache Invalidation (Outbox + Subscriber + Redis Pub/Sub + SCAN)', () => {
  beforeEach(() => {
    mockRedisFactory.mockReset();
  });

  describe('AccountCacheInvalidationSubscriber & InProcessEventBus', () => {
    test('lắng nghe account.opened, account.closed, account.balance_changed và xóa đúng nhóm key cache với throwOnError: true', async () => {
      const eventBus = new InProcessEventBus();
      const accountCache = fakeAccountCache();
      const subscriber = new AccountCacheInvalidationSubscriber(
        eventBus,
        accountCache,
      );
      subscriber.onModuleInit();

      // 1. Mở tài khoản -> chỉ xóa danh sách của user
      await eventBus.publish({
        id: 'evt-open',
        aggregateType: 'BankAccount',
        aggregateId: 'acc-1',
        eventType: ACCOUNT_EVENTS.OPENED,
        payload: {
          accountId: 'acc-1',
          userId: 'user-A',
          accountNumber: '000111222333',
        },
        occurredAt: new Date().toISOString(),
      });
      expect(accountCache.invalidateUserLists).toHaveBeenCalledWith('user-A', {
        throwOnError: true,
      });

      // 2. Biến động số dư chuyển khoản (2 tài khoản nguồn + đích) -> xóa đủ cả 2 tài khoản
      await eventBus.publish({
        id: 'evt-transfer',
        aggregateType: 'BankAccount',
        aggregateId: 'acc-1',
        eventType: ACCOUNT_EVENTS.BALANCE_CHANGED,
        payload: {
          accounts: [
            {
              accountId: 'acc-1',
              userId: 'user-A',
              accountNumber: '000111222333',
            },
            {
              accountId: 'acc-2',
              userId: 'user-B',
              accountNumber: '000444555666',
            },
          ],
        },
        occurredAt: new Date().toISOString(),
      });
      expect(accountCache.invalidateAccount).toHaveBeenCalledWith(
        {
          id: 'acc-1',
          userId: 'user-A',
          accountNumber: '000111222333',
        },
        { throwOnError: true },
      );
      expect(accountCache.invalidateAccount).toHaveBeenCalledWith(
        {
          id: 'acc-2',
          userId: 'user-B',
          accountNumber: '000444555666',
        },
        { throwOnError: true },
      );

      // 3. Đóng tài khoản -> xóa tài khoản đó
      accountCache.invalidateAccount.mockClear();
      await eventBus.publish({
        id: 'evt-close',
        aggregateType: 'BankAccount',
        aggregateId: 'acc-1',
        eventType: ACCOUNT_EVENTS.CLOSED,
        payload: {
          accountId: 'acc-1',
          userId: 'user-A',
          accountNumber: '000111222333',
        },
        occurredAt: new Date().toISOString(),
      });
      expect(accountCache.invalidateAccount).toHaveBeenCalledWith(
        {
          id: 'acc-1',
          userId: 'user-A',
          accountNumber: '000111222333',
        },
        { throwOnError: true },
      );

      // Hủy đăng ký khi module destroy
      subscriber.onModuleDestroy();
      accountCache.invalidateAccount.mockClear();
      await eventBus.publish({
        id: 'evt-after-destroy',
        aggregateType: 'BankAccount',
        aggregateId: 'acc-1',
        eventType: ACCOUNT_EVENTS.CLOSED,
        payload: {
          accountId: 'acc-1',
          userId: 'user-A',
          accountNumber: '000111222333',
        },
        occurredAt: new Date().toISOString(),
      });
      expect(accountCache.invalidateAccount).not.toHaveBeenCalled();
    });
  });

  describe('OutboxService & OutboxRelayWorker (Fault Tolerance & Auto Retry)', () => {
    test('khi Redis sập tạm thời, giao dịch chính KHÔNG bị lỗi, sự kiện giữ nguyên processed_at=null và được OutboxRelayWorker tự động retry khi Redis sống lại', async () => {
      const eventBus = new InProcessEventBus();
      const accountCache = fakeAccountCache();
      const subscriber = new AccountCacheInvalidationSubscriber(
        eventBus,
        accountCache,
      );
      subscriber.onModuleInit();

      // In-memory giả lập bảng outbox_events trên PostgreSQL
      const outboxTable = new Map<string, any>();

      const outboxEventDelegate = {
        updateMany: jest.fn(async ({ where, data }: any) => {
          const row = outboxTable.get(where.id);
          if (!row || (where.processedAt === null && row.processedAt !== null)) {
            return { count: 0 };
          }
          if (data.processedAt !== undefined) row.processedAt = data.processedAt;
          if (data.lastError !== undefined) row.lastError = data.lastError;
          if (data.retryCount?.increment) {
            row.retryCount += data.retryCount.increment;
          }
          return { count: 1 };
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const row = outboxTable.get(where.id);
          if (data.processedAt !== undefined) row.processedAt = data.processedAt;
          if (data.lastError !== undefined) row.lastError = data.lastError;
          if (data.retryCount?.increment) {
            row.retryCount += data.retryCount.increment;
          }
          return row;
        }),
      };

      const mockPrisma: Record<string, any> = {
        outboxEvent: outboxEventDelegate,
        $transaction: jest.fn(async (cb: any): Promise<any> => {
          const tx: Record<string, any> = {
            $queryRaw: jest.fn(async () =>
              Array.from(outboxTable.values()).filter(
                (r) => r.processedAt === null,
              ),
            ),
            outboxEvent: {
              ...outboxEventDelegate,
              create: jest.fn(async ({ data }: any) => {
                const record = {
                  id: 'outbox-1',
                  aggregateType: data.aggregateType,
                  aggregateId: data.aggregateId,
                  eventType: data.eventType,
                  payload: data.payload,
                  retryCount: 0,
                  lastError: null,
                  createdAt: new Date('2026-11-25T05:00:00.000Z'),
                  processedAt: null,
                };
                outboxTable.set(record.id, record);
                return record;
              }),
            },
            bankAccount: {
              update: jest.fn().mockResolvedValue({}),
              findMany: jest.fn().mockResolvedValue([
                {
                  id: 'acc-1',
                  userId: 'user-A',
                  accountNumber: '000111222333',
                },
              ]),
            },
          };
          return cb(tx);
        }),
      };

      const outboxService = new OutboxService(mockPrisma as any, eventBus);
      const worker = new OutboxRelayWorker(mockPrisma as any, eventBus);
      const uow = new PrismaUnitOfWork(mockPrisma as any, outboxService);

      // Giả lập Redis bị đứt mạng ngay lúc vừa COMMIT DB
      accountCache.invalidateAccount.mockRejectedValueOnce(
        new Error('ECONNREFUSED Redis down'),
      );

      // Giao dịch tiền tệ vẫn thành công bình thường, KHÔNG ném lỗi về phía khách hàng
      await expect(
        uow.execute(async (ctx) => {
          await ctx.accounts.updateBalance('acc-1', '900000');
        }),
      ).resolves.toBeUndefined();

      // Sự kiện vẫn nằm trong outbox_events với processedAt = null và retryCount = 1
      const pendingRow = outboxTable.get('outbox-1');
      expect(pendingRow.processedAt).toBeNull();
      expect(pendingRow.retryCount).toBe(1);
      expect(pendingRow.lastError).toContain('ECONNREFUSED Redis down');

      // Khi Redis phục hồi, OutboxRelayWorker quét lại và xóa cache thành công
      accountCache.invalidateAccount.mockResolvedValueOnce(undefined);
      const processedCount = await worker.pollOnce();

      expect(processedCount).toBe(1);
      expect(accountCache.invalidateAccount).toHaveBeenCalledTimes(2);
      expect(outboxTable.get('outbox-1').processedAt).toBeInstanceOf(Date);
      expect(outboxTable.get('outbox-1').lastError).toBeNull();

      await worker.onModuleDestroy();
      subscriber.onModuleDestroy();
    });
  });

  describe('PrismaAccountCommandRepository atomic Outbox recording', () => {
    test('createWithOpeningDeposit và closeIfZeroBalance ghi sự kiện vào outbox_events trong cùng transaction', async () => {
      const outboxCreates: any[] = [];
      const mockTx = {
        bankAccount: {
          create: jest.fn(async ({ data }: any) => ({
            id: 'acc-new',
            userId: 'user-A',
            accountNumber: data.accountNumber,
            accountName: data.accountName,
            accountType: data.accountType,
            currentBalance: '100000',
            currency: 'VND',
            status: 'ACTIVE',
            createdAt: new Date('2026-11-25T05:00:00.000Z'),
            closedAt: null,
          })),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            id: 'acc-new',
            userId: 'user-A',
            accountNumber: '000999888777',
          }),
        },
        financialTransaction: {
          create: jest.fn().mockResolvedValue({}),
        },
        outboxEvent: {
          create: jest.fn(async ({ data }: any) => {
            const rec = {
              id: `evt-${outboxCreates.length + 1}`,
              ...data,
              createdAt: new Date(),
            };
            outboxCreates.push(rec);
            return rec;
          }),
        },
      };

      const mockPrisma = {
        $transaction: jest.fn((cb: any) => cb(mockTx)),
      };
      const mockOutbox = {
        dispatchCommitted: jest.fn().mockResolvedValue(undefined),
      };

      const repo = new PrismaAccountCommandRepository(
        mockPrisma as any,
        mockOutbox as any,
      );

      await repo.createWithOpeningDeposit({
        userId: 'user-A',
        accountName: 'TK Thanh Toán',
        accountType: 'PAYMENT',
        initialDeposit: Money.fromString('100000'),
      });

      expect(outboxCreates[0]).toMatchObject({
        eventType: ACCOUNT_EVENTS.OPENED,
        aggregateId: 'acc-new',
      });

      await expect(
        repo.closeIfZeroBalance('acc-new', 'user-A'),
      ).resolves.toBe(true);

      expect(outboxCreates[1]).toMatchObject({
        eventType: ACCOUNT_EVENTS.CLOSED,
        payload: {
          accountId: 'acc-new',
          userId: 'user-A',
          accountNumber: '000999888777',
        },
      });
      expect(mockOutbox.dispatchCommitted).toHaveBeenCalledTimes(2);
    });
  });

  describe('MultiLevelCacheService: Redis Pub/Sub L1 Sync & Non-blocking SCAN + UNLINK', () => {
    test('đồng bộ xóa L1 RAM giữa 2 instance Node.js qua Redis Pub/Sub và dùng SCAN + UNLINK thay cho KEYS *', async () => {
      const node1Redis = createMockRedisPair();
      const node2Redis = createMockRedisPair();

      // Kết nối kênh Pub/Sub giả lập giữa Instance 1 và Instance 2
      node1Redis.client.publish.mockImplementation(
        async (channel: string, message: string) => {
          for (const listener of [
            ...node1Redis.messageListeners,
            ...node2Redis.messageListeners,
          ]) {
            listener(channel, message);
          }
          return 2;
        },
      );

      mockRedisFactory
        .mockReturnValueOnce(node1Redis.client)
        .mockReturnValueOnce(node2Redis.client);

      const config = { host: 'localhost', port: 6379 };
      const instance1 = new MultiLevelCacheService(config);
      const instance2 = new MultiLevelCacheService(config);

      // Cả 2 instance đều đang giữ bản sao cũ trong L1 RAM của riêng mình
      await instance1.set('accounts:id:acc-1', { currentBalance: '100000' }, 60);
      await instance2.set('accounts:id:acc-1', { currentBalance: '100000' }, 60);
      await instance2.set(
        'accounts:user:user-A:list:ALL:p1:l20',
        { total: 1 },
        30,
      );

      // Kiểm tra L1 đang hit trên Instance 2 (không gọi xuống Redis GET)
      node2Redis.client.get.mockClear();
      await expect(instance2.get('accounts:id:acc-1')).resolves.toEqual({
        currentBalance: '100000',
      });
      expect(node2Redis.client.get).not.toHaveBeenCalled();

      // Instance 1 thực hiện xóa cache qua AccountCacheInvalidator
      node1Redis.client.scan
        .mockResolvedValueOnce([
          '17',
          ['accounts:user:user-A:list:ALL:p1:l20'],
        ])
        .mockResolvedValueOnce([
          '0',
          ['accounts:user:user-A:list:ACTIVE:p1:l20'],
        ]);

      const invalidator1 = new AccountCacheInvalidator(instance1);
      await invalidator1.invalidateAccount(
        {
          id: 'acc-1',
          userId: 'user-A',
          accountNumber: '000111222333',
        },
        { throwOnError: true },
      );

      // Xác minh dùng SCAN + UNLINK theo lô thay vì KEYS
      expect(node1Redis.client.scan).toHaveBeenCalledTimes(2);
      expect(node1Redis.client.unlink).toHaveBeenCalledWith(
        'accounts:user:user-A:list:ALL:p1:l20',
      );
      expect(node1Redis.client.unlink).toHaveBeenCalledWith(
        'accounts:user:user-A:list:ACTIVE:p1:l20',
      );
      expect(node1Redis.client.publish).toHaveBeenCalledWith(
        CACHE_INVALIDATION_CHANNEL,
        expect.stringContaining('"target":"accounts:id:acc-1"'),
      );

      // Instance 2 nhận được Pub/Sub -> L1 RAM của Instance 2 đã bị xóa sạch tức thì!
      node2Redis.client.get.mockResolvedValue(null);
      await expect(instance2.get('accounts:id:acc-1')).resolves.toBeNull();
      await expect(
        instance2.get('accounts:user:user-A:list:ALL:p1:l20'),
      ).resolves.toBeNull();
      // Vì L1 trên Instance 2 đã bị xóa nên nó buộc phải gọi xuống L2 Redis
      expect(node2Redis.client.get).toHaveBeenCalledTimes(2);

      await instance1.onModuleDestroy();
      await instance2.onModuleDestroy();
    });
  });
});
