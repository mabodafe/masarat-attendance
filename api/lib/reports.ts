// Ported from server/lib/reports.js — the monthly timesheet payroll pays from.
//
// Every counting rule, every threshold and every rounding expression is
// byte-identical to the original. What changed, and only because the platform
// forced it:
//
//   1. `await` on the three all() calls in timesheet() and the one in byProject().
//   2. timesheet(): `? IS NULL` became `?::int IS NULL`. See the PORT NOTE below —
//      Postgres cannot infer a parameter's type when its only use is `$n IS NULL`
//      and rejects the statement outright ("could not determine data type of
//      parameter $2"), which SQLite happily accepted. The `::int` cast restores
//      the original null-safe "no user filter" semantics without changing them.
//   3. byProject(): the aggregate columns are cast back to Number. See the PORT
//      NOTE below — Postgres count()/sum() return bigint, which the driver hands
//      back as a string, so the JSON body would have changed from 1 to "1".
//
// No arithmetic, no rounding and no counting rule was touched.
import { all } from '../db.ts';
import * as T from './time.ts';

interface TimesheetRow {
  user_id: number;
  employee_code: unknown;
  full_name: unknown;
  job_title: unknown;
  department: unknown;
  active: boolean;
  scheduled_days: number;
  off_days: number;
  leave_days: number;
  holiday_days: number;
  worked_days: number;
  absent_days: number;
  paid_minutes: number;
  late_count: number;
  late_minutes: number;
  early_out_minutes: number;
  overtime_minutes: number;
  missing_checkout: number;
  still_open: number;
  flagged_days: number;
  unscheduled_days: number;
}

export interface TimesheetInput {
  from: string;
  to: string;
  userId?: number | null;
  includeInactive?: boolean;
}

/**
 * Per-employee timesheet for a date range: what they were rostered for, what
 * they actually recorded, and the totals payroll needs.
 *
 * Counting rules, stated once so the numbers are defensible:
 *  - scheduled_days   roster rows with status 'work'
 *  - worked_days      distinct work_dates with an attendance record
 *  - absent_days      rostered to work, no attendance record, and the day is
 *                     already over (today is never counted as an absence)
 *  - paid_minutes     sum of worked_minutes, which already has the unpaid break
 *                     deducted and is capped at the shift end for auto-closed
 *                     records
 */
export async function timesheet(
  { from, to, userId = null, includeInactive = false }: TimesheetInput,
): Promise<Record<string, unknown>> {
  const today = T.local().date;
  // PORT NOTE: `? IS NULL` is the only change to this query. SQLite accepted a
  // bare bound parameter there; Postgres needs the parameter's type to be
  // knowable, and `$2 IS NULL` is its only occurrence, so it errors with
  // "could not determine data type of parameter $2". `?::int IS NULL` is the
  // same test (users.id is INTEGER) and keeps the "null userId = all users"
  // behaviour exactly as it was. Nothing else in the statement is touched.
  const users = await all<Record<string, unknown>>(
    `SELECT id, employee_code, full_name, job_title, department, role, active
       FROM users
      WHERE role <> 'admin'
        AND (? = 1 OR active = 1)
        AND (?::int IS NULL OR id = ?)
      ORDER BY full_name`,
    includeInactive ? 1 : 0, userId, userId,
  );

  const schedules = await all<Record<string, unknown>>(
    'SELECT user_id, work_date, status FROM schedules WHERE work_date BETWEEN ? AND ?',
    from, to,
  );
  const records = await all<Record<string, unknown>>(
    `SELECT user_id, work_date, worked_minutes, late_minutes, early_out_minutes,
            overtime_minutes, status, flags
       FROM attendance WHERE work_date BETWEEN ? AND ?`,
    from, to,
  );

  const byUser = new Map<number, TimesheetRow>(users.map((u) => [u.id as number, {
    user_id: u.id as number,
    employee_code: u.employee_code,
    full_name: u.full_name,
    job_title: u.job_title,
    department: u.department,
    active: !!u.active,
    scheduled_days: 0, off_days: 0, leave_days: 0, holiday_days: 0,
    worked_days: 0, absent_days: 0,
    paid_minutes: 0, late_count: 0, late_minutes: 0,
    early_out_minutes: 0, overtime_minutes: 0,
    missing_checkout: 0, still_open: 0, flagged_days: 0,
    unscheduled_days: 0,
  }]));

  const rosterKeys = new Set<string>();
  for (const s of schedules) {
    const row = byUser.get(s.user_id as number);
    if (!row) continue;
    if (s.status === 'work') { row.scheduled_days += 1; rosterKeys.add(`${s.user_id}|${s.work_date}`); }
    else if (s.status === 'off') row.off_days += 1;
    else if (s.status === 'leave') row.leave_days += 1;
    else if (s.status === 'holiday') row.holiday_days += 1;
  }

  const attendedKeys = new Set<string>();
  for (const r of records) {
    const row = byUser.get(r.user_id as number);
    if (!row) continue;
    const key = `${r.user_id}|${r.work_date}`;
    if (!attendedKeys.has(key)) { row.worked_days += 1; attendedKeys.add(key); }
    if (!rosterKeys.has(key)) row.unscheduled_days += 1;

    row.paid_minutes += (r.worked_minutes as number) || 0;
    row.late_minutes += (r.late_minutes as number) || 0;
    row.early_out_minutes += (r.early_out_minutes as number) || 0;
    row.overtime_minutes += (r.overtime_minutes as number) || 0;
    if ((r.late_minutes as number) > 0) row.late_count += 1;
    if (r.status === 'open') row.still_open += 1;

    const flags = JSON.parse((r.flags as string) || '[]') as string[];
    if (flags.length) row.flagged_days += 1;
    if (flags.includes('missing_checkout')) row.missing_checkout += 1;
  }

  // Absences: rostered, nothing recorded, and the day has already finished.
  for (const s of schedules) {
    if (s.status !== 'work' || (s.work_date as string) >= today) continue;
    const row = byUser.get(s.user_id as number);
    if (row && !attendedKeys.has(`${s.user_id}|${s.work_date}`)) row.absent_days += 1;
  }

  const rows = [...byUser.values()].map((r) => ({
    ...r,
    paid_hours: Math.round((r.paid_minutes / 60) * 100) / 100,
    attendance_rate: r.scheduled_days
      ? Math.round((Math.min(r.worked_days, r.scheduled_days) / r.scheduled_days) * 1000) / 10
      : null,
  }));

  const totals = rows.reduce((acc, r) => {
    for (const k of ['scheduled_days', 'worked_days', 'absent_days', 'leave_days',
                     'paid_minutes', 'late_count', 'late_minutes', 'overtime_minutes',
                     'missing_checkout', 'flagged_days']) {
      acc[k] += (r as unknown as Record<string, number>)[k];
    }
    return acc;
  }, { scheduled_days: 0, worked_days: 0, absent_days: 0, leave_days: 0, paid_minutes: 0,
       late_count: 0, late_minutes: 0, overtime_minutes: 0, missing_checkout: 0, flagged_days: 0 } as Record<string, number>);
  totals.employees = rows.length;
  totals.paid_hours = Math.round((totals.paid_minutes / 60) * 100) / 100;

  return { from, to, generated_at: T.nowIso(), rows, totals };
}

/** Per-project totals for the same window - useful for client billing. */
export async function byProject(
  { from, to }: { from: string; to: string },
): Promise<Record<string, unknown>[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT p.id, p.code, p.name, p.client,
            count(a.id) AS records,
            count(DISTINCT a.user_id) AS employees,
            coalesce(sum(a.worked_minutes), 0) AS paid_minutes,
            coalesce(sum(a.overtime_minutes), 0) AS overtime_minutes
       FROM projects p
       LEFT JOIN attendance a ON a.project_id = p.id AND a.work_date BETWEEN ? AND ?
      GROUP BY p.id
      ORDER BY paid_minutes DESC, p.name`,
    from, to,
  );
  // PORT NOTE: the SQL is verbatim. Postgres types count() and sum() as bigint
  // and the driver returns bigint as a JS string, so records/employees/
  // paid_minutes/overtime_minutes arrived as "1" instead of 1 and the JSON body
  // would have changed shape. Number() restores the SQLite result exactly; the
  // key order is preserved because overwriting a spread key keeps its position,
  // and paid_hours uses the identical rounding expression.
  return rows.map((r) => ({
    ...r,
    records: Number(r.records),
    employees: Number(r.employees),
    paid_minutes: Number(r.paid_minutes),
    overtime_minutes: Number(r.overtime_minutes),
    paid_hours: Math.round((Number(r.paid_minutes) / 60) * 100) / 100,
  }));
}
