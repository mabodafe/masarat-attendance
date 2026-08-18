/**
 * Loads the real Masarat staff list from "بيان الموظفين.xlsx" into the system:
 * shifts, the four accounts listed under الصلاحيات, the thirteen employees with
 * their direct managers, and a working roster.
 *
 *   deno run -A scripts/import-masarat.ts                 # create / update, then roster 30 days
 *   deno run -A scripts/import-masarat.ts --days=60       # roster further ahead
 *   deno run -A scripts/import-masarat.ts --rest=5,6      # Friday AND Saturday off (default: Friday only)
 *   deno run -A scripts/import-masarat.ts --no-roster     # accounts and shifts only
 *
 * Safe to re-run: people are matched on employee code and updated in place, and
 * existing roster days are never overwritten.
 */
// PORT NOTE: 'use strict' dropped — Deno modules are always strict mode.
// PORT NOTE: node:crypto.randomBytes -> Web Crypto getRandomValues (see newPassword).
import { all, close, get, run, tx } from '../api/db.ts';
import { hashPassword } from '../api/lib/auth.ts';
import * as T from '../api/lib/time.ts';

// PORT NOTE: process.argv -> Deno.args. process.argv held [node, script, ...flags]
// while Deno.args holds only the flags, so startsWith/includes see the same set of
// user-supplied arguments and cannot accidentally match the script path.
const arg = (name: string, dflt: string): string => {
  const hit = Deno.args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const flag = (name: string) => Deno.args.includes(`--${name}`);

const ROSTER_DAYS = Math.max(0, Math.min(365, Number(arg('days', '30')) || 30));
const REST_DAYS = String(arg('rest', '5'))            // 0 = Sunday … 5 = Friday, 6 = Saturday
  .split(',').map((n) => Number(n.trim())).filter((n) => n >= 0 && n <= 6);
const DO_ROSTER = !flag('no-roster') && ROSTER_DAYS > 0;

const now = T.nowIso();
// PORT NOTE: same output shape as `Mas-${crypto.randomBytes(4).toString('hex')}`:
// 4 bytes -> 8 lower-case hex characters, so the password format and length are
// unchanged.
const newPassword = () =>
  `Mas-${Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, '0')).join('')}`;

interface Shift {
  code: string;
  name: string;
  start_time: string;
  end_time: string;
  crosses_midnight: number;
  grace_in_min: number;
  grace_out_min: number;
  early_in_min: number;
  break_min: number;
}

interface Person {
  employee_code: string;
  full_name: string;
  job_title?: string;
  email: string;
  phone?: string | null;
  department?: string;
  manager?: string;
  shift?: string;
  id?: number;
}

// ---------------------------------------------------------------------------
// Shifts. "من 6.00 الى 15.00" for the site crew; the transport and stores team
// is contracted for "عدد الساعات 8 ساعات عمل" with no fixed start, so they get a
// wide window that still totals eight hours.
// ---------------------------------------------------------------------------
const SHIFTS: Shift[] = [
  {
    code: 'MORNING', name: 'الوردية الصباحية 6:00 - 15:00',
    start_time: '06:00', end_time: '15:00', crosses_midnight: 0,
    grace_in_min: 15, grace_out_min: 10, early_in_min: 60,
    break_min: 60,   // 9 hours on site minus a one-hour break = the 8 paid hours
  },
  {
    code: 'FLEX8', name: 'دوام مرن 8 ساعات',
    start_time: '06:00', end_time: '14:00', crosses_midnight: 0,
    grace_in_min: 240, grace_out_min: 240, early_in_min: 60,
    break_min: 0,    // eight hours of work, start time not fixed
  },
];

// ---------------------------------------------------------------------------
// الصلاحيات - the four people the sheet lists as holding system authority.
// ---------------------------------------------------------------------------
const ADMINS: Person[] = [
  { employee_code: 'ADM-001', full_name: 'لؤي إسماعيل', job_title: 'مهندس - مدير مباشر', email: 'louai@masarat.local' },
  { employee_code: 'ADM-002', full_name: 'محمد شحاتة', job_title: 'مدير مباشر - النقل والمخازن', email: 'mshehata@masarat.local' },
  { employee_code: 'ADM-003', full_name: 'عمار الأديب', job_title: 'صلاحيات إدارية', email: 'ammar@masarat.local' },
  { employee_code: 'ADM-004', full_name: 'عبدالرحمن السباعي', job_title: 'صلاحيات إدارية', email: 'abdulrahman@masarat.local' },
];

// ---------------------------------------------------------------------------
// The thirteen employees, in the sheet's own numbering (column م).
// manager = employee_code of the direct manager in ADMINS.
// ---------------------------------------------------------------------------
const EMPLOYEES: Person[] = [
  { employee_code: 'EMP-001', full_name: 'عبد الرزاق محمد',   job_title: 'مراقب',        manager: 'ADM-001', shift: 'MORNING', department: 'المشاريع', email: 'emp001@masarat.local' },
  { employee_code: 'EMP-002', full_name: 'مجد معاذ',          job_title: 'مهندس',        manager: 'ADM-001', shift: 'MORNING', department: 'المشاريع', email: 'emp002@masarat.local' },
  { employee_code: 'EMP-003', full_name: 'محمد نور',          job_title: 'مراقب',        manager: 'ADM-001', shift: 'MORNING', department: 'المشاريع', email: 'emp003@masarat.local' },
  { employee_code: 'EMP-004', full_name: 'عبد المجيد السباعي', job_title: 'مهندس',        manager: 'ADM-001', shift: 'MORNING', department: 'المشاريع', email: 'emp004@masarat.local' },
  { employee_code: 'EMP-005', full_name: 'أحمد قناوي',        job_title: 'مراقب',        manager: 'ADM-001', shift: 'MORNING', department: 'المشاريع', email: 'emp005@masarat.local' },
  { employee_code: 'EMP-006', full_name: 'أحمد خيرت',         job_title: 'مراقب',        manager: 'ADM-001', shift: 'MORNING', department: 'المشاريع', email: 'emp006@masarat.local' },
  { employee_code: 'EMP-007', full_name: 'نايف الأديب',       job_title: 'مراقب',        manager: 'ADM-001', shift: 'MORNING', department: 'المشاريع', email: 'emp007@masarat.local' },
  { employee_code: 'EMP-008', full_name: 'عمر الأمين',        job_title: 'مهندس',        manager: 'ADM-001', shift: 'MORNING', department: 'المشاريع', email: 'emp008@masarat.local' },
  { employee_code: 'EMP-009', full_name: 'محمد الزيبق',       job_title: 'مهندس',        manager: 'ADM-001', shift: 'MORNING', department: 'المشاريع', email: 'emp009@masarat.local' },
  { employee_code: 'EMP-010', full_name: 'عبد الله الأديب',   job_title: 'مراقب',        manager: 'ADM-001', shift: 'MORNING', department: 'المشاريع', email: 'emp010@masarat.local' },
  { employee_code: 'EMP-011', full_name: 'محمود السبع',       job_title: 'سائق',         manager: 'ADM-002', shift: 'FLEX8',   department: 'النقل والمخازن', email: 'emp011@masarat.local' },
  { employee_code: 'EMP-012', full_name: 'محمد أبو عميرة',    job_title: 'سائق',         manager: 'ADM-002', shift: 'FLEX8',   department: 'النقل والمخازن', email: 'emp012@masarat.local' },
  { employee_code: 'EMP-013', full_name: 'وائل رضا',          job_title: 'مسؤول مخازن',  manager: 'ADM-002', shift: 'FLEX8',   department: 'النقل والمخازن', email: 'emp013@masarat.local' },
];

// ---------------------------------------------------------------------------

async function upsertShift(s: Shift): Promise<{ id: number; created: boolean }> {
  const existing = await get<{ id: number }>('SELECT id FROM shifts WHERE code = ?', s.code);
  if (existing) {
    await run(
      `UPDATE shifts SET name=?, start_time=?, end_time=?, crosses_midnight=?,
              grace_in_min=?, grace_out_min=?, early_in_min=?, break_min=?, active=1
        WHERE id = ?`,
      s.name, s.start_time, s.end_time, s.crosses_midnight,
      s.grace_in_min, s.grace_out_min, s.early_in_min, s.break_min, existing.id
    );
    return { id: existing.id, created: false };
  }
  // PORT NOTE: `RETURNING id` added so run().lastInsertRowid is populated —
  // Postgres has no equivalent of SQLite's implicit last insert rowid.
  const info = await run(
    `INSERT INTO shifts (code, name, start_time, end_time, crosses_midnight,
                         grace_in_min, grace_out_min, early_in_min, break_min, active)
     VALUES (?,?,?,?,?,?,?,?,?,1) RETURNING id`,
    s.code, s.name, s.start_time, s.end_time, s.crosses_midnight,
    s.grace_in_min, s.grace_out_min, s.early_in_min, s.break_min
  );
  return { id: Number(info.lastInsertRowid), created: true };
}

const credentials: (Person & { role: string; password: string })[] = [];

async function upsertUser(p: Person, role: string, managerId: number | null = null): Promise<{ id: number; created: boolean }> {
  const existing = await get<{ id: number }>('SELECT id FROM users WHERE employee_code = ?', p.employee_code);
  if (existing) {
    await run(
      `UPDATE users SET full_name=?, job_title=?, department=?, role=?, manager_id=?,
              active=1, updated_at=? WHERE id = ?`,
      p.full_name, p.job_title || null, p.department || null, role, managerId, now, existing.id
    );
    return { id: existing.id, created: false };
  }
  const password = newPassword();
  // PORT NOTE: `RETURNING id` added for the same reason as in upsertShift().
  const info = await run(
    `INSERT INTO users (employee_code, full_name, email, phone, job_title, department,
                        role, manager_id, password_hash, must_change_password, active,
                        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?) RETURNING id`,
    p.employee_code, p.full_name, p.email, p.phone || null,
    p.job_title || null, p.department || null, role, managerId,
    hashPassword(password), now, now
  );
  credentials.push({ ...p, role, password });
  return { id: Number(info.lastInsertRowid), created: true };
}

// --- run ---------------------------------------------------------------------

const shiftIds: Record<string, number> = {};
let shiftsCreated = 0;
for (const s of SHIFTS) {
  const r = await upsertShift(s);
  shiftIds[s.code] = r.id;
  if (r.created) shiftsCreated += 1;
}
console.log(`Shifts: ${SHIFTS.length} in place (${shiftsCreated} new)`);
console.log(`  MORNING  06:00-15:00, one hour break  -> 8 paid hours`);
console.log(`  FLEX8    8 hours, start not fixed (window 05:00-14:00 +4h grace)`);

const adminIds: Record<string, number> = {};
let usersCreated = 0;
await tx(async () => {
  for (const a of ADMINS) {
    const r = await upsertUser(a, 'admin');
    adminIds[a.employee_code] = r.id;
    if (r.created) usersCreated += 1;
  }
  for (const e of EMPLOYEES) {
    const r = await upsertUser(e, 'employee', adminIds[e.manager as string] ?? null);
    e.id = r.id;
    if (r.created) usersCreated += 1;
  }
});
console.log(`\nAccounts: ${ADMINS.length} with الصلاحيات + ${EMPLOYEES.length} employees (${usersCreated} new)`);

// --- roster ------------------------------------------------------------------
if (DO_ROSTER) {
  const start = T.local().date;
  const dates = T.dateRange(start, T.addDays(start, ROSTER_DAYS - 1), 400);
  // PORT NOTE: the original re-required './db' inline for this one all() call;
  // here all() is already imported at the top. Same query, same arguments.
  const holidays = new Set(
    (await all<{ holiday_date: string }>('SELECT holiday_date FROM holidays WHERE holiday_date BETWEEN ? AND ?',
      dates[0], dates[dates.length - 1])).map((h) => h.holiday_date)
  );
  let written = 0;
  let kept = 0;
  await tx(async () => {
    for (const e of EMPLOYEES) {
      for (const d of dates) {
        if (await get<{ id: number }>('SELECT id FROM schedules WHERE user_id = ? AND work_date = ?', e.id, d)) { kept += 1; continue; }
        const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
        const rest = REST_DAYS.includes(weekday);
        const holiday = holidays.has(d);
        await run(
          `INSERT INTO schedules (user_id, work_date, shift_id, project_id, status, created_at)
           VALUES (?,?,?,NULL,?,?)`,
          e.id, d,
          rest || holiday ? null : shiftIds[e.shift as string],
          holiday ? 'holiday' : rest ? 'off' : 'work',
          now
        );
        written += 1;
      }
    }
  });
  const names = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  console.log(`\nRoster: ${written} day(s) written over ${ROSTER_DAYS} days from ${start}` +
              `${kept ? `, ${kept} existing day(s) left alone` : ''}`);
  console.log(`  Rest days: ${REST_DAYS.map((d) => names[d]).join(', ') || 'none'}` +
              `  (change with --rest=5,6)`);
  console.log(`  No site assigned - each employee picks the project they attend,`);
  console.log(`  or set a default site per day in the admin roster grid.`);
}

if (credentials.length) {
  console.log('\n--- Sign-in details. Hand these out, then delete this output. ---');
  console.log('Everyone is asked to choose their own password at first sign-in.');
  console.log('They can sign in with the employee code OR the email.\n');
  const pad = (s: unknown, n: number) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
  console.log(`${pad('CODE', 9)}${pad('NAME', 24)}${pad('ROLE', 10)}PASSWORD`);
  for (const c of credentials) {
    console.log(`${pad(c.employee_code, 9)}${pad(c.full_name, 24)}${pad(c.role, 10)}${c.password}`);
  }
} else {
  console.log('\nAll accounts already existed; no new passwords were generated.');
  console.log('Reset a password from the admin console (Employees -> Edit).');
}

console.log('\nNext: add your real project sites in the admin console (Projects & sites),');
console.log('each with its GPS centre and geofence radius, then start the server.');

// PORT NOTE: node:sqlite held no open sockets, so the original script exited on
// its own. postgres.js keeps a pool alive, which would hang `deno run` forever,
// so the pool is closed here. No data behaviour is affected.
await close();
