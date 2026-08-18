// Ported from server/routes/me.js — express Router -> Hono.
//
// Same mapping as routes/auth.ts:
//   router.use(requireAuth)          -> meRoutes.use('*', A.requireAuth)
//   router.get('/x', h)              -> meRoutes.get('/x', h)
//   req.body?.field                  -> body(c).field
//   res.status(n).json(o)            -> c.json(o, n)
//   req.user                         -> c.get('user')
//   req.query.foo                    -> c.req.query('foo')
//   req.params.id                    -> c.req.param('id')
//   req.ip                           -> clientIp(c)
//   req.headers['user-agent']        -> c.req.header('user-agent')
// Every route path string, response body, status code and field name is
// byte-identical to the original.
//
// The only structural differences are platform-forced:
//   1. `await` on every db call and on every AT.* / LEAVE.* helper, because the
//      data layer is async now.
//   2. buildCalendar() became async (it runs three queries). shapeAttendance()
//      and shapeLeave() are pure and stay synchronous.
//   3. The inline `require('../lib/geo')` inside GET /projects became a
//      top-level ESM import — Deno has no synchronous require().
import { Hono } from 'npm:hono@4.6.14';
import { all, get } from '../db.ts';
import * as A from '../lib/auth.ts';
import { clientIp } from '../lib/auth.ts';
import type { SessionUser } from '../lib/auth.ts';
import * as T from '../lib/time.ts';
import * as AT from '../lib/attendance.ts';
import * as LEAVE from '../lib/leave.ts';
import config from '../config.ts';
// PORT NOTE: the original did `require('../lib/geo')` inside the GET /projects
// handler. Deno has no synchronous require(), so it is a static import here.
// Same functions, same behaviour.
import { distanceMeters, isValidCoord } from '../lib/geo.ts';

import type { Context } from 'npm:hono@4.6.14';

// Copied verbatim from routes/auth.ts.
const body = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
  try {
    const b = await c.req.json();
    return (b && typeof b === 'object') ? b as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export const meRoutes = new Hono<{ Variables: { user: SessionUser } }>();
meRoutes.use('*', A.requireAuth);

// PORT NOTE: req.headers['user-agent'] -> c.req.header('user-agent'); the
// String(... || '').slice(0, 300) wrapper is kept so the stored value is
// identical (undefined still becomes ''). req.ip -> clientIp(c), which returns
// 'unknown' rather than undefined when no client address can be determined.
// Both fields feed the punch_log audit trail.
const clientMeta = (c: Context) => ({
  userAgent: String(c.req.header('user-agent') || '').slice(0, 300),
  ip: clientIp(c),
});

function readFix(body: Record<string, unknown> | undefined) {
  return {
    lat: Number(body?.lat),
    lng: Number(body?.lng),
    accuracy: body?.accuracy == null ? null : Number(body.accuracy),
    captured_at: (body?.captured_at || null) as string | null,
    mocked: !!body?.mocked,
  };
}

/** Sites the employee may punch into, with live distance if a fix is supplied. */
meRoutes.get('/projects', async (c) => {
  const user = c.get('user') as SessionUser;
  const lat = Number(c.req.query('lat'));
  const lng = Number(c.req.query('lng'));
  const hasFix = isValidCoord(lat, lng);

  const rows = (await AT.projectsForUser(user.id)).map((p) => ({
    id: p.id, code: p.code, name: p.name, client: (p as unknown as Record<string, unknown>).client, address: (p as unknown as Record<string, unknown>).address,
    lat: p.lat, lng: p.lng, radius_m: p.radius_m,
    distance_m: hasFix ? distanceMeters(lat, lng, p.lat, p.lng) : null,
  }));
  if (hasFix) rows.sort((a, b) => (a.distance_m as number) - (b.distance_m as number));
  return c.json({ projects: rows });
});

/** Everything the check-in screen needs in one call. */
meRoutes.get('/status', async (c) => {
  const user = c.get('user') as SessionUser;
  const nowIso = T.nowIso();
  const openRec = await AT.openRecord(user.id);
  const target = await AT.resolvePunchTarget(user.id, nowIso);
  const localNow = T.local(nowIso);
  // Per-employee override, set by an admin. NULL — the default for every
  // existing employee — falls back to the app-wide SELFIE_MODE setting, so
  // this reports exactly what it always did unless an admin changed it.
  const photoPref = await get<{ photo_policy: string | null }>(
    'SELECT photo_policy FROM users WHERE id = ?', user.id,
  );

  const todaySchedule = await get<Record<string, unknown>>(
    `SELECT s.*, sh.name AS shift_name, sh.start_time, sh.end_time,
            p.name AS project_name
       FROM schedules s
       LEFT JOIN shifts sh ON sh.id = s.shift_id
       LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.user_id = ? AND s.work_date = ?`,
    user.id, localNow.date,
  );

  let nextWindow = null;
  if (!target.ok && target.upcoming) {
    const u = target.upcoming;
    nextWindow = {
      shift_name: u.shift.name,
      work_date: u.workDate,
      opens_at_local: `${T.local(u.openAt).date} ${T.local(u.openAt).hhmm}`,
      starts_at_local: `${T.local(u.startAt).date} ${T.local(u.startAt).hhmm}`,
    };
  }

  return c.json({
    server_time: nowIso,
    local_date: localNow.date,
    local_time: localNow.hhmm,
    tz: { offset_min: config.tzOffsetMin, label: config.tzLabel },
    location_rules: {
      max_accuracy_m: config.maxAccuracyM,
      max_fix_age_sec: config.maxFixAgeSec,
      selfie_mode: photoPref?.photo_policy || config.selfieMode,
    },
    can_check_in: !openRec && target.ok,
    can_check_out: !!openRec,
    reason: target.ok ? null : target.reason,
    shift_window: target.ok
      ? {
          shift_id: target.window!.shift.id,
          shift_name: target.window!.shift.name,
          work_date: target.window!.workDate,
          start_local: target.window!.shift.start_time,
          end_local: target.window!.shift.end_time,
          from_schedule: target.window!.fromSchedule,
          late_after_local: `${T.local(target.window!.lateAt).hhmm}`,
        }
      : null,
    next_window: nextWindow,
    today_schedule: todaySchedule
      ? {
          status: todaySchedule.status,
          shift_name: todaySchedule.shift_name,
          start_time: todaySchedule.start_time,
          end_time: todaySchedule.end_time,
          project_name: todaySchedule.project_name,
          note: todaySchedule.note,
        }
      : null,
    open_record: openRec
      ? {
          id: openRec.id,
          work_date: openRec.work_date,
          project_id: openRec.project_id,
          project_name: openRec.project_name,
          shift_name: openRec.shift_name,
          check_in_at: openRec.check_in_at,
          check_in_local: T.local(openRec.check_in_at as string).hhmm,
          elapsed_minutes: T.minutesBetween(openRec.check_in_at as string, nowIso),
          late_minutes: openRec.late_minutes,
        }
      : null,
  });
});

meRoutes.post('/check-in', async (c) => {
  const user = c.get('user') as SessionUser;
  const b = await body(c);
  const out = await AT.checkIn({
    user: user as unknown as { id: number },
    projectId: Number(b?.project_id),
    fix: readFix(b),
    note: b?.note ? String(b.note).slice(0, 500) : null,
    photo: b?.photo || null,
    ...clientMeta(c),
  });
  return c.json(out, out.ok ? 200 : 400);
});

meRoutes.post('/check-out', async (c) => {
  const user = c.get('user') as SessionUser;
  const b = await body(c);
  const out = await AT.checkOut({
    user: user as unknown as { id: number },
    projectId: b?.project_id ? Number(b.project_id) : null,
    fix: readFix(b),
    note: b?.note ? String(b.note).slice(0, 500) : null,
    photo: b?.photo || null,
    ...clientMeta(c),
  });
  return c.json(out, out.ok ? 200 : 400);
});

// ------------------------------------------------------------- leave requests

meRoutes.get('/leave', async (c) => {
  const user = c.get('user') as SessionUser;
  return c.json({
    types: LEAVE.TYPES,
    requests: (await LEAVE.list({ userId: user.id })).map(shapeLeave),
  });
});

meRoutes.post('/leave', async (c) => {
  const user = c.get('user') as SessionUser;
  const b = await body(c);
  const out = await LEAVE.create({
    userId: user.id,
    leaveType: String(b?.leave_type || 'annual'),
    from: String(b?.from_date || ''),
    to: String(b?.to_date || ''),
    reason: b?.reason,
  });
  return c.json(out, out.ok ? 201 : 400);
});

meRoutes.post('/leave/:id/cancel', async (c) => {
  const user = c.get('user') as SessionUser;
  const out = await LEAVE.cancel({ requestId: Number(c.req.param('id')), userId: user.id });
  return c.json(out, out.ok ? 200 : 400);
});

export function shapeLeave(l: Record<string, unknown>) {
  return {
    id: l.id, leave_type: l.leave_type, from_date: l.from_date, to_date: l.to_date,
    days: l.days, reason: l.reason, status: l.status,
    decided_by_name: l.decided_by_name, decision_note: l.decision_note,
    decided_at: l.decided_at ? `${T.local(l.decided_at as string).date} ${T.local(l.decided_at as string).hhmm}` : null,
    created_at: `${T.local(l.created_at as string).date} ${T.local(l.created_at as string).hhmm}`,
    full_name: l.full_name, employee_code: l.employee_code, user_id: l.user_id,
  };
}

/** Working calendar: roster + what actually happened, merged per day. */
meRoutes.get('/calendar', async (c) => {
  const user = c.get('user') as SessionUser;
  const today = T.local().date;
  const from = T.isYmd(c.req.query('from')) ? c.req.query('from') as string : `${today.slice(0, 7)}-01`;
  const to = T.isYmd(c.req.query('to')) ? c.req.query('to') as string : T.addDays(from, 41);
  return c.json({ from, to, days: await buildCalendar(user.id, from, to) });
});

meRoutes.get('/attendance', async (c) => {
  const user = c.get('user') as SessionUser;
  const today = T.local().date;
  const from = T.isYmd(c.req.query('from')) ? c.req.query('from') as string : `${today.slice(0, 7)}-01`;
  const to = T.isYmd(c.req.query('to')) ? c.req.query('to') as string : today;
  const rows = await attachSessions((await all<Record<string, unknown>>(
    `SELECT a.*, p.name AS project_name, sh.name AS shift_name
       FROM attendance a
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN shifts sh ON sh.id = a.shift_id
      WHERE a.user_id = ? AND a.work_date BETWEEN ? AND ?
      ORDER BY a.work_date DESC, a.check_in_at DESC`,
    user.id, from, to,
  )).map(shapeAttendance));

  const totals = rows.reduce(
    (acc, r) => {
      acc.days += 1;
      acc.worked_minutes += (r.worked_minutes as number) || 0;
      acc.late_minutes += (r.late_minutes as number) || 0;
      acc.overtime_minutes += (r.overtime_minutes as number) || 0;
      return acc;
    },
    { days: 0, worked_minutes: 0, late_minutes: 0, overtime_minutes: 0 },
  );
  return c.json({ from, to, totals, records: rows });
});

export function shapeAttendance(a: Record<string, unknown>) {
  return {
    id: a.id,
    work_date: a.work_date,
    project_name: a.project_name,
    shift_name: a.shift_name,
    check_in_at: a.check_in_at,
    check_in_local: T.local(a.check_in_at as string).hhmm,
    check_out_at: a.check_out_at,
    check_out_local: a.check_out_at ? T.local(a.check_out_at as string).hhmm : null,
    worked_minutes: a.worked_minutes,
    late_minutes: a.late_minutes,
    early_out_minutes: a.early_out_minutes,
    overtime_minutes: a.overtime_minutes,
    check_in_distance_m: a.check_in_distance_m,
    check_out_distance_m: a.check_out_distance_m,
    check_in_accuracy: a.check_in_accuracy,
    status: a.status,
    has_in_photo: !!a.check_in_photo,
    has_out_photo: !!a.check_out_photo,
    flags: JSON.parse((a.flags as string) || '[]'),
    sessions: undefined as unknown, // filled in by attachSessions(), when the caller wants it
  };
}

// NEW (not part of the original SQLite app): the admin's owner chose "merge
// into one daily total, sessions listed underneath" for the multi-session
// check-in/out feature — this fills that in. Mutates each shaped record's
// `sessions` array in place with one entry per check-in/out pair, in order,
// and returns the same array for convenience. A record with exactly one
// session (the common case, unchanged from before this feature) still gets
// a one-item sessions array, so the admin UI can render the same way either way.
export async function attachSessions<T extends { id: unknown; sessions: unknown }>(records: T[]): Promise<T[]> {
  const ids = records.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
  if (!ids.length) return records;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await all<Record<string, unknown>>(
    `SELECT * FROM attendance_sessions WHERE attendance_id IN (${placeholders}) ORDER BY attendance_id, seq`,
    ...ids,
  );
  const byAttendance = new Map<number, Record<string, unknown>[]>();
  for (const s of rows) {
    const key = Number(s.attendance_id);
    const shaped = {
      seq: s.seq,
      check_in_at: s.check_in_at,
      check_in_local: T.local(s.check_in_at as string).hhmm,
      check_out_at: s.check_out_at,
      check_out_local: s.check_out_at ? T.local(s.check_out_at as string).hhmm : null,
      worked_minutes: s.worked_minutes,
      note: s.check_in_note || s.check_out_note || null,
    };
    if (!byAttendance.has(key)) byAttendance.set(key, []);
    byAttendance.get(key)!.push(shaped);
  }
  for (const r of records) (r as unknown as { sessions: unknown }).sessions = byAttendance.get(Number(r.id)) || [];
  return records;
}

// PORT NOTE: buildCalendar became async — it runs three queries and the data
// layer is async now. routes/admin.ts must `await buildCalendar(...)`.
// Its arguments and its returned array of day objects are unchanged.
export async function buildCalendar(userId: number, from: string, to: string) {
  const dates = T.dateRange(from, to);
  const scheduleRows = await all<Record<string, unknown>>(
    `SELECT s.*, sh.name AS shift_name, sh.code AS shift_code,
            sh.start_time, sh.end_time, p.name AS project_name
       FROM schedules s
       LEFT JOIN shifts sh ON sh.id = s.shift_id
       LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.user_id = ? AND s.work_date BETWEEN ? AND ?`,
    userId, from, to,
  );
  const attRows = await all<Record<string, unknown>>(
    `SELECT a.*, p.name AS project_name, sh.name AS shift_name
       FROM attendance a
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN shifts sh ON sh.id = a.shift_id
      WHERE a.user_id = ? AND a.work_date BETWEEN ? AND ?`,
    userId, from, to,
  );
  const holidays = await all<Record<string, unknown>>(
    'SELECT * FROM holidays WHERE holiday_date BETWEEN ? AND ?', from, to);

  const byDate = new Map<string, {
    date: string;
    schedule: Record<string, unknown> | null;
    attendance: Record<string, unknown> | null;
    holiday: unknown;
  }>(dates.map((d) => [d, {
    date: d, schedule: null, attendance: null, holiday: null,
  }]));
  for (const s of scheduleRows) {
    const day = byDate.get(s.work_date as string);
    if (day) day.schedule = {
      status: s.status, shift_id: s.shift_id, shift_name: s.shift_name, shift_code: s.shift_code,
      start_time: s.start_time, end_time: s.end_time,
      project_id: s.project_id, project_name: s.project_name, note: s.note,
    };
  }
  for (const a of attRows) {
    const day = byDate.get(a.work_date as string);
    if (day) day.attendance = shapeAttendance(a);
  }
  for (const h of holidays) {
    const day = byDate.get(h.holiday_date as string);
    if (day) day.holiday = h.name;
  }
  return [...byDate.values()];
}

export default meRoutes;
