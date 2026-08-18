/**
 * Creates the two default shifts, one demo site, an admin account and two
 * sample employees, plus a two-week roster. Safe to re-run: existing rows are
 * left alone unless --reset is passed.
 *
 *   deno run -A scripts/seed.ts
 *   deno run -A scripts/seed.ts --reset      (wipes all data first)
 *
 * DEMO DATA ONLY. Never run this against production: it is the demo counterpart
 * of scripts/import-masarat.ts, which owns the real ADM-* / EMP-* accounts.
 */
// PORT NOTE: 'use strict' dropped — Deno modules are always strict mode.
// PORT NOTE: node:crypto.randomBytes -> Web Crypto getRandomValues (see tempPassword).
import { all, close, get, run, tx } from '../api/db.ts';
import { hashPassword } from '../api/lib/auth.ts';
import * as T from '../api/lib/time.ts';

// PORT NOTE: process.argv -> Deno.args. Deno.args excludes the runtime and the
// script path, so `includes('--reset')` matches exactly the same user flag.
const RESET = Deno.args.includes('--reset');
const now = T.nowIso();

function tempPassword(): string {
  // PORT NOTE: same output shape as crypto.randomBytes(6).toString('base64url'):
  // 6 bytes = 48 bits = exactly 8 base64 characters with no '=' padding, so the
  // password stays 10 characters long and in the same alphabet.
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const b64url = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64url.replace(/[-_]/g, 'a') + 'A1';
}

if (RESET) {
  await tx(async () => {
    for (const t of ['punch_log', 'attendance', 'schedules', 'project_members', 'holidays', 'projects', 'shifts', 'users']) {
      // PORT NOTE: kept as DELETE, deliberately NOT switched to
      // TRUNCATE ... RESTART IDENTITY. SQLite's DELETE left sqlite_sequence
      // advanced, so ids kept climbing after a reset; Postgres DELETE likewise
      // leaves the identity sequences advanced. Same behaviour either way.
      await run(`DELETE FROM ${t}`);
    }
  });
  console.log('All data cleared.');
}

// ---- shifts -----------------------------------------------------------------
const SHIFTS = [
  { code: 'MORNING', name: 'Morning shift', start_time: '06:00', end_time: '15:00', crosses_midnight: 0, grace_in_min: 15, grace_out_min: 10, early_in_min: 60, break_min: 30 },
  { code: 'NIGHT',   name: 'Night shift',   start_time: '18:00', end_time: '03:00', crosses_midnight: 1, grace_in_min: 15, grace_out_min: 10, early_in_min: 60, break_min: 30 },
];
for (const s of SHIFTS) {
  if (await get<{ id: number }>('SELECT id FROM shifts WHERE code = ?', s.code)) continue;
  await run(
    `INSERT INTO shifts (code, name, start_time, end_time, crosses_midnight,
                         grace_in_min, grace_out_min, early_in_min, break_min, active)
     VALUES (?,?,?,?,?,?,?,?,?,1)`,
    s.code, s.name, s.start_time, s.end_time, s.crosses_midnight,
    s.grace_in_min, s.grace_out_min, s.early_in_min, s.break_min
  );
  console.log(`Shift created: ${s.name} ${s.start_time}-${s.end_time}`);
}

// ---- demo site --------------------------------------------------------------
// Replace these coordinates with the real site before going live.
const SITE = {
  code: 'SITE-001', name: 'Head Office', client: 'Internal',
  address: 'Replace with the real site address',
  lat: 24.7136, lng: 46.6753, radius_m: 150,
};
if (!await get<{ id: number }>('SELECT id FROM projects WHERE code = ?', SITE.code)) {
  await run(
    `INSERT INTO projects (code, name, client, address, lat, lng, radius_m, active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,1,?,?)`,
    SITE.code, SITE.name, SITE.client, SITE.address, SITE.lat, SITE.lng, SITE.radius_m, now, now
  );
  console.log(`Project created: ${SITE.name} (${SITE.lat}, ${SITE.lng}) fence ${SITE.radius_m} m`);
}

// ---- accounts ---------------------------------------------------------------
// Demo accounts use a DEMO- prefix so they never collide with a real staff
// import (see scripts/import-masarat.ts, which owns ADM-* and EMP-*).
const PEOPLE = [
  { employee_code: 'DEMO-ADM', full_name: 'System Administrator', email: 'admin@company.local', role: 'admin', job_title: 'HR Administrator', department: 'HR' },
  { employee_code: 'DEMO-E01', full_name: 'Sample Employee One', email: 'emp1@company.local', role: 'employee', job_title: 'Site Engineer', department: 'Operations' },
  { employee_code: 'DEMO-E02', full_name: 'Sample Employee Two', email: 'emp2@company.local', role: 'employee', job_title: 'Foreman', department: 'Operations' },
];
const credentials: { employee_code: string; role: string; email: string; password: string }[] = [];
for (const p of PEOPLE) {
  if (await get<{ id: number }>('SELECT id FROM users WHERE employee_code = ?', p.employee_code)) continue;
  const pwd = p.role === 'admin' ? 'Admin@12345' : tempPassword();
  await run(
    `INSERT INTO users (employee_code, full_name, email, phone, job_title, department,
                        role, password_hash, must_change_password, active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,1,1,?,?)`,
    p.employee_code, p.full_name, p.email, null, p.job_title, p.department,
    p.role, hashPassword(pwd), now, now
  );
  credentials.push({ ...p, password: pwd });
}

// ---- two-week roster for the sample employees -------------------------------
const morning = await get<{ id: number }>("SELECT id FROM shifts WHERE code = 'MORNING'");
const night = await get<{ id: number }>("SELECT id FROM shifts WHERE code = 'NIGHT'");
const project = await get<{ id: number }>('SELECT id FROM projects WHERE code = ?', SITE.code);
// Demo accounts only, so re-running the seed never rosters real staff.
const employees = await all<{ id: number }>(
  "SELECT id FROM users WHERE role = 'employee' AND employee_code LIKE 'DEMO-%' ORDER BY employee_code"
);

if (employees.length && morning && night && project) {
  const start = T.local().date;
  await tx(async () => {
    // PORT NOTE: employees.forEach((emp, idx) => ...) became an indexed for loop.
    // Array.prototype.forEach does not await, so the inserts would have escaped
    // the transaction. The idx % 2 shift alternation is unchanged.
    for (let idx = 0; idx < employees.length; idx += 1) {
      const emp = employees[idx];
      for (const d of T.dateRange(start, T.addDays(start, 13))) {
        const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
        const off = weekday === 5 || weekday === 6; // Friday, Saturday
        await run(
          `INSERT INTO schedules (user_id, work_date, shift_id, project_id, status, created_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(user_id, work_date) DO NOTHING`,
          emp.id, d,
          off ? null : (idx % 2 === 0 ? morning.id : night.id),
          off ? null : project.id,
          off ? 'off' : 'work', now
        );
      }
    }
  });
  console.log('Two-week roster created for the sample employees (Fri/Sat off).');
}

console.log('\nDone.');
if (credentials.length) {
  console.log('\nSign-in details (change these immediately):');
  for (const c of credentials) {
    console.log(`  ${c.role.padEnd(9)} ${c.employee_code.padEnd(8)} ${c.email.padEnd(22)} ${c.password}`);
  }
} else {
  console.log('Accounts already existed; no new passwords generated.');
}
console.log('\nStart the server with:  npm start');

// PORT NOTE: node:sqlite held no open sockets, so the original script exited on
// its own. postgres.js keeps a pool alive, which would hang `deno run` forever,
// so the pool is closed here. No data behaviour is affected.
await close();
