const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { clearRedisPrefix, registerAndLogin, req, withServer } = require('./helper.cjs');

withServer(async ({ baseUrl, redis }) => {
  const user = await registerAndLogin(baseUrl, redis, 'idem');
  await clearRedisPrefix(redis, 'rl:transactions:*');
  await clearRedisPrefix(redis, 'rl:transfers:*');

  const openRes = await req(baseUrl, 'POST', '/accounts', {
    token: user.accessToken,
    body: {
      accountName: 'idempotency verify',
      accountType: 'PAYMENT',
      initialDeposit: '100000',
    },
  });
  assert.equal(openRes.status, 201);
  const accountId = openRes.json.data.id;

  // thieu header Idempotency-Key thi tra 400
  const missingKey = await req(baseUrl, 'POST', `/accounts/${accountId}/transactions`, {
    token: user.accessToken,
    body: { type: 'CREDIT', amount: '50000' },
  });
  assert.equal(missingKey.status, 400);
  console.log(`deposit missing idempotency key: status=${missingKey.status} time=${missingKey.ms} ms`);

  // nap lan 1 tra 201
  const depKey = randomUUID();
  const dep1 = await req(baseUrl, 'POST', `/accounts/${accountId}/transactions`, {
    token: user.accessToken,
    headers: { 'Idempotency-Key': depKey },
    body: { type: 'CREDIT', amount: '50000' },
  });
  assert.equal(dep1.status, 201);
  assert.equal(dep1.json.data.balanceAfter, '150000');
  console.log(`deposit create: status=${dep1.status} balance=${dep1.json.data.balanceAfter} time=${dep1.ms} ms`);

  // nap replay cung key tra 200, khong cong lai
  const dep2 = await req(baseUrl, 'POST', `/accounts/${accountId}/transactions`, {
    token: user.accessToken,
    headers: { 'Idempotency-Key': depKey },
    body: { type: 'CREDIT', amount: '50000' },
  });
  assert.equal(dep2.status, 200);
  assert.equal(dep2.json.data.id, dep1.json.data.id);
  assert.equal(dep2.json.data.balanceAfter, '150000');
  console.log(`deposit replay: status=${dep2.status} same_id=${dep2.json.data.id === dep1.json.data.id} balance=${dep2.json.data.balanceAfter} time=${dep2.ms} ms`);

  // dung lai key cu nhung doi so tien thi tra 409
  const reused = await req(baseUrl, 'POST', `/accounts/${accountId}/transactions`, {
    token: user.accessToken,
    headers: { 'Idempotency-Key': depKey },
    body: { type: 'CREDIT', amount: '90000' },
  });
  assert.equal(reused.status, 409);
  assert.equal(reused.json?.error?.code, 'IDEMPOTENCY_KEY_REUSED');
  console.log(`deposit reused different amount: status=${reused.status} code=${reused.json.error.code} time=${reused.ms} ms`);

  // rut lan 1 (201) va replay rut (200)
  const wdKey = randomUUID();
  const wd1 = await req(baseUrl, 'POST', `/accounts/${accountId}/transactions`, {
    token: user.accessToken,
    headers: { 'Idempotency-Key': wdKey },
    body: { type: 'DEBIT', amount: '40000' },
  });
  assert.equal(wd1.status, 201);
  assert.equal(wd1.json.data.balanceAfter, '110000');

  const wd2 = await req(baseUrl, 'POST', `/accounts/${accountId}/transactions`, {
    token: user.accessToken,
    headers: { 'Idempotency-Key': wdKey },
    body: { type: 'DEBIT', amount: '40000' },
  });
  assert.equal(wd2.status, 200);
  assert.equal(wd2.json.data.id, wd1.json.data.id);
  console.log(`withdraw create+replay: status1=${wd1.status} status2=${wd2.status} balance=${wd2.json.data.balanceAfter} time=${wd2.ms} ms`);

  // kiem tra chan null byte tren dto transfer (tsk-11)
  const nullByte = await req(baseUrl, 'POST', '/transfers', {
    token: user.accessToken,
    headers: { 'Idempotency-Key': randomUUID() },
    body: {
      sourceAccountId: accountId,
      destinationAccountNumber: '123456\u00007890',
      amount: '1000',
    },
  });
  assert.equal(nullByte.status, 400);
  assert.equal(nullByte.json?.error?.code, 'VALIDATION_ERROR');
  console.log(`transfer null byte dto check: status=${nullByte.status} code=${nullByte.json.error.code} time=${nullByte.ms} ms`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
