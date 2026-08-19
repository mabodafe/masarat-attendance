// Owner's request (2026-08-18): "auto free up space every 60 days (make sure
// first you extracted all data copy to admin firstly)". Locked-in decisions
// from that conversation, both load-bearing for the design below:
//   (a) scope is selfie PHOTOS ONLY — attendance rows, worked hours and every
//       report are kept forever, untouched by this feature.
//   (b) the pre-delete backup is a plain downloadable file in the admin
//       console (this module + the /admin/photo-backups routes), NOT
//       Supabase Storage and NOT email.
//
// Two entry points:
//   runCleanupIfDue() — called by the scheduled cron endpoint. Only actually
//     purges once RETENTION_DAYS have passed since the last backup row, so a
//     daily/hourly watchdog poke is always safe to run.
//   runCleanup()      — called by the admin's own "Run cleanup now" button.
//     Always executes; there is nothing unsafe about running it early, since
//     eligibility is judged by each photo's own age, not by a clock.
//
// Ordering inside runCleanup() is the entire point of this feature: the zip
// is built and its row COMMITTED to photo_backups before a single photo is
// deleted from object storage or a single *_photo column is cleared. If the
// process dies between those two steps, the worst case is a photo that is
// backed up but not yet deleted — never the other way around.
import { all, get, run as sqlRun } from '../db.ts';
import * as T from './time.ts';
import { readPunchPhoto, deletePhoto } from './photos.ts';
import { zipSync } from 'npm:fflate@0.8.2';

export const RETENTION_DAYS = 60;

export interface CleanupResult {
  ran: boolean;
  purged_photos: number;
  backup_id: number | null;
  reason?: string;
}

export interface BackupRow {
  id: number;
  created_at: string;
  cutoff_at: string;
  photo_count: number;
  size_bytes: number;
}

function cutoffIso(nowIso: string): string {
  return new Date(Date.parse(nowIso) - RETENTION_DAYS * 86_400_000).toISOString();
}

// Both attendance and attendance_sessions carry their own check_in_photo /
// check_out_photo columns (one row per session since the multi-session
// feature shipped) — a photo is eligible the moment its OWN punch is older
// than the cutoff, regardless of how long the rest of that shift's row has
// been open.
async function collectExpiredKeys(cutoff: string): Promise<string[]> {
  const rows = await all<Record<string, unknown>>(
    `SELECT check_in_at, check_in_photo, check_out_at, check_out_photo FROM attendance
      WHERE (check_in_photo IS NOT NULL AND check_in_at < ?)
         OR (check_out_photo IS NOT NULL AND check_out_at < ?)
     UNION ALL
     SELECT check_in_at, check_in_photo, check_out_at, check_out_photo FROM attendance_sessions
      WHERE (check_in_photo IS NOT NULL AND check_in_at < ?)
         OR (check_out_photo IS NOT NULL AND check_out_at < ?)`,
    cutoff, cutoff, cutoff, cutoff,
  );
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.check_in_photo && (r.check_in_at as string) < cutoff) keys.add(r.check_in_photo as string);
    if (r.check_out_photo && r.check_out_at && (r.check_out_at as string) < cutoff) keys.add(r.check_out_photo as string);
  }
  return [...keys];
}

/** Unconditional: backs up and purges every selfie older than RETENTION_DAYS. */
export async function runCleanup(nowIso: string = T.nowIso()): Promise<CleanupResult> {
  const cutoff = cutoffIso(nowIso);
  const keys = await collectExpiredKeys(cutoff);

  const entries: Record<string, Uint8Array> = {};
  for (const key of keys) {
    const bytes = await readPunchPhoto(key);
    if (bytes) entries[key] = bytes;
  }
  // zipSync with zero entries still produces a real, openable (empty) zip —
  // verified locally — so a "nothing was old enough yet" run still leaves a
  // genuine archive behind, and the automatic cadence still gets a fresh
  // watermark to measure the next 60 days from.
  const archive = zipSync(entries, { level: 6 });

  const inserted = await sqlRun(
    `INSERT INTO photo_backups (created_at, cutoff_at, photo_count, size_bytes, archive)
     VALUES (?,?,?,?,?) RETURNING id`,
    nowIso, cutoff, Object.keys(entries).length, archive.length, archive,
  );
  const backupId = inserted.lastInsertRowid;

  // Only AFTER the backup is safely committed does anything get deleted.
  for (const key of Object.keys(entries)) await deletePhoto(key);
  await sqlRun(`UPDATE attendance SET check_in_photo = NULL WHERE check_in_photo IS NOT NULL AND check_in_at < ?`, cutoff);
  await sqlRun(`UPDATE attendance SET check_out_photo = NULL WHERE check_out_photo IS NOT NULL AND check_out_at < ?`, cutoff);
  await sqlRun(`UPDATE attendance_sessions SET check_in_photo = NULL WHERE check_in_photo IS NOT NULL AND check_in_at < ?`, cutoff);
  await sqlRun(`UPDATE attendance_sessions SET check_out_photo = NULL WHERE check_out_photo IS NOT NULL AND check_out_at < ?`, cutoff);

  return { ran: true, purged_photos: Object.keys(entries).length, backup_id: backupId };
}

/** The automatic cron path: a no-op unless RETENTION_DAYS have passed since the last backup row. */
export async function runCleanupIfDue(nowIso: string = T.nowIso()): Promise<CleanupResult> {
  const last = await get<{ created_at: string }>('SELECT created_at FROM photo_backups ORDER BY created_at DESC LIMIT 1');
  if (last) {
    const daysSince = (Date.parse(nowIso) - Date.parse(last.created_at)) / 86_400_000;
    if (daysSince < RETENTION_DAYS) {
      return {
        ran: false, purged_photos: 0, backup_id: null,
        reason: `last cleanup ran ${Math.floor(daysSince)} day(s) ago; next one is due at ${RETENTION_DAYS} days`,
      };
    }
  }
  return await runCleanup(nowIso);
}

export async function listBackups(): Promise<BackupRow[]> {
  return await all<BackupRow>(
    `SELECT id, created_at, cutoff_at, photo_count, size_bytes FROM photo_backups ORDER BY created_at DESC`,
  );
}

export async function getBackupArchive(id: number): Promise<Uint8Array | null> {
  const row = await get<{ archive: Uint8Array }>('SELECT archive FROM photo_backups WHERE id = ?', id);
  return row ? row.archive : null;
}
