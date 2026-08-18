// Ported from server/routes/admin.js — express Router -> Hono.
//
// Same mapping as routes/auth.ts and routes/me.ts:
//   router.use(A.requireAuth, A.requireRole(...)) -> adminRoutes.use('*', ...)
//   router.get('/x', h)                           -> adminRoutes.get('/x', h)
//   router.post('/x', adminOnly, h)               -> adminRoutes.post('/x', adminOnly, h)
//   req.body?.field                               -> (await body(c)).field
//   res.status(n).json(o)                         -> c.json(o, n)
//   req.user                                      -> c.get('user')
//   req.query.foo                                 -> c.req.query('foo')
//   req.params.id                                 -> c.req.param('id')
// Every route path string, response body, status code, error message and field
// name is byte-identical to the original. `adminOnly` is applied to exactly the
// same nine routes as before (POST/PATCH users, POST/PATCH projects,
// POST/PATCH shifts, POST/DELETE holidays, PATCH attendance); everything else
// stays open to supervisors, exactly as the original router-level guard allowed.
//
// The only structural differences are platform-forced:
//   1. `await` on every db call and on every AT.* / LEAVE.* / REPORTS.* helper
//      and on buildCalendar(), because the data layer is async now. The local
//      helpers managerCycle(), lastActiveAdmin() and setMembership() therefore
//      became async too. shapeAttendance() / shapeLeave() are pure and stay sync.
//   2. `require('../config')` inside the dashboard handler became a top-level
//      ESM import — Deno has no synchronous require().
//   3. The punch-photo endpoint no longer streams a file from disk; there is no
//      filesystem. readPunchPhoto() returns the bytes from object storage.
//   4. Three SQL rewrites required by Postgres, all listed in PORT NOTEs below.
import { Hono } from 'npm:hono@4.6.14';
import { all, get, run, tx } from '../db.ts';
import * as A from '../lib/auth.ts';
import type { SessionUser } from '../lib/auth.ts';
import * as T from '../lib/time.ts';
import * as AT from '../lib/attendance.ts';
import * as LEAVE from '../lib/leave.ts';
import * as REPORTS from '../lib/reports.ts';
// PORT NOTE: PHOTOS.photoPath() is gone — there is no filesystem and no
// res.sendFile(). readPunchPhoto() applies the identical filename allowlist the
// old photoPath() applied before touching disk, then returns the bytes.
import { readPunchPhoto } from '../lib/photos.ts';
// PORT NOTE: the original did `require('../config')` inline inside the GET
// /dashboard handler. Deno has no synchronous require(), so it is a static
// import here. Same value, same behaviour.
import config from '../config.ts';
import { publicUser } from './auth.ts';
import { buildCalendar, shapeAttendance, shapeLeave } from './me.ts';

// Copied verbatim from routes/auth.ts.
const body = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
  try {
    const b = await c.req.json();
    return (b && typeof b === 'object') ? b as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export const adminRoutes = new Hono<{ Variables: { user: SessionUser } }>();
adminRoutes.use('*', A.requireAuth, A.requireRole('admin', 'supervisor'));

const adminOnly = A.requireRole('admin');
const int = (v: unknown): number | null => (v === '' || v == null ? null : Number.parseInt(String(v), 10));

// ---------------------------------------------------------------- employees

adminRoutes.get('/users', async (c) => {
  const q = `%${String(c.req.query('q') || '').trim()}%`;
  const rows = await all<Record<string, unknown>>(
    `SELECT u.*, m.full_name AS manager_name,
            (SELECT count(*) FROM project_members pm WHERE pm.user_id = u.id) AS project_count,
            (SELECT count(*) FROM users r WHERE r.manager_id = u.id AND r.active = 1) AS reports_count
       FROM users u
       LEFT JOIN users m ON m.id = u.manager_id
      WHERE (? = '%%' OR u.full_name LIKE ? OR u.employee_code LIKE ? OR u.email LIKE ?)
      ORDER BY u.active DESC, u.employee_code`,
    q, q, q, q,
  );
  return c.json({
    users: rows.map((u) => ({
      ...publicUser(u), active: !!u.active, project_count: u.project_count,
      manager_name: u.manager_name, reports_count: u.reports_count, created_at: u.created_at,
      // Per-employee overrides (see routes/admin.ts PATCH /users/:id below).
      // photo_policy is null for every employee until an admin sets it.
      photo_policy: (u.photo_policy ?? null) as string | null,
      flexible_punch: !!u.flexible_punch,
    })),
  });
});

adminRoutes.post('/users', adminOnly, async (c) => {
  const b = await body(c);
  const code = String(b.employee_code || '').trim();
  const name = String(b.full_name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const role = ['admin', 'supervisor', 'employee'].includes(b.role as string) ? b.role as string : 'employee';
  const password = String(b.password || '');

  if (!code || !name || !email) return c.json({ error: 'Employee ID, full name and email are required.' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'Email address is not valid.' }, 400);
  if (password.length < 8) return c.json({ error: 'Temporary password must be at least 8 characters.' }, 400);
  if (await get('SELECT id FROM users WHERE lower(employee_code) = lower(?)', code)) {
    return c.json({ error: `Employee ID ${code} already exists.` }, 400);
  }
  if (await get('SELECT id FROM users WHERE lower(email) = ?', email)) {
    return c.json({ error: `${email} is already registered.` }, 400);
  }

  const managerId = int(b.manager_id);
  if (managerId && !await get('SELECT id FROM users WHERE id = ?', managerId)) {
    return c.json({ error: 'The direct manager you chose does not exist.' }, 400);
  }

  const now = T.nowIso();
  // PORT NOTE: `RETURNING id` added so run() can populate lastInsertRowid, which
  // Postgres does not provide on its own. Nothing else in the statement changed.
  const info = await run(
    `INSERT INTO users (employee_code, full_name, email, phone, job_title, department,
                        role, manager_id, password_hash, must_change_password, active,
                        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?)
     RETURNING id`,
    code, name, email, b.phone || null, b.job_title || null, b.department || null,
    role, managerId, A.hashPassword(password), now, now,
  );
  const id = Number(info.lastInsertRowid);
  await setMembership(id, b.project_ids);
  return c.json({
    user: {
      ...publicUser((await get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', id))!),
      active: true,
    },
  }, 201);
});

adminRoutes.patch('/users/:id', adminOnly, async (c) => {
  const id = int(c.req.param('id'));
  const user = await get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', id);
  if (!user) return c.json({ error: 'Employee not found.' }, 404);
  const b = await body(c);

  if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email))) {
    return c.json({ error: 'Email address is not valid.' }, 400);
  }
  if (b.email && await get('SELECT id FROM users WHERE lower(email) = lower(?) AND id <> ?', b.email, id)) {
    return c.json({ error: 'That email belongs to another employee.' }, 400);
  }
  if (b.role === 'employee' && user.role === 'admin' && await lastActiveAdmin(id)) {
    return c.json({ error: 'This is the last active admin. Promote another admin first.' }, 400);
  }
  if (b.active === false && user.role === 'admin' && await lastActiveAdmin(id)) {
    return c.json({ error: 'You cannot deactivate the last active admin.' }, 400);
  }

  if (b.manager_id !== undefined) {
    const mid = int(b.manager_id);
    if (mid && !await get('SELECT id FROM users WHERE id = ?', mid)) {
      return c.json({ error: 'The direct manager you chose does not exist.' }, 400);
    }
    if (mid === id) return c.json({ error: 'Someone cannot be their own direct manager.' }, 400);
    if (mid && await managerCycle(id, mid)) return c.json({ error: 'That would create a loop in the reporting line.' }, 400);
  }

  // The field list is hardcoded, so `${f} = ?` can never carry user input into
  // the SQL text — only the values are parameterised. Kept exactly as it was.
  const fields = ['full_name', 'email', 'phone', 'job_title', 'department', 'role'];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const f of fields) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(f === 'email' ? String(b[f]).toLowerCase() : b[f]); }
  }
  if (b.manager_id !== undefined) { sets.push('manager_id = ?'); vals.push(int(b.manager_id) || null); }
  if (b.active !== undefined) { sets.push('active = ?'); vals.push(b.active ? 1 : 0); }
  // Per-employee overrides. photo_policy of '' or null means "inherit the
  // app-wide SELFIE_MODE setting"; flexible_punch lets this one employee
  // check in/out at any time instead of only inside their shift's window.
  if (b.photo_policy !== undefined) {
    const pp = b.photo_policy === '' ? null : b.photo_policy;
    if (pp !== null && !['off', 'optional', 'required'].includes(pp as string)) {
      return c.json({ error: 'photo_policy must be off, optional, required, or blank to use the default.' }, 400);
    }
    sets.push('photo_policy = ?'); vals.push(pp);
  }
  if (b.flexible_punch !== undefined) { sets.push('flexible_punch = ?'); vals.push(b.flexible_punch ? 1 : 0); }
  if (b.password) {
    if (String(b.password).length < 8) return c.json({ error: 'Password must be at least 8 characters.' }, 400);
    sets.push('password_hash = ?', 'must_change_password = 1');
    vals.push(A.hashPassword(b.password));
  }
  if (sets.length) {
    sets.push('updated_at = ?'); vals.push(T.nowIso());
    await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  }
  if (b.project_ids !== undefined) await setMembership(id!, b.project_ids);
  return c.json({
    user: {
      ...publicUser((await get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', id))!),
      active: !!(await get<Record<string, unknown>>('SELECT active FROM users WHERE id = ?', id))!.active,
    },
  });
});

adminRoutes.get('/users/:id/projects', async (c) => {
  return c.json({
    project_ids: (await all<Record<string, unknown>>(
      'SELECT project_id FROM project_members WHERE user_id = ?', int(c.req.param('id'))))
      .map((r) => r.project_id),
  });
});

/** Would making `managerId` the manager of `userId` close a reporting loop? */
async function managerCycle(userId: number | null, managerId: number) {
  let cursor: number | null = managerId;
  for (let hops = 0; cursor && hops < 50; hops += 1) {
    if (cursor === userId) return true;
    cursor = (await get<{ manager_id: number | null }>('SELECT manager_id FROM users WHERE id = ?', cursor))?.manager_id ?? null;
  }
  return false;
}

async function lastActiveAdmin(excludeId: number | null) {
  const row = await get<{ n: number }>("SELECT count(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", excludeId);
  return row!.n === 0;
}

async function setMembership(userId: number, projectIds: unknown) {
  if (!Array.isArray(projectIds)) return;
  await tx(async () => {
    await run('DELETE FROM project_members WHERE user_id = ?', userId);
    for (const pid of projectIds) {
      if (await get('SELECT id FROM projects WHERE id = ?', Number(pid))) {
        // PORT NOTE: `INSERT OR IGNORE` -> `ON CONFLICT DO NOTHING` (contract).
        await run('INSERT INTO project_members (project_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING', Number(pid), userId);
      }
    }
  });
}

// ----------------------------------------------------------------- projects

adminRoutes.get('/projects', async (c) => {
  return c.json({
    projects: (await all<Record<string, unknown>>(
      `SELECT p.*, (SELECT count(*) FROM project_members m WHERE m.project_id = p.id) AS member_count
         FROM projects p ORDER BY p.active DESC, p.name`,
    )).map((p) => ({ ...p, active: !!p.active })),
  });
});

adminRoutes.post('/projects', adminOnly, async (c) => {
  const p = validateProject(await body(c));
  if (p.error) return c.json({ error: p.error }, 400);
  if (await get('SELECT id FROM projects WHERE lower(code) = lower(?)', p.code)) {
    return c.json({ error: `Project code ${p.code} already exists.` }, 400);
  }
  const now = T.nowIso();
  // PORT NOTE: `RETURNING id` added for lastInsertRowid (contract).
  const info = await run(
    `INSERT INTO projects (code, name, client, address, lat, lng, radius_m, active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,1,?,?)
     RETURNING id`,
    p.code, p.name, p.client, p.address, p.lat, p.lng, p.radius_m, now, now,
  );
  return c.json({ project: await get('SELECT * FROM projects WHERE id = ?', Number(info.lastInsertRowid)) }, 201);
});

adminRoutes.patch('/projects/:id', adminOnly, async (c) => {
  const id = int(c.req.param('id'));
  if (!await get('SELECT id FROM projects WHERE id = ?', id)) return c.json({ error: 'Project not found.' }, 404);
  const b = await body(c);
  // Hardcoded field allowlists again — only values are parameterised.
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const f of ['code', 'name', 'client', 'address']) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(String(b[f]).trim()); }
  }
  for (const f of ['lat', 'lng']) {
    if (b[f] !== undefined) {
      const v = Number(b[f]);
      if (!Number.isFinite(v)) return c.json({ error: `${f} must be a number.` }, 400);
      sets.push(`${f} = ?`); vals.push(v);
    }
  }
  if (b.radius_m !== undefined) {
    const r = int(b.radius_m);
    if (!(r !== null && r >= 20 && r <= 20000)) return c.json({ error: 'Geofence radius must be between 20 and 20000 metres.' }, 400);
    sets.push('radius_m = ?'); vals.push(r);
  }
  if (b.active !== undefined) { sets.push('active = ?'); vals.push(b.active ? 1 : 0); }
  if (!sets.length) return c.json({ error: 'Nothing to update.' }, 400);
  sets.push('updated_at = ?'); vals.push(T.nowIso());
  await run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  return c.json({ project: await get('SELECT * FROM projects WHERE id = ?', id) });
});

interface ProjectDraft {
  error?: string;
  code?: string;
  name?: string;
  lat?: number;
  lng?: number;
  radius_m?: number;
  client?: string | null;
  address?: string | null;
}

function validateProject(b: Record<string, unknown> = {}): ProjectDraft {
  const code = String(b.code || '').trim();
  const name = String(b.name || '').trim();
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  const radius_m = int(b.radius_m) ?? 150;
  if (!code || !name) return { error: 'Project code and name are required.' };
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { error: 'Latitude must be between -90 and 90.' };
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { error: 'Longitude must be between -180 and 180.' };
  if (!(radius_m >= 20 && radius_m <= 20000)) return { error: 'Geofence radius must be between 20 and 20000 metres.' };
  return {
    code, name, lat, lng, radius_m,
    client: b.client ? String(b.client).trim() : null,
    address: b.address ? String(b.address).trim() : null,
  };
}

// ------------------------------------------------------------------- shifts

adminRoutes.get('/shifts', async (c) => {
  return c.json({
    shifts: (await all<Record<string, unknown>>('SELECT * FROM shifts ORDER BY start_time')).map((s) => ({
      ...s, crosses_midnight: !!s.crosses_midnight, active: !!s.active,
    })),
  });
});

adminRoutes.post('/shifts', adminOnly, async (c) => {
  const s = validateShift(await body(c));
  if (s.error) return c.json({ error: s.error }, 400);
  if (await get('SELECT id FROM shifts WHERE lower(code) = lower(?)', s.code)) {
    return c.json({ error: `Shift code ${s.code} already exists.` }, 400);
  }
  // PORT NOTE: `RETURNING id` added for lastInsertRowid (contract).
  const info = await run(
    `INSERT INTO shifts (code, name, start_time, end_time, crosses_midnight,
                         grace_in_min, grace_out_min, early_in_min, break_min, active)
     VALUES (?,?,?,?,?,?,?,?,?,1)
     RETURNING id`,
    s.code, s.name, s.start_time, s.end_time, s.crosses_midnight,
    s.grace_in_min, s.grace_out_min, s.early_in_min, s.break_min,
  );
  return c.json({ shift: await get('SELECT * FROM shifts WHERE id = ?', Number(info.lastInsertRowid)) }, 201);
});

adminRoutes.patch('/shifts/:id', adminOnly, async (c) => {
  const id = int(c.req.param('id'));
  const existing = await get<Record<string, unknown>>('SELECT * FROM shifts WHERE id = ?', id);
  if (!existing) return c.json({ error: 'Shift not found.' }, 404);
  const b = await body(c);
  const s = validateShift({ ...existing, ...b });
  if (s.error) return c.json({ error: s.error }, 400);
  await run(
    `UPDATE shifts SET code=?, name=?, start_time=?, end_time=?, crosses_midnight=?,
            grace_in_min=?, grace_out_min=?, early_in_min=?, break_min=?, active=?
      WHERE id = ?`,
    s.code, s.name, s.start_time, s.end_time, s.crosses_midnight,
    s.grace_in_min, s.grace_out_min, s.early_in_min, s.break_min,
    b.active === undefined ? existing.active : (b.active ? 1 : 0), id,
  );
  return c.json({ shift: await get('SELECT * FROM shifts WHERE id = ?', id) });
});

interface ShiftDraft {
  error?: string;
  code?: string;
  name?: string;
  start_time?: string;
  end_time?: string;
  crosses_midnight?: number;
  grace_in_min?: number;
  grace_out_min?: number;
  early_in_min?: number;
  break_min?: number;
}

function validateShift(b: Record<string, unknown> = {}): ShiftDraft {
  const code = String(b.code || '').trim();
  const name = String(b.name || '').trim();
  const start = String(b.start_time || '').trim();
  const end = String(b.end_time || '').trim();
  if (!code || !name) return { error: 'Shift code and name are required.' };
  const sm = T.hhmmToMin(start);
  const em = T.hhmmToMin(end);
  if (sm == null || em == null) return { error: 'Start and end time must be HH:MM (24-hour).' };
  if (sm === em) return { error: 'Start and end time cannot be the same.' };
  const n = (v: unknown, d: number, min: number, max: number) => {
    const x = int(v);
    const val = x == null || Number.isNaN(x) ? d : x;
    return Math.min(max, Math.max(min, val));
  };
  return {
    code, name, start_time: T.minToHhmm(sm), end_time: T.minToHhmm(em),
    crosses_midnight: em < sm ? 1 : (b.crosses_midnight ? 1 : 0),
    grace_in_min: n(b.grace_in_min, 15, 0, 240),
    grace_out_min: n(b.grace_out_min, 10, 0, 240),
    early_in_min: n(b.early_in_min, 60, 0, 480),
    break_min: n(b.break_min, 0, 0, 240),
  };
}

// ----------------------------------------------------------------- holidays

adminRoutes.get('/holidays', async (c) => {
  return c.json({ holidays: await all('SELECT * FROM holidays ORDER BY holiday_date') });
});

adminRoutes.post('/holidays', adminOnly, async (c) => {
  const b = await body(c);
  const date = String(b.holiday_date || '');
  const name = String(b.name || '').trim();
  if (!T.isYmd(date)) return c.json({ error: 'Date must be YYYY-MM-DD.' }, 400);
  if (!name) return c.json({ error: 'Holiday name is required.' }, 400);
  // PORT NOTE: `INSERT OR REPLACE` -> the ON CONFLICT rewrite prescribed by the
  // contract. Same upsert-by-holiday_date semantics.
  await run(
    `INSERT INTO holidays (holiday_date, name) VALUES (?,?)
     ON CONFLICT (holiday_date) DO UPDATE SET name = EXCLUDED.name`,
    date, name,
  );
  return c.json({ ok: true }, 201);
});

adminRoutes.delete('/holidays/:date', adminOnly, async (c) => {
  await run('DELETE FROM holidays WHERE holiday_date = ?', c.req.param('date'));
  return c.json({ ok: true });
});

// ---------------------------------------------------- calendar / scheduling

adminRoutes.get('/calendar', async (c) => {
  const userId = int(c.req.query('user_id'));
  if (!userId) return c.json({ error: 'user_id is required.' }, 400);
  const today = T.local().date;
  const from = T.isYmd(c.req.query('from')) ? c.req.query('from') as string : `${today.slice(0, 7)}-01`;
  const to = T.isYmd(c.req.query('to')) ? c.req.query('to') as string : T.addDays(from, 41);
  return c.json({ from, to, days: await buildCalendar(userId, from, to) });
});

/** Roster grid: every employee x every date in the range. */
adminRoutes.get('/roster', async (c) => {
  const today = T.local().date;
  const from = T.isYmd(c.req.query('from')) ? c.req.query('from') as string : today;
  const to = T.isYmd(c.req.query('to')) ? c.req.query('to') as string : T.addDays(from, 13);
  const dates = T.dateRange(from, to, 62);
  const users = await all("SELECT id, employee_code, full_name FROM users WHERE active = 1 AND role <> 'admin' ORDER BY full_name");
  const rows = await all<Record<string, unknown>>(
    `SELECT s.user_id, s.work_date, s.status, s.shift_id, s.project_id,
            sh.code AS shift_code, sh.name AS shift_name, p.name AS project_name
       FROM schedules s
       LEFT JOIN shifts sh ON sh.id = s.shift_id
       LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.work_date BETWEEN ? AND ?`,
    from, to,
  );
  const map: Record<string, Record<string, unknown>> = {};
  for (const r of rows) (map[r.user_id as string] ||= {})[r.work_date as string] = r;
  return c.json({
    from, to, dates, users,
    holidays: await all('SELECT * FROM holidays WHERE holiday_date BETWEEN ? AND ?', from, to),
    cells: map,
  });
});

/** Upsert one roster day. */
adminRoutes.post('/schedules', async (c) => {
  const b = await body(c);
  const userId = int(b.user_id);
  const date = String(b.work_date || '');
  const status = ['work', 'off', 'leave', 'holiday'].includes(b.status as string) ? b.status as string : 'work';
  if (!userId || !await get('SELECT id FROM users WHERE id = ?', userId)) return c.json({ error: 'Unknown employee.' }, 400);
  if (!T.isYmd(date)) return c.json({ error: 'work_date must be YYYY-MM-DD.' }, 400);

  let shiftId = int(b.shift_id);
  if (status === 'work') {
    if (!shiftId || !await get('SELECT id FROM shifts WHERE id = ? AND active = 1', shiftId)) {
      return c.json({ error: 'Pick an active shift for a working day.' }, 400);
    }
  } else {
    shiftId = null;
  }
  const projectId = int(b.project_id);
  if (projectId && !await get('SELECT id FROM projects WHERE id = ?', projectId)) return c.json({ error: 'Unknown project.' }, 400);

  // The ON CONFLICT clause was already valid Postgres — left exactly as it was.
  await run(
    `INSERT INTO schedules (user_id, work_date, shift_id, project_id, status, note, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(user_id, work_date) DO UPDATE SET
       shift_id = excluded.shift_id, project_id = excluded.project_id,
       status = excluded.status, note = excluded.note`,
    userId, date, shiftId, projectId, status, b.note || null, T.nowIso(),
  );
  return c.json({ ok: true });
});

adminRoutes.delete('/schedules', async (c) => {
  const userId = int(c.req.query('user_id'));
  const date = String(c.req.query('work_date') || '');
  if (!userId || !T.isYmd(date)) return c.json({ error: 'user_id and work_date are required.' }, 400);
  await run('DELETE FROM schedules WHERE user_id = ? AND work_date = ?', userId, date);
  return c.json({ ok: true });
});

/**
 * Bulk roster generation: assign a shift to a set of employees over a date
 * range, skipping chosen rest weekdays and (optionally) public holidays.
 */
adminRoutes.post('/schedules/generate', async (c) => {
  const b = await body(c);
  const userIds = Array.isArray(b.user_ids) ? b.user_ids.map(Number).filter(Boolean) : [];
  const from = String(b.from || '');
  const to = String(b.to || '');
  const shiftId = int(b.shift_id);
  const projectId = int(b.project_id);
  const restDays = Array.isArray(b.rest_weekdays) ? b.rest_weekdays.map(Number) : [5, 6]; // Fri, Sat
  const skipHolidays = b.skip_holidays !== false;
  const overwrite = !!b.overwrite;

  if (!userIds.length) return c.json({ error: 'Select at least one employee.' }, 400);
  if (!T.isYmd(from) || !T.isYmd(to) || to < from) return c.json({ error: 'Give a valid date range.' }, 400);
  if (!await get('SELECT id FROM shifts WHERE id = ? AND active = 1', shiftId)) return c.json({ error: 'Pick an active shift.' }, 400);
  const dates = T.dateRange(from, to, 400);
  if (dates.length * userIds.length > 20000) return c.json({ error: 'Range is too large. Split it into smaller batches.' }, 400);

  const holidaySet = new Set((await all<Record<string, unknown>>(
    'SELECT holiday_date FROM holidays WHERE holiday_date BETWEEN ? AND ?', from, to))
    .map((h) => h.holiday_date as string));
  const now = T.nowIso();
  let created = 0;
  let skipped = 0;

  await tx(async () => {
    for (const uid of userIds) {
      if (!await get('SELECT id FROM users WHERE id = ? AND active = 1', uid)) continue;
      for (const d of dates) {
        const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
        let status = 'work';
        let sid: number | null = shiftId;
        if (restDays.includes(weekday)) { status = 'off'; sid = null; }
        else if (skipHolidays && holidaySet.has(d)) { status = 'holiday'; sid = null; }

        const existing = await get('SELECT id FROM schedules WHERE user_id = ? AND work_date = ?', uid, d);
        if (existing && !overwrite) { skipped += 1; continue; }
        // ON CONFLICT already valid Postgres — unchanged.
        await run(
          `INSERT INTO schedules (user_id, work_date, shift_id, project_id, status, created_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(user_id, work_date) DO UPDATE SET
             shift_id = excluded.shift_id, project_id = excluded.project_id, status = excluded.status`,
          uid, d, sid, projectId, status, now,
        );
        created += 1;
      }
    }
  });
  return c.json({ ok: true, written: created, skipped });
});

// --------------------------------------------------------------- attendance

// PORT NOTE: this helper took express's `req.query` object. Hono's
// `c.req.query()` (no argument) returns the same flat Record of query
// parameters, so the helper body is unchanged apart from `await all(...)`.
// There is no `(? IS NULL OR ...)` pattern here — the original builds the WHERE
// clause conditionally from a hardcoded fragment list, so no ::int cast is
// needed. Same for the punch-log query below.
async function attendanceQuery(q: Record<string, string | undefined>) {
  const today = T.local().date;
  const from = T.isYmd(q.from) ? q.from as string : `${today.slice(0, 7)}-01`;
  const to = T.isYmd(q.to) ? q.to as string : today;
  const where = ['a.work_date BETWEEN ? AND ?'];
  const params: unknown[] = [from, to];
  if (int(q.user_id)) { where.push('a.user_id = ?'); params.push(int(q.user_id)); }
  if (int(q.project_id)) { where.push('a.project_id = ?'); params.push(int(q.project_id)); }
  if (int(q.shift_id)) { where.push('a.shift_id = ?'); params.push(int(q.shift_id)); }
  if (q.status) { where.push('a.status = ?'); params.push(String(q.status)); }
  if (q.flagged === 'true') where.push("a.flags <> '[]'");
  if (q.late === 'true') where.push('a.late_minutes > 0');
  const rows = await all<Record<string, unknown>>(
    `SELECT a.*, u.full_name, u.employee_code, p.name AS project_name, sh.name AS shift_name
       FROM attendance a
       JOIN users u ON u.id = a.user_id
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN shifts sh ON sh.id = a.shift_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.work_date DESC, u.full_name`,
    ...params,
  );
  return { from, to, rows };
}

adminRoutes.get('/attendance', async (c) => {
  const { from, to, rows } = await attendanceQuery(c.req.query());
  const records = rows.map((r) => ({
    ...shapeAttendance(r),
    user_id: r.user_id, full_name: r.full_name, employee_code: r.employee_code,
  }));
  const totals = records.reduce((acc, r) => {
    acc.records += 1;
    acc.worked_minutes += (r.worked_minutes as number) || 0;
    acc.late_minutes += (r.late_minutes as number) || 0;
    acc.overtime_minutes += (r.overtime_minutes as number) || 0;
    if (r.flags.length) acc.flagged += 1;
    return acc;
  }, { records: 0, worked_minutes: 0, late_minutes: 0, overtime_minutes: 0, flagged: 0 });
  return c.json({ from, to, totals, records });
});

adminRoutes.get('/attendance.csv', async (c) => {
  const { from, to, rows } = await attendanceQuery(c.req.query());
  const header = [
    'Employee ID', 'Employee', 'Work date', 'Shift', 'Project', 'Check in', 'Check out',
    'Worked (h:mm)', 'Worked (min)', 'Late (min)', 'Early out (min)', 'Overtime (min)',
    'In distance (m)', 'Out distance (m)', 'In accuracy (m)', 'Status', 'Flags', 'Notes',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.employee_code, r.full_name, r.work_date, r.shift_name || '', r.project_name,
      `${T.local(r.check_in_at as string).date} ${T.local(r.check_in_at as string).hhmm}`,
      r.check_out_at ? `${T.local(r.check_out_at as string).date} ${T.local(r.check_out_at as string).hhmm}` : '',
      hm(r.worked_minutes as number | null), r.worked_minutes ?? '', r.late_minutes, r.early_out_minutes, r.overtime_minutes,
      r.check_in_distance_m ?? '', r.check_out_distance_m ?? '', Math.round((r.check_in_accuracy as number) ?? 0),
      r.status, JSON.parse((r.flags as string) || '[]').join(' '),
      [r.check_in_note, r.check_out_note].filter(Boolean).join(' | '),
    ].map(csvCell).join(','));
  }
  // PORT NOTE: res.setHeader + res.send -> c.body with the same two headers and
  // the same body. '﻿' is the identical byte sequence (EF BB BF) the
  // original literal BOM produced; Excel needs it to read the Arabic names.
  return c.body('﻿' + lines.join('\r\n'), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="attendance_${from}_to_${to}.csv"`,
  });
});

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const hm = (min: number | null) => (min == null ? '' : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`);

/** Admin correction of a punch (missed check-out, wrong site, disputed time). */
adminRoutes.patch('/attendance/:id', adminOnly, async (c) => {
  const id = int(c.req.param('id'));
  const rec = await get<Record<string, unknown>>('SELECT * FROM attendance WHERE id = ?', id);
  if (!rec) return c.json({ error: 'Record not found.' }, 404);
  const b = await body(c);
  // Hardcoded field/key pairs again — user input never reaches the SQL text.
  const sets: string[] = [];
  const vals: unknown[] = [];

  for (const [field, key] of [['check_in_at', 'check_in_local'], ['check_out_at', 'check_out_local']]) {
    if (b[key] === undefined) continue;
    if (b[key] === null || b[key] === '') {
      if (field === 'check_out_at') { sets.push('check_out_at = NULL', "status = 'open'"); }
      continue;
    }
    const min = T.hhmmToMin(b[key]);
    if (min == null) return c.json({ error: `${key} must be HH:MM.` }, 400);
    // A time earlier than the shift start on a midnight-crossing shift belongs to the next day.
    const shift = rec.shift_id ? await get<AT.Shift>('SELECT * FROM shifts WHERE id = ?', rec.shift_id) : null;
    const startMin = shift ? T.hhmmToMin(shift.start_time) : 0;
    const date = shift && shift.crosses_midnight && min < startMin! ? T.addDays(rec.work_date as string, 1) : rec.work_date as string;
    sets.push(`${field} = ?`);
    vals.push(T.localToUtc(date, min).toISOString());
  }
  if (b.project_id !== undefined && await get('SELECT id FROM projects WHERE id = ?', int(b.project_id))) {
    sets.push('project_id = ?'); vals.push(int(b.project_id));
  }
  if (b.admin_note !== undefined) {
    sets.push('check_out_note = ?'); vals.push(String(b.admin_note).slice(0, 500));
  }
  if (!sets.length) return c.json({ error: 'Nothing to update.' }, 400);

  sets.push('updated_at = ?'); vals.push(T.nowIso());
  await run(`UPDATE attendance SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);

  // Recompute derived minutes and mark the record as manually adjusted.
  const fresh = (await get<Record<string, unknown>>('SELECT * FROM attendance WHERE id = ?', id))!;
  if (fresh.check_out_at) {
    const shift = fresh.shift_id ? await get<AT.Shift>('SELECT * FROM shifts WHERE id = ?', fresh.shift_id) : null;
    const gross = T.minutesBetween(fresh.check_in_at as string, fresh.check_out_at as string);
    let late = 0; let earlyOut = 0; let overtime = 0;
    if (shift) {
      const w = AT.shiftWindow(shift, fresh.work_date as string);
      // PORT NOTE: identical arithmetic; TypeScript needs .getTime() to subtract
      // Date objects, which plain JavaScript did implicitly.
      late = Math.max(0, Math.round((new Date(fresh.check_in_at as string).getTime() - w.lateAt.getTime()) / T.MS_MIN));
      earlyOut = Math.max(0, Math.round(((w.endAt.getTime() - shift.grace_out_min * T.MS_MIN) - new Date(fresh.check_out_at as string).getTime()) / T.MS_MIN));
      overtime = Math.max(0, Math.round((new Date(fresh.check_out_at as string).getTime() - w.endAt.getTime()) / T.MS_MIN));
    }
    // Derived flags must follow the corrected times, not the original punch.
    const flags = new Set<string>(JSON.parse((fresh.flags as string) || '[]'));
    for (const f of ['late', 'early_out', 'overtime', 'missing_checkout', 'auto_closed']) flags.delete(f);
    if (late > 0) flags.add('late');
    if (earlyOut > 0) flags.add('early_out');
    if (overtime > 0) flags.add('overtime');
    flags.add('manually_adjusted');
    await run(
      `UPDATE attendance SET worked_minutes = ?, late_minutes = ?, early_out_minutes = ?,
              overtime_minutes = ?, status = 'closed', flags = ? WHERE id = ?`,
      Math.max(0, gross - (shift?.break_min || 0)), late, earlyOut, overtime,
      JSON.stringify([...flags]), id,
    );
  }
  return c.json({ record: shapeAttendance((await get<Record<string, unknown>>(
    `SELECT a.*, p.name AS project_name, sh.name AS shift_name FROM attendance a
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN shifts sh ON sh.id = a.shift_id WHERE a.id = ?`, id))!) });
});

/** The selfie taken at a punch. Streamed only to admins and supervisors. */
adminRoutes.get('/attendance/:id/photo/:kind', async (c) => {
  const rec = await get<Record<string, unknown>>(
    'SELECT check_in_photo, check_out_photo FROM attendance WHERE id = ?', int(c.req.param('id')));
  if (!rec) return c.json({ error: 'Record not found.' }, 404);
  const name = c.req.param('kind') === 'out' ? rec.check_out_photo : rec.check_in_photo;
  // PORT NOTE: PHOTOS.photoPath() + res.sendFile() are gone — there is no
  // filesystem. readPunchPhoto() runs the same filename allowlist and returns
  // the bytes from object storage, or null. The 404 body and the authorisation
  // behaviour (router-level admin-or-supervisor guard, no adminOnly) are
  // unchanged.
  const bytes = await readPunchPhoto(name);
  if (!bytes) return c.json({ error: 'No photo stored for this punch.' }, 404);
  // PORT NOTE: both original res.setHeader() calls are preserved here. Note that
  // index.ts's global middleware sets Cache-Control: no-store after the handler
  // returns, which the Node app did not do; that middleware is not this file's
  // to change.
  // PORT NOTE: the `as unknown as BodyInit` cast is a Deno lib-typing quirk only
  // (Uint8Array<ArrayBufferLike> vs BodyInit) — the same one lib/storage.ts hits.
  // It changes nothing at runtime; the bytes are sent verbatim.
  return new Response(bytes as unknown as BodyInit, {
    headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' },
  });
});

// ------------------------------------------------------ timesheet / payroll

function rangeFrom(q: Record<string, string | undefined>) {
  const today = T.local().date;
  const from = T.isYmd(q.from) ? q.from as string : `${today.slice(0, 7)}-01`;
  const to = T.isYmd(q.to) ? q.to as string : today;
  return { from, to };
}

adminRoutes.get('/timesheet', async (c) => {
  const { from, to } = rangeFrom(c.req.query());
  const sheet = await REPORTS.timesheet({
    from, to,
    userId: int(c.req.query('user_id')) || null,
    includeInactive: c.req.query('include_inactive') === 'true',
  });
  return c.json({ ...sheet, by_project: await REPORTS.byProject({ from, to }) });
});

adminRoutes.get('/timesheet.csv', async (c) => {
  const { from, to } = rangeFrom(c.req.query());
  // PORT NOTE: REPORTS.timesheet() is declared as Promise<Record<string, unknown>>,
  // so the shape is narrowed here purely to satisfy `deno check`. No values are
  // converted and no behaviour changes.
  const sheet = await REPORTS.timesheet({
    from, to,
    userId: int(c.req.query('user_id')) || null,
    includeInactive: c.req.query('include_inactive') === 'true',
  }) as { rows: Record<string, string | number | null>[]; totals: Record<string, number> };
  const header = [
    'Employee ID', 'Employee', 'Job title', 'Department',
    'Scheduled days', 'Worked days', 'Absent days', 'Leave days', 'Rest days', 'Holidays',
    'Attendance %', 'Paid hours', 'Paid minutes', 'Late count', 'Late minutes',
    'Early out minutes', 'Overtime minutes', 'Missing check-outs', 'Unscheduled days', 'Days needing review',
  ];
  const lines = [`Timesheet ${from} to ${to}`, header.join(',')];
  for (const r of sheet.rows) {
    lines.push([
      r.employee_code, r.full_name, r.job_title || '', r.department || '',
      r.scheduled_days, r.worked_days, r.absent_days, r.leave_days, r.off_days, r.holiday_days,
      r.attendance_rate ?? '', r.paid_hours, r.paid_minutes, r.late_count, r.late_minutes,
      r.early_out_minutes, r.overtime_minutes, r.missing_checkout, r.unscheduled_days, r.flagged_days,
    ].map(csvCell).join(','));
  }
  lines.push('');
  lines.push(['TOTAL', `${sheet.totals.employees} employees`, '', '',
    sheet.totals.scheduled_days, sheet.totals.worked_days, sheet.totals.absent_days,
    sheet.totals.leave_days, '', '', '', sheet.totals.paid_hours, sheet.totals.paid_minutes,
    sheet.totals.late_count, sheet.totals.late_minutes, '', sheet.totals.overtime_minutes,
    sheet.totals.missing_checkout, '', sheet.totals.flagged_days].map(csvCell).join(','));

  // PORT NOTE: same two headers, same BOM, same body as the original res.send.
  return c.body('﻿' + lines.join('\r\n'), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="timesheet_${from}_to_${to}.csv"`,
  });
});

// -------------------------------------------------------------- leave admin

adminRoutes.get('/leave', async (c) => {
  return c.json({
    types: LEAVE.TYPES,
    requests: (await LEAVE.list({
      userId: int(c.req.query('user_id')) || null,
      status: c.req.query('status') || null,
    })).map(shapeLeave),
  });
});

adminRoutes.post('/leave/:id/decide', async (c) => {
  const user = c.get('user') as SessionUser;
  const b = await body(c);
  const out = await LEAVE.decide({
    requestId: int(c.req.param('id'))!,
    deciderId: user.id,
    approve: b.approve === true,
    note: b.note,
  });
  return c.json(out, out.ok ? 200 : 400);
});

/** Admin may also enter leave directly on someone's behalf (phone call, paper form). */
adminRoutes.post('/leave', async (c) => {
  const user = c.get('user') as SessionUser;
  const b = await body(c);
  const userId = int(b.user_id);
  if (!userId || !await get('SELECT id FROM users WHERE id = ? AND active = 1', userId)) {
    return c.json({ error: 'Choose an active employee.' }, 400);
  }
  const created = await LEAVE.create({
    userId,
    leaveType: String(b.leave_type || 'annual'),
    from: String(b.from_date || ''),
    to: String(b.to_date || ''),
    reason: b.reason,
  });
  if (!created.ok) return c.json(created, 400);
  // Entered by an administrator, so it is approved and applied immediately.
  const decided = await LEAVE.decide({
    requestId: created.id as number, deciderId: user.id, approve: true,
    note: b.note || 'Entered by administrator',
  });
  return c.json({ ...created, ...decided }, 201);
});

// ---------------------------------------------------------------- dashboard

adminRoutes.get('/dashboard', async (c) => {
  const today = T.local().date;
  const yesterday = T.addDays(today, -1);

  const onSite = (await all<Record<string, unknown>>(
    `SELECT a.id, a.check_in_at, a.late_minutes, a.check_in_distance_m,
            u.full_name, u.employee_code, p.name AS project_name, sh.name AS shift_name
       FROM attendance a
       JOIN users u ON u.id = a.user_id
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN shifts sh ON sh.id = a.shift_id
      WHERE a.status = 'open'
      ORDER BY a.check_in_at`,
  )).map((r) => ({
    ...r,
    check_in_local: T.local(r.check_in_at as string).hhmm,
    elapsed_minutes: T.minutesBetween(r.check_in_at as string, T.nowIso()),
  }));

  const scheduledToday = await all<Record<string, unknown>>(
    `SELECT s.user_id, u.full_name, u.employee_code, sh.name AS shift_name, sh.start_time,
            p.name AS project_name
       FROM schedules s
       JOIN users u ON u.id = s.user_id AND u.active = 1
       LEFT JOIN shifts sh ON sh.id = s.shift_id
       LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.work_date = ? AND s.status = 'work'`,
    today,
  );
  const punchedToday = new Set(
    (await all<Record<string, unknown>>('SELECT DISTINCT user_id FROM attendance WHERE work_date IN (?, ?)', today, yesterday))
      .map((r) => r.user_id),
  );
  const absent = scheduledToday.filter((s) => !punchedToday.has(s.user_id));

  const stats = (await get<{ records: number; late: number | null; worked: number | null; overtime: number | null }>(
    `SELECT count(*) AS records,
            sum(CASE WHEN late_minutes > 0 THEN 1 ELSE 0 END) AS late,
            sum(coalesce(worked_minutes, 0)) AS worked,
            sum(coalesce(overtime_minutes, 0)) AS overtime
       FROM attendance WHERE work_date = ?`,
    today,
  ))!;

  return c.json({
    local_date: today,
    local_time: T.local().hhmm,
    tz: config.tzLabel,
    counts: {
      employees: (await get<{ n: number }>('SELECT count(*) AS n FROM users WHERE active = 1'))!.n,
      projects: (await get<{ n: number }>('SELECT count(*) AS n FROM projects WHERE active = 1'))!.n,
      on_site_now: onSite.length,
      scheduled_today: scheduledToday.length,
      absent_today: absent.length,
      late_today: stats.late || 0,
      worked_minutes_today: stats.worked || 0,
      overtime_minutes_today: stats.overtime || 0,
      pending_leave: (await get<{ n: number }>("SELECT count(*) AS n FROM leave_requests WHERE status = 'pending'"))!.n,
    },
    pending_leave: (await LEAVE.list({ status: 'pending' })).slice(0, 20).map(shapeLeave),
    on_site: onSite,
    absent,
    flagged: (await all<Record<string, unknown>>(
      `SELECT a.id, a.work_date, a.flags, a.check_in_distance_m, a.status,
              u.full_name, u.employee_code, p.name AS project_name
         FROM attendance a
         JOIN users u ON u.id = a.user_id
         JOIN projects p ON p.id = a.project_id
        WHERE a.flags <> '[]' AND a.work_date >= ?
        ORDER BY a.work_date DESC LIMIT 50`,
      T.addDays(today, -14),
    )).map((r) => ({ ...r, flags: JSON.parse((r.flags as string) || '[]') })),
  });
});

/** Rejected punch attempts - the audit trail for "the app would not let me in". */
adminRoutes.get('/punch-log', async (c) => {
  const userId = int(c.req.query('user_id'));
  const where = userId ? 'WHERE l.user_id = ?' : '';
  const params: unknown[] = userId ? [userId] : [];
  return c.json({
    log: (await all<Record<string, unknown>>(
      `SELECT l.*, u.full_name, u.employee_code, p.name AS project_name
         FROM punch_log l
         LEFT JOIN users u ON u.id = l.user_id
         LEFT JOIN projects p ON p.id = l.project_id
         ${where}
        ORDER BY l.server_time DESC LIMIT 300`,
      ...params,
    )).map((r) => ({ ...r, server_local: `${T.local(r.server_time as string).date} ${T.local(r.server_time as string).hhmm}` })),
  });
});

export default adminRoutes;
