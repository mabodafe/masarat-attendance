// Ported from server/routes/auth.js — express Router -> Hono.
//
// Mapping used consistently across every route file:
//   router.post('/x', h)            -> app.post('/x', h)
//   req.body?.field                 -> (await c.req.json().catch(()=>({}))).field
//   res.status(n).json(o)           -> c.json(o, n)
//   res.json(o)                     -> c.json(o)
//   req.user                        -> c.get('user')
//   A.requireAuth as middleware     -> same, as Hono middleware
// Every response body, status code and message string is byte-identical to the
// original so the existing frontend and the test suite need no changes.
import { Hono } from 'npm:hono@4.6.14';
import { get, run } from '../db.ts';
import * as A from '../lib/auth.ts';
import type { SessionUser } from '../lib/auth.ts';
import * as T from '../lib/time.ts';
import config from '../config.ts';
import * as PR from '../lib/password_reset.ts';

export interface PublicUser {
  id: number;
  employee_code: string;
  full_name: string;
  email: string;
  phone: string | null;
  job_title: string | null;
  department: string | null;
  role: string;
  manager_id: number | null;
  must_change_password: boolean;
}

export function publicUser(u: Record<string, unknown>): PublicUser {
  return {
    id: u.id as number,
    employee_code: u.employee_code as string,
    full_name: u.full_name as string,
    email: u.email as string,
    phone: (u.phone ?? null) as string | null,
    job_title: (u.job_title ?? null) as string | null,
    department: (u.department ?? null) as string | null,
    role: u.role as string,
    manager_id: (u.manager_id ?? null) as number | null,
    must_change_password: !!u.must_change_password,
  };
}

const body = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
  try {
    const b = await c.req.json();
    return (b && typeof b === 'object') ? b as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export const authRoutes = new Hono<{ Variables: { user: SessionUser } }>();

authRoutes.post('/login', async (c) => {
  const b = await body(c);
  const identifier = String(b.identifier ?? '').trim();
  const password = String(b.password ?? '');
  if (!identifier || !password) {
    return c.json({ error: 'Enter your employee ID / email and password.' }, 400);
  }

  const key = A.throttleKey(c, identifier);
  if (await A.isThrottled(key)) {
    return c.json({ error: 'Too many failed attempts. Try again in 15 minutes.' }, 429);
  }

  const user = await get<Record<string, unknown>>(
    `SELECT * FROM users
      WHERE lower(email) = lower(?) OR lower(employee_code) = lower(?)`,
    identifier,
    identifier,
  );
  if (!user || !A.verifyPassword(password, user.password_hash)) {
    await A.noteFailure(key);
    return c.json({ error: 'Wrong employee ID / email or password.' }, 401);
  }
  if (!user.active) return c.json({ error: 'This account has been deactivated.' }, 403);

  await A.clearFailures(key);
  return c.json({
    token: await A.issueToken(user as unknown as { id: number; role: string; employee_code: string }),
    user: publicUser(user),
    server_time: T.nowIso(),
    tz: { offset_min: config.tzOffsetMin, label: config.tzLabel },
  });
});

authRoutes.get('/me', A.requireAuth, async (c) => {
  const sessionUser = c.get('user') as unknown as Record<string, unknown>;
  // Per-employee override, set by an admin. NULL — the default for every
  // existing employee — falls back to the app-wide SELFIE_MODE setting, so
  // this reports exactly what it always did unless an admin changed it.
  const pref = await get<{ photo_policy: string | null }>(
    'SELECT photo_policy FROM users WHERE id = ?', sessionUser.id as number,
  );
  return c.json({
    user: publicUser(sessionUser),
    server_time: T.nowIso(),
    tz: { offset_min: config.tzOffsetMin, label: config.tzLabel },
    location_rules: {
      max_accuracy_m: config.maxAccuracyM,
      max_fix_age_sec: config.maxFixAgeSec,
      allow_out_of_fence: config.allowOutOfFenceWithFlag,
      selfie_mode: pref?.photo_policy || config.selfieMode,
    },
  });
});

authRoutes.post('/change-password', A.requireAuth, async (c) => {
  const b = await body(c);
  const user = c.get('user') as { id: number };
  const current = String(b.current_password ?? '');
  const next = String(b.new_password ?? '');
  if (next.length < 8) return c.json({ error: 'New password must be at least 8 characters.' }, 400);

  const row = await get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', user.id);
  if (!A.verifyPassword(current, row?.password_hash)) {
    return c.json({ error: 'Current password is wrong.' }, 401);
  }
  await run(
    'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
    A.hashPassword(next),
    T.nowIso(),
    user.id,
  );
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- v2.1: forgot password
// Public, so the sign-in screen can decide whether to show "Forgot password?".
authRoutes.get('/options', async (c) => {
  return c.json({ password_reset_requests: await PR.requestsEnabled() });
});

// The employee asks an administrator to reset their password. The answer is the
// same whether or not the ID exists, so this cannot be used to discover accounts.
authRoutes.post('/forgot-password', async (c) => {
  const b = await body(c);
  const identifier = String(b.identifier ?? '').trim();
  if (!identifier) return c.json({ error: 'Enter your employee ID or email.' }, 400);
  if (!await PR.requestsEnabled()) {
    return c.json({ error: 'Password reset requests are turned off. Please contact your administrator.', code: 'disabled' }, 403);
  }
  const key = 'reset:' + A.throttleKey(c, identifier);
  if (await A.isThrottled(key)) {
    return c.json({ error: 'Too many requests. Try again in 15 minutes.' }, 429);
  }
  await A.noteFailure(key); // every request counts towards the limit
  await PR.createRequest(identifier);
  return c.json({ ok: true });
});

export default authRoutes;
