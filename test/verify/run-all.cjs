const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const scripts = [
  'cache.cjs',
  'rate-limit.cjs',
  'idempotency.cjs',
  'auth-session.cjs',
  'reservation.cjs',
  'settlement.cjs',
];

for (const file of scripts) {
  execFileSync(process.execPath, [join(__dirname, file)], { stdio: 'inherit' });
}
