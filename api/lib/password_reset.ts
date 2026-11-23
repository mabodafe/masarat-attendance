// Password resets (v2.1).
//
// Two ways a password gets reset, both ending the same way:
//   1. The employee taps "Forgot password?" -> a 'pending' row in password_resets.
//      An admin approves it -> a temporary password is generated and shown ONCE to
//      the admin, who passes it to the employee (in person / WhatsApp).
//   2. An admin presses "Reset password" on an employee -> same result, recorded
//      as source 'admin'.
// Either way the account is marked must_change_password = 1, so the temporary
// password only works until the employee sets their own, and any login lockout
// on that account is cleared so the employee can sign in straight away.
//
// The temporary password is never stored in plain text and never returned twice.
import { all, get, run } from '../db.ts';
import * as A from './auth.ts';
import * as T from './time.ts';

export const SETTING_REQUESTS = 'password_reset_requests';

// No 0/O, 1/l/I: the password is read aloud or typed from a WhatsApp message.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** 10 characters, always containing an upper, a lower and a digit. */
export function generateTempPassword(): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    // 256 is not a multiple of 54; reject the top slice so every character is uniform.
    if (bytes.some((b) => b >= 216)) continue;
    const pwd = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd) && /[2-9]/.test(pwd)) return pwd;
  }
}

export async function requestsEnabled(): Promise<boolean> {
  const row = await get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', SETTING_REQUESTS);
  return row ? row.value === 'on' : true; // default: on
}

export async function setRequestsEnabled(on: boolean, adminId: number): Promise<void> {
  await run(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?,?,?,?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
                                     updated_by = excluded.updated_by`,
    SETTING_REQUESTS, on ? 'on' : 'off', T.nowIso(), adminId,
  );
}

/** Removes every login-throttle row for this account, whatever IP it came from. */
export async function clearLockouts(user: { employee_code: string; email: string }): Promise<void> {
  // throttle keys are '<ip>|<lowercased identifier>' (see lib/auth.ts throttleKey).
  for (const id of [user.employee_code, user.email]) {
    const suffix = `|${String(id).toLowerCase()}`;
    await run('DELETE FROM login_attempts WHERE right(attempt_key, ?) = ?', suffix.length, suffix);
  }
}

/** Sets a fresh temporary password on the account and returns it (plain, once). */
export async function applyTempPassword(userId: number): Promise<string> {
  const user = await get<{ employee_code: string; email: string }>(
    'SELECT employee_code, email FROM users WHERE id = ?', userId);
  if (!user) throw new Error('user not found');
  const temp = generateTempPassword();
  await run(
    'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?',
    A.hashPassword(temp), T.nowIso(), userId,
  );
  await clearLockouts(user);
  return temp;
}

/** Employee-side request. Returns what happened, for the caller to decide the response. */
export async function createRequest(identifier: string): Promise<'created' | 'ignored'> {
  const user = await get<{ id: number; active: number }>(
    `SELECT id, active FROM users WHERE lower(email) = lower(?) OR lower(employee_code) = lower(?)`,
    identifier, identifier,
  );
  if (!user || !user.active) return 'ignored';
  // The partial unique index allows one pending row per user; a repeat is a no-op.
  const res = await run(
    `INSERT INTO password_resets (user_id, source, status, requested_at)
     VALUES (?, 'employee_request', 'pending', ?)
     ON CONFLICT (user_id) WHERE status = 'pending' DO NOTHING`,
    user.id, T.nowIso(),
  );
  return res.changes ? 'created' : 'ignored';
}

export async function list(status?: string): Promise<Record<string, unknown>[]> {
  const where = status ? 'WHERE r.status = ?' : '';
  return await all<Record<string, unknown>>(
    `SELECT r.id, r.user_id, r.source, r.status, r.requested_at, r.decided_at,
            u.employee_code, u.full_name, u.active, u.role,
            d.full_name AS decided_by_name
       FROM password_resets r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN users d ON d.id = r.decided_by
       ${where}
      ORDER BY (r.status = 'pending') DESC, r.requested_at DESC
      LIMIT 200`,
    ...(status ? [status] : []),
  );
}

export async function pendingCount(): Promise<number> {
  const row = await get<{ n: number }>("SELECT count(*) AS n FROM password_resets WHERE status = 'pending'");
  return Number(row?.n ?? 0);
}

/**
 * Approve or reject a pending request. The status flip is a single conditional
 * UPDATE, so two admins pressing at the same moment cannot both win.
 */
export async function decide(
  requestId: number, approve: boolean, adminId: number,
): Promise<{ ok: false; error: string; status: number } | { ok: true; temp_password?: string; user_id: number }> {
  const flipped = await run(
    `UPDATE password_resets SET status = ?, decided_at = ?, decided_by = ?
      WHERE id = ? AND status = 'pending'
      RETURNING user_id`,
    approve ? 'approved' : 'rejected', T.nowIso(), adminId, requestId,
  );
  if (!flipped.rows.length) {
    const exists = await get('SELECT id FROM password_resets WHERE id = ?', requestId);
    return exists
      ? { ok: false, error: 'This request has already been handled.', status: 400 }
      : { ok: false, error: 'Request not found.', status: 404 };
  }
  const userId = Number(flipped.rows[0].user_id);
  if (!approve) return { ok: true, user_id: userId };
  return { ok: true, user_id: userId, temp_password: await applyTempPassword(userId) };
}

/** Direct admin reset. Also closes any open request from the same employee. */
export async function adminReset(userId: number, adminId: number): Promise<string> {
  const now = T.nowIso();
  const temp = await applyTempPassword(userId);
  const closed = await run(
    `UPDATE password_resets SET status = 'approved', decided_at = ?, decided_by = ?
      WHERE user_id = ? AND status = 'pending'`,
    now, adminId, userId,
  );
  if (!closed.changes) {
    await run(
      `INSERT INTO password_resets (user_id, source, status, requested_at, decided_at, decided_by)
       VALUES (?, 'admin', 'approved', ?, ?, ?)`,
      userId, now, now, adminId,
    );
  }
  return temp;
}
