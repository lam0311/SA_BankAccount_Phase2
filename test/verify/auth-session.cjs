const assert = require('node:assert/strict');
const { clearRedisPrefix, registerAndLogin, req, withServer } = require('./helper.cjs');

function decodeJwtPayload(token) {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

withServer(async ({ baseUrl, redis }) => {
  const user = await registerAndLogin(baseUrl, redis, 'auth20');
  const claims = decodeJwtPayload(user.accessToken);
  assert.ok(typeof claims.jti === 'string' && claims.jti.length > 0);
  assert.equal(claims.exp - claims.iat, 900);
  console.log(`login token claims: access_ttl=${claims.exp - claims.iat}s has_jti=true has_refresh=true`);

  // 1. logout thu hoi ngay access token qua jti blacklist
  const beforeLogout = await req(baseUrl, 'GET', '/accounts', { token: user.accessToken });
  assert.equal(beforeLogout.status, 200);

  const logoutRes = await req(baseUrl, 'POST', '/auth/logout', {
    token: user.accessToken,
    body: { refreshToken: user.refreshToken },
  });
  assert.equal(logoutRes.status, 200);

  const afterLogout = await req(baseUrl, 'GET', '/accounts', { token: user.accessToken });
  assert.equal(afterLogout.status, 401);
  console.log(`logout revoke jti: before=${beforeLogout.status} logout=${logoutRes.status} after=${afterLogout.status} (${afterLogout.ms} ms)`);

  // 2. xoay vong refresh token va bat dung lai token cu
  await clearRedisPrefix(redis, 'rl:auth:*');
  const login2 = await req(baseUrl, 'POST', '/auth/login', {
    body: { email: user.email, password: user.password },
  });
  assert.equal(login2.status, 200);
  const rt1 = login2.json.data.refreshToken;

  const refresh1 = await req(baseUrl, 'POST', '/auth/refresh', {
    body: { refreshToken: rt1 },
  });
  assert.equal(refresh1.status, 200);
  const rt2 = refresh1.json.data.refreshToken;
  assert.ok(rt2 && rt2 !== rt1);

  const reuseRt1 = await req(baseUrl, 'POST', '/auth/refresh', {
    body: { refreshToken: rt1 },
  });
  assert.equal(reuseRt1.status, 401);

  const useRt2AfterReuse = await req(baseUrl, 'POST', '/auth/refresh', {
    body: { refreshToken: rt2 },
  });
  assert.equal(useRt2AfterReuse.status, 401);
  console.log(`refresh rotation: rotate=${refresh1.status} reuse_rt1=${reuseRt1.status} rt2_revoked=${useRt2AfterReuse.status} (${refresh1.ms} ms)`);

  // 3. khoa tai khoan theo email khi sai mat khau 5 lan (xoa rate limit ip moi lan gui)
  const victimEmail = `lock_${Date.now()}@bank.local`;
  const statuses = [];
  let lockTime = 0;
  for (let i = 1; i <= 6; i++) {
    await clearRedisPrefix(redis, 'rl:auth:*');
    const res = await req(baseUrl, 'POST', '/auth/login', {
      body: { email: victimEmail, password: 'WrongPassword1!' },
    });
    statuses.push(res.status);
    if (i <= 5) {
      assert.equal(res.status, 401);
    } else {
      assert.equal(res.status, 429);
      assert.equal(res.json?.error?.code, 'ACCOUNT_LOCKED');
      lockTime = res.ms;
    }
  }
  console.log(`email brute force lockout: attempts_1_to_5=${statuses.slice(0, 5).join(',')} attempt_6=${statuses[5]} (${lockTime} ms)`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
