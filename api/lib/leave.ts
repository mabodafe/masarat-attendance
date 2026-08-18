// Ported from server/lib/leave.js.
//
// Payroll-relevant: approving a request writes 'leave' onto the working calendar,
// which is what reports.ts later counts as leave_days. The logic is UNCHANGED;
// only the platform-forced differences below apply:
//
//   1. `await` on every all/get/run/tx call (node:sqlite was synchronous).
//   2. The INSERT in create() gained `RETURNING id` so info.lastInsertRowid still
//      works (db.ts populates it from the returned row).
//   3. The tx() callback is async, and the day loop stays a `for` loop so the
//      per-day get/run calls can be awaited.
//
// The ON CONFLICT(user_id, work_date) DO UPDATE clause was already in the
// original and is valid Postgres, so it is left byte-identical.
import { all, get, run, tx } from '../db.ts';
import * as T from './time.ts';

export const TYPES = ['annual', 'sick', 'unpaid', 'emergency'];
const MAX_SPAN_DAYS = 120;

function countDays(from: string, to: string): number {
  return T.dateRange(from, to, MAX_SPAN_DAYS + 1).length;
}

/** A new request may not overlap one that is already pending or approved. */
export function findOverlap(
  userId: number,
  from: string,
  to: string,
  excludeId = 0,
): Promise<Record<string, unknown> | null> {
  return get<Record<string, unknown>>(
    `SELECT * FROM leave_requests
      WHERE user_id = ? AND id <> ?
        AND status IN ('pending', 'approved')
        AND from_date <= ? AND to_date >= ?
      LIMIT 1`,
    userId, excludeId, to, from,
  );
}

export interface CreateInput {
  userId: number;
  leaveType: string;
  from: string;
  to: string;
  reason?: unknown;
}

export async function create(
  { userId, leaveType, from, to, reason }: CreateInput,
): Promise<Record<string, unknown>> {
  if (!TYPES.includes(leaveType)) return { ok: false, error: 'Choose a valid leave type.' };
  if (!T.isYmd(from) || !T.isYmd(to)) return { ok: false, error: 'Give valid start and end dates.' };
  if (to < from) return { ok: false, error: 'The end date is before the start date.' };

  const days = countDays(from, to);
  if (days > MAX_SPAN_DAYS) {
    return { ok: false, error: `A single request cannot cover more than ${MAX_SPAN_DAYS} days.` };
  }
  const clash = await findOverlap(userId, from, to);
  if (clash) {
    return { ok: false, error: `This overlaps a ${clash.status} request for ${clash.from_date} to ${clash.to_date}.` };
  }

  const now = T.nowIso();
  const info = await run(
    `INSERT INTO leave_requests (user_id, leave_type, from_date, to_date, days, reason, status, created_at)
     VALUES (?,?,?,?,?,?, 'pending', ?)
     RETURNING id`,
    userId, leaveType, from, to, days, reason ? String(reason).slice(0, 500) : null, now,
  );
  return { ok: true, id: Number(info.lastInsertRowid), days };
}

export interface DecideInput {
  requestId: number;
  deciderId: number;
  approve: unknown;
  note?: unknown;
}

/**
 * Approve or reject. Approving writes 'leave' onto the working calendar for
 * every working (or unrostered) day in the range; existing rest days and public
 * holidays are left as they are, so leave is not silently spent on days off.
 */
export async function decide(
  { requestId, deciderId, approve, note }: DecideInput,
): Promise<Record<string, unknown>> {
  const req = await get<Record<string, unknown>>('SELECT * FROM leave_requests WHERE id = ?', requestId);
  if (!req) return { ok: false, error: 'Leave request not found.' };
  if (req.status !== 'pending') return { ok: false, error: `This request is already ${req.status}.` };

  const now = T.nowIso();
  let applied = 0;

  await tx(async () => {
    await run(
      `UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
        WHERE id = ?`,
      approve ? 'approved' : 'rejected', deciderId, now,
      note ? String(note).slice(0, 500) : null, requestId,
    );
    if (!approve) return;

    for (const date of T.dateRange(req.from_date as string, req.to_date as string, MAX_SPAN_DAYS + 1)) {
      const existing = await get<{ status: string }>(
        'SELECT status FROM schedules WHERE user_id = ? AND work_date = ?', req.user_id, date);
      if (existing && existing.status !== 'work') continue; // keep rest days and holidays
      await run(
        `INSERT INTO schedules (user_id, work_date, shift_id, project_id, status, note, created_at)
         VALUES (?,?,NULL,NULL,'leave',?,?)
         ON CONFLICT(user_id, work_date) DO UPDATE SET
           status = 'leave', shift_id = NULL, project_id = NULL, note = excluded.note`,
        req.user_id, date, `${req.leave_type} leave (request #${requestId})`, now,
      );
      applied += 1;
    }
  });

  return { ok: true, status: approve ? 'approved' : 'rejected', days_applied: applied };
}

/** An employee may withdraw their own request while it is still pending. */
export async function cancel(
  { requestId, userId }: { requestId: number; userId: number },
): Promise<Record<string, unknown>> {
  const req = await get<Record<string, unknown>>('SELECT * FROM leave_requests WHERE id = ?', requestId);
  if (!req) return { ok: false, error: 'Leave request not found.' };
  if (req.user_id !== userId) return { ok: false, error: 'This is not your request.' };
  if (req.status !== 'pending') return { ok: false, error: `A ${req.status} request cannot be withdrawn.` };
  await run("UPDATE leave_requests SET status = 'cancelled', decided_at = ? WHERE id = ?", T.nowIso(), requestId);
  return { ok: true };
}

export interface ListInput {
  userId?: number | null;
  status?: string | null;
  from?: string | null;
  to?: string | null;
}

export function list(
  { userId = null, status = null, from = null, to = null }: ListInput,
): Promise<Record<string, unknown>[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (userId) { where.push('l.user_id = ?'); params.push(userId); }
  if (status) { where.push('l.status = ?'); params.push(status); }
  if (from && to) { where.push('l.from_date <= ? AND l.to_date >= ?'); params.push(to, from); }
  return all<Record<string, unknown>>(
    `SELECT l.*, u.full_name, u.employee_code, d.full_name AS decided_by_name
       FROM leave_requests l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN users d ON d.id = l.decided_by
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.from_date DESC`,
    ...params,
  );
}
