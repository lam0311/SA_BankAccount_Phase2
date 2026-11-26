const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { clearRedisPrefix, registerAndLogin, req, withServer } = require('./helper.cjs');

withServer(
  async ({ baseUrl, redis }) => {
    const user = await registerAndLogin(baseUrl, redis, 'settle');
    await clearRedisPrefix(redis, 'queue:withdraw:settlement');
    await clearRedisPrefix(redis, 'res:*');

    const openRes = await req(baseUrl, 'POST', '/accounts', {
      token: user.accessToken,
      body: {
        accountName: 'settlement bench',
        accountType: 'PAYMENT',
        initialDeposit: '10000000',
      },
    });
    assert.equal(openRes.status, 201);
    const accountId = openRes.json.data.id;

    // 1 lenh moi dau tien de nap so du len redis (tu miss sang hit)
    const warmup = await req(baseUrl, 'POST', `/accounts/${accountId}/transactions`, {
      token: user.accessToken,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { type: 'DEBIT', amount: '1000' },
    });
    assert.equal(warmup.status, 201);

    // 20 luong dong thoi x 25 lenh = 500 lenh rut tien qua http that
    const workers = 20;
    const perWorker = 25;
    const total = workers * perWorker;
    let okCount = 0;

    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: workers }, () =>
        (async () => {
          for (let i = 0; i < perWorker; i++) {
            const res = await req(baseUrl, 'POST', `/accounts/${accountId}/transactions`, {
              token: user.accessToken,
              headers: { 'Idempotency-Key': randomUUID() },
              body: { type: 'DEBIT', amount: '1000' },
            });
            if (res.status === 201) okCount += 1;
          }
        })(),
      ),
    );
    const elapsedMs = performance.now() - t0;
    const throughput = (total / (elapsedMs / 1000)).toFixed(2);
    assert.equal(okCount, total);

    // cho worker chay nen ghi not lo cuoi xuong postgres va xoa cache doc de kiem tra db that
    await new Promise((r) => setTimeout(r, 600));
    await clearRedisPrefix(redis, `accounts:*${accountId}*`);
    await clearRedisPrefix(redis, `accounts:*${user.userId}*`);

    const acc = await req(baseUrl, 'GET', `/accounts/${accountId}`, {
      token: user.accessToken,
    });
    assert.equal(acc.status, 200);
    assert.equal(acc.json.data.currentBalance, '9499000');

    const history = await req(baseUrl, 'GET', `/accounts/${accountId}/transactions?page=1&limit=1`, {
      token: user.accessToken,
    });
    assert.equal(history.status, 200);
    assert.equal(history.json.pagination.total, 502);

    console.log(
      `http debit 20 vu (${total} calls): ok=${okCount} time=${elapsedMs.toFixed(2)} ms throughput=${throughput} req/s`,
    );
    console.log(
      `postgres reconcile: balance=${acc.json.data.currentBalance} entries=${history.json.pagination.total}`,
    );

    // 2. test tranh chap cold-start 20 vu dong thoi khi redis chua co key (chua warmup)
    const raceOpen = await req(baseUrl, 'POST', '/accounts', {
      token: user.accessToken,
      body: {
        accountName: 'cold start race',
        accountType: 'PAYMENT',
        initialDeposit: '100000',
      },
    });
    assert.equal(raceOpen.status, 201);
    const raceAccId = raceOpen.json.data.id;

    const raceResponses = await Promise.all(
      Array.from({ length: 20 }, () =>
        req(baseUrl, 'POST', `/accounts/${raceAccId}/transactions`, {
          token: user.accessToken,
          headers: { 'Idempotency-Key': randomUUID() },
          body: { type: 'DEBIT', amount: '10000' },
        }),
      ),
    );

    const ok201 = raceResponses.filter((r) => r.status === 201).length;
    const rejected409 = raceResponses.filter(
      (r) => r.status === 409 && r.json?.error?.code === 'INSUFFICIENT_FUNDS',
    ).length;
    assert.equal(ok201, 10);
    assert.equal(rejected409, 10);

    for (let i = 0; i < 100; i++) {
      const qlen = await redis.llen('queue:withdraw:settlement');
      if (qlen === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 150));
    await clearRedisPrefix(redis, `accounts:*${raceAccId}*`);
    await clearRedisPrefix(redis, `accounts:*${user.userId}*`);

    const raceAcc = await req(baseUrl, 'GET', `/accounts/${raceAccId}`, {
      token: user.accessToken,
    });
    assert.equal(raceAcc.status, 200);
    assert.equal(raceAcc.json.data.currentBalance, '0');

    const raceHistory = await req(
      baseUrl,
      'GET',
      `/accounts/${raceAccId}/transactions?type=DEBIT&page=1&limit=1`,
      { token: user.accessToken },
    );
    assert.equal(raceHistory.status, 200);
    assert.equal(raceHistory.json.pagination.total, 10);

    console.log(
      `cold start race 20 vu: ok_201=${ok201} rejected_409=${rejected409} balance=${raceAcc.json.data.currentBalance} debit_entries=${raceHistory.json.pagination.total}`,
    );
  },
  { RATE_LIMIT_ENABLED: 'false' },
).catch((err) => {
  console.error(err);
  process.exit(1);
});
