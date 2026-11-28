const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { loadEnv } = require('./helper.cjs');

const distServicePath = resolve(
  __dirname,
  '../../dist/modules/money-movement/infrastructure/cache/redis-atomic-reservation.service.js',
);
const { RedisAtomicReservationService } = require(distServicePath);

async function waitReady(service, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (service.redis && service.redis.status === 'ready') return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('redis not ready');
}

async function main() {
  const dotEnv = loadEnv();
  const host = process.env.REDIS_HOST || dotEnv.REDIS_HOST || '127.0.0.1';
  const port = Number(process.env.REDIS_PORT || dotEnv.REDIS_PORT || 6379);
  const service = new RedisAtomicReservationService({ host, port });

  try {
    await waitReady(service);
    await service.invalidate('acc-race');
    await service.invalidate('acc-bench');

    // 1. test tranh chap 20 vu x 10 lan = 200 lenh rut 10000 tu so du 1000000
    await service.seedAccount({
      accountId: 'acc-race',
      userId: 'u1',
      status: 'ACTIVE',
      balance: '1000000',
    });

    const counts = { ok: 0, insufficient: 0, other: 0 };
    const tRace = performance.now();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        (async () => {
          for (let i = 0; i < 10; i++) {
            const res = await service.reserveDebit('acc-race', 'u1', '10000');
            if (res.status === 'OK') counts.ok += 1;
            else if (res.status === 'INSUFFICIENT_FUNDS') counts.insufficient += 1;
            else counts.other += 1;
          }
        })(),
      ),
    );
    const raceMs = (performance.now() - tRace).toFixed(2);
    const raceBalance = await service.redis.hget('res:account:acc-race', 'balance');

    assert.equal(counts.ok, 100);
    assert.equal(counts.insufficient, 100);
    assert.equal(counts.other, 0);
    assert.equal(raceBalance, '0');
    console.log(`reservation race 20 vu: ok=${counts.ok} insufficient=${counts.insufficient} balance=${raceBalance} overdraft=0 time=${raceMs} ms`);

    // 2. test thong luong 20 vu x 100 lan = 2000 lenh
    await service.seedAccount({
      accountId: 'acc-bench',
      userId: 'u1',
      status: 'ACTIVE',
      balance: '100000000',
    });

    const totalCalls = 2000;
    let benchOk = 0;
    const tBench = performance.now();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        (async () => {
          for (let i = 0; i < 100; i++) {
            const res = await service.reserveDebit('acc-bench', 'u1', '1000');
            if (res.status === 'OK') benchOk += 1;
          }
        })(),
      ),
    );
    const benchMs = performance.now() - tBench;
    const throughput = (totalCalls / (benchMs / 1000)).toFixed(2);
    const benchBalance = await service.redis.hget('res:account:acc-bench', 'balance');

    assert.equal(benchOk, totalCalls);
    assert.equal(benchBalance, '98000000');
    assert.ok(Number(throughput) >= 500);
    console.log(`reservation throughput 20 vu: calls=${totalCalls} time=${benchMs.toFixed(2)} ms throughput=${throughput} req/s balance=${benchBalance}`);

    // 3. kiem tra hoan tien va replay idempotency
    await service.releaseDebit('acc-bench', '1000');
    const afterRelease = await service.redis.hget('res:account:acc-bench', 'balance');
    assert.equal(afterRelease, '98001000');

    await service.markIdempotencyKey('acc-bench', 'idem-verify-001');
    const replayRes = await service.reserveDebit('acc-bench', 'u1', '1000', 'idem-verify-001');
    assert.equal(replayRes.status, 'REPLAY');
    console.log(`reservation release+replay: after_release=${afterRelease} replay=${replayRes.status}`);
  } finally {
    await service.invalidate('acc-race');
    await service.invalidate('acc-bench');
    if (service.redis && service.redis.status === 'ready') {
      await service.redis.del('res:idem:acc-bench:idem-verify-001', 'queue:withdraw:settlement');
    }
    await service.onModuleDestroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
