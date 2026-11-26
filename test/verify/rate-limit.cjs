const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { clearRedisPrefix, registerAndLogin, req, withServer } = require('./helper.cjs');

withServer(async ({ baseUrl, redis }) => {
  // 1. rate limit api dang nhap (5 req / 60s theo ip)
  await clearRedisPrefix(redis, 'rl:auth:*');
  const authStatuses = [];
  const authTimes = [];

  for (let i = 1; i <= 7; i++) {
    const res = await req(baseUrl, 'POST', '/auth/login', {
      body: { email: `rl_check_${Date.now()}_${i}@bank.local`, password: 'WrongPassword1!' },
    });
    authStatuses.push(res.status);
    authTimes.push(res.ms);
    if (i <= 5) {
      assert.equal(res.status, 401);
    } else {
      assert.equal(res.status, 429);
      assert.equal(res.json?.error?.code, 'RATE_LIMIT_EXCEEDED');
    }
  }

  console.log(`auth login limit (5/60s): pass_401=${authStatuses.filter((s) => s === 401).length} blocked_429=${authStatuses.filter((s) => s === 429).length} blocked_time=${authTimes[5]} ms`);

  // 2. rate limit api chuyen khoan (20 req / 10s theo ip)
  const user = await registerAndLogin(baseUrl, redis, 'rl_tf');
  await clearRedisPrefix(redis, 'rl:transfers:*');

  const tfResponses = await Promise.all(
    Array.from({ length: 22 }, () =>
      req(baseUrl, 'POST', '/transfers', {
        token: user.accessToken,
        headers: { 'Idempotency-Key': randomUUID() },
        body: {
          sourceAccountId: randomUUID(),
          destinationAccountNumber: '123456789012',
          amount: '1000',
        },
      }),
    ),
  );
  const tfPassed = tfResponses.filter((r) => r.status !== 429);
  const tfBlocked = tfResponses.filter((r) => r.status === 429);
  assert.equal(tfPassed.length, 20);
  assert.equal(tfBlocked.length, 2);
  assert.equal(tfBlocked[0].json?.error?.code, 'RATE_LIMIT_EXCEEDED');

  console.log(`transfers limit (20/10s): passed=${tfPassed.length} blocked_429=${tfBlocked.length} blocked_time=${tfBlocked[0].ms} ms`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
