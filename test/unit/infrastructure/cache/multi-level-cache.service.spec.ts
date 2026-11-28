import { EventEmitter } from 'node:events';
import {
  CACHE_INVALIDATION_CHANNEL,
  MultiLevelCacheService,
} from '@src/infrastructure/cache/multi-level-cache.service';
import { CachedAccountQueryRepository } from '@src/modules/accounts/infrastructure/persistence/cached-account-query.repository';
import type { AccountReadModel } from '@src/modules/accounts/application/queries/account.read-model';
import type { PrismaAccountQueryRepository } from '@src/modules/accounts/infrastructure/persistence/prisma-account-query.repository';

// Shared in-memory Redis store + Pub/Sub broker cho toàn bộ mock clients trong test
const sharedStore = new Map<string, string>();
const pubSubBroker = new EventEmitter();
let failNextConnect = false;

class MockRedis extends EventEmitter {
  status: string = 'wait';
  private subscribedChannels = new Set<string>();
  private brokerListeners = new Map<string, (msg: string) => void>();

  async connect(): Promise<void> {
    if (failNextConnect) {
      this.status = 'close';
      throw new Error('ECONNREFUSED');
    }
    this.status = 'ready';
    this.emit('ready');
  }

  async get(key: string): Promise<string | null> {
    return sharedStore.has(key) ? sharedStore.get(key)! : null;
  }

  async setex(key: string, _ttl: number, value: string): Promise<'OK'> {
    sharedStore.set(key, value);
    return 'OK';
  }

  duplicate(): MockRedis {
    return new MockRedis();
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const k of keys) {
      if (sharedStore.delete(k)) deleted++;
    }
    return deleted;
  }

  async unlink(...keys: string[]): Promise<number> {
    return this.del(...keys);
  }

  async scan(
    _cursor: string,
    _matchLiteral: string,
    pattern: string,
  ): Promise<[string, string[]]> {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    const matched = [...sharedStore.keys()].filter((k) =>
      pattern.endsWith('*') ? k.startsWith(prefix) : k === pattern,
    );
    return ['0', matched];
  }

  async subscribe(channel: string): Promise<number> {
    if (!this.subscribedChannels.has(channel)) {
      this.subscribedChannels.add(channel);
      const listener = (message: string) => {
        this.emit('message', channel, message);
      };
      this.brokerListeners.set(channel, listener);
      pubSubBroker.on(channel, listener);
    }
    return this.subscribedChannels.size;
  }

  async publish(channel: string, message: string): Promise<number> {
    // Phát bất đồng bộ qua microtask giống mạng Redis thực tế
    setImmediate(() => {
      pubSubBroker.emit(channel, message);
    });
    return pubSubBroker.listenerCount(channel);
  }

  async quit(): Promise<'OK'> {
    this.cleanup();
    this.status = 'end';
    return 'OK';
  }

  disconnect(): void {
    this.cleanup();
    this.status = 'end';
  }

  private cleanup(): void {
    for (const [channel, listener] of this.brokerListeners.entries()) {
      pubSubBroker.off(channel, listener);
    }
    this.brokerListeners.clear();
    this.subscribedChannels.clear();
  }
}

jest.mock('ioredis', () => {
  return {
    __esModule: true,
    default: jest.fn(() => new MockRedis()),
  };
});

describe('MultiLevelCacheService (TSK-17: Single-Flight & Multi-Node Pub/Sub)', () => {
  const redisCfg = { host: '127.0.0.1', port: 6379 };
  const servicesToDestroy: MultiLevelCacheService[] = [];

  async function createCacheNode(): Promise<MultiLevelCacheService> {
    const service = new MultiLevelCacheService(redisCfg);
    servicesToDestroy.push(service);
    await service.waitUntilReady(1000);
    return service;
  }

  beforeEach(() => {
    sharedStore.clear();
    failNextConnect = false;
  });

  afterEach(async () => {
    while (servicesToDestroy.length > 0) {
      const svc = servicesToDestroy.pop()!;
      await svc.onModuleDestroy();
    }
  });

  describe('Single-Flight (Chống Cache Stampede)', () => {
    it('500 request đồng thời khi cache miss chỉ tạo đúng 1 query DB duy nhất', async () => {
      const cache = await createCacheNode();
      const dbFetcher = jest.fn(async () => {
        // Giả lập độ trễ truy vấn PostgreSQL 25ms
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { accountId: 'acc-001', balance: '5000000' };
      });

      const CONCURRENCY = 500;
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          cache.getOrSet('accounts:id:acc-001', 60, dbFetcher),
        ),
      );

      // Chỉ ĐÚNG 1 lần gọi vào DB bất chấp 500 request ập vào cùng lúc
      expect(dbFetcher).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(CONCURRENCY);
      for (const res of results) {
        expect(res).toEqual({ accountId: 'acc-001', balance: '5000000' });
      }
      // Sau khi xong, dữ liệu đã nằm trong cả L1 và L2
      expect(cache.hasInL1('accounts:id:acc-001')).toBe(true);
      expect(sharedStore.has('accounts:id:acc-001')).toBe(true);
    });

    it('CachedAccountQueryRepository: 500 lệnh findById đồng thời chỉ gọi prismaQueryRepo đúng 1 lần', async () => {
      const cache = await createCacheNode();
      const fakeReadModel: AccountReadModel = {
        id: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        accountNumber: '100000000001',
        accountName: 'Main Payment',
        accountType: 'PAYMENT',
        currentBalance: '2500000',
        currency: 'VND',
        status: 'ACTIVE',
        closedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      };

      const prismaQueryRepo = {
        findById: jest.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return fakeReadModel;
        }),
      } as unknown as PrismaAccountQueryRepository;

      const repo = new CachedAccountQueryRepository(prismaQueryRepo, cache);

      const results = await Promise.all(
        Array.from({ length: 500 }, () => repo.findById(fakeReadModel.id)),
      );

      expect(prismaQueryRepo.findById).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(500);
      expect(results[0]?.currentBalance).toBe('2500000');
      expect(results[499]?.currentBalance).toBe('2500000');
    });

    it('dọn sạch inFlight map khi DB lỗi để các request sau có thể thử lại bình thường', async () => {
      const cache = await createCacheNode();
      let attempt = 0;

      const flakyFetcher = jest.fn(async () => {
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (attempt === 1) {
          throw new Error('DB_TEMP_ERROR');
        }
        return { balance: '999' };
      });

      const failedBatch = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          cache.getOrSet('accounts:id:flaky', 60, flakyFetcher),
        ),
      );

      expect(flakyFetcher).toHaveBeenCalledTimes(1);
      expect(failedBatch.every((r) => r.status === 'rejected')).toBe(true);

      // Lần thử lại tiếp theo phải thành công, không bị kẹt Promise lỗi cũ
      const recovered = await cache.getOrSet('accounts:id:flaky', 60, flakyFetcher);
      expect(flakyFetcher).toHaveBeenCalledTimes(2);
      expect(recovered).toEqual({ balance: '999' });
    });

    it('không ghi ngược dữ liệu cũ vào cache nếu key bị invalidate trong lúc DB đang query', async () => {
      const cache = await createCacheNode();
      let releaseDb!: () => void;

      const slowDbRead = jest.fn(
        () =>
          new Promise<{ balance: string }>((resolve) => {
            releaseDb = () => resolve({ balance: '100000' });
          }),
      );

      const readPromise = cache.getOrSet('accounts:id:race', 60, slowDbRead);

      // Đợi microtask để readPromise vào tới slowDbRead
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Trong lúc DB đọc chậm, một lệnh ghi khác invalidate key này
      await cache.del('accounts:id:race');

      // Bây giờ DB đọc chậm mới trả về giá trị cũ
      releaseDb();
      await readPromise;

      // Dữ liệu cũ 100000 KHÔNG được phép ghi ngược vào L1 hay L2
      expect(cache.hasInL1('accounts:id:race')).toBe(false);
      expect(sharedStore.has('accounts:id:race')).toBe(false);
    });
  });

  describe('Đồng bộ L1 Cache đa Node qua Redis Pub/Sub', () => {
    it('Node 1 xóa key (update số dư) -> Node 2 lập tức xóa L1 RAM qua Pub/Sub', async () => {
      const node1 = await createCacheNode();
      const node2 = await createCacheNode();

      expect(node1.getInstanceId()).not.toBe(node2.getInstanceId());

      const key = 'accounts:id:acc-multi-node';

      // Cả 2 node đều nạp số dư cũ vào L1 RAM của mình
      await node1.set(key, { balance: '1000000' }, 60);
      const node2Before = await node2.get<{ balance: string }>(key);
      expect(node2Before).toEqual({ balance: '1000000' });
      expect(node1.hasInL1(key)).toBe(true);
      expect(node2.hasInL1(key)).toBe(true);

      // Lắng nghe thời điểm Node 2 nhận được sự kiện xóa L1 từ Pub/Sub
      const invalidatedOnNode2 = new Promise<void>((resolve) => {
        const unsub = node2.onL1Invalidated((msg) => {
          if (msg.type === 'key' && msg.target === key) {
            unsub();
            resolve();
          }
        });
      });

      // Node 1 cập nhật số dư và xóa cache
      await node1.del(key);
      await invalidatedOnNode2;

      expect(node1.hasInL1(key)).toBe(false);
      expect(node2.hasInL1(key)).toBe(false);
    });

    it('Node 1 gọi delByPattern -> Node 2 xóa toàn bộ key khớp pattern trong L1 qua Pub/Sub', async () => {
      const node1 = await createCacheNode();
      const node2 = await createCacheNode();

      const user1Page1 = 'accounts:user:u1:list:ALL:p1:l20';
      const user1Page2 = 'accounts:user:u1:list:ACTIVE:p2:l10';
      const user2Page1 = 'accounts:user:u2:list:ALL:p1:l20';

      await node1.set(user1Page1, { items: [1], total: 1 }, 30);
      await node1.set(user1Page2, { items: [2], total: 1 }, 30);
      await node1.set(user2Page1, { items: [3], total: 1 }, 30);

      // Warm up L1 trên Node 2
      await node2.get(user1Page1);
      await node2.get(user1Page2);
      await node2.get(user2Page1);

      expect(node2.hasInL1(user1Page1)).toBe(true);
      expect(node2.hasInL1(user1Page2)).toBe(true);
      expect(node2.hasInL1(user2Page1)).toBe(true);

      const invalidatedOnNode2 = new Promise<void>((resolve) => {
        const unsub = node2.onL1Invalidated((msg) => {
          if (msg.type === 'pattern' && msg.target === 'accounts:user:u1:*') {
            unsub();
            resolve();
          }
        });
      });

      await node1.delByPattern('accounts:user:u1:*');
      await invalidatedOnNode2;

      // Key của user u1 bị xóa sạch ở cả 2 node
      expect(node2.hasInL1(user1Page1)).toBe(false);
      expect(node2.hasInL1(user1Page2)).toBe(false);
      // Key của user u2 vẫn giữ nguyên (không bị xóa nhầm)
      expect(node2.hasInL1(user2Page1)).toBe(true);
    });

    it('bỏ qua thông điệp Pub/Sub do chính node đó phát ra (không xử lý lặp)', async () => {
      const node1 = await createCacheNode();
      const listener = jest.fn();
      node1.onL1Invalidated(listener);

      await node1.set('accounts:id:self', { balance: '100' }, 60);
      await node1.del('accounts:id:self');

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(listener).not.toHaveBeenCalled();
    });

    it('chạy ổn định ở chế độ suy giảm (L1-only) khi Redis mất kết nối', async () => {
      failNextConnect = true;
      const cache = new MultiLevelCacheService(redisCfg);
      servicesToDestroy.push(cache);

      const fetcher = jest.fn(async () => ({ balance: '777' }));
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          cache.getOrSet('accounts:id:degraded', 60, fetcher),
        ),
      );

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(results[0]).toEqual({ balance: '777' });
      expect(cache.hasInL1('accounts:id:degraded')).toBe(true);

      // Đảm bảo channel constant được export đúng
      expect(CACHE_INVALIDATION_CHANNEL).toBe('sa_bank:cache:l1:invalidate');
    });
  });
});
