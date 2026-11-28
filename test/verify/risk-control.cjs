const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { clearRedisPrefix, registerAndLogin, req, withServer } = require('./helper.cjs');

withServer(
  async ({ baseUrl, redis }) => {
    const user = await registerAndLogin(baseUrl, redis, 'risk');
    await clearRedisPrefix(redis, 'risk:*');
    await clearRedisPrefix(redis, 'res:*');
    await clearRedisPrefix(redis, 'queue:withdraw:settlement');

    const acc1Res = await req(baseUrl, 'POST', '/accounts', {
      token: user.accessToken,
      body: {
        accountName: 'risk main',
        accountType: 'PAYMENT',
        initialDeposit: '1000000',
      },
    });
    assert.equal(acc1Res.status, 201);
    const acc1 = acc1Res.json.data;

    const acc2Res = await req(baseUrl, 'POST', '/accounts', {
      token: user.accessToken,
      body: {
        accountName: 'risk dest',
        accountType: 'PAYMENT',
        initialDeposit: '100000',
      },
    });
    assert.equal(acc2Res.status, 201);
    const acc2 = acc2Res.json.data;

    // 1. dong bang tai khoan va kiem tra chan rut, chan chuyen, giu nguyen so du
    const freezeRes = await req(baseUrl, 'POST', `/accounts/${acc1.id}/freeze`, {
      token: user.accessToken,
    });
    assert.equal(freezeRes.status, 200);
    assert.equal(freezeRes.json.data.status, 'FROZEN');

    const frozenWithdraw = await req(baseUrl, 'POST', `/accounts/${acc1.id}/transactions`, {
      token: user.accessToken,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { type: 'DEBIT', amount: '10000' },
    });
    assert.equal(frozenWithdraw.status, 409);
    assert.equal(frozenWithdraw.json.error.code, 'ACCOUNT_FROZEN');

    const frozenTransfer = await req(baseUrl, 'POST', '/transfers', {
      token: user.accessToken,
      headers: { 'Idempotency-Key': randomUUID() },
      body: {
        sourceAccountId: acc1.id,
        destinationAccountNumber: acc2.accountNumber,
        amount: '10000',
      },
    });
    assert.equal(frozenTransfer.status, 409);
    assert.equal(frozenTransfer.json.error.code, 'ACCOUNT_FROZEN');

    const checkAcc = await req(baseUrl, 'GET', `/accounts/${acc1.id}`, {
      token: user.accessToken,
    });
    assert.equal(checkAcc.status, 200);
    assert.equal(checkAcc.json.data.currentBalance, '1000000');

    console.log(
      `frozen check: status=${freezeRes.json.data.status} withdraw=${frozenWithdraw.status}/${frozenWithdraw.json.error.code} transfer=${frozenTransfer.status}/${frozenTransfer.json.error.code} balance=${checkAcc.json.data.currentBalance}`,
    );

    // mo khoa tai khoan de test han muc ngay va velocity
    const unfreezeRes = await req(baseUrl, 'POST', `/accounts/${acc1.id}/unfreeze`, {
      token: user.accessToken,
    });
    assert.equal(unfreezeRes.status, 200);
    assert.equal(unfreezeRes.json.data.status, 'ACTIVE');

    // 2. test han muc chi tieu ngay (dat 100000 VND)
    const w1 = await req(baseUrl, 'POST', `/accounts/${acc1.id}/transactions`, {
      token: user.accessToken,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { type: 'DEBIT', amount: '60000' },
    });
    assert.equal(w1.status, 201);

    const wDailyExceeded = await req(baseUrl, 'POST', `/accounts/${acc1.id}/transactions`, {
      token: user.accessToken,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { type: 'DEBIT', amount: '50000' },
    });
    assert.equal(wDailyExceeded.status, 409);
    assert.equal(wDailyExceeded.json.error.code, 'DAILY_LIMIT_EXCEEDED');

    console.log(
      `daily limit check: first=${w1.status} exceeded=${wDailyExceeded.status}/${wDailyExceeded.json.error.code}`,
    );

    // 3. test velocity (dat toi da 3 lenh trong 60 giay; da dung 1 lenh o tren)
    const w2 = await req(baseUrl, 'POST', `/accounts/${acc1.id}/transactions`, {
      token: user.accessToken,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { type: 'DEBIT', amount: '10000' },
    });
    assert.equal(w2.status, 201);

    const w3 = await req(baseUrl, 'POST', `/accounts/${acc1.id}/transactions`, {
      token: user.accessToken,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { type: 'DEBIT', amount: '10000' },
    });
    assert.equal(w3.status, 201);

    const wVelExceeded = await req(baseUrl, 'POST', `/accounts/${acc1.id}/transactions`, {
      token: user.accessToken,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { type: 'DEBIT', amount: '10000' },
    });
    assert.equal(wVelExceeded.status, 429);
    assert.equal(wVelExceeded.json.error.code, 'VELOCITY_LIMIT_EXCEEDED');

    console.log(
      `velocity check: tx2=${w2.status} tx3=${w3.status} tx4=${wVelExceeded.status}/${wVelExceeded.json.error.code}`,
    );
  },
  {
    RATE_LIMIT_ENABLED: 'false',
    RISK_CONTROL_ENABLED: 'true',
    DAILY_OUTFLOW_LIMIT_VND: '100000',
    VELOCITY_MAX_TX: '3',
    VELOCITY_WINDOW_SECONDS: '60',
  },
).catch((err) => {
  console.error(err);
  process.exit(1);
});
