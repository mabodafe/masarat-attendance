// Ported from server/lib/attendance.js — the payroll-critical file.
//
// This decides whether a punch is accepted, which calendar day it belongs to, and
// how many minutes get paid. The logic is UNCHANGED line for line; only the three
// things below differ, each forced by the platform:
//
//   1. `await` on every database call (node:sqlite was synchronous).
//   2. `shift_id IS ?`  ->  `shift_id IS NOT DISTINCT FROM ?`
//      SQLite's `IS` doubles as a null-safe equality operator with a bound
//      parameter. Postgres does NOT allow that — `IS` only accepts NULL/TRUE/FALSE
//      literals, so the original query is a syntax error there. IS NOT DISTINCT
//      FROM is the exact Postgres equivalent, including when shift_id is NULL.
//   3. lastInsertRowid -> `RETURNING id`.
//
// Everything else — every threshold, every flag name, every message string — is
// byte-identical to the version that passes the 122-check suite.
import config from '../config.ts';
import { all, get, run } from '../db.ts';
import * as T from './time.ts';
import { distanceMeters, isValidCoord } from './geo.ts';
import { savePunchPhoto } from './photos.ts';

export interface Shift {
  id: number;
  code: string;
  name: string;
  start_time: string;
  end_time: string;
  crosses_midnight: number;
  grace_in_min: number;
  grace_out_min: number;
  early_in_min: number;
  break_min: number;
  active: number;
}

export interface ShiftWindow {
  workDate: string;
  shift: Shift;
  crosses: number;
  openAt: Date;
  startAt: Date;
  lateAt: Date;
  endAt: Date;
  closeAt: Date;
  schedule?: Record<string, unknown> | null;
  fromSchedule?: boolean;
  holiday?: string | null;
}

/**
 * Absolute UTC boundaries of one shift occurrence.
 *   openAt  - earliest a check-in is accepted
 *   startAt - scheduled start
 *   lateAt  - start + grace, anything after counts as late
 *   endAt   - scheduled end (next local day when the shift crosses midnight)
 *   closeAt - latest a check-out is accepted before the record is auto-closed
 */
export function shiftWindow(shift: Shift, workDate: string): ShiftWindow {
  const startMin = T.hhmmToMin(shift.start_time)!;
  const endMin = T.hhmmToMin(shift.end_time)!;
  const crosses = shift.crosses_midnight ? 1 : endMin <= startMin ? 1 : 0;
  const startAt = T.localToUtc(workDate, startMin);
  const endAt = T.localToUtc(crosses ? T.addDays(workDate, 1) : workDate, endMin);
  return {
    workDate,
    shift,
    crosses,
    openAt: new Date(startAt.getTime() - shift.early_in_min * T.MS_MIN),
    startAt,
    lateAt: new Date(startAt.getTime() + shift.grace_in_min * T.MS_MIN),
    endAt,
    closeAt: new Date(endAt.getTime() + 8 * 60 * T.MS_MIN), // 8h overtime ceiling
  };
}

export function activeShifts(): Promise<Shift[]> {
  return all<Shift>('SELECT * FROM shifts WHERE active = 1 ORDER BY start_time');
}

export interface PunchTarget {
  ok: boolean;
  window?: ShiftWindow;
  reason?: string;
  upcoming?: ShiftWindow | null;
  candidates?: ShiftWindow[];
}

/**
 * Which shift occurrence is this employee punching into right now?
 * Looks at yesterday and today so night shifts that cross midnight resolve to
 * the calendar day they *started* on.
 */
export async function resolvePunchTarget(userId: number, nowIso: string = T.nowIso()): Promise<PunchTarget> {
  const now = new Date(nowIso);
  const today = T.local(now).date;
  const dates = [T.addDays(today, -1), today];

  const scheduled = await all<Record<string, unknown>>(
    `SELECT s.*, sh.id AS sh_id
       FROM schedules s
       JOIN shifts sh ON sh.id = s.shift_id
      WHERE s.user_id = ? AND s.work_date IN (?, ?) AND s.status = 'work'`,
    userId,
    dates[0],
    dates[1],
  );

  const candidates: ShiftWindow[] = [];
  for (const sc of scheduled) {
    const shift = await get<Shift>('SELECT * FROM shifts WHERE id = ?', sc.shift_id);
    if (!shift) continue;
    const w = shiftWindow(shift, sc.work_date as string);
    w.schedule = sc;
    w.fromSchedule = true;
    candidates.push(w);
  }

  // No roster entry: fall back to any active shift whose window is open now, so
  // ad-hoc site work still gets recorded (flagged for the admin to confirm).
  if (candidates.length === 0) {
    const holiday = await get<{ name: string }>('SELECT * FROM holidays WHERE holiday_date = ?', today);
    for (const shift of await activeShifts()) {
      for (const d of dates) {
        const w = shiftWindow(shift, d);
        w.schedule = null;
        w.fromSchedule = false;
        w.holiday = holiday ? holiday.name : null;
        candidates.push(w);
      }
    }
  }

  const open = candidates.filter((w) => now >= w.openAt && now <= w.endAt);
  if (open.length === 0) {
    let upcoming = candidates
      .filter((w) => w.openAt > now)
      .sort((a, b) => a.openAt.getTime() - b.openAt.getTime())[0];
    // Nothing left today: look ahead to the employee's next rostered working day
    // so the app can answer "when can I check in?" instead of just refusing.
    if (!upcoming) upcoming = (await nextRosteredWindow(userId, today)) as ShiftWindow;
    return { ok: false, reason: 'outside_shift_window', upcoming: upcoming || null, candidates };
  }
  // Closest scheduled start wins when two windows overlap.
  open.sort((a, b) =>
    Math.abs(now.getTime() - a.startAt.getTime()) - Math.abs(now.getTime() - b.startAt.getTime()));
  return { ok: true, window: open[0] };
}

/** The next rostered working shift strictly after `afterDate`, if there is one. */
export async function nextRosteredWindow(userId: number, afterDate: string): Promise<ShiftWindow | null> {
  const row = await get<{ work_date: string; shift_id: number }>(
    `SELECT s.work_date, s.shift_id
       FROM schedules s
       JOIN shifts sh ON sh.id = s.shift_id AND sh.active = 1
      WHERE s.user_id = ? AND s.status = 'work' AND s.work_date > ?
      ORDER BY s.work_date LIMIT 1`,
    userId,
    afterDate,
  );
  if (!row) return null;
  const shift = await get<Shift>('SELECT * FROM shifts WHERE id = ?', row.shift_id);
  if (!shift) return null;
  const w = shiftWindow(shift, row.work_date);
  w.schedule = row as unknown as Record<string, unknown>;
  w.fromSchedule = true;
  return w;
}

/** The employee's currently-open attendance record, if any. */
export function openRecord(userId: number): Promise<Record<string, unknown> | null> {
  return get<Record<string, unknown>>(
    `SELECT a.*, p.name AS project_name, p.code AS project_code,
            sh.name AS shift_name, sh.start_time, sh.end_time, sh.break_min,
            sh.grace_out_min, sh.crosses_midnight
       FROM attendance a
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN shifts sh ON sh.id = a.shift_id
      WHERE a.user_id = ? AND a.status = 'open'
      ORDER BY a.check_in_at DESC LIMIT 1`,
    userId,
  );
}

interface PunchLogRecord {
  user_id: number;
  kind: string;
  outcome: string;
  reason?: string | null;
  project_id?: number | null;
  lat?: unknown;
  lng?: unknown;
  accuracy?: unknown;
  distance_m?: number | null;
  device_time?: string | null;
  server_time: string;
  user_agent?: string | null;
  ip?: string | null;
}

async function logPunch(rec: PunchLogRecord): Promise<void> {
  await run(
    `INSERT INTO punch_log
       (user_id, kind, outcome, reason, project_id, lat, lng, accuracy, distance_m,
        device_time, server_time, user_agent, ip)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    rec.user_id, rec.kind, rec.outcome, rec.reason ?? null, rec.project_id ?? null,
    rec.lat ?? null, rec.lng ?? null, rec.accuracy ?? null, rec.distance_m ?? null,
    rec.device_time ?? null, rec.server_time, rec.user_agent ?? null, rec.ip ?? null,
  );
}

export interface Fix {
  lat?: unknown;
  lng?: unknown;
  accuracy?: unknown;
  captured_at?: string | null;
  mocked?: boolean;
}

export interface Project {
  id: number;
  code: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  active: number;
}

export interface FixResult {
  ok: boolean;
  code?: string;
  error?: string;
  distance?: number;
  lat?: number;
  lng?: number;
  accuracy?: number;
  flags: string[];
}

/**
 * Validates a GPS fix against a project geofence and the trust settings.
 * Returns { ok, error?, distance, flags[] }.
 */
export function validateFix(project: Project, fix: Fix, nowIso: string): FixResult {
  const flags: string[] = [];
  const lat = Number(fix?.lat);
  const lng = Number(fix?.lng);
  const accuracy = fix?.accuracy == null ? null : Number(fix.accuracy);

  if (!isValidCoord(lat, lng)) {
    return { ok: false, code: 'bad_coords', error: 'Location reading is invalid. Turn GPS on and try again.', flags };
  }

  // A cached or replayed fix is refused outright.
  if (fix.captured_at) {
    const age = (new Date(nowIso).getTime() - new Date(fix.captured_at).getTime()) / 1000;
    if (!Number.isFinite(age)) {
      return { ok: false, code: 'bad_fix_time', error: 'Location reading has no valid timestamp.', flags };
    }
    if (age > config.maxFixAgeSec) {
      return {
        ok: false,
        code: 'stale_fix',
        error: `Location reading is ${Math.round(age)}s old. Open your GPS and refresh your location.`,
        flags,
      };
    }
    if (age < -config.maxClockSkewSec) flags.push('clock_skew');
  } else {
    return { ok: false, code: 'no_fix_time', error: 'Location reading is missing its timestamp.', flags };
  }

  if (accuracy == null || !Number.isFinite(accuracy)) {
    return { ok: false, code: 'no_accuracy', error: 'Location accuracy is unknown. Enable precise/high-accuracy GPS.', flags };
  }
  if (accuracy > config.maxAccuracyM) {
    return {
      ok: false,
      code: 'low_accuracy',
      error: `GPS accuracy is ±${Math.round(accuracy)} m (limit ±${config.maxAccuracyM} m). ` +
        `Step outside, keep GPS on, and wait for a better signal.`,
      flags,
    };
  }
  if (fix.mocked) flags.push('mock_location_suspected');

  const distance = distanceMeters(lat, lng, project.lat, project.lng);
  // The fence is widened by the reading's own error margin, so an honest fix at
  // the edge of a site is not punished for phone hardware.
  const allowed = project.radius_m + Math.min(accuracy, config.maxAccuracyM);
  if (distance > allowed) {
    if (!config.allowOutOfFenceWithFlag) {
      return {
        ok: false,
        code: 'out_of_fence',
        error: `You are ${distance} m from ${project.name}. You must be within ${project.radius_m} m of the site.`,
        distance,
        flags,
      };
    }
    flags.push('out_of_fence');
  }
  return { ok: true, distance, lat, lng, accuracy, flags };
}

/** Projects this employee is allowed to punch into. */
export async function projectsForUser(userId: number): Promise<Project[]> {
  const assigned = await all<Project>(
    `SELECT p.* FROM projects p
       JOIN project_members m ON m.project_id = p.id
      WHERE m.user_id = ? AND p.active = 1
      ORDER BY p.name`,
    userId,
  );
  if (assigned.length) return assigned;
  return await all<Project>('SELECT * FROM projects WHERE active = 1 ORDER BY name');
}

export async function canUseProject(userId: number, projectId: unknown): Promise<boolean> {
  const list = await projectsForUser(userId);
  return list.some((p) => p.id === Number(projectId));
}

/**
 * Applies the selfie policy. Returns { ok, name } or { ok: false, error }.
 * Runs only after every other check has passed, so a refused punch never leaves
 * an orphan image in the bucket.
 */
export async function handlePhoto(
  photo: unknown,
  { userId, kind }: { userId: number; kind: string },
): Promise<{ ok: boolean; name?: string | null; code?: string; error?: string }> {
  if (config.selfieMode === 'off') return { ok: true, name: null };
  if (!photo) {
    if (config.selfieMode === 'required') {
      return { ok: false, code: 'photo_required', error: 'A photo is required. Allow camera access and take the photo.' };
    }
    return { ok: true, name: null };
  }
  const saved = await savePunchPhoto(photo, { userId, kind });
  if (saved.error) return { ok: false, code: 'bad_photo', error: saved.error };
  return { ok: true, name: saved.name };
}

export interface PunchInput {
  user: { id: number };
  projectId?: unknown;
  fix?: Fix;
  note?: string | null;
  photo?: unknown;
  userAgent?: string | null;
  ip?: string | null;
}

export async function checkIn(
  { user, projectId, fix, note, photo, userAgent, ip }: PunchInput,
): Promise<Record<string, unknown>> {
  const nowIso = T.nowIso();
  const project = await get<Project>('SELECT * FROM projects WHERE id = ? AND active = 1', projectId);
  const base = {
    user_id: user.id,
    kind: 'in',
    project_id: (projectId ?? null) as number | null,
    lat: fix?.lat,
    lng: fix?.lng,
    accuracy: fix?.accuracy,
    device_time: fix?.captured_at ?? null,
    server_time: nowIso,
    user_agent: userAgent ?? null,
    ip: ip ?? null,
  };

  const reject = async (code: string, error: string, distance?: number) => {
    await logPunch({ ...base, outcome: 'rejected', reason: code, distance_m: distance ?? null });
    return { ok: false, code, error };
  };

  if (!project) return await reject('unknown_project', 'Select a valid project or site.');
  if (!(await canUseProject(user.id, project.id))) {
    return await reject('project_not_assigned', 'You are not assigned to this project. Ask your admin.');
  }
  if (await openRecord(user.id)) {
    return await reject('already_open', 'You are already checked in. Check out first.');
  }

  const target = await resolvePunchTarget(user.id, nowIso);
  if (!target.ok) {
    const up = target.upcoming;
    const msg = up
      ? `No shift is open right now. Your next shift (${up.shift.name}) opens for check-in at ` +
        `${T.local(up.openAt).hhmm} on ${T.local(up.openAt).date}.`
      : 'No shift is open right now. Ask your admin to add you to the working calendar.';
    return await reject('outside_shift_window', msg);
  }
  const w = target.window!;

  const v = validateFix(project, fix ?? {}, nowIso);
  if (!v.ok) return await reject(v.code!, v.error!, v.distance);

  const flags = new Set(v.flags);
  if (!w.fromSchedule) flags.add('no_schedule');
  if (w.holiday) flags.add('holiday_work');
  const schedProject = w.schedule?.project_id as number | undefined;
  if (schedProject && schedProject !== project.id) flags.add('site_differs_from_roster');

  const now = new Date(nowIso);
  const lateMinutes = Math.max(0, Math.round((now.getTime() - w.lateAt.getTime()) / T.MS_MIN));
  if (lateMinutes > 0) flags.add('late');

  // SQLite allowed `shift_id IS ?` as null-safe equality. Postgres requires
  // IS NOT DISTINCT FROM — same semantics, including a NULL shift_id.
  const existing = await get<{ id: number }>(
    'SELECT id FROM attendance WHERE user_id = ? AND work_date = ? AND shift_id IS NOT DISTINCT FROM ?',
    user.id,
    w.workDate,
    w.shift.id,
  );
  if (existing) {
    return await reject('already_recorded', 'This shift is already recorded for today.');
  }

  const pic = await handlePhoto(photo, { userId: user.id, kind: 'in' });
  if (!pic.ok) return await reject(pic.code!, pic.error!, v.distance);
  if (pic.name) flags.add('photo_captured');

  const info = await run(
    `INSERT INTO attendance
       (user_id, work_date, shift_id, project_id,
        check_in_at, check_in_lat, check_in_lng, check_in_accuracy, check_in_distance_m,
        check_in_device, check_in_note, check_in_photo, late_minutes, status, flags, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?)
     RETURNING id`,
    user.id, w.workDate, w.shift.id, project.id,
    nowIso, v.lat, v.lng, v.accuracy, v.distance,
    userAgent || null, note || null, pic.name, lateMinutes,
    JSON.stringify([...flags]), nowIso, nowIso,
  );

  await logPunch({ ...base, outcome: 'accepted', reason: null, distance_m: v.distance ?? null });
  return {
    ok: true,
    attendance_id: Number(info.lastInsertRowid),
    work_date: w.workDate,
    shift: { id: w.shift.id, name: w.shift.name, start_time: w.shift.start_time, end_time: w.shift.end_time },
    project: { id: project.id, name: project.name },
    check_in_at: nowIso,
    check_in_local: T.local(nowIso).hhmm,
    distance_m: v.distance,
    accuracy_m: Math.round(v.accuracy!),
    late_minutes: lateMinutes,
    flags: [...flags],
  };
}

export async function checkOut(
  { user, projectId, fix, note, photo, userAgent, ip }: PunchInput,
): Promise<Record<string, unknown>> {
  const nowIso = T.nowIso();
  const rec = await openRecord(user.id);
  const base = {
    user_id: user.id,
    kind: 'out',
    project_id: (projectId ?? rec?.project_id ?? null) as number | null,
    lat: fix?.lat,
    lng: fix?.lng,
    accuracy: fix?.accuracy,
    device_time: fix?.captured_at ?? null,
    server_time: nowIso,
    user_agent: userAgent ?? null,
    ip: ip ?? null,
  };
  const reject = async (code: string, error: string, distance?: number) => {
    await logPunch({ ...base, outcome: 'rejected', reason: code, distance_m: distance ?? null });
    return { ok: false, code, error };
  };

  if (!rec) return await reject('not_checked_in', 'You are not checked in.');

  // Checking out from a different site than you checked in at is allowed but flagged.
  const outProjectId = projectId ? Number(projectId) : (rec.project_id as number);
  const project = await get<Project>('SELECT * FROM projects WHERE id = ?', outProjectId);
  if (!project) return await reject('unknown_project', 'Select a valid project or site.');

  const v = validateFix(project, fix ?? {}, nowIso);
  if (!v.ok) return await reject(v.code!, v.error!, v.distance);

  const flags = new Set<string>(JSON.parse((rec.flags as string) || '[]'));
  for (const f of v.flags) flags.add(f);
  if (project.id !== rec.project_id) flags.add('checked_out_at_other_site');

  const shift = rec.shift_id ? await get<Shift>('SELECT * FROM shifts WHERE id = ?', rec.shift_id) : null;
  let earlyOut = 0;
  let overtime = 0;
  if (shift) {
    const w = shiftWindow(shift, rec.work_date as string);
    const now = new Date(nowIso);
    earlyOut = Math.max(
      0,
      Math.round((w.endAt.getTime() - shift.grace_out_min * T.MS_MIN - now.getTime()) / T.MS_MIN),
    );
    overtime = Math.max(0, Math.round((now.getTime() - w.endAt.getTime()) / T.MS_MIN));
    if (earlyOut > 0) flags.add('early_out');
    if (overtime > 0) flags.add('overtime');
  }

  const gross = T.minutesBetween(rec.check_in_at as string, nowIso);
  if (gross < 1) return await reject('too_soon', 'Too soon after check-in. Wait a minute and try again.');
  const worked = Math.max(0, gross - (shift?.break_min || 0));

  const pic = await handlePhoto(photo, { userId: user.id, kind: 'out' });
  if (!pic.ok) return await reject(pic.code!, pic.error!, v.distance);

  await run(
    `UPDATE attendance SET
       check_out_at = ?, check_out_lat = ?, check_out_lng = ?, check_out_accuracy = ?,
       check_out_distance_m = ?, check_out_device = ?, check_out_note = ?, check_out_project_id = ?,
       check_out_photo = ?, worked_minutes = ?, early_out_minutes = ?, overtime_minutes = ?,
       status = 'closed', flags = ?, updated_at = ?
     WHERE id = ?`,
    nowIso, v.lat, v.lng, v.accuracy, v.distance, userAgent || null, note || null, project.id,
    pic.name, worked, earlyOut, overtime, JSON.stringify([...flags]), nowIso, rec.id,
  );

  await logPunch({ ...base, outcome: 'accepted', reason: null, distance_m: v.distance ?? null });
  return {
    ok: true,
    attendance_id: rec.id,
    work_date: rec.work_date,
    check_out_at: nowIso,
    check_out_local: T.local(nowIso).hhmm,
    worked_minutes: worked,
    early_out_minutes: earlyOut,
    overtime_minutes: overtime,
    distance_m: v.distance,
    flags: [...flags],
  };
}

/**
 * Closes records left open past their overtime ceiling (phone died, forgot to
 * punch out). Worked time is capped at the scheduled end so nobody is paid for
 * a missing punch, and the record is flagged for the admin to correct.
 */
export async function autoCloseStale(nowIso: string = T.nowIso()): Promise<number> {
  const now = new Date(nowIso);
  const rows = await all<Record<string, unknown>>("SELECT * FROM attendance WHERE status = 'open'");
  let closed = 0;
  for (const rec of rows) {
    const shift = rec.shift_id ? await get<Shift>('SELECT * FROM shifts WHERE id = ?', rec.shift_id) : null;
    const limit = shift
      ? shiftWindow(shift, rec.work_date as string).closeAt
      : new Date(new Date(rec.check_in_at as string).getTime() + 16 * 60 * T.MS_MIN);
    if (now <= limit) continue;

    const endAt = shift ? shiftWindow(shift, rec.work_date as string).endAt : limit;
    const gross = Math.max(0, T.minutesBetween(rec.check_in_at as string, endAt.toISOString()));
    const flags = new Set<string>(JSON.parse((rec.flags as string) || '[]'));
    flags.add('missing_checkout');
    flags.add('auto_closed');
    await run(
      `UPDATE attendance SET status = 'auto_closed', check_out_at = ?,
              worked_minutes = ?, flags = ?, updated_at = ?
         WHERE id = ?`,
      endAt.toISOString(), Math.max(0, gross - (shift?.break_min || 0)),
      JSON.stringify([...flags]), nowIso, rec.id,
    );
    closed += 1;
  }
  return closed;
}
