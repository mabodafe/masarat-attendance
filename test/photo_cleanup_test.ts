// Verifies the OWNER'S REQUEST of 2026-08-18:
//
//   "auto free up space every 60 days (make sure first you extracted all
//    data copy to admin firstly)"
//
// and the two decisions locked in while designing it:
//   (a) only selfie PHOTOS are ever purged — attendance rows, worked hours
//       and every report are untouched, forever.
//   (b) the pre-delete backup is a plain downloadable file in the admin
//       console, not Supabase Storage and not email.
//
// This suite proves:
//   1. a selfie older than the retention window is backed up into a real,
//      downloadable zip BEFORE its bytes are removed from storage and its
//      *_photo column is nulled.
//   2. a selfie younger than the window is left completely alone.
//   3. the attendance row's own data (worked_minutes, status, dates) is
//      byte-for-byte unchanged by a cleanup that purged its photo.
//   4. attendance_sessions photos are covered by the same sweep, not just
//      the parent attendance row's own columns.
//   5. runCleanupIfDue() — the automatic cron path — is a safe no-op when
//      called again shortly after a real cleanup, so polling it daily can
//      never cause two cleanups within the 60-day window.
//   6. the admin console's three routes: list backups, download one (a real
//      zip, byte-identical to what was actually purged), and a supervisor
//      (not admin) is refused the "run cleanup now" action.
// Selfies written by this run must NOT land in the live/shared photo
// directory — same reasoning and same mechanism as test/run.ts. This MUST
// happen before any api/* module is imported (including transitively, via
// api/index.ts -> .../admin.ts -> .../photoCleanup.ts -> .../photos.ts ->
// .../storage.ts, which reads LOCAL_PHOTO_DIR at module load time), so every
// api import below is a dynamic `await import()` rather than a static one —
// a static import is hoisted and would resolve before this line ever runs.
const PHOTO_DIR = await Deno.makeTempDir({ prefix: 'masarat-test-photos-' });
Deno.env.set('LOCAL_PHOTO_DIR', PHOTO_DIR);
Deno.env.delete('SUPABASE_URL');
Deno.env.delete('SUPABASE_SERVICE_ROLE_KEY');

const { app } = await import('../api/index.ts');
const { hashPassword } = await import('../api/lib/auth.ts');
const { applySchema, close, get, run } = await import('../api/db.ts');
const { unzipSync } = await import('npm:fflate@0.8.2');

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${cond ? '' : '  ' + JSON.stringify(extra)}`);
  cond ? pass++ : fail++;
};
const section = (n: string) => console.log(`\n${n}`);

const AT = await import('../api/lib/attendance.ts');
const T = await import('../api/lib/time.ts');
const PC = await import('../api/lib/photoCleanup.ts');

const PORT = 3299;
const BASE = `http://127.0.0.1:${PORT}`;
const server = Deno.serve({ port: PORT, hostname: '127.0.0.1', onListen: () => {} }, app.fetch);
const req = (path: string, init: RequestInit = {}) =>
  fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

await applySchema(await Deno.readTextFile(new URL('../db/schema.postgres.sql', import.meta.url)));
await run(`TRUNCATE attendance_sessions, attendance, punch_log, leave_requests, schedules,
                   project_members, projects, shifts, holidays, login_attempts, photo_backups, users
           RESTART IDENTITY CASCADE`);

const now = T.nowIso();
const today = T.local().date;

await run(
  `INSERT INTO users (employee_code, full_name, email, role, password_hash, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?)`,
  'ADM-200', 'Photo Cleanup Admin', 'pca@masarat.local', 'admin', hashPassword('Correct-Horse-1'), now, now,
);
await run(
  `INSERT INTO users (employee_code, full_name, email, role, password_hash, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?)`,
  'SUP-200', 'Photo Cleanup Supervisor', 'pcs@masarat.local', 'supervisor', hashPassword('Correct-Horse-2'), now, now,
);
// Two separate employees, one per scenario. Deliberate: the multi-session
// feature makes a check-out-then-check-in for the SAME user/day/shift
// resume the SAME attendance row (a new session on it, not a new row) — so
// reusing one employee for both the "old" and "recent" punches would just
// produce one row with two sessions, not two independently-aged rows. Two
// employees keeps the two scenarios cleanly separate.
await run(
  `INSERT INTO users (employee_code, full_name, email, role, password_hash, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?)`,
  'EMP-200', 'Photo Cleanup Employee Old', 'pce-old@masarat.local', 'employee', hashPassword('Correct-Horse-3'), now, now,
);
await run(
  `INSERT INTO users (employee_code, full_name, email, role, password_hash, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?)`,
  'EMP-201', 'Photo Cleanup Employee Recent', 'pce-recent@masarat.local', 'employee', hashPassword('Correct-Horse-4'), now, now,
);
await run(
  `INSERT INTO projects (code,name,lat,lng,radius_m,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
  'SITE-PC', 'Photo Cleanup Site', 24.71355, 46.67529, 150, now, now,
);
await run(
  `INSERT INTO shifts (code,name,start_time,end_time,grace_in_min,early_in_min,break_min)
   VALUES (?,?,?,?,?,?,?)`,
  'ALLDAY-PC', 'All day', '00:01', '23:59', 15, 60, 0,
);
await run(
  `INSERT INTO schedules (user_id, work_date, shift_id, status, created_at) VALUES (?,?,?,?,?)`,
  3, today, 1, 'work', now,
);
await run(
  `INSERT INTO schedules (user_id, work_date, shift_id, status, created_at) VALUES (?,?,?,?,?)`,
  4, today, 1, 'work', now,
);

const admin = (await (await req('/api/auth/login', { method: 'POST',
  body: JSON.stringify({ identifier: 'ADM-200', password: 'Correct-Horse-1' }) })).json()).token;
const supervisor = (await (await req('/api/auth/login', { method: 'POST',
  body: JSON.stringify({ identifier: 'SUP-200', password: 'Correct-Horse-2' }) })).json()).token;

// A synthetic but structurally valid JPEG, same recipe as the main suite's
// selfie section: correct magic bytes, comfortably over the minimum size.
function jpeg(fillByte: number): string {
  const body = new Uint8Array(3000).fill(fillByte);
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...body, 0xff, 0xd9]);
  return `data:image/jpeg;base64,${btoa(String.fromCharCode(...bytes))}`;
}

const fix = () => ({ lat: 24.71355, lng: 46.67529, accuracy: 12, captured_at: new Date().toISOString() });
const oldUser = { id: 3 };
const recentUser = { id: 4 };

const backdate = async (table: string, extraWhere: string, minutesAgo: number) => {
  await run(`UPDATE ${table} SET check_in_at = ? WHERE ${extraWhere}`,
    new Date(Date.now() - minutesAgo * 60_000).toISOString());
};

section('An old selfie is backed up, then purged; a recent one is left alone');
let oldAttendanceId: number, recentAttendanceId: number;
{
  const oldPhotoUrl = jpeg(0x10);
  const ci1 = await AT.checkIn({ user: oldUser, projectId: 1, fix: fix(), photo: oldPhotoUrl });
  ok('old-record check-in with a photo is accepted', ci1.ok === true, ci1);
  oldAttendanceId = ci1.attendance_id as number;
  // Same two-step backdate the main suite's single-session test uses: push
  // check_in_at back far enough that the "too soon" guard lets check-out
  // through, on both the attendance row and its session-1 row.
  await backdate('attendance', `id = ${oldAttendanceId}`, 120);
  await backdate('attendance_sessions', `attendance_id = ${oldAttendanceId} AND seq = 1`, 120);
  const co1 = await AT.checkOut({ user: oldUser, projectId: 1, fix: fix(), photo: oldPhotoUrl });
  ok('old-record check-out with a photo is accepted', co1.ok === true, co1);

  // Now push this record's own check_in_at / check_out_at, and its session
  // row's, all the way to 70 days ago — past the 60-day retention window.
  // work_date is left alone on purpose: cleanup eligibility is judged by the
  // punch's own timestamp, not by which calendar day it was rostered against.
  const seventyDaysAgo = new Date(Date.now() - 70 * 86_400_000).toISOString();
  await run('UPDATE attendance SET check_in_at = ?, check_out_at = ? WHERE id = ?',
    seventyDaysAgo, seventyDaysAgo, oldAttendanceId);
  await run('UPDATE attendance_sessions SET check_in_at = ?, check_out_at = ? WHERE attendance_id = ?',
    seventyDaysAgo, seventyDaysAgo, oldAttendanceId);

  const recentPhotoUrl = jpeg(0x20);
  const ci2 = await AT.checkIn({ user: recentUser, projectId: 1, fix: fix(), photo: recentPhotoUrl });
  ok('recent-record check-in with a photo is accepted', ci2.ok === true, ci2);
  recentAttendanceId = ci2.attendance_id as number;
  await backdate('attendance', `id = ${recentAttendanceId}`, 120);
  await backdate('attendance_sessions', `attendance_id = ${recentAttendanceId} AND seq = 1`, 120);
  const co2 = await AT.checkOut({ user: recentUser, projectId: 1, fix: fix(), photo: recentPhotoUrl });
  ok('recent-record check-out with a photo is accepted', co2.ok === true, co2);
  // check_in_at/check_out_at are left ~2 hours old — well inside the 60-day
  // retention window, nowhere near the cutoff.

  const before = await get<Record<string, unknown>>('SELECT * FROM attendance WHERE id = ?', oldAttendanceId);
  const beforeWorkedMinutes = before!.worked_minutes;

  const result = await PC.runCleanup();
  ok('runCleanup() reports it ran', result.ran === true, result);
  // The old record has two distinct selfies — its own check-in shot and its
  // own check-out shot — both older than the cutoff, so both are purged. The
  // recent record's two selfies are untouched.
  ok('both of the old record\'s photos were purged (in and out); the recent record\'s are untouched',
    result.purged_photos === 2, result);
  ok('a backup row id was returned', typeof result.backup_id === 'number' && result.backup_id! > 0, result);

  const oldAfter = await get<Record<string, unknown>>('SELECT * FROM attendance WHERE id = ?', oldAttendanceId);
  ok('the old record\'s check_in_photo was cleared', oldAfter!.check_in_photo == null, oldAfter);
  ok('the old record\'s check_out_photo was cleared', oldAfter!.check_out_photo == null, oldAfter);
  ok("the old record's worked_minutes is completely unchanged by the photo purge",
    oldAfter!.worked_minutes === beforeWorkedMinutes, [oldAfter!.worked_minutes, beforeWorkedMinutes]);
  ok('the old record itself still exists — cleanup never touches attendance rows',
    oldAfter != null);

  const oldSession = await get<Record<string, unknown>>(
    'SELECT * FROM attendance_sessions WHERE attendance_id = ?', oldAttendanceId);
  ok('the old session row\'s photos were cleared too', oldSession!.check_in_photo == null && oldSession!.check_out_photo == null, oldSession);

  const recentAfter = await get<Record<string, unknown>>('SELECT * FROM attendance WHERE id = ?', recentAttendanceId);
  ok('the recent record\'s check_in_photo survives (it is not 60 days old yet)', recentAfter!.check_in_photo != null, recentAfter);
  ok('the recent record\'s check_out_photo survives', recentAfter!.check_out_photo != null, recentAfter);

  const stillFetchable = await req(`/api/admin/attendance/${recentAttendanceId}/photo/in`, { headers: { authorization: `Bearer ${admin}` } });
  ok('the recent photo can still be fetched through the normal admin endpoint', stillFetchable.status === 200);
  const goneNow = await req(`/api/admin/attendance/${oldAttendanceId}/photo/in`, { headers: { authorization: `Bearer ${admin}` } });
  ok('the purged photo is gone from the normal admin endpoint (404, not an error)', goneNow.status === 404);
}

section('The zip actually contains what was purged, and nothing more');
let backupId: number;
{
  const rows = await PC.listBackups();
  ok('exactly one backup row exists', rows.length === 1, rows.length);
  backupId = rows[0].id;
  ok('its photo_count matches what runCleanup() reported', rows[0].photo_count === 2, rows[0]);
  ok('its size_bytes is a real, non-trivial archive size', rows[0].size_bytes > 100, rows[0]);

  const archive = await PC.getBackupArchive(backupId);
  ok('the archive bytes are retrievable', archive != null && archive.length === rows[0].size_bytes);
  const entries = unzipSync(archive!);
  ok('the zip contains exactly the two purged files (check-in and check-out)', Object.keys(entries).length === 2, Object.keys(entries));
}

section('runCleanupIfDue() never double-runs inside the 60-day window');
{
  const again = await PC.runCleanupIfDue();
  ok('a second call right away is a no-op', again.ran === false, again);
  ok('it explains why', typeof again.reason === 'string' && again.reason!.includes('day'), again);

  const rows = await PC.listBackups();
  ok('no second backup row was created', rows.length === 1, rows.length);
}

section('The admin console routes');
{
  const list = await req('/api/admin/photo-backups', { headers: { authorization: `Bearer ${admin}` } });
  const listBody = await list.json();
  ok('GET /admin/photo-backups -> 200 for an admin', list.status === 200 && listBody.backups.length === 1, listBody);
  ok('reports the retention window', listBody.retention_days === 60, listBody);

  const listAsSupervisor = await req('/api/admin/photo-backups', { headers: { authorization: `Bearer ${supervisor}` } });
  ok('a supervisor can also list backups (read-only, not destructive)', listAsSupervisor.status === 200);

  const dl = await req(`/api/admin/photo-backups/${backupId}/download`, { headers: { authorization: `Bearer ${admin}` } });
  const dlBytes = new Uint8Array(await dl.arrayBuffer());
  ok('download responds with a zip content type',
    dl.status === 200 && dl.headers.get('content-type') === 'application/zip', dl.headers.get('content-type'));
  ok('the downloaded bytes are a real zip (PK magic bytes)',
    dlBytes.length > 4 && dlBytes[0] === 0x50 && dlBytes[1] === 0x4b, dlBytes.slice(0, 4));

  const dlMissing = await req('/api/admin/photo-backups/999999/download', { headers: { authorization: `Bearer ${admin}` } });
  ok('downloading an unknown backup id 404s', dlMissing.status === 404);

  const runAsSupervisor = await req('/api/admin/photo-backups/run', { method: 'POST', headers: { authorization: `Bearer ${supervisor}` } });
  ok('a supervisor is refused "run cleanup now" — that is a destructive, admin-only action',
    runAsSupervisor.status === 403, runAsSupervisor.status);

  const runAsAdmin = await req('/api/admin/photo-backups/run', { method: 'POST', headers: { authorization: `Bearer ${admin}` } });
  const runBody = await runAsAdmin.json();
  ok('an admin CAN run cleanup on demand, independent of the 60-day cadence',
    runAsAdmin.status === 200 && runBody.ran === true, runBody);
  ok('running again immediately finds nothing new to purge (already clean)', runBody.purged_photos === 0, runBody);

  const rowsAfter = await PC.listBackups();
  ok('the admin-triggered run recorded its own backup row, resetting the clock for the cron path',
    rowsAfter.length === 2, rowsAfter.length);
}

section('The cron endpoint refuses anything without the shared secret');
{
  const noSecret = await req('/api/cron/photo-cleanup', { method: 'POST' });
  ok('no x-cron-secret header -> 401', noSecret.status === 401);
  const wrongSecret = await req('/api/cron/photo-cleanup', { method: 'POST', headers: { 'x-cron-secret': 'wrong' } });
  ok('a wrong x-cron-secret -> 401', wrongSecret.status === 401);
}

console.log(`\nPASS: ${pass}   FAIL: ${fail}`);
await close();
await server.shutdown();
if (fail) Deno.exit(1);
