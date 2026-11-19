import { Inject, Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';
import { LRUCache } from 'lru-cache';
import redisConfig from '@src/common/config/redis.config';

@Injectable()
export class MultiLevelCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(MultiLevelCacheService.name);
  private readonly redisClient: Redis;
  private readonly l1Cache: LRUCache<string, string>;

  constructor(
    @Inject(redisConfig.KEY)
    private readonly config: ConfigType<typeof redisConfig>,
  ) {
    // 1. Tầng L1: In-Memory LRU Cache (RAM Node.js)
    this.l1Cache = new LRUCache<string, string>({
      max: 1000, // Tối đa 1000 keys
      ttl: 15 * 1000, // TTL mặc định L1: 15 giây
    });

    // 2. Tầng L2: Redis Cache
    this.redisClient = new Redis({
      host: this.config.host,
      port: this.config.port,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });

    this.redisClient.connect().catch((err) => {
      this.logger.warn(`Redis connection failed: ${err.message}. Running degraded with L1 only.`);
    });
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

  async set(key: string, value: any, ttlSeconds: number = 60): Promise<void> {
    const serialized = JSON.stringify(value);

    // Ghi vào L1
    this.l1Cache.set(key, serialized, { ttl: Math.min(ttlSeconds, 15) * 1000 });

    // Ghi vào L2
    try {
      await this.redisClient.setex(key, ttlSeconds, serialized);
    } catch (error) {
      this.logger.error(`Redis SET error for key ${key}: ${error}`);
    }
  }

  async del(key: string): Promise<void> {
    this.l1Cache.delete(key);
    try {
      await this.redisClient.del(key);
    } catch (error) {
      this.logger.error(`Redis DEL error for key ${key}: ${error}`);
    }
  }

  async delByPattern(pattern: string): Promise<void> {
    // Xóa trong L1
    for (const key of this.l1Cache.keys()) {
      if (this.matchPattern(key, pattern)) {
        this.l1Cache.delete(key);
      }
    }

    // Xóa trong L2
    try {
      const keys = await this.redisClient.keys(pattern);
      if (keys.length > 0) {
        await this.redisClient.del(...keys);
      }
    } catch (error) {
      this.logger.error(`Redis DEL by pattern error: ${error}`);
    }
  }

  private matchPattern(key: string, pattern: string): boolean {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(key);
  }

  async onModuleDestroy() {
    await this.redisClient.quit();
  }
}
