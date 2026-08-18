// Ported from server/lib/auth.js.
//
// TWO DELIBERATE CHANGES, EVERYTHING ELSE IDENTICAL:
//
// 1. bcryptjs is KEPT (not swapped for WebCrypto). It is pure JavaScript, so it
//    runs on Deno unchanged — and critically, the 17 existing accounts' bcrypt
//    hashes keep verifying. Swapping the algorithm would invalidate every
//    password in the database.
//
// 2. jsonwebtoken -> jose. jsonwebtoken reaches into Node's crypto internals,
//    which is fragile on an edge runtime. jose is web-standard and produces the
//    same HS256 JWTs, so the token format is unchanged.
//
// 3. The login throttle moved from an in-memory Map to the login_attempts table.
//    An in-memory Map is worthless on a serverless runtime: every invocation may
//    be a fresh isolate, so an attacker would get unlimited attempts. Same policy
//    as before — 8 failures per (ip + identifier) per 15 minutes.
// bcryptjs is CommonJS, so it must be imported as a default export under Deno.
import bcrypt from 'npm:bcryptjs@2.4.3';
import { jwtVerify, SignJWT } from 'npm:jose@5.9.6';
import type { Context } from 'npm:hono@4.6.14';
import config from '../config.ts';
import { get, run } from '../db.ts';

const secretKey = new TextEncoder().encode(config.jwtSecret);

export const hashPassword = (plain: unknown): string => bcrypt.hashSync(String(plain), 10);
export const verifyPassword = (plain: unknown, hash: unknown): boolean =>
  bcrypt.compareSync(String(plain), String(hash ?? ''));

export interface SessionUser {
  id: number;
  employee_code: string;
  full_name: string;
  email: string;
  phone: string | null;
  job_title: string | null;
  department: string | null;
  role: 'admin' | 'supervisor' | 'employee';
  manager_id: number | null;
  must_change_password: number;
  active: number;
}

export async function issueToken(user: { id: number; role: string; employee_code: string }): Promise<string> {
  return await new SignJWT({ sub: String(user.id), role: user.role, code: user.employee_code })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${config.tokenTtlHours}h`)
    .sign(secretKey);
}

function bearer(c: Context): string | null {
  const h = c.req.header('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/**
 * Hono middleware. Populates c.set('user', ...). Rejects deactivated accounts
 * even when the token is still valid — the user row is re-read on every request,
 * exactly as before.
 */
export async function requireAuth(c: Context, next: () => Promise<void>) {
  const token = bearer(c);
  if (!token) return c.json({ error: 'Not signed in.' }, 401);

  let sub: string | undefined;
  try {
    const { payload } = await jwtVerify(token, secretKey);
    sub = typeof payload.sub === 'string' ? payload.sub : undefined;
  } catch {
    return c.json({ error: 'Session expired. Please sign in again.' }, 401);
  }

  const user = await get<SessionUser>(
    `SELECT id, employee_code, full_name, email, phone, job_title, department, role,
            manager_id, must_change_password, active
       FROM users WHERE id = ?`,
    Number(sub),
  );
  if (!user || !user.active) return c.json({ error: 'Account is not active.' }, 403);
  c.set('user', user);
  await next();
}

export function requireRole(...roles: string[]) {
  return async (c: Context, next: () => Promise<void>) => {
    const user = c.get('user') as SessionUser | undefined;
    if (!user || !roles.includes(user.role)) {
      return c.json({ error: 'You do not have permission for this action.' }, 403);
    }
    await next();
  };
}

// --------------------------------------------------------------------------
// Client IP
//
// The Node version used Express's req.ip with `trust proxy` on unconditionally,
// which meant a directly-reachable app could be fed a forged X-Forwarded-For and
// the throttle defeated. Here the order is deliberate:
//   1. cf-connecting-ip  — set by Cloudflare and NOT forgeable by the client
//   2. the LAST entry of x-forwarded-for — appended by the nearest trusted proxy;
//      the leftmost entry is the one a client can spoof, so it is never used.
// --------------------------------------------------------------------------
export function clientIp(c: Context): string {
  const cf = c.req.header('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return c.req.header('x-real-ip')?.trim() || 'unknown';
}

// --- Login throttle, now backed by Postgres --------------------------------
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export function throttleKey(c: Context, identifier: unknown): string {
  return `${clientIp(c)}|${String(identifier ?? '').toLowerCase()}`;
}

export async function isThrottled(key: string): Promise<boolean> {
  const rec = await get<{ first_at: string; attempts: number }>(
    'SELECT first_at, attempts FROM login_attempts WHERE attempt_key = ?',
    key,
  );
  if (!rec) return false;
  if (Date.now() - new Date(rec.first_at).getTime() > WINDOW_MS) {
    await run('DELETE FROM login_attempts WHERE attempt_key = ?', key);
    return false;
  }
  return rec.attempts >= MAX_ATTEMPTS;
}

export async function noteFailure(key: string): Promise<void> {
  const nowIso = new Date().toISOString();
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  // One statement, so two simultaneous failed logins cannot race each other:
  // a stale window is reset, a live window is incremented.
  await run(
    `INSERT INTO login_attempts (attempt_key, first_at, attempts) VALUES (?,?,1)
     ON CONFLICT (attempt_key) DO UPDATE SET
       attempts = CASE WHEN login_attempts.first_at < ? THEN 1 ELSE login_attempts.attempts + 1 END,
       first_at = CASE WHEN login_attempts.first_at < ? THEN ? ELSE login_attempts.first_at END`,
    key, nowIso, cutoff, cutoff, nowIso,
  );
}

export async function clearFailures(key: string): Promise<void> {
  await run('DELETE FROM login_attempts WHERE attempt_key = ?', key);
}

/** Housekeeping so the table cannot grow without bound. Called by the cron endpoint. */
export async function purgeOldAttempts(): Promise<number> {
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  const res = await run('DELETE FROM login_attempts WHERE first_at < ?', cutoff);
  return res.changes;
}
