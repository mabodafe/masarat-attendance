// Verifies the OWNER'S REQUEST of 2026-08-18:
//
//   "any employee enable to re check-in in the same shift (if he check-out and
//    back to continue his work) it must continue calculating the shift hours"
//
// Before this feature, checking in a second time for the same user/day/shift
// was refused with `already_recorded`, so a lunch break or a quick errand mid-
// shift meant the employee's second session was simply never recorded. This
// suite proves:
//   1. check out, then check back in on the SAME shift/day -> ACCEPTED, not
//      `already_recorded`, and the attendance row goes back to `open`.
//   2. late_minutes stays pinned to the FIRST check-in of the day; it is not
//      recomputed (and not zeroed) on the second check-in.
//   3. checking out too soon after the SECOND check-in is refused exactly
//      like it is after the first — the "too soon" guard follows the current
//      session, not the shift's original check-in time from hours earlier.
//   4. the final worked_minutes is the SUM of both sessions' own time, minus
//      the shift's unpaid break exactly once — not the wall-clock gap from
//      first check-in to last check-out, which would wrongly pay the break
//      between sessions.
//   5. attendance_sessions holds one row per session, in order, each with its
//      own check-in/out.
//   6. an AUTO-CLOSED record (the employee never checked out and the system
//      closed it) is NOT silently reopened by a later check-in — that still
//      needs an admin's eyes, exactly as `already_recorded` always meant.
import { applySchema, all, close, get, run } from '../api/db.ts';

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${cond ? '' : '  ' + JSON.stringify(extra)}`);
  cond ? pass++ : fail++;
};
const section = (n: string) => console.log(`\n${n}`);

const AT = await import('../api/lib/attendance.ts');
const T = await import('../api/lib/time.ts');
const ME = await import('../api/routes/me.ts');

await applySchema(await Deno.readTextFile(new URL('../db/schema.postgres.sql', import.meta.url)));
await run(`TRUNCATE attendance_sessions, attendance, punch_log, leave_requests, schedules,
                   project_members, projects, shifts, holidays, login_attempts, users
           RESTART IDENTITY CASCADE`);

const now = T.nowIso();
const today = T.local().date;

await run(
  `INSERT INTO users (employee_code, full_name, email, role, password_hash, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?)`,
  'EMP-100', 'Multi Session Tester', 'mst@masarat.local', 'employee', 'x', now, now,
);
await run(
  `INSERT INTO projects (code,name,lat,lng,radius_m,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
  'SITE-MS', 'Session Test Site', 24.71355, 46.67529, 150, now, now,
);
// A shift open all day (so this test never depends on wall time), with a
// 30-minute unpaid break, so the "deducted once, not per session" check has
// something to actually deduct.
await run(
  `INSERT INTO shifts (code,name,start_time,end_time,grace_in_min,early_in_min,break_min)
   VALUES (?,?,?,?,?,?,?)`,
  'ALLDAY-MS', 'All day', '00:01', '23:59', 15, 60, 30,
);
await run(
  `INSERT INTO schedules (user_id, work_date, shift_id, status, created_at) VALUES (?,?,?,?,?)`,
  1, today, 1, 'work', now,
);

const user = { id: 1 };
const fix = () => ({ lat: 24.71355, lng: 46.67529, accuracy: 12, captured_at: new Date().toISOString() });
const backdate = async (table: string, extraWhere: string, minutesAgo: number) => {
  await run(`UPDATE ${table} SET check_in_at = ? WHERE ${extraWhere}`,
    new Date(Date.now() - minutesAgo * 60_000).toISOString());
};

section('Session 1: check in, then out');
let attendanceId: number;
{
  const ci = await AT.checkIn({ user, projectId: 1, fix: fix(), userAgent: 'test', ip: '203.0.113.7' });
  ok('first check-in is accepted', ci.ok === true, ci);
  attendanceId = ci.attendance_id as number;

  const rows = await all<Record<string, unknown>>('SELECT * FROM attendance_sessions WHERE attendance_id = ? ORDER BY seq', attendanceId);
  ok('exactly one session row exists after the first check-in', rows.length === 1, rows.length);
  ok('session 1 has no check-out yet', rows[0]?.check_out_at == null, rows[0]);

  const tooSoon = await AT.checkOut({ user, projectId: 1, fix: fix() });
  ok('checking out immediately is refused as too_soon', tooSoon.ok === false && tooSoon.code === 'too_soon', tooSoon);

  // Backdate BOTH the attendance row and its session 1, exactly like the
  // main suite's single-session test does — session 1's own check_in_at is
  // now what the "too soon" guard and this session's own minutes are judged
  // against.
  await backdate('attendance', `id = ${attendanceId}`, 120);
  await backdate('attendance_sessions', `attendance_id = ${attendanceId} AND seq = 1`, 120);

  const co = await AT.checkOut({ user, projectId: 1, fix: fix(), note: 'lunch break' });
  ok('first check-out is accepted', co.ok === true, co);
  // Session 1 is ~120 minutes gross, minus the shift's 30-minute break,
  // deducted the moment there is a checkout to deduct it from — 90.
  ok('worked time after session 1 is gross minus the break (120 - 30)',
    Math.abs((co.worked_minutes as number) - 90) <= 2, co.worked_minutes);

  const rec = await get<Record<string, unknown>>('SELECT * FROM attendance WHERE id = ?', attendanceId);
  ok('the attendance row is closed', rec!.status === 'closed', rec!.status);
  ok('late_minutes was recorded on the first check-in', typeof rec!.late_minutes === 'number');
}

section('Re-check-in on the SAME shift/day: continue, do not restart');
const originalLate = (await get<Record<string, unknown>>('SELECT late_minutes FROM attendance WHERE id = ?', attendanceId))!.late_minutes;
{
  const ci2 = await AT.checkIn({ user, projectId: 1, fix: fix(), userAgent: 'test', ip: '203.0.113.7' });
  ok('re-check-in after checkout is ACCEPTED, not already_recorded', ci2.ok === true && ci2.code !== 'already_recorded', ci2);
  ok('the response says this is a resumed session', ci2.resumed === true, ci2);
  ok('late_minutes is unchanged from the very first check-in', ci2.late_minutes === originalLate, [ci2.late_minutes, originalLate]);
  ok('the SAME attendance row is reused, not a new one', ci2.attendance_id === attendanceId, ci2.attendance_id);

  const rec = await get<Record<string, unknown>>('SELECT * FROM attendance WHERE id = ?', attendanceId);
  ok('the attendance row is open again', rec!.status === 'open', rec!.status);

  const dup = await AT.checkIn({ user, projectId: 1, fix: fix() });
  ok('a THIRD check-in while already open is still refused (unchanged guard)', dup.ok === false && dup.code === 'already_open', dup);

  const sessions = await all<Record<string, unknown>>(
    'SELECT * FROM attendance_sessions WHERE attendance_id = ? ORDER BY seq', attendanceId);
  ok('a second session row was created', sessions.length === 2, sessions.length);
  ok('session 2 has no check-out yet', sessions[1]?.check_out_at == null, sessions[1]);

  const tooSoon2 = await AT.checkOut({ user, projectId: 1, fix: fix() });
  ok('checking out immediately after the SECOND check-in is also too_soon',
    tooSoon2.ok === false && tooSoon2.code === 'too_soon', tooSoon2);

  await backdate('attendance_sessions', `attendance_id = ${attendanceId} AND seq = 2`, 60);

  const co2 = await AT.checkOut({ user, projectId: 1, fix: fix(), note: 'end of day' });
  ok('second check-out is accepted', co2.ok === true, co2);
  // Session 1 ~120 min + session 2 ~60 min = ~180 min gross, minus the
  // shift's one 30-minute break, applied ONCE across both sessions -> ~150.
  ok('worked_minutes sums both sessions and deducts the break only once',
    Math.abs((co2.worked_minutes as number) - 150) <= 2, co2.worked_minutes);

  const finalSessions = await all<Record<string, unknown>>(
    'SELECT * FROM attendance_sessions WHERE attendance_id = ? ORDER BY seq', attendanceId);
  ok('both sessions are now closed', finalSessions.every((s) => s.check_out_at != null), finalSessions);
  ok('session 1 kept its own ~120-minute duration', Math.abs((finalSessions[0].worked_minutes as number) - 120) <= 2, finalSessions[0].worked_minutes);
  ok('session 2 kept its own ~60-minute duration', Math.abs((finalSessions[1].worked_minutes as number) - 60) <= 2, finalSessions[1].worked_minutes);
}

section('The admin/employee report merges into one daily total, sessions listed underneath');
{
  // This is the owner's explicit choice for how multi-session days should
  // read in a report: one row with the day's total, and the individual
  // check-in/out pairs available underneath it — not one row per session.
  const raw = (await all<Record<string, unknown>>('SELECT * FROM attendance WHERE id = ?', attendanceId));
  const shaped = raw.map(ME.shapeAttendance);
  ok('shapeAttendance still returns exactly one row for the whole day', shaped.length === 1, shaped.length);

  const withSessions = await ME.attachSessions(shaped);
  const day = withSessions[0] as unknown as { worked_minutes: number; sessions: Array<Record<string, unknown>> };
  ok('the one row carries the FULL day total, not just the last session',
    Math.abs(day.worked_minutes - 150) <= 2, day.worked_minutes);
  ok('its sessions array lists both check-in/out pairs, in order',
    day.sessions.length === 2 && day.sessions[0].seq === 1 && day.sessions[1].seq === 2, day.sessions);
  ok('each listed session has its own worked_minutes',
    Math.abs((day.sessions[0].worked_minutes as number) - 120) <= 2 &&
    Math.abs((day.sessions[1].worked_minutes as number) - 60) <= 2,
    day.sessions);
}

section('An auto-closed record is NOT silently reopened by a later check-in');
{
  // Force the just-closed record into auto_closed, the way the missed-
  // checkout sweep would, and prove a fresh check-in still refuses it —
  // that case still needs an admin's eyes, exactly as before this feature.
  await run("UPDATE attendance SET status = 'auto_closed' WHERE id = ?", attendanceId);
  const blocked = await AT.checkIn({ user, projectId: 1, fix: fix() });
  ok('check-in against an auto_closed record for the same shift/day is refused',
    blocked.ok === false && blocked.code === 'already_recorded', blocked);
}

console.log(`\nPASS: ${pass}   FAIL: ${fail}`);
await close();
if (fail) Deno.exit(1);
