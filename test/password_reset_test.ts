// v2.1 — password reset: employee "forgot password" requests, admin approve /
// reject, direct admin reset, the on/off switch, and lockout clearing.
// Boots the real Hono app over HTTP against a throwaway Postgres.
import { app } from '../api/index.ts';
import { hashPassword } from '../api/lib/auth.ts';
import { generateTempPassword } from '../api/lib/password_reset.ts';
import { applySchema, close, get, run } from '../api/db.ts';

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${cond ? '' : '  ' + JSON.stringify(extra)}`);
  cond ? pass++ : fail++;
};
const section = (n: string) => console.log(`\n${n}`);

const PORT = 3289;
const BASE = `http://127.0.0.1:${PORT}`;
const server = Deno.serve({ port: PORT, hostname: '127.0.0.1', onListen: () => {} }, app.fetch);

let ipSeq = 10;
// deno-lint-ignore no-explicit-any
async function call(path: string, { method = 'GET', token, body, ip }: { method?: string; token?: string; body?: unknown; ip?: string } = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': ip ?? '198.51.100.1',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const login = (identifier: string, password: string, ip?: string) =>
  call('/api/auth/login', { method: 'POST', body: { identifier, password }, ip });

// ---------------------------------------------------------------- setup
await applySchema(await Deno.readTextFile(new URL('../db/schema.postgres.sql', import.meta.url)));
await run(`TRUNCATE password_resets, app_settings, attendance, punch_log, leave_requests, schedules,
                   project_members, projects, shifts, holidays, login_attempts, users RESTART IDENTITY CASCADE`);
const mk = (code: string, email: string, role: string, pwd: string, active = 1) => run(
  `INSERT INTO users (employee_code, full_name, email, role, password_hash,
                      must_change_password, active, created_at, updated_at)
   VALUES (?,?,?,?,?,0,?,?,?)`,
  code, code, email, role, hashPassword(pwd), active, '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z');
await mk('ADM-001', 'adm@masarat.local', 'admin', 'Admin-Pass-1');
await mk('SUP-001', 'sup@masarat.local', 'supervisor', 'Super-Pass-1');
await mk('EMP-001', 'emp001@masarat.local', 'employee', 'Forgotten-Pass-1');
await mk('EMP-002', 'emp002@masarat.local', 'employee', 'Emp2-Pass-1');
await mk('EMP-009', 'emp009@masarat.local', 'employee', 'Gone-Pass-1', 0);
const admin = (await login('ADM-001', 'Admin-Pass-1')).body.token;
const sup = (await login('SUP-001', 'Super-Pass-1')).body.token;
const emp2 = (await login('EMP-002', 'Emp2-Pass-1')).body.token;
const empId = (await get<{ id: number }>("SELECT id FROM users WHERE employee_code = 'EMP-001'"))!.id;

section('Temporary passwords');
{
  const sample = Array.from({ length: 200 }, generateTempPassword);
  ok('always 10 characters', sample.every((p) => p.length === 10));
  ok('always has upper, lower and a digit', sample.every((p) => /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p)));
  ok('never uses look-alike characters 0 O 1 l I', sample.every((p) => !/[0O1lI]/.test(p)));
  ok('200 samples are all different', new Set(sample).size === 200);
}

section('Switch defaults and visibility');
{
  const o = await call('/api/auth/options');
  ok('sign-in screen sees requests are ON by default', o.status === 200 && o.body.password_reset_requests === true, o);
  ok('supervisor can read the setting', (await call('/api/admin/settings', { token: sup })).body.password_reset_requests === true);
  ok('an employee cannot read admin settings', (await call('/api/admin/settings', { token: emp2 })).status === 403);
}

section('Employee asks for a reset');
{
  // EMP-001 locked himself out first
  for (let i = 0; i < 8; i++) await login('EMP-001', 'wrong-guess', '198.51.100.50');
  const locked = await login('EMP-001', 'Forgotten-Pass-1', '198.51.100.50');
  ok('precondition: EMP-001 is locked out after 8 wrong tries', locked.status === 429, locked);

  ok('empty identifier -> 400', (await call('/api/auth/forgot-password', { method: 'POST', body: {} })).status === 400);
  const r = await call('/api/auth/forgot-password', { method: 'POST', body: { identifier: 'emp-001' } });
  ok('request accepted (case-insensitive ID)', r.status === 200 && r.body.ok === true, r);
  const unknown = await call('/api/auth/forgot-password', { method: 'POST', body: { identifier: 'NOPE-404' } });
  ok('unknown ID gets the identical answer (no account discovery)', unknown.status === 200 && unknown.body.ok === true, unknown);
  await call('/api/auth/forgot-password', { method: 'POST', body: { identifier: 'EMP-009' } });
  await call('/api/auth/forgot-password', { method: 'POST', body: { identifier: 'emp001@masarat.local' }, ip: '198.51.100.2' });

  const q = await call('/api/admin/password-resets?status=pending', { token: admin });
  ok('exactly one pending request (repeat and email form merged, inactive & unknown ignored)',
    q.body.requests.length === 1 && q.body.requests[0].employee_code === 'EMP-001' && q.body.pending === 1, q.body);
  ok('supervisor can see the queue', (await call('/api/admin/password-resets', { token: sup })).status === 200);
  ok('dashboard counts the pending reset', (await call('/api/admin/dashboard', { token: admin })).body.counts.pending_password_resets === 1);

  let limited = 0;
  for (let i = 0; i < 9; i++) {
    const x = await call('/api/auth/forgot-password', { method: 'POST', body: { identifier: 'EMP-002' }, ip: '198.51.100.99' });
    if (x.status === 429) limited++;
  }
  ok('requests are rate-limited (8 per 15 min per IP + ID)', limited === 1, limited);
}

section('Approving and rejecting');
let temp = '';
{
  const reqId = (await call('/api/admin/password-resets?status=pending', { token: admin })).body.requests
    .find((x: { employee_code: string }) => x.employee_code === 'EMP-001').id;
  ok('supervisor cannot approve', (await call(`/api/admin/password-resets/${reqId}/approve`, { method: 'POST', token: sup })).status === 403);
  ok('employee cannot approve', (await call(`/api/admin/password-resets/${reqId}/approve`, { method: 'POST', token: emp2 })).status === 403);

  const a = await call(`/api/admin/password-resets/${reqId}/approve`, { method: 'POST', token: admin });
  temp = a.body.temp_password;
  ok('approve returns a temporary password once', a.status === 200 && typeof temp === 'string' && temp.length === 10, a);
  ok('approve names the employee', a.body.user?.employee_code === 'EMP-001', a.body);
  const again = await call(`/api/admin/password-resets/${reqId}/approve`, { method: 'POST', token: admin });
  ok('approving twice is refused', again.status === 400 && !again.body.temp_password, again);
  ok('unknown request -> 404', (await call('/api/admin/password-resets/99999/approve', { method: 'POST', token: admin })).status === 404);

  ok('old password no longer works', (await login('EMP-001', 'Forgotten-Pass-1', '198.51.100.3')).status === 401);
  const l = await login('EMP-001', temp, '198.51.100.50');
  ok('temporary password works from the IP that was locked out (lockout cleared)', l.status === 200, l);
  ok('employee is forced to choose a new password', l.body.user?.must_change_password === true, l.body.user);
  const ch = await call('/api/auth/change-password', { method: 'POST', token: l.body.token,
    body: { current_password: temp, new_password: 'My-Own-Pass-9' } });
  ok('employee sets his own password', ch.status === 200, ch);
  ok('and can sign in with it, no longer forced to change',
    (await login('EMP-001', 'My-Own-Pass-9')).body.user?.must_change_password === false);
  const row = await get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', empId);
  ok('the temporary password is never stored in plain text', !row!.password_hash.includes(temp));

  await call('/api/auth/forgot-password', { method: 'POST', body: { identifier: 'EMP-001' }, ip: '198.51.100.4' });
  const p2 = (await call('/api/admin/password-resets?status=pending', { token: admin })).body.requests[0];
  const rj = await call(`/api/admin/password-resets/${p2.id}/reject`, { method: 'POST', token: admin });
  ok('reject works', rj.status === 200, rj);
  ok('a rejected request leaves the password alone', (await login('EMP-001', 'My-Own-Pass-9')).status === 200);
  const hist = (await call('/api/admin/password-resets', { token: admin })).body.requests;
  ok('history shows who decided', hist.some((h: { status: string; decided_by_name: string }) =>
    h.status === 'rejected' && h.decided_by_name === 'ADM-001'), hist);
}

section('Direct admin reset');
{
  await call('/api/auth/forgot-password', { method: 'POST', body: { identifier: 'EMP-001' }, ip: '198.51.100.5' });
  ok('supervisor cannot reset', (await call(`/api/admin/users/${empId}/reset-password`, { method: 'POST', token: sup })).status === 403);
  ok('unknown employee -> 404', (await call('/api/admin/users/99999/reset-password', { method: 'POST', token: admin })).status === 404);
  const r = await call(`/api/admin/users/${empId}/reset-password`, { method: 'POST', token: admin });
  ok('admin reset returns a temporary password', r.status === 200 && r.body.temp_password?.length === 10, r);
  ok('the new temporary password works', (await login('EMP-001', r.body.temp_password)).status === 200);
  const pend = await call('/api/admin/password-resets?status=pending', { token: admin });
  ok('the open request from the same employee was closed by the reset',
    !pend.body.requests.some((x: { employee_code: string }) => x.employee_code === 'EMP-001'), pend.body);
  const cnt = await get<{ n: number }>("SELECT count(*) AS n FROM password_resets WHERE user_id = ? AND status = 'approved'", empId);
  ok('the reset is in the audit history', Number(cnt!.n) === 2, cnt);
  const r2 = await call(`/api/admin/users/${empId}/reset-password`, { method: 'POST', token: admin });
  ok('with nothing pending, a direct reset is logged as source admin',
    !!(await get("SELECT id FROM password_resets WHERE user_id = ? AND source = 'admin'", empId)) && r2.status === 200);
}

section('Edit form reset also clears the lockout');
{
  for (let i = 0; i < 8; i++) await login('EMP-002', 'bad', '198.51.100.77');
  ok('precondition: EMP-002 locked', (await login('EMP-002', 'Emp2-Pass-1', '198.51.100.77')).status === 429);
  const emp2Id = (await get<{ id: number }>("SELECT id FROM users WHERE employee_code = 'EMP-002'"))!.id;
  await call(`/api/admin/users/${emp2Id}`, { method: 'PATCH', token: admin, body: { password: 'Typed-By-Admin-1' } });
  ok('password typed in Edit works straight away from the locked IP',
    (await login('EMP-002', 'Typed-By-Admin-1', '198.51.100.77')).status === 200);
}

section('Admin switches requests off');
{
  ok('supervisor cannot change the switch',
    (await call('/api/admin/settings', { method: 'PATCH', token: sup, body: { password_reset_requests: false } })).status === 403);
  ok('bad value -> 400',
    (await call('/api/admin/settings', { method: 'PATCH', token: admin, body: { password_reset_requests: 'no' } })).status === 400);
  const off = await call('/api/admin/settings', { method: 'PATCH', token: admin, body: { password_reset_requests: false } });
  ok('admin turns requests off', off.status === 200 && off.body.password_reset_requests === false, off);
  ok('sign-in screen sees it is off', (await call('/api/auth/options')).body.password_reset_requests === false);
  const blocked = await call('/api/auth/forgot-password', { method: 'POST', body: { identifier: 'EMP-002' }, ip: '198.51.100.6' });
  ok('requests are refused while off', blocked.status === 403 && blocked.body.code === 'disabled', blocked);
  ok('admin can still reset directly while off',
    (await call(`/api/admin/users/${empId}/reset-password`, { method: 'POST', token: admin })).status === 200);
  await call('/api/admin/settings', { method: 'PATCH', token: admin, body: { password_reset_requests: true } });
  ok('and turns them back on', (await call('/api/auth/options')).body.password_reset_requests === true);
  ok('the change records who made it',
    (await get<{ updated_by: number }>("SELECT updated_by FROM app_settings WHERE key = 'password_reset_requests'"))!.updated_by === 1);
}

await server.shutdown();
await close();
console.log(`\nPASS: ${pass}   FAIL: ${fail}`);
if (fail) Deno.exit(1);
