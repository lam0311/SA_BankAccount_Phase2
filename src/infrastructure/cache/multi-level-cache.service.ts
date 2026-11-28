import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';
import { LRUCache } from 'lru-cache';
import redisConfig from '@src/common/config/redis.config';

export const CACHE_INVALIDATION_CHANNEL = 'cache:invalidate';

export interface CacheInvalidationMessage {
  type: 'key' | 'pattern';
  target: string;
  senderId: string;
  sentAt: number;
}

export interface GetOrSetOptions {
  cacheNull?: boolean;
}

type InvalidationListener = (message: CacheInvalidationMessage) => void;

@Injectable()
export class MultiLevelCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(MultiLevelCacheService.name);
  private readonly instanceId = randomUUID();
  private readonly redisClient: Redis;
  private readonly subscriberClient: Redis;
  private readonly l1Cache: LRUCache<string, string>;

  // Single-Flight: gom các request đồng thời khi cache miss vào cùng 1 Promise duy nhất
  private readonly inFlight = new Map<string, Promise<unknown>>();
  // Ngăn một request đọc chậm ghi ngược dữ liệu cũ vào cache sau khi key đã bị invalidate
  private readonly invalidatedInFlight = new Set<string>();
  private readonly invalidationListeners = new Set<InvalidationListener>();

  private subscribed = false;

  constructor(
    @Inject(redisConfig.KEY)
    private readonly config: ConfigType<typeof redisConfig>,
  ) {
    // 1. Tầng L1: In-Memory LRU Cache (RAM cục bộ của Node.js)
    this.l1Cache = new LRUCache<string, string>({
      max: 1000, // Tối đa 1000 keys
      ttl: 15 * 1000, // TTL mặc định L1: 15 giây
    });

    const baseRedisOptions = {
      host: this.config.host,
      port: this.config.port,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    };

    // 2. Tầng L2: Redis Command Client (GET / SETEX / DEL / SCAN / PUBLISH)
    this.redisClient = new Redis(baseRedisOptions);
    this.redisClient.on('error', (err) => {
      this.logger.warn(`Redis command client error: ${err.message}`);
    });

    // 3. Redis Pub/Sub Subscriber Client riêng biệt (đồng bộ xóa L1 đa Node)
    this.subscriberClient = new Redis(baseRedisOptions);
    this.subscriberClient.on('error', (err) => {
      this.logger.warn(`Redis subscriber client error: ${err.message}`);
    });
    this.subscriberClient.on('message', (channel, rawMessage) => {
      this.handleInvalidationMessage(channel, rawMessage);
    });
    this.subscriberClient.on('ready', () => {
      this.subscribeToInvalidationChannel();
    });
    this.subscriberClient.on('close', () => {
      this.subscribed = false;
    });

    this.redisClient.connect().catch((err) => {
      this.logger.warn(
        `Redis connection failed: ${err.message}. Running degraded with L1 only.`,
      );
    });

    this.subscriberClient.connect().catch((err) => {
      this.logger.warn(
        `Redis Pub/Sub subscriber failed: ${err.message}. Running degraded without cross-node L1 sync.`,
      );
    });
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  hasInL1(key: string): boolean {
    return this.l1Cache.has(key);
  }

  onL1Invalidated(listener: InvalidationListener): () => void {
    this.invalidationListeners.add(listener);
    return () => {
      this.invalidationListeners.delete(listener);
    };
  }

  /**
   * Chờ Redis Command Client và Pub/Sub Subscriber sẵn sàng (phục vụ khởi động/kiểm thử).
   */
  async waitUntilReady(timeoutMs: number = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (
        this.redisClient.status === 'ready' &&
        this.subscriberClient.status === 'ready' &&
        this.subscribed
      ) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  async get<T>(key: string): Promise<T | null> {
    // Bước 1: Kiểm tra L1 (RAM Node.js)
    const l1Hit = this.l1Cache.get(key);
    if (l1Hit !== undefined) {
      return JSON.parse(l1Hit) as T;
    }

    // Bước 2: Miss L1 -> Kiểm tra L2 (Redis)
    if (this.isRedisReady()) {
      try {
        const l2Hit = await this.redisClient.get(key);
        if (l2Hit !== null) {
          // Nạp ngược lại vào L1
          this.l1Cache.set(key, l2Hit);
          return JSON.parse(l2Hit) as T;
        }
      } catch (error) {
        this.logger.error(`Redis GET error for key ${key}: ${error}`);
      }
    }

    return null;
  }

  /**
   * TSK-17: Single-Flight (Chống Cache Stampede / Thundering Herd).
   * Nếu có N request đồng thời cùng miss 1 key, chỉ request ĐẦU TIÊN được gọi `fetcher()`
   * (truy vấn DB); N-1 request còn lại chia sẻ chung Promise đang bay và nhận cùng kết quả.
   */
  async getOrSet<T>(
    key: string,
    ttlSeconds: number,
    fetcher: () => Promise<T>,
    options: GetOrSetOptions = {},
  ): Promise<T> {
    // Fast-path: kiểm tra L1 đồng bộ trong RAM (< 0.1ms)
    const l1Hit = this.l1Cache.get(key);
    if (l1Hit !== undefined) {
      return JSON.parse(l1Hit) as T;
    }

    // Nếu đã có request khác đang bay cho cùng key -> chờ chung Promise đó
    const existingFlight = this.inFlight.get(key);
    if (existingFlight) {
      return (await existingFlight) as T;
    }

    // Tạo duy nhất 1 Promise thực thi L2 lookup -> DB fetcher -> backfill Cache
    const flight = (async (): Promise<T> => {
      // Kiểm tra L2 (Redis) trước khi gọi DB
      if (this.isRedisReady()) {
        try {
          const l2Hit = await this.redisClient.get(key);
          if (l2Hit !== null) {
            if (!this.invalidatedInFlight.has(key)) {
              this.l1Cache.set(key, l2Hit, {
                ttl: Math.min(ttlSeconds, 15) * 1000,
              });
            }
            return JSON.parse(l2Hit) as T;
          }
        } catch (error) {
          this.logger.error(`Redis GET error for key ${key}: ${error}`);
        }
      }

      // Miss cả L1 & L2 -> Gọi DB đúng 1 lần duy nhất
      const value = await fetcher();

      const shouldCache =
        (value !== null && value !== undefined) || options.cacheNull === true;

      if (shouldCache && !this.invalidatedInFlight.has(key)) {
        await this.set(key, value, ttlSeconds);
      }

      return value;
    })();

    // Lưu vào inFlight ĐỒNG BỘ trước bất kỳ lệnh await nào để gom toàn bộ concurrent callers
    this.inFlight.set(key, flight);

    try {
      return await flight;
    } finally {
      this.inFlight.delete(key);
      this.invalidatedInFlight.delete(key);
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number = 60): Promise<void> {
    const serialized = JSON.stringify(value);

    // Ghi vào L1 (TTL L1 tối đa 15s để hạn chế rủi ro stale data)
    this.l1Cache.set(key, serialized, {
      ttl: Math.min(ttlSeconds, 15) * 1000,
    });

    // Ghi vào L2 (Redis)
    if (this.isRedisReady()) {
      try {
        await this.redisClient.setex(key, ttlSeconds, serialized);
      } catch (error) {
        this.logger.error(`Redis SET error for key ${key}: ${error}`);
      }
    }
  }

  /**
   * Xóa key ở L1 cục bộ, L2 Redis, đồng thời phát sự kiện qua Redis Pub/Sub
   * để tất cả các Node khác trong cluster xóa L1 RAM ngay lập tức (< 10ms).
   */
  async del(key: string): Promise<void> {
    this.evictLocalKey(key);

    if (this.isRedisReady()) {
      try {
        await this.redisClient.del(key);
        await this.publishInvalidation('key', key);
      } catch (error) {
        this.logger.error(`Redis DEL/PUBLISH error for key ${key}: ${error}`);
      }
    }
  }

  /**
   * Xóa theo pattern ở L1 cục bộ, L2 Redis (dùng SCAN không chặn event loop Redis),
   * và phát sự kiện Pub/Sub đồng bộ xóa L1 trên mọi Node khác.
   */
  async delByPattern(pattern: string): Promise<void> {
    this.evictLocalPattern(pattern);

    if (this.isRedisReady()) {
      try {
        let cursor = '0';
        do {
          const [nextCursor, keys] = await this.redisClient.scan(
            cursor,
            'MATCH',
            pattern,
            'COUNT',
            100,
          );
          cursor = nextCursor;
          if (keys.length > 0) {
            await this.redisClient.del(...keys);
          }
        } while (cursor !== '0');

        await this.publishInvalidation('pattern', pattern);
      } catch (error) {
        this.logger.error(`Redis DEL by pattern error: ${error}`);
      }
    }
  }

  private subscribeToInvalidationChannel(): void {
    this.subscriberClient
      .subscribe(CACHE_INVALIDATION_CHANNEL)
      .then(() => {
        this.subscribed = true;
      })
      .catch((err) => {
        this.subscribed = false;
        this.logger.warn(
          `Failed to subscribe to ${CACHE_INVALIDATION_CHANNEL}: ${err.message}`,
        );
      });
  }

  private async publishInvalidation(
    type: 'key' | 'pattern',
    target: string,
  ): Promise<void> {
    const payload: CacheInvalidationMessage = {
      type,
      target,
      senderId: this.instanceId,
      sentAt: Date.now(),
    };
    await this.redisClient.publish(
      CACHE_INVALIDATION_CHANNEL,
      JSON.stringify(payload),
    );
  }

  private handleInvalidationMessage(channel: string, rawMessage: string): void {
    if (channel !== CACHE_INVALIDATION_CHANNEL) {
      return;
    }

    try {
      const message = JSON.parse(rawMessage) as CacheInvalidationMessage;

      // Bỏ qua thông điệp do chính node này phát ra (L1 cục bộ đã xóa đồng bộ trước đó)
      if (message.senderId === this.instanceId) {
        return;
      }

      if (message.type === 'key') {
        this.evictLocalKey(message.target);
      } else if (message.type === 'pattern') {
        this.evictLocalPattern(message.target);
      }

      for (const listener of this.invalidationListeners) {
        listener(message);
      }
    } catch (error) {
      this.logger.warn(`Invalid cache invalidation message received: ${error}`);
    }
  }

  private evictLocalKey(key: string): void {
    this.l1Cache.delete(key);
    if (this.inFlight.has(key)) {
      this.invalidatedInFlight.add(key);
    }
  }

  private evictLocalPattern(pattern: string): void {
    for (const key of this.l1Cache.keys()) {
      if (this.matchPattern(key, pattern)) {
        this.l1Cache.delete(key);
      }
    }
    for (const key of this.inFlight.keys()) {
      if (this.matchPattern(key, pattern)) {
        this.invalidatedInFlight.add(key);
      }
    }
  }

  /**
   * So khớp wildcard `*` tuyến tính O(n) — không dùng RegExp để tránh lỗ hổng ReDoS (SAST Semgrep).
   */
  private matchPattern(key: string, pattern: string): boolean {
    if (pattern === '*') return true;
    const parts = pattern.split('*');
    if (parts.length === 1) return key === pattern;

    let pos = 0;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '') continue;

      if (i === 0) {
        if (!key.startsWith(part)) return false;
        pos = part.length;
      } else if (i === parts.length - 1) {
        if (!key.endsWith(part) || key.length - part.length < pos) return false;
        pos = key.length;
      } else {
        const idx = key.indexOf(part, pos);
        if (idx === -1) return false;
        pos = idx + part.length;
      }
    }
    return true;
  }

  private isRedisReady(): boolean {
    return this.redisClient.status === 'ready';
  }

  async onModuleDestroy(): Promise<void> {
    this.subscribed = false;
    this.invalidationListeners.clear();

    const closeClient = async (client: Redis) => {
      if (client.status === 'ready') {
        await client.quit().catch(() => {});
      } else if (client.status !== 'end') {
        client.disconnect();
      }
    };

    await Promise.all([
      closeClient(this.subscriberClient),
      closeClient(this.redisClient),
    ]);
  }
}
