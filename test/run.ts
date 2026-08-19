/**
 * End-to-end test run. Boots a throwaway server on its own database, exercises
 * the whole API, then checks the shift maths directly.
 *
 *   cd /tmp/masarat-pg && DATABASE_URL=... JWT_SECRET=... deno run -A test/run.ts
 *
 * Nothing here touches the shared masarat_test database.
 *
 * PORT NOTES on the harness mechanism (behaviour is unchanged; only the plumbing
 * differs, because the app is now Deno + Hono + Postgres):
 *   * data/test.db is gone. A dedicated Postgres database (TEST_DATABASE_URL, or
 *     a database named masarat_suite derived from DATABASE_URL) is created,
 *     db/schema.postgres.sql is applied, and every table is TRUNCATE ... RESTART
 *     IDENTITY, which is the equivalent of deleting the old sqlite file.
 *   * `spawn(node, server/index.js)` becomes `Deno.serve({ port: 3199 }, app.fetch)`
 *     in this process. The base URL is unchanged, so every fetch below is unchanged.
 *   * `execFileSync(node, server/seed.js)` becomes
 *     `new Deno.Command(Deno.execPath(), { args: ['run','-A','scripts/seed.ts'] })`.
 *   * the two raw `new DatabaseSync(DB)` writes become run() calls through api/db.ts.
 *   * `createRequire` becomes plain `await import('../api/...')`.
 *   * selfies: PHOTO_DIR becomes LOCAL_PHOTO_DIR (api/lib/storage.ts), pointed at a
 *     freshly created temp directory so nothing can land next to the live photos.
 *   * the 'Selfie policy modes' section runs in three child `deno run` processes,
 *     one per SELFIE_MODE, because api/config.ts reads Deno.env once at module load
 *     and selfieMode can therefore no longer be reassigned in-process.
 */

// ---------------------------------------------------------------------------
// Environment. This MUST happen before any api/* module is imported, because
// config.ts and db.ts read Deno.env at module load time. That is the exact role
// the original's `Object.assign(process.env, ENV)` played.
// ---------------------------------------------------------------------------
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;

// Selfies written during the run must NOT land in the live photo directory.
const PHOTO_DIR = await Deno.makeTempDir({ prefix: 'masarat-test-photos-' });

function suiteDatabaseUrl(): string {
  const explicit = Deno.env.get('TEST_DATABASE_URL');
  if (explicit) return explicit;
  const base = Deno.env.get('DATABASE_URL');
  if (!base) throw new Error('Set DATABASE_URL (or TEST_DATABASE_URL) before running the suite.');
  const u = new URL(base);
  u.pathname = '/masarat_suite';
  return u.toString();
}
const SUITE_URL = suiteDatabaseUrl();

// The original's JWT_SECRET ('test-secret-value-for-the-test-run') has only 14
// distinct characters, and config.ts now refuses to boot on fewer than 16. The
// suffix below is the smallest change that satisfies the rule; no assertion
// depends on the secret's value.
const ENV: Record<string, string> = {
  PORT: String(PORT),
  DATABASE_URL: SUITE_URL,
  LOCAL_PHOTO_DIR: PHOTO_DIR,
  JWT_SECRET: 'test-secret-value-for-the-test-run-x9Q7Zk2',
  TZ_OFFSET_MIN: '180',
  MAX_ACCURACY_M: '75',
  MAX_FIX_AGE_SEC: '90',
  ALLOW_OUT_OF_FENCE_WITH_FLAG: 'false',
};
for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
// Cloud storage must stay out of the picture so photos use the local directory.
Deno.env.delete('SUPABASE_URL');
Deno.env.delete('SUPABASE_SERVICE_ROLE_KEY');

let fails = 0;
let passes = 0;
const ok = (label: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${cond ? '' : '  ' + JSON.stringify(extra)}`);
  if (cond) passes += 1;
  else fails += 1;
};
const section = (name: string) => console.log(`\n${name}`);

// ---------------------------------------------------------------- byte helpers
// Buffer is gone; these three helpers replace Buffer.concat/alloc/toString.
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function filled(len: number, value: number): Uint8Array {
  return new Uint8Array(len).fill(value);
}
function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// ---------------------------------------------------------------- child processes
async function runScript(args: string[]): Promise<void> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args,
    cwd: ROOT,
    env: ENV,
    stdout: 'piped',
    stderr: 'piped',
  });
  const out = await cmd.output();
  if (!out.success) {
    throw new Error(
      `${args.join(' ')} failed (${out.code})\n${new TextDecoder().decode(out.stdout)}\n${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
}

async function psqlAdmin(statement: string): Promise<{ code: number; err: string }> {
  const admin = new URL(SUITE_URL);
  const dbName = admin.pathname.replace(/^\//, '');
  admin.pathname = '/postgres';
  const cmd = new Deno.Command('psql', {
    args: [admin.toString(), '-v', 'ON_ERROR_STOP=1', '-c', statement.replace('$DB', dbName)],
    stdout: 'piped',
    stderr: 'piped',
  });
  const out = await cmd.output();
  return { code: out.code, err: new TextDecoder().decode(out.stderr) };
}

// ---------------------------------------------------------------- test setup
// Equivalent of `fs.rmSync(data/test.db)`: a dedicated database, schema applied,
// every table emptied with identities reset.
{
  const created = await psqlAdmin('CREATE DATABASE $DB');
  if (created.code !== 0 && !/already exists/i.test(created.err)) {
    throw new Error(`could not create the suite database:\n${created.err}`);
  }
}

const store = await import('../api/db.ts');
await store.applySchema(await Deno.readTextFile(new URL('../db/schema.postgres.sql', import.meta.url)));
await store.run(`TRUNCATE attendance, punch_log, leave_requests, schedules, project_members,
                          projects, shifts, holidays, login_attempts, users RESTART IDENTITY CASCADE`);

await runScript(['run', '-A', 'scripts/seed.ts']);

const { app } = await import('../api/index.ts');
const server = Deno.serve({ port: PORT, hostname: '127.0.0.1', onListen: () => {} }, app.fetch);

async function waitForServer(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Server did not start.');
}

// deno-lint-ignore no-explicit-any
type Json = any;

async function api(
  p: string,
  { method = 'GET', token, body }: { method?: string; token?: string; body?: Json } = {},
): Promise<{ status: number; body: Json }> {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: Json = null;
  try { json = await r.json(); } catch { /* csv or empty */ }
  return { status: r.status, body: json };
}

const nowIso = () => new Date().toISOString();

try {
  await waitForServer();

  // ------------------------------------------------------------------- auth
  section('Authentication and roles');
  ok('health check', (await api('/api/health')).status === 200);
  ok('wrong password is refused',
    (await api('/api/auth/login', { method: 'POST', body: { identifier: 'DEMO-ADM', password: 'nope' } })).status === 401);

  const login = await api('/api/auth/login', { method: 'POST', body: { identifier: 'DEMO-ADM', password: 'Admin@12345' } });
  ok('admin signs in with the employee ID', login.status === 200 && !!login.body.token, login.body);
  const admin = login.body.token;

  ok('unauthenticated request is blocked', (await api('/api/me/status')).status === 401);

  // -------------------------------------------------------------- reference
  section('Projects, shifts and accounts');
  const shifts = (await api('/api/admin/shifts', { token: admin })).body.shifts;
  const morning = shifts.find((s: Json) => s.code === 'MORNING');
  ok('morning and night shifts exist', shifts.length === 2, shifts.map((s: Json) => s.code));
  ok('night shift is marked as crossing midnight', shifts.find((s: Json) => s.code === 'NIGHT').crosses_midnight === true);

  const proj = await api('/api/admin/projects', {
    method: 'POST', token: admin,
    body: { code: 'TEST-SITE', name: 'Test Tower', client: 'ACME', lat: 24.8, lng: 46.8, radius_m: 100 },
  });
  ok('project created', proj.status === 201, proj.body);
  const P = proj.body.project;

  ok('duplicate project code refused',
    (await api('/api/admin/projects', { method: 'POST', token: admin, body: { code: 'TEST-SITE', name: 'x', lat: 1, lng: 1 } })).status === 400);
  ok('impossible latitude refused',
    (await api('/api/admin/projects', { method: 'POST', token: admin, body: { code: 'BAD', name: 'x', lat: 999, lng: 1 } })).status === 400);
  ok('bad shift time refused',
    (await api('/api/admin/shifts', { method: 'POST', token: admin, body: { code: 'X', name: 'x', start_time: '99:99', end_time: '10:00' } })).status === 400);

  const emp = await api('/api/admin/users', {
    method: 'POST', token: admin,
    body: {
      employee_code: 'EMP-900', full_name: 'Test Worker', email: 'tw@company.local',
      role: 'employee', password: 'Passw0rd123', job_title: 'Mason', project_ids: [P.id],
    },
  });
  ok('employee account created', emp.status === 201, emp.body);
  const empId = emp.body.user.id;

  const empLogin = await api('/api/auth/login', { method: 'POST', body: { identifier: 'tw@company.local', password: 'Passw0rd123' } });
  ok('employee signs in with email', empLogin.status === 200, empLogin.body);
  ok('employee is forced to change the temporary password', empLogin.body.user.must_change_password === true);
  const et = empLogin.body.token;

  ok('employee cannot reach the admin API', (await api('/api/admin/users', { token: et })).status === 403);

  const mine = await api('/api/me/projects', { token: et });
  ok('employee only sees the sites they are assigned to',
    mine.body.projects.length === 1 && mine.body.projects[0].id === P.id, mine.body.projects);

  // ---------------------------------------------------------- direct manager
  section('Reporting line (المدير المباشر)');
  const mgr = await api('/api/admin/users', {
    method: 'POST', token: admin,
    // A supervisor, not an admin: a second admin account would make DEMO-ADM no
    // longer the last one and quietly defeat the safeguard test further down.
    body: { employee_code: 'MGR-900', full_name: 'Test Manager', email: 'mgr@company.local',
            role: 'supervisor', password: 'Passw0rd123' },
  });
  ok('manager account created', mgr.status === 201, mgr.body);
  const mgrId = mgr.body.user.id;

  ok('an employee can be linked to a direct manager',
    (await api(`/api/admin/users/${empId}`, { method: 'PATCH', token: admin,
      body: { manager_id: mgrId } })).status === 200);
  const listed = (await api('/api/admin/users?q=EMP-900', { token: admin })).body.users[0];
  ok('the manager name comes back on the employee', listed.manager_name === 'Test Manager', listed);
  const mgrRow = (await api('/api/admin/users?q=MGR-900', { token: admin })).body.users[0];
  ok('the manager shows a report count', mgrRow.reports_count === 1, mgrRow);

  ok('nobody can be their own manager',
    (await api(`/api/admin/users/${empId}`, { method: 'PATCH', token: admin,
      body: { manager_id: empId } })).status === 400);
  ok('a reporting loop is refused',
    (await api(`/api/admin/users/${mgrId}`, { method: 'PATCH', token: admin,
      body: { manager_id: empId } })).status === 400);
  ok('an unknown manager is refused',
    (await api(`/api/admin/users/${empId}`, { method: 'PATCH', token: admin,
      body: { manager_id: 999999 } })).status === 400);
  ok('the manager link can be cleared',
    (await api(`/api/admin/users/${empId}`, { method: 'PATCH', token: admin,
      body: { manager_id: null } })).status === 200);

  // ------------------------------------------------------------------ roster
  section('Working calendar');
  const status0 = await api('/api/me/status', { token: et });
  const today = status0.body.local_date;

  // A shift that is open all day keeps this test independent of the clock.
  const wide = await api('/api/admin/shifts', {
    method: 'POST', token: admin,
    body: { code: 'ALLDAY', name: 'Test all-day', start_time: '00:05', end_time: '23:55',
            grace_in_min: 1440, grace_out_min: 0, early_in_min: 5, break_min: 0 },
  });
  const W = wide.body.shift;

  ok('roster a single day',
    (await api('/api/admin/schedules', { method: 'POST', token: admin,
      body: { user_id: empId, work_date: today, shift_id: W.id, project_id: P.id, status: 'work' } })).status === 200);
  ok('a working day without a shift is refused',
    (await api('/api/admin/schedules', { method: 'POST', token: admin,
      body: { user_id: empId, work_date: today, status: 'work' } })).status === 400);

  const gen = await api('/api/admin/schedules/generate', {
    method: 'POST', token: admin,
    body: { user_ids: [empId], from: today, to: '2026-12-31', shift_id: morning.id,
            project_id: P.id, rest_weekdays: [5, 6], overwrite: true },
  });
  ok('bulk roster generation', gen.status === 200 && gen.body.written > 30, gen.body);
  ok('roster grid returns cells',
    !!(await api(`/api/admin/roster?from=${today}&to=${today}`, { token: admin })).body.cells[empId]);

  // Put the all-day test shift back on today so the punch tests are deterministic.
  await api('/api/admin/schedules', { method: 'POST', token: admin,
    body: { user_id: empId, work_date: today, shift_id: W.id, project_id: P.id, status: 'work' } });
  ok('check-in is open once the employee is rostered',
    (await api('/api/me/status', { token: et })).body.can_check_in === true);

  // ------------------------------------------------------- location rejection
  section('Location trust rules');
  const at = { lat: 24.80030, lng: 46.80020 };   // ~40 m from the site centre
  const tryIn = (body: Json) => api('/api/me/check-in', { method: 'POST', token: et, body: { project_id: P.id, ...body } });

  ok('outside the geofence is refused',
    (await tryIn({ lat: 24.9, lng: 46.9, accuracy: 10, captured_at: nowIso() })).body.code === 'out_of_fence');
  ok('a poor GPS reading is refused',
    (await tryIn({ ...at, accuracy: 500, captured_at: nowIso() })).body.code === 'low_accuracy');
  ok('a cached (stale) reading is refused',
    (await tryIn({ ...at, accuracy: 10, captured_at: new Date(Date.now() - 600000).toISOString() })).body.code === 'stale_fix');
  ok('a reading with no timestamp is refused',
    (await tryIn({ ...at, accuracy: 10 })).body.code === 'no_fix_time');
  ok('a reading with no accuracy is refused',
    (await tryIn({ ...at, captured_at: nowIso() })).body.code === 'no_accuracy');
  ok('the 0,0 coordinate is refused',
    (await tryIn({ lat: 0, lng: 0, accuracy: 10, captured_at: nowIso() })).body.code === 'bad_coords');
  ok('a site the employee is not assigned to is refused',
    (await api('/api/me/check-in', { method: 'POST', token: et,
      body: { project_id: 1, ...at, accuracy: 10, captured_at: nowIso() } })).body.code === 'project_not_assigned');

  // ------------------------------------------------------------ happy path
  section('Check in and check out');
  const ci = await tryIn({ ...at, accuracy: 12, captured_at: nowIso(), note: 'Gate B' });
  ok('check-in inside the geofence is accepted', ci.status === 200 && ci.body.ok, ci.body);
  ok('the recorded distance is right', ci.body.distance_m > 30 && ci.body.distance_m < 50, ci.body.distance_m);
  ok('a second check-in is refused', (await tryIn({ ...at, accuracy: 12, captured_at: nowIso() })).body.code === 'already_open');

  const st = await api('/api/me/status', { token: et });
  ok('status now offers check-out', st.body.can_check_out === true && !!st.body.open_record);
  ok('check-out one second later is refused',
    (await api('/api/me/check-out', { method: 'POST', token: et,
      body: { project_id: P.id, ...at, accuracy: 12, captured_at: nowIso() } })).body.code === 'too_soon');

  // Backdate the check-in so the check-out produces a realistic duration.
  // PORT NOTE: was a direct node:sqlite write; now the same UPDATE through api/db.ts.
  // Multi-session support (check out, come back, keep the same shift running)
  // moved the "how long was this session open" maths onto attendance_sessions
  // — session 1's own check_in_at, not attendance.check_in_at directly — so
  // that has to be backdated too, or checkOut() still sees "a few ms ago" and
  // correctly refuses it as too_soon.
  await store.run('UPDATE attendance SET check_in_at = ? WHERE id = ?',
    new Date(Date.now() - 3 * 3600 * 1000).toISOString(), ci.body.attendance_id);
  await store.run('UPDATE attendance_sessions SET check_in_at = ? WHERE attendance_id = ? AND seq = 1',
    new Date(Date.now() - 3 * 3600 * 1000).toISOString(), ci.body.attendance_id);

  const co = await api('/api/me/check-out', { method: 'POST', token: et,
    body: { project_id: P.id, ...at, accuracy: 12, captured_at: nowIso(), note: 'done' } });
  ok('check-out is accepted', co.status === 200 && co.body.ok, co.body);
  ok('worked time is about three hours', Math.abs(co.body.worked_minutes - 180) <= 2, co.body.worked_minutes);
  ok('a second check-out is refused',
    (await api('/api/me/check-out', { method: 'POST', token: et,
      body: { project_id: P.id, ...at, accuracy: 12, captured_at: nowIso() } })).body.code === 'not_checked_in');

  // --------------------------------------------------------- site deletion
  section('Deleting a project / site');
  // P now has a real attendance row (the check-in/check-out above), so this
  // must be refused — deleting it would erase a payroll record. This is the
  // owner's explicit requirement that removing a site must never touch real
  // attendance history.
  const delWithHistory = await api(`/api/admin/projects/${P.id}`, { method: 'DELETE', token: admin });
  ok('a site with attendance history cannot be deleted', delWithHistory.status === 400 && delWithHistory.body.code === 'has_history', delWithHistory.body);
  ok('the site is still there afterwards',
    (await api('/api/admin/projects', { token: admin })).body.projects.some((p: Json) => p.id === P.id));

  // A site that was created and never actually used has nothing referencing
  // it, so it can be removed outright.
  const throwaway = await api('/api/admin/projects', {
    method: 'POST', token: admin,
    body: { code: 'DELETE-ME', name: 'Never used', lat: 24.5, lng: 46.5, radius_m: 100 },
  });
  ok('throwaway project created', throwaway.status === 201, throwaway.body);
  const delEmpty = await api(`/api/admin/projects/${throwaway.body.project.id}`, { method: 'DELETE', token: admin });
  ok('a site with zero history can be deleted', delEmpty.status === 200 && delEmpty.body.ok, delEmpty.body);
  ok('the deleted site no longer appears in the list',
    !(await api('/api/admin/projects', { token: admin })).body.projects.some((p: Json) => p.id === throwaway.body.project.id));
  ok('deleting an already-deleted (unknown) site 404s',
    (await api(`/api/admin/projects/${throwaway.body.project.id}`, { method: 'DELETE', token: admin })).status === 404);

  // -------------------------------------------------------------- reporting
  section('Reports and audit');
  ok('employee sees their own hours',
    (await api(`/api/me/attendance?from=${today}&to=${today}`, { token: et })).body.records.length === 1);
  const cal = (await api(`/api/me/calendar?from=${today}&to=${today}`, { token: et })).body.days[0];
  ok('calendar merges roster and actual attendance', !!cal.schedule && !!cal.attendance, cal);
  ok('admin attendance report',
    (await api(`/api/admin/attendance?from=${today}&to=${today}`, { token: admin })).body.totals.records >= 1);

  const csv = await fetch(`${BASE}/api/admin/attendance.csv?from=${today}&to=${today}`,
    { headers: { authorization: `Bearer ${admin}` } });
  const csvText = await csv.text();
  ok('CSV export contains the record', csv.status === 200 && csvText.includes('EMP-900'), csvText.slice(0, 80));

  const log = (await api(`/api/admin/punch-log?user_id=${empId}`, { token: admin })).body.log;
  ok('every rejected attempt is in the audit trail', log.filter((l: Json) => l.outcome === 'rejected').length >= 7, log.length);
  ok('the dashboard reports today', (await api('/api/admin/dashboard', { token: admin })).status === 200);

  // ------------------------------------------------------------- correction
  section('Admin corrections');
  const fix = await api(`/api/admin/attendance/${ci.body.attendance_id}`, {
    method: 'PATCH', token: admin,
    body: { check_in_local: '08:00', check_out_local: '17:00', admin_note: 'verified by foreman' },
  });
  ok('corrected times are recomputed', fix.body.record.worked_minutes === 540, fix.body.record);
  ok('the correction is permanently marked', fix.body.record.flags.includes('manually_adjusted'), fix.body.record.flags);

  const late = await api(`/api/admin/attendance/${ci.body.attendance_id}`, {
    method: 'PATCH', token: admin, body: { check_in_local: '10:00', check_out_local: '17:00' },
  });
  ok('derived flags follow the corrected times', late.body.record.flags.includes('late'), late.body.record.flags);

  // --------------------------------------------------------------- accounts
  section('Account safeguards');
  ok('the last active admin cannot be deactivated',
    (await api(`/api/admin/users/${login.body.user.id}`, { method: 'PATCH', token: admin, body: { active: false } })).status === 400);
  ok('a short password is refused',
    (await api('/api/auth/change-password', { method: 'POST', token: et,
      body: { current_password: 'Passw0rd123', new_password: 'short' } })).status === 400);
  ok('a wrong current password is refused',
    (await api('/api/auth/change-password', { method: 'POST', token: et,
      body: { current_password: 'wrong', new_password: 'NewPassw0rd!' } })).status === 401);
  ok('password change succeeds',
    (await api('/api/auth/change-password', { method: 'POST', token: et,
      body: { current_password: 'Passw0rd123', new_password: 'NewPassw0rd!' } })).status === 200);
  const relog = await api('/api/auth/login', { method: 'POST', body: { identifier: 'tw@company.local', password: 'NewPassw0rd!' } });
  ok('the new password works and the prompt is cleared',
    relog.status === 200 && relog.body.user.must_change_password === false, relog.body.user);

  // ---------------------------------------------------------------- selfies
  section('Selfie at the punch');
  // A synthetic but structurally valid JPEG: correct magic bytes, over the
  // minimum size, under the maximum.
  const jpeg = concatBytes(
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    filled(3000, 0x20),
    new Uint8Array([0xff, 0xd9]),
  );
  const jpegUrl = `data:image/jpeg;base64,${toBase64(jpeg)}`;

  const st2 = await api('/api/me/status', { token: et });
  ok('the client is told the selfie policy', st2.body.location_rules.selfie_mode === 'optional',
    st2.body.location_rules);

  // Reopen a punch so a photo can be attached to it.
  await api('/api/admin/schedules', { method: 'POST', token: admin,
    body: { user_id: empId, work_date: today, shift_id: W.id, project_id: P.id, status: 'work' } });
  const et2 = relog.body.token;
  // PORT NOTE: was a direct node:sqlite write; now the same DELETE through api/db.ts.
  await store.run('DELETE FROM attendance WHERE user_id = ?', empId);

  // Bad photos first, while there is still no open record: the photo is the last
  // thing checked, so these only surface once everything else is valid.
  const pngUrl = 'data:image/png;base64,' + toBase64(filled(2000, 1));
  ok('a non-JPEG photo is refused',
    (await api('/api/me/check-in', { method: 'POST', token: et2,
      body: { project_id: P.id, ...at, accuracy: 12, captured_at: nowIso(), photo: pngUrl } })).body.code === 'bad_photo');
  const fakeJpeg = 'data:image/jpeg;base64,' + toBase64(filled(2000, 0x41));
  ok('a file that only claims to be a JPEG is refused',
    (await api('/api/me/check-in', { method: 'POST', token: et2,
      body: { project_id: P.id, ...at, accuracy: 12, captured_at: nowIso(), photo: fakeJpeg } })).body.code === 'bad_photo');
  const tinyJpeg = 'data:image/jpeg;base64,' + toBase64(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  ok('a truncated photo is refused',
    (await api('/api/me/check-in', { method: 'POST', token: et2,
      body: { project_id: P.id, ...at, accuracy: 12, captured_at: nowIso(), photo: tinyJpeg } })).body.code === 'bad_photo');
  ok('a refused photo leaves no attendance record behind',
    (await api('/api/me/status', { token: et2 })).body.open_record === null);

  const withPhoto = await api('/api/me/check-in', { method: 'POST', token: et2,
    body: { project_id: P.id, ...at, accuracy: 12, captured_at: nowIso(), photo: jpegUrl } });
  ok('check-in with a photo is accepted', withPhoto.status === 200 && withPhoto.body.ok, withPhoto.body);
  ok('the record is flagged as having a photo', withPhoto.body.flags.includes('photo_captured'), withPhoto.body.flags);
  ok('a punch without a photo is still accepted while the policy is "optional"',
    (await api('/api/me/status', { token: et2 })).body.can_check_out === true);

  const shot = await fetch(`${BASE}/api/admin/attendance/${withPhoto.body.attendance_id}/photo/in`,
    { headers: { authorization: `Bearer ${admin}` } });
  ok('an admin can retrieve the photo',
    shot.status === 200 && shot.headers.get('content-type') === 'image/jpeg', shot.status);
  ok('the stored photo is the one that was sent',
    new Uint8Array(await shot.arrayBuffer()).length === jpeg.length);

  const noShot = await fetch(`${BASE}/api/admin/attendance/${withPhoto.body.attendance_id}/photo/out`,
    { headers: { authorization: `Bearer ${admin}` } });
  ok('a punch with no photo reports 404', noShot.status === 404);
  ok('an employee cannot read punch photos',
    (await api(`/api/admin/attendance/${withPhoto.body.attendance_id}/photo/in`, { token: et2 })).status === 403);

  // ------------------------------------------------------------------ leave
  section('Leave requests');
  const badRange = await api('/api/me/leave', { method: 'POST', token: et2,
    body: { leave_type: 'annual', from_date: '2026-10-10', to_date: '2026-10-01' } });
  ok('an end date before the start is refused', badRange.status === 400, badRange.body);
  ok('an unknown leave type is refused',
    (await api('/api/me/leave', { method: 'POST', token: et2,
      body: { leave_type: 'sabbatical', from_date: '2026-10-01', to_date: '2026-10-03' } })).status === 400);

  const leave = await api('/api/me/leave', { method: 'POST', token: et2,
    body: { leave_type: 'annual', from_date: '2026-10-05', to_date: '2026-10-09', reason: 'Family trip' } });
  ok('leave request submitted', leave.status === 201 && leave.body.days === 5, leave.body);

  ok('an overlapping request is refused',
    (await api('/api/me/leave', { method: 'POST', token: et2,
      body: { leave_type: 'sick', from_date: '2026-10-08', to_date: '2026-10-12' } })).status === 400);

  const mineLeave = await api('/api/me/leave', { token: et2 });
  ok('the employee sees their own request',
    mineLeave.body.requests.length === 1 && mineLeave.body.requests[0].status === 'pending', mineLeave.body.requests);

  const pending = await api('/api/admin/leave?status=pending', { token: admin });
  ok('the request appears in the admin queue', pending.body.requests.some((r: Json) => r.id === leave.body.id));
  ok('the dashboard counts pending leave',
    (await api('/api/admin/dashboard', { token: admin })).body.counts.pending_leave >= 1);

  const decided = await api(`/api/admin/leave/${leave.body.id}/decide`, {
    method: 'POST', token: admin, body: { approve: true, note: 'Approved, cover arranged' },
  });
  ok('leave approved', decided.status === 200 && decided.body.status === 'approved', decided.body);
  ok('approval wrote leave days onto the calendar', decided.body.days_applied >= 3, decided.body);
  ok('deciding twice is refused',
    (await api(`/api/admin/leave/${leave.body.id}/decide`, { method: 'POST', token: admin, body: { approve: false } })).status === 400);

  const cal2 = await api('/api/me/calendar?from=2026-10-05&to=2026-10-09', { token: et2 });
  const leaveDays = cal2.body.days.filter((d: Json) => d.schedule?.status === 'leave');
  ok('the calendar shows the approved leave', leaveDays.length >= 3, cal2.body.days.map((d: Json) => d.schedule?.status));
  ok('rest days inside the range were not spent as leave',
    cal2.body.days.filter((d: Json) => d.schedule?.status === 'off').length >= 1,
    cal2.body.days.map((d: Json) => `${d.date}:${d.schedule?.status}`));

  ok('an approved request cannot be withdrawn by the employee',
    (await api(`/api/me/leave/${leave.body.id}/cancel`, { method: 'POST', token: et2 })).status === 400);

  const pend2 = await api('/api/me/leave', { method: 'POST', token: et2,
    body: { leave_type: 'sick', from_date: '2026-11-02', to_date: '2026-11-03' } });
  ok('a pending request can be withdrawn',
    (await api(`/api/me/leave/${pend2.body.id}/cancel`, { method: 'POST', token: et2 })).status === 200);

  const onBehalf = await api('/api/admin/leave', { method: 'POST', token: admin,
    body: { user_id: empId, leave_type: 'emergency', from_date: '2026-11-16', to_date: '2026-11-18', reason: 'Called in' } });
  ok('an admin can enter leave directly and it is applied at once',
    onBehalf.status === 201 && onBehalf.body.status === 'approved' && onBehalf.body.days_applied >= 1, onBehalf.body);
  ok('admin-entered leave shows in the employee\'s own list',
    (await api('/api/me/leave', { token: et2 })).body.requests.some(
      (r: Json) => r.from_date === '2026-11-16' && r.status === 'approved'));

  // -------------------------------------------------------------- timesheet
  section('Timesheet and payroll summary');
  const ts = await api(`/api/admin/timesheet?from=${today}&to=${today}`, { token: admin });
  ok('timesheet returns a row per employee', ts.status === 200 && ts.body.rows.length >= 3, ts.body.rows?.length);
  const meRow = ts.body.rows.find((r: Json) => r.employee_code === 'EMP-900');
  ok('the employee who punched today shows one worked day', meRow.worked_days === 1, meRow);
  ok('administrators are left out of the timesheet',
    !ts.body.rows.some((r: Json) => r.employee_code === 'DEMO-ADM'), ts.body.rows.map((r: Json) => r.employee_code));
  ok('today is never counted as an absence', meRow.absent_days === 0, meRow);
  ok('totals are summed', ts.body.totals.employees === ts.body.rows.length, ts.body.totals);
  ok('per-project hours are included', Array.isArray(ts.body.by_project) && ts.body.by_project.length >= 2,
    ts.body.by_project?.length);

  const wide2 = await api(`/api/admin/timesheet?from=2026-10-01&to=2026-10-31`, { token: admin });
  const octRow = wide2.body.rows.find((r: Json) => r.employee_code === 'EMP-900');
  ok('approved leave is counted as leave days, not absence', octRow.leave_days >= 3, octRow);

  const tsCsv = await fetch(`${BASE}/api/admin/timesheet.csv?from=${today}&to=${today}`,
    { headers: { authorization: `Bearer ${admin}` } });
  const tsText = await tsCsv.text();
  ok('timesheet CSV exports',
    tsCsv.status === 200 && tsText.includes('Paid hours') && tsText.includes('TOTAL'), tsText.slice(0, 100));

  // A genuine binary .xlsx (SheetJS-built), for admins who want to open the
  // monthly attendance sheet straight in Excel instead of a CSV. An .xlsx
  // file is itself a zip archive, so "starts with the zip magic bytes PK"
  // is the cheapest real proof this is an actual workbook and not just the
  // CSV renamed with a different extension.
  const tsXlsx = await fetch(`${BASE}/api/admin/timesheet.xlsx?from=${today}&to=${today}`,
    { headers: { authorization: `Bearer ${admin}` } });
  const tsXlsxBytes = new Uint8Array(await tsXlsx.arrayBuffer());
  ok('timesheet Excel export responds with the xlsx content type',
    tsXlsx.status === 200 &&
    tsXlsx.headers.get('content-type') === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    tsXlsx.headers.get('content-type'));
  ok('timesheet Excel export is a real workbook (zip magic bytes PK)',
    tsXlsxBytes.length > 100 && tsXlsxBytes[0] === 0x50 && tsXlsxBytes[1] === 0x4b, tsXlsxBytes.slice(0, 4));
  ok('timesheet Excel export sets a filename with the date range',
    (tsXlsx.headers.get('content-disposition') || '').includes(`timesheet_${today}_to_${today}.xlsx`),
    tsXlsx.headers.get('content-disposition'));

  // -------------------------------------------------------- shift maths
  section('Shift maths (night shift across midnight)');
  // PORT NOTE: createRequire(...) of the three server modules becomes plain
  // dynamic imports of the ported ones. `store` is already imported above.
  const T = await import('../api/lib/time.ts');
  const AT = await import('../api/lib/attendance.ts');

  const night = await store.get<Json>("SELECT * FROM shifts WHERE code = 'NIGHT'");
  const w = AT.shiftWindow(night, '2026-08-20');
  ok('check-in opens at 17:00 on the 20th',
    T.local(w.openAt).hhmm === '17:00' && T.local(w.openAt).date === '2026-08-20', T.local(w.openAt));
  ok('the shift ends at 03:00 on the 21st',
    T.local(w.endAt).hhmm === '03:00' && T.local(w.endAt).date === '2026-08-21', T.local(w.endAt));
  ok('late starts at 18:15', T.local(w.lateAt).hhmm === '18:15', T.local(w.lateAt));

  const nightEmp = await store.get<Json>("SELECT * FROM users WHERE employee_code = 'DEMO-E02'");
  await store.run(
    `INSERT INTO schedules (user_id, work_date, shift_id, project_id, status, created_at)
     VALUES (?, '2026-08-20', ?, NULL, 'work', ?)
     ON CONFLICT(user_id, work_date) DO UPDATE SET shift_id = excluded.shift_id, status = 'work'`,
    nightEmp.id, night.id, new Date().toISOString());
  await store.run("DELETE FROM schedules WHERE user_id = ? AND work_date = '2026-08-21'", nightEmp.id);

  const r0130 = await AT.resolvePunchTarget(nightEmp.id, T.localToUtc('2026-08-21', 90).toISOString());
  ok('a punch at 01:30 belongs to the previous work day',
    r0130.ok && r0130.window!.workDate === '2026-08-20' && r0130.window!.shift.code === 'NIGHT', r0130.window?.workDate);
  ok('16:59 is one minute too early',
    (await AT.resolvePunchTarget(nightEmp.id, T.localToUtc('2026-08-20', 16 * 60 + 59).toISOString())).ok === false);
  ok('03:01 is after the window closes',
    (await AT.resolvePunchTarget(nightEmp.id, T.localToUtc('2026-08-21', 181).toISOString())).ok === false);
  ok('18:02 to 02:58 is 536 minutes',
    T.minutesBetween(T.localToUtc('2026-08-20', 1082).toISOString(), T.localToUtc('2026-08-21', 178).toISOString()) === 536);

  // The three selfie policies.
  // PORT NOTE: the original reassigned cfg.selfieMode in-process. api/config.ts
  // reads Deno.env once at module load, so each mode now runs in its own child
  // `deno run` (test/selfie_modes_child.ts) with SELFIE_MODE set in its env; the
  // child boots the app on its own port, calls handlePhoto exactly as the original
  // did, and prints the results as JSON for these assertions to check.
  section('Selfie policy modes');
  const modes = await selfieModeResults(jpegUrl);

  const offMode = modes.off;
  ok('"off" ignores a photo entirely', offMode.withPhoto.name === null);
  ok('"off" accepts a punch with no photo', offMode.withoutPhoto.ok === true);

  const optMode = modes.optional;
  ok('"optional" accepts a punch with no photo', optMode.withoutPhoto.ok === true);
  const optShot = optMode.withPhoto;
  ok('"optional" stores a photo when one is sent', optShot.ok && !!optShot.name, optShot);

  const reqMode = modes.required;
  const missing = reqMode.withoutPhoto;
  ok('"required" refuses a punch with no photo',
    missing.ok === false && missing.code === 'photo_required', missing);
  ok('"required" accepts a valid photo', reqMode.withPhoto.ok === true);

  // ------------------------------------------------- real staff list import
  section('Masarat staff import');
  await runScript(['run', '-A', 'scripts/import-masarat.ts', '--days=14']);

  const staff = (await api('/api/admin/users', { token: admin })).body.users;
  const byCode = (c: string) => staff.find((u: Json) => u.employee_code === c);
  ok('thirteen employees imported',
    ['EMP-001', 'EMP-013'].every((c) => byCode(c)) &&
    staff.filter((u: Json) => /^EMP-0(0[1-9]|1[0-3])$/.test(u.employee_code)).length === 13,
    staff.filter((u: Json) => u.employee_code.startsWith('EMP-0')).length);
  ok('the four الصلاحيات accounts are admins',
    ['ADM-001', 'ADM-002', 'ADM-003', 'ADM-004'].every((c) => byCode(c)?.role === 'admin'),
    ['ADM-001', 'ADM-002', 'ADM-003', 'ADM-004'].map((c) => byCode(c)?.role));
  ok('Arabic names survive the round trip',
    byCode('EMP-001').full_name === 'عبد الرزاق محمد', byCode('EMP-001')?.full_name);
  ok('job titles are kept in Arabic',
    byCode('EMP-002').job_title === 'مهندس' && byCode('EMP-011').job_title === 'سائق',
    [byCode('EMP-002')?.job_title, byCode('EMP-011')?.job_title]);
  ok('site crew report to لؤي إسماعيل',
    byCode('EMP-001').manager_name === 'لؤي إسماعيل', byCode('EMP-001')?.manager_name);
  ok('drivers and stores report to محمد شحاتة',
    ['EMP-011', 'EMP-012', 'EMP-013'].every((c) => byCode(c).manager_name === 'محمد شحاتة'),
    ['EMP-011', 'EMP-012', 'EMP-013'].map((c) => byCode(c)?.manager_name));
  ok('لؤي إسماعيل has ten direct reports', byCode('ADM-001').reports_count === 10,
    byCode('ADM-001')?.reports_count);

  const importedShifts = (await api('/api/admin/shifts', { token: admin })).body.shifts;
  const morningShift = importedShifts.find((s: Json) => s.code === 'MORNING');
  ok('the morning shift matches the sheet (06:00-15:00)',
    morningShift.start_time === '06:00' && morningShift.end_time === '15:00', morningShift);
  ok('a one-hour break makes it eight paid hours', morningShift.break_min === 60, morningShift.break_min);
  ok('a flexible eight-hour shift exists for drivers and stores',
    !!importedShifts.find((s: Json) => s.code === 'FLEX8'), importedShifts.map((s: Json) => s.code));

  const importedRoster = await api(`/api/admin/roster?from=${today}&to=${T.addDays(today, 13)}`, { token: admin });
  ok('the roster covers the imported staff',
    importedRoster.body.users.filter((u: Json) => u.employee_code.startsWith('EMP-0')).length >= 13,
    importedRoster.body.users.length);
  const emp1 = staff.find((u: Json) => u.employee_code === 'EMP-001');
  const fridays = importedRoster.body.dates.filter((d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() === 5);
  ok('Friday is a rest day',
    fridays.length > 0 && fridays.every((d: string) => importedRoster.body.cells[emp1.id]?.[d]?.status === 'off'),
    fridays.map((d: string) => importedRoster.body.cells[emp1.id]?.[d]?.status));
  ok('other days are working days on the morning shift',
    importedRoster.body.dates.filter((d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 5)
      .every((d: string) => {
        const c = importedRoster.body.cells[emp1.id]?.[d];
        return c && (c.status === 'work' || c.status === 'holiday');
      }));

  // Re-running must not duplicate anyone or trample the roster.
  await runScript(['run', '-A', 'scripts/import-masarat.ts', '--days=14']);
  const staff2 = (await api('/api/admin/users', { token: admin })).body.users;
  ok('re-running the import creates no duplicates', staff2.length === staff.length,
    `${staff.length} -> ${staff2.length}`);

  const imported = (await api('/api/admin/timesheet?from=' + today + '&to=' + T.addDays(today, 13),
    { token: admin })).body;
  ok('imported staff appear on the timesheet',
    imported.rows.filter((r: Json) => r.employee_code.startsWith('EMP-0')).length >= 13,
    imported.rows.length);
  ok('admins are still excluded from the timesheet',
    !imported.rows.some((r: Json) => r.employee_code.startsWith('ADM-')),
    imported.rows.map((r: Json) => r.employee_code).filter((c: string) => c.startsWith('ADM')));
} catch (err) {
  console.error('\nTest run crashed:', err);
  fails += 1;
} finally {
  // PORT NOTE: replaces server.kill() — the app runs in this process now, so the
  // listener and the Postgres pool both have to be closed or deno never exits.
  await server.shutdown();
  await store.close();
  await new Promise((r) => setTimeout(r, 250));
}

// Nothing may have been written outside the dedicated photo directory. The Node
// suite polluted data/photos; this makes that regression loud. (Not an ok() check:
// the suite's 122 assertions are fixed.)
for (const stray of [`${ROOT}/data/photos`, `${ROOT}/.local-photos`]) {
  try {
    Deno.statSync(stray);
    console.error(`\n[harness] photos escaped the test directory: ${stray}`);
    fails += 1;
  } catch { /* absent, as it must be */ }
}

console.log(`\n${passes} PASS  ${fails} FAIL  (of ${passes + fails})`);
console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll checks passed.\n');
Deno.exit(fails ? 1 : 0);

// ---------------------------------------------------------------------------
// Runs test/selfie_modes_child.ts once per SELFIE_MODE and collects its JSON.
// ---------------------------------------------------------------------------
interface PhotoOutcome { ok: boolean; name?: string | null; code?: string; error?: string }
interface ModeResult { mode: string; withPhoto: PhotoOutcome; withoutPhoto: PhotoOutcome }

async function selfieModeResults(jpegUrl: string): Promise<Record<string, ModeResult>> {
  const out: Record<string, ModeResult> = {};
  const modeList = ['off', 'optional', 'required'];
  for (let i = 0; i < modeList.length; i += 1) {
    const mode = modeList[i];
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ['run', '-A', 'test/selfie_modes_child.ts'],
      cwd: ROOT,
      env: {
        ...ENV,
        SELFIE_MODE: mode,
        PORT: String(3200 + i),
        TEST_JPEG_DATA_URL: jpegUrl,
      },
      stdout: 'piped',
      stderr: 'piped',
    });
    const res = await cmd.output();
    const stdout = new TextDecoder().decode(res.stdout);
    const stderr = new TextDecoder().decode(res.stderr);
    if (!res.success) throw new Error(`selfie child (${mode}) failed:\n${stdout}\n${stderr}`);
    const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    if (!line) throw new Error(`selfie child (${mode}) printed no result:\n${stdout}\n${stderr}`);
    out[mode] = JSON.parse(line) as ModeResult;
  }
  return out;
}
