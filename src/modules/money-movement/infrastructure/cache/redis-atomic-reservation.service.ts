import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import { ConfigType } from "@nestjs/config";
import Redis from "ioredis";
import { redisConfig } from "@src/common/config";
import type { TransactionEntryRecord } from "../../application/ports/unit-of-work.port";
import {
  AccountBalanceCache,
  BalanceReservationPort,
  QueuedWithdrawalItem,
  ReserveResult,
  ReserveStatus,
} from "../../application/ports/balance-reservation.port";

const CACHE_TTL = 300;
const MAX_SAFE_AMOUNT = 9_007_199_254_740_991n;
const SETTLEMENT_QUEUE_KEY = "queue:withdraw:settlement";

// lua nap so du lan dau, neu key da co san thi bo qua de khong ghi de so du moi
const SEED_LUA = `
local key = KEYS[1]
if redis.call('EXISTS', key) == 1 then
  return 0
end
redis.call('HSET', key, 'userId', ARGV[1], 'status', ARGV[2], 'balance', ARGV[3])
redis.call('EXPIRE', key, tonumber(ARGV[4]))
return 1
`;

// lua tru tien va day luon lenh vao hang doi ghi nen trong cung 1 thao tac nguyen tu
const DEBIT_LUA = `
local accKey = KEYS[1]
local idemKey = KEYS[2]
local queueKey = KEYS[3]
local reqUserId = ARGV[1]
local amount = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local txId = ARGV[4]
local createdAt = ARGV[5]
local hasDesc = ARGV[6]
local descVal = ARGV[7]
local rawIdemKey = ARGV[8]
local accountId = ARGV[9]

if redis.call('EXISTS', accKey) == 0 then
  return { 'MISS', '0' }
end

local ownerId = redis.call('HGET', accKey, 'userId')
if ownerId ~= reqUserId then
  return { 'NOT_OWNER', '0' }
end

if idemKey ~= '' then
  local cachedTx = redis.call('GET', idemKey)
  if cachedTx then
    return { 'REPLAY', cachedTx }
  end
end

local status = redis.call('HGET', accKey, 'status')
if status ~= 'ACTIVE' then
  return { 'CLOSED', '0' }
end

local balance = tonumber(redis.call('HGET', accKey, 'balance'))
if balance == nil or balance < amount then
  return { 'INSUFFICIENT_FUNDS', tostring(balance or 0) }
end

local nextBalance = balance - amount
redis.call('HSET', accKey, 'balance', tostring(nextBalance))
redis.call('EXPIRE', accKey, ttl)

local payload = cjson.encode({
  id = txId,
  accountId = accountId,
  userId = reqUserId,
  amount = tostring(amount),
  balanceAfter = tostring(nextBalance),
  description = hasDesc == '1' and descVal or cjson.null,
  idempotencyKey = rawIdemKey ~= '' and rawIdemKey or cjson.null,
  createdAt = createdAt
})

if idemKey ~= '' then
  redis.call('SET', idemKey, payload, 'EX', ttl)
end

redis.call('RPUSH', queueKey, payload)
return { 'OK', payload }
`;

// lua cong tra lai tien tren redis neu can hoan tac
const RELEASE_LUA = `
local accKey = KEYS[1]
local amount = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

if redis.call('EXISTS', accKey) == 0 then
  return 0
end

local balance = tonumber(redis.call('HGET', accKey, 'balance'))
if balance == nil then
  return 0
end

redis.call('HSET', accKey, 'balance', tostring(balance + amount))
redis.call('EXPIRE', accKey, ttl)
return 1
`;

// lua lay 1 lo lenh tu dau hang doi va cat khoi danh sach trong cung 1 lenh
const POP_BATCH_LUA = `
local queueKey = KEYS[1]
local limit = tonumber(ARGV[1])
local items = redis.call('LRANGE', queueKey, 0, limit - 1)
if #items > 0 then
  redis.call('LTRIM', queueKey, #items, -1)
end
return items
`;

function toTransactionRecord(item: QueuedWithdrawalItem): TransactionEntryRecord {
  return {
    id: item.id,
    accountId: item.accountId,
    transferId: null,
    transactionType: "DEBIT",
    referenceType: "CASH_WITHDRAWAL",
    amount: item.amount,
    balanceAfter: item.balanceAfter,
    status: "COMPLETED",
    description: item.description,
    idempotencyKey: item.idempotencyKey,
    createdAt: new Date(item.createdAt),
  };
}

@Injectable()
export class RedisAtomicReservationService
  implements BalanceReservationPort, OnModuleDestroy
{
  private readonly logger = new Logger(RedisAtomicReservationService.name);
  private readonly redis?: Redis;

  constructor(
    @Optional()
    @Inject(redisConfig.KEY)
    config?: ConfigType<typeof redisConfig>,
  ) {
    if (!config) return;

    // ket noi redis voi che do khong xep hang lenh khi mat mang de fallback nhanh sang db
    this.redis = new Redis({
      host: config.host,
      port: config.port,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      enableOfflineQueue: false,
    });

    this.redis.connect().catch((err) => {
      this.logger.warn(`khong ket noi duoc redis, chuyen sang dung db lock: ${err.message}`);
    });
  }

  private isReady(): boolean {
    return this.redis?.status === "ready";
  }

  private accKey(accountId: string): string {
    return `res:account:${accountId}`;
  }

  private idemKey(accountId: string, key?: string): string {
    return key ? `res:idem:${accountId}:${key}` : "";
  }

  private initLockKey(accountId: string): string {
    return `res:init:${accountId}`;
  }

  private isSafeNumber(value: string): boolean {
    try {
      const n = BigInt(value);
      return n >= 0n && n <= MAX_SAFE_AMOUNT;
    } catch {
      return false;
    }
  }

  async seedAccount(data: AccountBalanceCache): Promise<void> {
    if (!this.isReady() || !this.redis || !this.isSafeNumber(data.balance)) return;

    try {
      await this.redis.eval(
        SEED_LUA,
        1,
        this.accKey(data.accountId),
        data.userId,
        data.status,
        data.balance,
        String(CACHE_TTL),
      );
    } catch (err) {
      this.logger.warn(`seed so du len redis that bai: ${(err as Error).message}`);
    }
  }

  async syncAccount(data: AccountBalanceCache): Promise<void> {
    if (!this.isReady() || !this.redis) return;

    if (!this.isSafeNumber(data.balance)) {
      await this.invalidate(data.accountId);
      return;
    }

    try {
      const key = this.accKey(data.accountId);
      await this.redis.hset(key, {
        userId: data.userId,
        status: data.status,
        balance: data.balance,
      });
      await this.redis.expire(key, CACHE_TTL);
    } catch (err) {
      this.logger.warn(`dong bo so du len redis that bai: ${(err as Error).message}`);
    }
  }

  async reserveDebit(
    accountId: string,
    userId: string,
    amount: string,
    idempotencyKey?: string,
    description?: string | null,
  ): Promise<ReserveResult> {
    if (!this.isReady() || !this.redis || !this.isSafeNumber(amount)) {
      return { status: "FALLBACK" };
    }

    try {
      const txId = randomUUID();
      const createdAt = new Date().toISOString();
      const hasDesc = description !== undefined && description !== null ? "1" : "0";

      const res = (await this.redis.eval(
        DEBIT_LUA,
        3,
        this.accKey(accountId),
        this.idemKey(accountId, idempotencyKey),
        SETTLEMENT_QUEUE_KEY,
        userId,
        amount,
        String(CACHE_TTL),
        txId,
        createdAt,
        hasDesc,
        description ?? "",
        idempotencyKey ?? "",
        accountId,
      )) as [ReserveStatus, string];

      const status = res[0];
      const payload = res[1];

      if (status === "OK") {
        const parsed = JSON.parse(payload) as QueuedWithdrawalItem;
        return {
          status: "OK",
          remainingBalance: parsed.balanceAfter,
          queuedTransaction: toTransactionRecord(parsed),
        };
      }

      if (status === "REPLAY") {
        // neu key cu chi luu "1" (tu luong dong bo) thi cho xuong db lay hoa don cu
        if (payload === "1") {
          return { status: "REPLAY" };
        }
        const parsed = JSON.parse(payload) as QueuedWithdrawalItem;
        return {
          status: "REPLAY",
          replayedTransaction: toTransactionRecord(parsed),
        };
      }

      return { status, remainingBalance: payload };
    } catch (err) {
      this.logger.warn(`chay lua tru tien loi, dung db lock: ${(err as Error).message}`);
      return { status: "FALLBACK" };
    }
  }

  async releaseDebit(accountId: string, amount: string): Promise<void> {
    if (!this.isReady() || !this.redis || !this.isSafeNumber(amount)) return;

    try {
      await this.redis.eval(
        RELEASE_LUA,
        1,
        this.accKey(accountId),
        amount,
        String(CACHE_TTL),
      );
    } catch (err) {
      this.logger.warn(`hoan tien tren redis loi: ${(err as Error).message}`);
      await this.invalidate(accountId);
    }
  }

  async markIdempotencyKey(accountId: string, idempotencyKey: string): Promise<void> {
    if (!this.isReady() || !this.redis) return;

    try {
      await this.redis.set(this.idemKey(accountId, idempotencyKey), "1", "EX", CACHE_TTL);
    } catch (err) {
      this.logger.warn(`luu idempotency key tren redis loi: ${(err as Error).message}`);
    }
  }

  async invalidate(accountId: string): Promise<void> {
    if (!this.isReady() || !this.redis) return;

    try {
      await this.redis.del(this.accKey(accountId));
    } catch (err) {
      this.logger.warn(`xoa cache so du tren redis loi: ${(err as Error).message}`);
    }
  }

  async popSettlementBatch(limit: number): Promise<QueuedWithdrawalItem[]> {
    if (!this.isReady() || !this.redis || limit <= 0) return [];

    try {
      const rawItems = (await this.redis.eval(
        POP_BATCH_LUA,
        1,
        SETTLEMENT_QUEUE_KEY,
        String(limit),
      )) as string[];

      return rawItems.map((raw) => JSON.parse(raw) as QueuedWithdrawalItem);
    } catch (err) {
      this.logger.warn(`lay lo lenh tu hang doi redis loi: ${(err as Error).message}`);
      return [];
    }
  }

  async requeueSettlementBatch(items: QueuedWithdrawalItem[]): Promise<void> {
    if (!this.isReady() || !this.redis || items.length === 0) return;

    try {
      // day nguoc lai vao dau danh sach de giu dung thu tu cu
      const reversed = [...items].reverse().map((item) => JSON.stringify(item));
      await this.redis.lpush(SETTLEMENT_QUEUE_KEY, ...reversed);
    } catch (err) {
      this.logger.error(`tra nguoc lenh vao hang doi redis that bai: ${(err as Error).message}`);
    }
  }

  async acquireInitLock(accountId: string): Promise<boolean> {
    if (!this.isReady() || !this.redis) return true;
    try {
      const res = await this.redis.set(this.initLockKey(accountId), "1", "PX", 3000, "NX");
      return res === "OK";
    } catch {
      return true;
    }
  }

  async releaseInitLock(accountId: string): Promise<void> {
    if (!this.isReady() || !this.redis) return;
    try {
      await this.redis.del(this.initLockKey(accountId));
    } catch (err) {
      this.logger.warn(`xoa khoa khoi tao redis loi: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis?.status === "ready") {
      await this.redis.quit();
    }
  }
}
