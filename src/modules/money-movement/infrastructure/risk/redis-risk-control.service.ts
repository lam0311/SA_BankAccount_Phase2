import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import { ConfigService, ConfigType } from "@nestjs/config";
import Redis from "ioredis";
import { redisConfig } from "@src/common/config";
import {
  RiskCheckResult,
  RiskControlPort,
} from "../../application/ports/risk-control.port";

const MAX_SAFE_AMOUNT = 9_007_199_254_740_991n;

// kiem tra tan suat giao dich va han muc chi tieu ngay trong cung 1 lenh lua
const CHECK_AND_CONSUME_LUA = `
local dailyKey = KEYS[1]
local velKey = KEYS[2]
local amount = tonumber(ARGV[1])
local dailyLimit = tonumber(ARGV[2])
local dailyTtl = tonumber(ARGV[3])
local maxVel = tonumber(ARGV[4])
local velWinSec = tonumber(ARGV[5])
local nowMs = tonumber(ARGV[6])
local member = ARGV[7]

local cutoff = nowMs - (velWinSec * 1000)
redis.call('ZREMRANGEBYSCORE', velKey, '-inf', cutoff)
local currentCount = redis.call('ZCARD', velKey)
if currentCount >= maxVel then
  return { 'VELOCITY_LIMIT_EXCEEDED', tostring(currentCount) }
end

local spent = tonumber(redis.call('GET', dailyKey) or '0')
if spent + amount > dailyLimit then
  return { 'DAILY_LIMIT_EXCEEDED', tostring(spent) }
end

local nextSpent = spent + amount
redis.call('SET', dailyKey, tostring(nextSpent), 'EX', dailyTtl)
redis.call('ZADD', velKey, nowMs, member)
redis.call('EXPIRE', velKey, velWinSec)
return { 'OK', tostring(nextSpent) }
`;

// tra lai han muc va tan suat neu giao dich bi loi phia sau
const RELEASE_RISK_LUA = `
local dailyKey = KEYS[1]
local velKey = KEYS[2]
local amount = tonumber(ARGV[1])
local member = ARGV[2]

if member ~= '' then
  redis.call('ZREM', velKey, member)
end

if redis.call('EXISTS', dailyKey) == 1 then
  local spent = tonumber(redis.call('GET', dailyKey) or '0')
  local nextSpent = spent - amount
  if nextSpent < 0 then
    nextSpent = 0
  end
  local ttl = redis.call('TTL', dailyKey)
  if ttl > 0 then
    redis.call('SET', dailyKey, tostring(nextSpent), 'EX', ttl)
  else
    redis.call('SET', dailyKey, tostring(nextSpent))
  end
end
return 1
`;

function getUtcDateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function secondsUntilEndOfUtcDay(now: Date): number {
  const end = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
  );
  return Math.max(1, Math.ceil((end - now.getTime()) / 1000));
}

@Injectable()
export class RedisRiskControlService implements RiskControlPort, OnModuleDestroy {
  private readonly logger = new Logger(RedisRiskControlService.name);
  private readonly redis?: Redis;
  private readonly enabled: boolean;
  private readonly dailyLimitVnd: string;
  private readonly velocityMaxTx: number;
  private readonly velocityWindowSeconds: number;

  constructor(
    @Optional()
    @Inject(redisConfig.KEY)
    config?: ConfigType<typeof redisConfig>,
    @Optional()
    configService?: ConfigService,
  ) {
    this.enabled = (configService?.get<string>("RISK_CONTROL_ENABLED") ?? "true") !== "false";
    this.dailyLimitVnd = configService?.get<string>("DAILY_OUTFLOW_LIMIT_VND") ?? "500000000";
    this.velocityMaxTx = Number(configService?.get<number>("VELOCITY_MAX_TX") ?? 10);
    this.velocityWindowSeconds = Number(configService?.get<number>("VELOCITY_WINDOW_SECONDS") ?? 60);

    if (!config) return;

    this.redis = new Redis({
      host: config.host,
      port: config.port,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      enableOfflineQueue: false,
    });

    this.redis.connect().catch((err) => {
      this.logger.warn(`khong ket noi duoc redis cho risk control: ${err.message}`);
    });
  }

  private isReady(): boolean {
    return this.redis?.status === "ready";
  }

  private isSafeNumber(value: string): boolean {
    try {
      const n = BigInt(value);
      return n >= 0n && n <= MAX_SAFE_AMOUNT;
    } catch {
      return false;
    }
  }

  private dailyKey(accountId: string, now: Date): string {
    return `risk:daily:${accountId}:${getUtcDateString(now)}`;
  }

  private velocityKey(accountId: string): string {
    return `risk:vel:${accountId}`;
  }

  async checkAndConsumeOutflow(
    accountId: string,
    amount: string,
  ): Promise<RiskCheckResult> {
    if (
      !this.enabled ||
      !this.isReady() ||
      !this.redis ||
      !this.isSafeNumber(amount) ||
      !this.isSafeNumber(this.dailyLimitVnd)
    ) {
      return { status: "SKIPPED" };
    }

    const now = new Date();
    const memberId = randomUUID();

    try {
      const res = (await this.redis.eval(
        CHECK_AND_CONSUME_LUA,
        2,
        this.dailyKey(accountId, now),
        this.velocityKey(accountId),
        amount,
        this.dailyLimitVnd,
        String(secondsUntilEndOfUtcDay(now)),
        String(this.velocityMaxTx),
        String(this.velocityWindowSeconds),
        String(now.getTime()),
        memberId,
      )) as [string, string];

      const status = res[0];
      const metric = res[1];

      if (status === "VELOCITY_LIMIT_EXCEEDED") {
        return {
          status: "VELOCITY_LIMIT_EXCEEDED",
          velocityCount: Number(metric),
        };
      }

      if (status === "DAILY_LIMIT_EXCEEDED") {
        return {
          status: "DAILY_LIMIT_EXCEEDED",
          dailySpent: metric,
        };
      }

      return {
        status: "OK",
        memberId,
        dailySpent: metric,
      };
    } catch (err) {
      this.logger.warn(`kiem tra han muc tren redis loi: ${(err as Error).message}`);
      return { status: "SKIPPED" };
    }
  }

  async releaseOutflow(
    accountId: string,
    amount: string,
    memberId?: string,
  ): Promise<void> {
    if (!this.enabled || !this.isReady() || !this.redis || !this.isSafeNumber(amount)) {
      return;
    }

    const now = new Date();
    try {
      await this.redis.eval(
        RELEASE_RISK_LUA,
        2,
        this.dailyKey(accountId, now),
        this.velocityKey(accountId),
        amount,
        memberId ?? "",
      );
    } catch (err) {
      this.logger.warn(`hoan tac han muc tren redis loi: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis?.status === "ready") {
      await this.redis.quit();
    }
  }
}
