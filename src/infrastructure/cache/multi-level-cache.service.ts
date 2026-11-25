import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';
import { LRUCache } from 'lru-cache';
import redisConfig from '@src/common/config/redis.config';

export const CACHE_INVALIDATION_CHANNEL = 'sa_bank:cache:l1:invalidate';

export interface CacheInvalidateOptions {
  readonly throwOnError?: boolean;
}

export interface CacheInvalidationMessage {
  readonly originId: string;
  readonly type: 'key' | 'pattern';
  readonly target: string;
}

const DEFAULT_SCAN_COUNT = 100;

@Injectable()
export class MultiLevelCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(MultiLevelCacheService.name);
  private readonly instanceId = randomUUID();
  private readonly redisClient: Redis;
  private readonly redisSubscriber: Redis;
  private readonly l1Cache: LRUCache<string, string>;

  constructor(
    @Inject(redisConfig.KEY)
    private readonly config: ConfigType<typeof redisConfig>,
  ) {
    // 1. Tầng L1: In-Memory LRU Cache (RAM Node.js cục bộ từng instance)
    this.l1Cache = new LRUCache<string, string>({
      max: 1000, // Tối đa 1000 keys
      ttl: 15 * 1000, // TTL mặc định L1: 15 giây
    });

    // 2. Tầng L2: Redis Cache dùng chung
    const redisOptions = {
      host: this.config.host,
      port: this.config.port,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    };

    this.redisClient = new Redis(redisOptions);
    this.redisClient.on('error', (err) => {
      this.logger.debug(`Redis client error: ${err.message}`);
    });

    // 3. Kênh Redis Pub/Sub chuyên biệt để đồng bộ xóa L1 giữa nhiều instance Node.js
    this.redisSubscriber =
      typeof this.redisClient.duplicate === 'function'
        ? this.redisClient.duplicate(redisOptions)
        : new Redis(redisOptions);

    this.redisSubscriber.on('error', (err) => {
      this.logger.debug(`Redis subscriber error: ${err.message}`);
    });
    this.redisSubscriber.on('message', (channel: string, message: string) => {
      this.handleInvalidationMessage(channel, message);
    });

    this.redisClient.connect().catch((err) => {
      this.logger.warn(
        `Redis connection failed: ${err.message}. Running degraded with L1 only.`,
      );
    });

    this.initSubscriber().catch((err) => {
      this.logger.warn(
        `Redis Pub/Sub subscriber failed: ${err.message}. Cross-instance L1 sync degraded.`,
      );
    });
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  private async initSubscriber(): Promise<void> {
    await this.redisSubscriber.connect();
    await this.redisSubscriber.subscribe(CACHE_INVALIDATION_CHANNEL);
  }

  /**
   * Nhận thông điệp Pub/Sub từ các instance khác để xóa L1 RAM cục bộ tức thì.
   */
  handleInvalidationMessage(channel: string, rawMessage: string): void {
    if (channel !== CACHE_INVALIDATION_CHANNEL) {
      return;
    }

    try {
      const parsed = JSON.parse(rawMessage) as Partial<CacheInvalidationMessage>;
      if (!parsed || typeof parsed.target !== 'string') {
        return;
      }
      // Bỏ qua thông điệp do chính instance này vừa phát đi
      if (parsed.originId === this.instanceId) {
        return;
      }

      if (parsed.type === 'key') {
        this.l1Cache.delete(parsed.target);
      } else if (parsed.type === 'pattern') {
        this.evictL1ByPattern(parsed.target);
      }
    } catch (error) {
      this.logger.warn(`Invalid cache invalidation message ignored: ${error}`);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    // Bước 1: Kiểm tra L1
    const l1Hit = this.l1Cache.get(key);
    if (l1Hit) {
      return JSON.parse(l1Hit) as T;
    }

    // Bước 2: Miss L1 -> Kiểm tra L2
    try {
      const l2Hit = await this.redisClient.get(key);
      if (l2Hit) {
        // Nạp ngược lại vào L1
        this.l1Cache.set(key, l2Hit);
        return JSON.parse(l2Hit) as T;
      }
    } catch (error) {
      this.logger.error(`Redis GET error for key ${key}: ${error}`);
    }

    return null;
  }

  async set(key: string, value: unknown, ttlSeconds: number = 60): Promise<void> {
    const serialized = JSON.stringify(value);

    // Ghi vào L1
    this.l1Cache.set(key, serialized, {
      ttl: Math.min(ttlSeconds, 15) * 1000,
    });

    // Ghi vào L2
    try {
      await this.redisClient.setex(key, ttlSeconds, serialized);
    } catch (error) {
      this.logger.error(`Redis SET error for key ${key}: ${error}`);
    }
  }

  async del(key: string, options?: CacheInvalidateOptions): Promise<void> {
    this.l1Cache.delete(key);
    try {
      await this.redisClient.del(key);
      await this.publishInvalidation('key', key);
    } catch (error) {
      this.logger.error(`Redis DEL error for key ${key}: ${error}`);
      if (options?.throwOnError) {
        throw error;
      }
    }
  }

  async delByPattern(
    pattern: string,
    options?: CacheInvalidateOptions,
  ): Promise<void> {
    // Xóa trong L1 của instance hiện tại
    this.evictL1ByPattern(pattern);

    // Xóa trong L2 bằng con trỏ SCAN + UNLINK (không gây block luồng đơn Redis như KEYS *)
    try {
      await this.scanAndUnlink(pattern);
      await this.publishInvalidation('pattern', pattern);
    } catch (error) {
      this.logger.error(`Redis DEL by pattern error: ${error}`);
      if (options?.throwOnError) {
        throw error;
      }
    }
  }

  private evictL1ByPattern(pattern: string): void {
    for (const key of this.l1Cache.keys()) {
      if (this.matchPattern(key, pattern)) {
        this.l1Cache.delete(key);
      }
    }
  }

  private async scanAndUnlink(pattern: string): Promise<void> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redisClient.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        DEFAULT_SCAN_COUNT,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.redisClient.unlink(...keys);
      }
    } while (cursor !== '0');
  }

  private async publishInvalidation(
    type: 'key' | 'pattern',
    target: string,
  ): Promise<void> {
    const message: CacheInvalidationMessage = {
      originId: this.instanceId,
      type,
      target,
    };
    await this.redisClient.publish(
      CACHE_INVALIDATION_CHANNEL,
      JSON.stringify(message),
    );
  }

  private matchPattern(key: string, pattern: string): boolean {
    if (!pattern.includes('*')) return key === pattern;
    const parts = pattern.split('*');
    const prefix = parts[0];
    const suffix = parts[parts.length - 1];
    if (
      key.length < prefix.length + suffix.length ||
      !key.startsWith(prefix) ||
      !key.endsWith(suffix)
    ) {
      return false;
    }
    let pos = prefix.length;
    const limit = key.length - suffix.length;
    for (let i = 1; i < parts.length - 1; i++) {
      if (parts[i].length === 0) continue;
      const idx = key.indexOf(parts[i], pos);
      if (idx === -1 || idx + parts[i].length > limit) return false;
      pos = idx + parts[i].length;
    }
    return true;
  }

  async ping(timeoutMs = 1500): Promise<{ ok: boolean; latencyMs: number }> {
    const start = performance.now();
    let timer: NodeJS.Timeout | null = null;
    try {
      const timeoutPromise = new Promise<string>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Redis ping timeout')),
          timeoutMs,
        );
        timer.unref();
      });
      const pong = await Promise.race([
        this.redisClient.ping(),
        timeoutPromise,
      ]);
      const latencyMs = Number((performance.now() - start).toFixed(2));
      return { ok: pong === 'PONG', latencyMs };
    } catch {
      const latencyMs = Number((performance.now() - start).toFixed(2));
      return { ok: false, latencyMs };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([
      this.safeCloseClient(this.redisSubscriber),
      this.safeCloseClient(this.redisClient),
    ]);
  }

  private async safeCloseClient(client: Redis | undefined): Promise<void> {
    if (!client) return;
    if (client.status === 'ready' || client.status === 'connect') {
      await client.quit().catch(() => {
        client.disconnect();
      });
      return;
    }
    if (typeof client.disconnect === 'function') {
      client.disconnect();
    }
  }
}
