const assert = require('node:assert/strict');
const { clearRedisPrefix, registerAndLogin, req, withServer } = require('./helper.cjs');

withServer(async ({ baseUrl, redis }) => {
  const user = await registerAndLogin(baseUrl, redis, 'cache');

  const openRes = await req(baseUrl, 'POST', '/accounts', {
    token: user.accessToken,
    body: {
      accountName: 'cache verify account',
      accountType: 'PAYMENT',
      initialDeposit: '100000',
    },
  });
  assert.equal(openRes.status, 201);
  const accountId = openRes.json.data.id;

  // xoa cache tai khoan nay de lan doc dau tien chac chan la cold miss
  await clearRedisPrefix(redis, `accounts:*${user.userId}*`);
  await clearRedisPrefix(redis, `accounts:*${accountId}*`);

  const coldList = await req(baseUrl, 'GET', '/accounts', { token: user.accessToken });
  assert.equal(coldList.status, 200);

  const warmLatencies = [];
  for (let i = 0; i < 5; i++) {
    const warmList = await req(baseUrl, 'GET', '/accounts', { token: user.accessToken });
    assert.equal(warmList.status, 200);
    warmLatencies.push(warmList.ms);
  }

  const warmAvg = (
    warmLatencies.reduce((sum, v) => sum + v, 0) / warmLatencies.length
  ).toFixed(2);
  const redisKeys = await redis.keys(`accounts:*${user.userId}*`);
  assert.ok(redisKeys.length > 0);

  console.log(`cache list cold: status=${coldList.status} time=${coldList.ms} ms`);
  console.log(`cache list warm (5 calls): avg=${warmAvg} ms min=${Math.min(...warmLatencies).toFixed(2)} ms max=${Math.max(...warmLatencies).toFixed(2)} ms`);
  console.log(`redis cache keys (${user.userId}): count=${redisKeys.length}`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
