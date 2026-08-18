// Boots the real Hono app over HTTP and exercises the whole authentication slice,
// including the throttle that had to move from memory into Postgres.
import { app } from '../api/index.ts';
import { hashPassword } from '../api/lib/auth.ts';
import { all, applySchema, close, get, run } from '../api/db.ts';

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${cond ? '' : '  ' + JSON.stringify(extra)}`);
  cond ? pass++ : fail++;
};
const section = (n: string) => console.log(`\n${n}`);

const PORT = 3288;
const BASE = `http://127.0.0.1:${PORT}`;
const server = Deno.serve({ port: PORT, hostname: '127.0.0.1', onListen: () => {} }, app.fetch);

// A fixed client IP so the throttle key is deterministic, delivered the way
// Cloudflare delivers it (cf-connecting-ip, which a client cannot forge).
const IP = { 'cf-connecting-ip': '203.0.113.7' };
const req = (path: string, init: RequestInit = {}) =>
  fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...IP, ...(init.headers ?? {}) },
  });

// ---------------------------------------------------------------- setup
await applySchema(await Deno.readTextFile(new URL('../db/schema.postgres.sql', import.meta.url)));
await run(`TRUNCATE attendance, punch_log, leave_requests, schedules, project_members,
                   projects, shifts, holidays, login_attempts, users RESTART IDENTITY CASCADE`);
await run(
  `INSERT INTO users (employee_code, full_name, email, role, password_hash,
                      must_change_password, active, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?)`,
  'ADM-001', 'لؤي إسماعيل', 'adm@masarat.local', 'admin', hashPassword('Correct-Horse-1'),
  1, 1, '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z',
);
await run(
  `INSERT INTO users (employee_code, full_name, email, role, password_hash,
                      must_change_password, active, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?)`,
  'EMP-001', 'محمد شحاتة', 'emp@masarat.local', 'employee', hashPassword('Correct-Horse-2'),
  0, 0, '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z',
);

section('Health');
{
  const r = await req('/api/health');
  const j = await r.json();
  ok('GET /api/health -> 200', r.status === 200, r.status);
  ok('reports the company timezone label', j.tz === 'Asia/Riyadh', j);
  ok('reports a local_time in "YYYY-MM-DD HH:MM" form', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(j.local_time), j);
  ok('sends nosniff', r.headers.get('x-content-type-options') === 'nosniff');
  ok('sends no-referrer', r.headers.get('referrer-policy') === 'no-referrer');
  ok('sends Permissions-Policy geolocation=(self) — required or phones cannot share GPS',
    r.headers.get('permissions-policy') === 'geolocation=(self)');
  ok('API responses are no-store', (r.headers.get('cache-control') ?? '').includes('no-store'));
}

section('Login');
let token = '';
{
  const r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({}) });
  ok('missing credentials -> 400 with the original message',
    r.status === 400 && (await r.json()).error === 'Enter your employee ID / email and password.', r.status);
}
{
  const r = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'adm@masarat.local', password: 'wrong' }),
  });
  ok('wrong password -> 401', r.status === 401, r.status);
}
{
  const r = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'ADM-001', password: 'Correct-Horse-1' }),
  });
  const j = await r.json();
  token = j.token ?? '';
  ok('sign in with the EMPLOYEE CODE works', r.status === 200 && !!j.token, r.status);
  ok('returns a JWT with three segments', token.split('.').length === 3);
  ok('must_change_password surfaces as a boolean', j.user?.must_change_password === true, j.user);
  ok('Arabic name round-trips through the API', j.user?.full_name === 'لؤي إسماعيل', j.user);
  ok('never returns the password hash', !('password_hash' in (j.user ?? {})), j.user);
}
{
  const r = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'ADM@MASARAT.LOCAL', password: 'Correct-Horse-1' }),
  });
  ok('sign in with the EMAIL, case-insensitively, works', r.status === 200, r.status);
}
{
  const r = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'EMP-001', password: 'Correct-Horse-2' }),
  });
  ok('deactivated account -> 403, not 200', r.status === 403, r.status);
}

section('Session');
{
  const r = await req('/api/auth/me');
  ok('no token -> 401', r.status === 401, r.status);
}
{
  const r = await req('/api/auth/me', { headers: { authorization: 'Bearer not.a.real.token' } });
  ok('forged token -> 401', r.status === 401, r.status);
}
{
  const r = await req('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json();
  ok('valid token -> 200', r.status === 200, r.status);
  ok('exposes the location rules the app needs', j.location_rules?.max_accuracy_m === 75, j.location_rules);
  ok('exposes selfie_mode', j.location_rules?.selfie_mode === 'optional', j.location_rules);
}
{
  // deactivate the admin mid-session: the user row is re-read on every request
  await run('UPDATE users SET active = 0 WHERE employee_code = ?', 'ADM-001');
  const r = await req('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
  ok('a valid token for a NOW-DEACTIVATED account -> 403', r.status === 403, r.status);
  await run('UPDATE users SET active = 1 WHERE employee_code = ?', 'ADM-001');
}

section('Change password');
{
  const r = await req('/api/auth/change-password', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ current_password: 'Correct-Horse-1', new_password: 'short' }),
  });
  ok('under 8 characters -> 400', r.status === 400, r.status);
}
{
  const r = await req('/api/auth/change-password', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ current_password: 'WRONG', new_password: 'A-Longer-Password-1' }),
  });
  ok('wrong current password -> 401', r.status === 401, r.status);
}
{
  const r = await req('/api/auth/change-password', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ current_password: 'Correct-Horse-1', new_password: 'A-Longer-Password-1' }),
  });
  ok('correct change -> 200', r.status === 200, r.status);
  const u = await get<{ must_change_password: number }>(
    'SELECT must_change_password FROM users WHERE employee_code = ?', 'ADM-001');
  ok('clears must_change_password', u?.must_change_password === 0, u);
  const r2 = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'ADM-001', password: 'A-Longer-Password-1' }),
  });
  ok('the new password works', r2.status === 200, r2.status);
  const r3 = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'ADM-001', password: 'Correct-Horse-1' }),
  });
  ok('the old password no longer works', r3.status === 401, r3.status);
}

section('Login throttle — the piece that had to move from memory into Postgres');
await run('DELETE FROM login_attempts');
{
  const statuses: number[] = [];
  for (let i = 0; i < 9; i += 1) {
    const r = await req('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'ADM-001', password: `bad-${i}` }),
    });
    statuses.push(r.status);
  }
  ok('first 8 failures -> 401', statuses.slice(0, 8).every((s) => s === 401), statuses);
  ok('9th failure -> 429 (8 per 15 min, unchanged policy)', statuses[8] === 429, statuses);

  const rows = await all<{ attempts: number }>('SELECT attempts FROM login_attempts');
  ok('the counter is persisted in Postgres, so it survives a cold isolate',
    rows.length === 1 && rows[0].attempts >= 8, rows);

  const r = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'ADM-001', password: 'A-Longer-Password-1' }),
  });
  ok('even the CORRECT password is refused while throttled', r.status === 429, r.status);
}
{
  // A different client IP must have its own budget.
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9' },
    body: JSON.stringify({ identifier: 'ADM-001', password: 'A-Longer-Password-1' }),
  });
  ok('a different IP is not affected by another IP\'s throttle', r.status === 200, r.status);
}
{
  // THE ATTACK THE OLD CODE WAS VULNERABLE TO: rotate X-Forwarded-For to get a
  // fresh throttle bucket each time. cf-connecting-ip is authoritative, so it fails.
  await run('DELETE FROM login_attempts');
  let blocked = false;
  for (let i = 0; i < 12; i += 1) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.7',
        'x-forwarded-for': `10.0.0.${i}`, // forged, rotating
      },
      body: JSON.stringify({ identifier: 'ADM-001', password: `spoof-${i}` }),
    });
    if (r.status === 429) { blocked = true; break; }
  }
  ok('rotating a forged X-Forwarded-For does NOT defeat the throttle', blocked);
}
{
  const expired = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  await run('UPDATE login_attempts SET first_at = ?', expired);
  const r = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'ADM-001', password: 'A-Longer-Password-1' }),
  });
  ok('the window expires after 15 minutes and access is restored', r.status === 200, r.status);
}

section('Unknown routes and the cron guard');
{
  const r = await req('/api/nope');
  ok('unknown /api route -> 404 JSON, no stack trace',
    r.status === 404 && (await r.json()).error === 'Unknown endpoint.', r.status);
}
{
  const r = await req('/api/cron/auto-close', { method: 'POST' });
  ok('auto-close without the shared secret -> 401 (it replaced an in-process timer)', r.status === 401, r.status);
}

console.log(`\nPASS: ${pass}   FAIL: ${fail}`);
await server.shutdown();
await close();
if (fail) Deno.exit(1);
