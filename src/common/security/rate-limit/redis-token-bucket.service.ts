import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigType } from "@nestjs/config";
import Redis from "ioredis";
import redisConfig from "@src/common/config/redis.config";

// Kiểu dữ liệu trả về sau mỗi lần xin 1 token để đi qua API
export interface TokenBucketResult {
  allowed: boolean;           // true = cho qua, false = chặn (mã 429)
  remaining: number;          // Số token còn lại trong xô
  retryAfterSeconds: number;  // Số giây client phải đợi nếu bị chặn
}

// Script chạy nnguyên tử trực tiếp bên trong Redis
// Giúp nhiều request ập vào cùng 1 mili-giây không bị đọc trùng số dư (tránh Race Condition)
const TOKEN_BUCKET_LUA = `
-- set tham số
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- Mở xô trên Redis xem đang còn mấy xu và lần cuối nạp là lúc nào
local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

-- Tính toán số xu hiện có sau khi nạp thêm theo thời gian trôi qua
if tokens == nil or last_refill == nil then
  -- Khách mới gọi lần đầu cho phát đầy xô
  tokens = capacity
  last_refill = now
else
  -- Khách cũ thì tính số ms đã trôi qua kể từ lần gọi trước
  local elapsed = math.max(0, now - last_refill)
  local refill_rate = capacity / window_ms
  -- Cộng xu vừa bơm vào xô, nhưng không vượt quá trần capacity
  tokens = math.min(capacity, tokens + (elapsed * refill_rate))
  last_refill = now
end

-- Kiểm tra xem trong xô còn đủ 1 xu để thu phí không
local allowed = 0
local retry_after_ms = 0

if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  local needed = 1 - tokens
  retry_after_ms = math.ceil(needed / (capacity / window_ms))
end

-- Lưu lại trạng thái mới lên Redis và hẹn giờ tự xóa key nếu khách im lặng hết 1 chu kỳ
redis.call('HSET', key, 'tokens', tostring(tokens), 'last_refill', tostring(last_refill))
redis.call('PEXPIRE', key, window_ms)

return { allowed, math.floor(tokens), retry_after_ms }
`;

@Injectable()
export class RedisTokenBucketService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisTokenBucketService.name);
  private readonly redisClient: Redis;

  constructor(
    @Inject(redisConfig.KEY)
    private readonly config: ConfigType<typeof redisConfig>,
  ) {
    this.redisClient = new Redis({
      host: this.config.host,
      port: this.config.port,
      lazyConnect: true,          // Chỉ kết nối khi gọi connect()
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,       // Quá 2 giây không nối được Redis thì bỏ qua
      enableOfflineQueue: false,
    });

    this.redisClient.connect().catch((err) => {
      this.logger.warn(
        `Redis rate limiter connection failed: ${err.message}. Failing open.`,
      );
    });
  }

  async consume(
    key: string,
    capacity: number,
    windowMs: number,
  ): Promise<TokenBucketResult> {
    // Fail-open: nếu Redis đang rớt thì- tạm thời cho request đi qua để không làm sập
    if (this.redisClient.status !== "ready") {
      return { allowed: true, remaining: capacity, retryAfterSeconds: 0 };
    }

    try {
      const now = Date.now();
      // Gọi lệnh EVAL chạy đoạn Lua trên Redis.
      const result = (await this.redisClient.eval(
        TOKEN_BUCKET_LUA,
        1,
        key,
        String(capacity),
        String(windowMs),
        String(now),
      )) as [number, number, number];

      const [allowedFlag, remaining, retryAfterMs] = result;

      return {
        allowed: allowedFlag === 1,
        remaining: Math.max(0, remaining),
        // HTTP Header Retry-After chuẩn quy định tính bằng giây
        retryAfterSeconds:
          retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 0,
      };
    } catch (error) {
      this.logger.warn(`Rate limiter Redis error: ${error}. Failing open.`);
      return { allowed: true, remaining: capacity, retryAfterSeconds: 0 };
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redisClient.status !== "end") {
      await this.redisClient.quit().catch(() => {});
    }
  }
}
