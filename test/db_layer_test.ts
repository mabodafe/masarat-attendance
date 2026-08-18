// Proves the ported data layer behaves like the SQLite one it replaces.
// Run: DATABASE_URL=... deno run -A test/db_layer_test.ts
import { all, get, run, tx, ensureColumn, applySchema, toPgPlaceholders, close } from '../api/db.ts';

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${cond ? '' : '  ' + JSON.stringify(extra)}`);
  cond ? pass++ : fail++;
};
const section = (n: string) => console.log(`\n${n}`);

// ---------------------------------------------------------------- placeholders
section('Placeholder conversion (the mechanism that lets 172 queries be reused verbatim)');
ok('single placeholder', toPgPlaceholders('SELECT * FROM users WHERE id = ?') === 'SELECT * FROM users WHERE id = $1');
ok('multiple placeholders numbered in order',
  toPgPlaceholders('INSERT INTO t (a,b,c) VALUES (?,?,?)') === 'INSERT INTO t (a,b,c) VALUES ($1,$2,$3)');
ok('BETWEEN ? AND ? (used by the roster/holiday queries)',
  toPgPlaceholders('WHERE d BETWEEN ? AND ?') === 'WHERE d BETWEEN $1 AND $2');
ok('a ? inside a SQL string literal is NOT treated as a placeholder',
  toPgPlaceholders("SELECT 'why?' , ? FROM t") === "SELECT 'why?' , $1 FROM t",
  toPgPlaceholders("SELECT 'why?' , ? FROM t"));
ok('escaped quote inside a literal does not break the scanner',
  toPgPlaceholders("SELECT 'it''s ok?' , ? FROM t") === "SELECT 'it''s ok?' , $1 FROM t",
  toPgPlaceholders("SELECT 'it''s ok?' , ? FROM t"));
ok('a ? inside a line comment is left alone',
  toPgPlaceholders('SELECT ? -- what?\n , ?') === 'SELECT $1 -- what?\n , $2',
  toPgPlaceholders('SELECT ? -- what?\n , ?'));
ok('quoted identifier is respected',
  toPgPlaceholders('SELECT "a?b", ? FROM t') === 'SELECT "a?b", $1 FROM t');

// ---------------------------------------------------------------- setup
const schema = await Deno.readTextFile(new URL('../db/schema.postgres.sql', import.meta.url));
await applySchema(schema);
// clean slate, and reset identities so ids are predictable for these assertions
await run(`TRUNCATE attendance, punch_log, leave_requests, schedules, project_members,
                   projects, shifts, holidays, login_attempts, users RESTART IDENTITY CASCADE`);

section('Helper contracts (same names and argument shapes as the SQLite version)');
const ins = await run(
  `INSERT INTO users (employee_code, full_name, email, password_hash, created_at, updated_at)
   VALUES (?,?,?,?,?,?) RETURNING id`,
  'E-001', 'لؤي إسماعيل', 'l@x.local', 'hash', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z',
);
ok('run() returns lastInsertRowid from RETURNING (replaces SQLite lastInsertRowid)', ins.lastInsertRowid === 1, ins);
ok('run() reports changes', ins.changes === 1, ins);

const one = await get<{ full_name: string }>('SELECT * FROM users WHERE employee_code = ?', 'E-001');
ok('get() returns a single row', one?.full_name === 'لؤي إسماعيل', one);
ok('get() returns null when nothing matches', (await get('SELECT * FROM users WHERE id = ?', 9999)) === null);

const many = await all('SELECT * FROM users');
ok('all() returns an array', Array.isArray(many) && many.length === 1);

section('Parameter coercion (node:sqlite refused booleans and undefined; parity kept)');
await run('UPDATE users SET active = ?, phone = ? WHERE id = ?', false, undefined, 1);
const coerced = await get<{ active: number; phone: string | null }>('SELECT active, phone FROM users WHERE id = ?', 1);
ok('boolean false coerces to integer 0', coerced?.active === 0, coerced);
ok('undefined coerces to NULL', coerced?.phone === null, coerced);
await run('UPDATE users SET active = ? WHERE id = ?', true, 1);
ok('boolean true coerces to integer 1', (await get<{ active: number }>('SELECT active FROM users WHERE id=?', 1))?.active === 1);

section('Unique-violation detection (Postgres wording differs from SQLite — this is the fix)');
try {
  await run(
    `INSERT INTO users (employee_code, full_name, email, password_hash, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
    'E-001', 'dup', 'dup@x.local', 'h', 't', 't',
  );
  ok('duplicate insert rejected', false, 'no error thrown');
} catch (err) {
  const e = err as Error & { isUniqueViolation?: boolean; code?: string };
  ok('duplicate insert throws', true);
  ok('error carries isUniqueViolation (SQLSTATE 23505), not fragile text matching',
    e.isUniqueViolation === true && e.code === '23505', { code: e.code, flag: e.isUniqueViolation });
  ok('SQLite text match would NOT have caught this (proving the old handler was broken)',
    !/UNIQUE constraint/.test(String(e.message)), e.message);
}

section('ON CONFLICT (already Postgres syntax in the original — reused verbatim)');
await run(
  `INSERT INTO shifts (code,name,start_time,end_time,break_min) VALUES (?,?,?,?,?)`,
  'MORNING', 'Morning', '06:00', '15:00', 60,
);
await run(
  `INSERT INTO schedules (user_id, work_date, shift_id, status, created_at) VALUES (?,?,?,?,?)
   ON CONFLICT (user_id, work_date) DO UPDATE SET status = EXCLUDED.status`,
  1, '2026-08-18', 1, 'work', 't',
);
await run(
  `INSERT INTO schedules (user_id, work_date, shift_id, status, created_at) VALUES (?,?,?,?,?)
   ON CONFLICT (user_id, work_date) DO UPDATE SET status = EXCLUDED.status`,
  1, '2026-08-18', 1, 'off', 't',
);
const sched = await all('SELECT status FROM schedules WHERE user_id = ?', 1);
ok('ON CONFLICT DO UPDATE upserts rather than duplicating', sched.length === 1 && (sched[0] as { status: string }).status === 'off', sched);

section('Transactions (tx() commits on return, rolls back on throw)');
await tx(async () => {
  await run('UPDATE users SET job_title = ? WHERE id = ?', 'committed', 1);
});
ok('tx() commits', (await get<{ job_title: string }>('SELECT job_title FROM users WHERE id=?', 1))?.job_title === 'committed');

try {
  await tx(async () => {
    await run('UPDATE users SET job_title = ? WHERE id = ?', 'should-not-persist', 1);
    throw new Error('deliberate failure inside the transaction');
  });
} catch { /* expected */ }
ok('tx() rolls back every write on throw',
  (await get<{ job_title: string }>('SELECT job_title FROM users WHERE id=?', 1))?.job_title === 'committed');

let nested = false;
await tx(async () => {
  await tx(async () => { nested = true; await run('SELECT 1'); });
});
ok('nested tx() joins the outer transaction instead of deadlocking', nested);

section('ensureColumn (replaces PRAGMA table_info; still additive and idempotent)');
const added1 = await ensureColumn('users', 'probe_col', 'TEXT');
const added2 = await ensureColumn('users', 'probe_col', 'TEXT');
ok('adds a missing column', added1 === true);
ok('is a no-op when the column exists (idempotent on every boot)', added2 === false);
await run('ALTER TABLE users DROP COLUMN probe_col');

section('Geofence precision (why DOUBLE PRECISION and not Postgres REAL)');
await run(
  `INSERT INTO projects (code,name,lat,lng,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
  'P1', 'Site One', 24.71355, 46.67529, 't', 't',
);
const p = await get<{ lat: number; lng: number }>('SELECT lat, lng FROM projects WHERE code = ?', 'P1');
ok('latitude survives the round trip exactly', p?.lat === 24.71355, p);
ok('longitude survives the round trip exactly', p?.lng === 46.67529, p);

console.log(`\nPASS: ${pass}   FAIL: ${fail}`);
await close();
if (fail) Deno.exit(1);
