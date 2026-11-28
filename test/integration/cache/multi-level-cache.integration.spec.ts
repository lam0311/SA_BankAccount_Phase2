import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { config as loadEnv } from 'dotenv';
import { describe, beforeAll, afterAll, it, expect } from '@jest/globals';
import { MultiLevelCacheService } from '@src/infrastructure/cache/multi-level-cache.service';

loadEnv({ quiet: true });

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[idx];
}

describe('MultiLevelCacheService Integration Tests (Real Redis - TSK-17)', () => {
  const redisHost = process.env.REDIS_HOST || '127.0.0.1';
  const redisPort = Number(process.env.REDIS_PORT || 6379);
  const runId = randomUUID().slice(0, 8);
  const keysToCleanup: string[] = [];

  let node1: MultiLevelCacheService;
  let node2: MultiLevelCacheService;

  beforeAll(async () => {
    const config = { host: redisHost, port: redisPort };
    node1 = new MultiLevelCacheService(config);
    node2 = new MultiLevelCacheService(config);

    const [ready1, ready2] = await Promise.all([
      node1.waitUntilReady(4000),
      node2.waitUntilReady(4000),
    ]);

    if (!ready1 || !ready2) {
      throw new Error(
        `Không thể kết nối Redis thật tại ${redisHost}:${redisPort}. Hãy chạy: docker compose up -d redis`,
      );
    }
  });

  afterAll(async () => {
    if (node1) {
      for (const key of keysToCleanup) {
        await node1.del(key);
      }
      await node1.onModuleDestroy();
    }
    if (node2) {
      await node2.onModuleDestroy();
    }
  });

  it('Single-Flight: 500 request đồng thời khi cache miss chỉ tạo đúng 1 query DB', async () => {
    const sfKey = `accounts:id:tsk17-sf-${runId}`;
    keysToCleanup.push(sfKey);
    await node1.del(sfKey);

    let dbQueryCount = 0;
    const simulatedDbQuery = async () => {
      dbQueryCount++;
      // Mô phỏng độ trễ truy vấn PostgreSQL (~25ms)
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        id: `acc-${runId}`,
        accountNumber: '100000099999',
        currentBalance: '5000000',
        status: 'ACTIVE',
      };
    };

    const CONCURRENT_REQS = 500;
    const start = performance.now();
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_REQS }, () =>
        node1.getOrSet(sfKey, 60, simulatedDbQuery),
      ),
    );
    const elapsedMs = performance.now() - start;

    expect(dbQueryCount).toBe(1);
    expect(responses).toHaveLength(CONCURRENT_REQS);
    for (const res of responses) {
      expect(res.currentBalance).toBe('5000000');
    }
    expect(node1.hasInL1(sfKey)).toBe(true);

    console.info(
      `[TSK-17 Single-Flight] concurrent=${CONCURRENT_REQS}, dbQueries=${dbQueryCount} (reduced ${(((CONCURRENT_REQS - dbQueryCount) / CONCURRENT_REQS) * 100).toFixed(1)}%), elapsed=${elapsedMs.toFixed(2)}ms`,
    );
  });

  it('Redis Pub/Sub: Node 1 update số dư & xóa cache -> Node 2 xóa L1 RAM < 10ms (10 vòng đo)', async () => {
    expect(node1.getInstanceId()).not.toBe(node2.getInstanceId());

    const ITERATIONS = 10;
    const keyLatencies: number[] = [];
    const listPattern = `accounts:user:u-${runId}:*`;
    const listKey = `accounts:user:u-${runId}:list:ALL:p1:l20`;

    for (let i = 1; i <= ITERATIONS; i++) {
      const accKey = `accounts:id:tsk17-sync-${runId}-${i}`;
      keysToCleanup.push(accKey);

      // 1. Warm-up số dư cũ (1.000.000 VND) vào L1 RAM của CẢ Node 1 và Node 2
      await node1.set(accKey, { id: accKey, currentBalance: '1000000' }, 60);
      await node1.set(
        listKey,
        { items: [{ currentBalance: '1000000' }], total: 1 },
        30,
      );

      const node2Before = await node2.get<{ id: string; currentBalance: string }>(
        accKey,
      );
      await node2.get(listKey);

      expect(node2Before?.currentBalance).toBe('1000000');
      expect(node1.hasInL1(accKey)).toBe(true);
      expect(node2.hasInL1(accKey)).toBe(true);
      expect(node2.hasInL1(listKey)).toBe(true);

      // 2. Đo chính xác thời điểm Node 2 nhận Pub/Sub và xóa L1 RAM
      const waitNode2KeyEvicted = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timeout chờ Node 2 xóa L1 cho key ${accKey}`)),
          2000,
        );
        const unsub = node2.onL1Invalidated((msg) => {
          if (msg.type === 'key' && msg.target === accKey) {
            clearTimeout(timer);
            unsub();
            resolve(performance.now());
          }
        });
      });

      const t0 = performance.now();
      await node1.del(accKey);
      const tEvicted = await waitNode2KeyEvicted;
      const latencyMs = tEvicted - t0;
      keyLatencies.push(latencyMs);

      expect(node1.hasInL1(accKey)).toBe(false);
      expect(node2.hasInL1(accKey)).toBe(false);

      // 3. Kiểm chứng luôn delByPattern xóa cache danh sách trên Node 2
      const waitNode2PatternEvicted = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timeout chờ Node 2 xóa L1 theo pattern')),
          2000,
        );
        const unsub = node2.onL1Invalidated((msg) => {
          if (msg.type === 'pattern' && msg.target === listPattern) {
            clearTimeout(timer);
            unsub();
            resolve();
          }
        });
      });

      await node1.delByPattern(listPattern);
      await waitNode2PatternEvicted;
      expect(node2.hasInL1(listKey)).toBe(false);

      // 4. Node 2 đọc lại nhận ngay số dư MỚI (500.000 VND) -> 0% stale data
      const freshOnNode2 = await node2.getOrSet(accKey, 60, async () => ({
        id: accKey,
        currentBalance: '500000',
      }));
      expect(freshOnNode2.currentBalance).toBe('500000');

      console.info(
        `[TSK-17 Pub/Sub] Run #${String(i).padStart(2, '0')}: Node 1 del() -> Node 2 L1 evicted in ${latencyMs.toFixed(2)}ms | freshBalance=${freshOnNode2.currentBalance}`,
      );
    }

    const sorted = [...keyLatencies].sort((a, b) => a - b);
    const minMs = sorted[0];
    const p50Ms = percentile(sorted, 50);
    const p95Ms = percentile(sorted, 95);
    const maxMs = sorted[sorted.length - 1];

    console.info(
      `[TSK-17 Pub/Sub Summary] runs=${ITERATIONS}, min=${minMs.toFixed(2)}ms, p50=${p50Ms.toFixed(2)}ms, p95=${p95Ms.toFixed(2)}ms, max=${maxMs.toFixed(2)}ms`,
    );

    expect(maxMs).toBeLessThan(10);
  });
});
