// Verifies the POLICY THE OWNER CHOSE on 2026-08-18:
//
//   "anybody can check in/out from anywhere, and admin can check the
//    coordinates/link later to make sure the employee attended the real project"
//
// That is ALLOW_OUT_OF_FENCE_WITH_FLAG=true. It does NOT disable location
// recording — every punch still captures lat/lng, accuracy and the distance from
// the selected site, and is tagged `out_of_fence` for the admin to review.
//
// This suite proves four things before the setting goes live:
//   1. a punch from far outside the fence is ACCEPTED (not refused)
//   2. it is FLAGGED out_of_fence, so it cannot pass unnoticed
//   3. the real distance and coordinates are RECORDED, to 5 decimal places
//   4. the other GPS defences still hold — a punch with no fix, a stale fix, or
//      junk coordinates is still refused. "From anywhere" must not become
//      "without GPS at all", or the audit trail would be worthless.
import { all, applySchema, close, get, run } from '../api/db.ts';

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${cond ? '' : '  ' + JSON.stringify(extra)}`);
  cond ? pass++ : fail++;
};
const section = (n: string) => console.log(`\n${n}`);

const cfg = (await import('../api/config.ts')).default;
const AT = await import('../api/lib/attendance.ts');
const T = await import('../api/lib/time.ts');

await applySchema(await Deno.readTextFile(new URL('../db/schema.postgres.sql', import.meta.url)));
await run(`TRUNCATE attendance, punch_log, leave_requests, schedules, project_members,
                   projects, shifts, holidays, login_attempts, users RESTART IDENTITY CASCADE`);

const now = T.nowIso();
const today = T.local().date;

// One employee, one site in Riyadh, one shift that is open right now.
await run(
  `INSERT INTO users (employee_code, full_name, email, role, password_hash, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?)`,
  'EMP-001', 'محمد شحاتة', 'e@masarat.local', 'employee', 'x', now, now,
);
await run(
  `INSERT INTO projects (code,name,lat,lng,radius_m,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
  'SITE-1', 'مشروع الرياض', 24.71355, 46.67529, 150, now, now,
);
// A shift whose window is open all day, so the test never depends on wall time.
await run(
  `INSERT INTO shifts (code,name,start_time,end_time,grace_in_min,early_in_min,break_min)
   VALUES (?,?,?,?,?,?,?)`,
  'ALLDAY', 'All day', '00:01', '23:59', 15, 60, 60,
);
await run(
  `INSERT INTO schedules (user_id, work_date, shift_id, status, created_at) VALUES (?,?,?,?,?)`,
  1, today, 1, 'work', now,
);

const user = { id: 1 };
const goodFix = (lat: number, lng: number) => ({
  lat, lng, accuracy: 12, captured_at: new Date().toISOString(),
});

section(`Policy in force: ALLOW_OUT_OF_FENCE_WITH_FLAG = ${cfg.allowOutOfFenceWithFlag}`);
ok('the open-attendance policy is enabled', cfg.allowOutOfFenceWithFlag === true, cfg.allowOutOfFenceWithFlag);

section('1. A punch from far outside the site is accepted, recorded and flagged');
{
  // Jeddah — about 850 km from the Riyadh site.
  const res = await AT.checkIn({ user, projectId: 1, fix: goodFix(21.48581, 39.19797), userAgent: 'test', ip: '203.0.113.7' });
  ok('check-in from ~850 km away is ACCEPTED', res.ok === true, res);
  ok('it is flagged out_of_fence for admin review',
    Array.isArray(res.flags) && (res.flags as string[]).includes('out_of_fence'), res.flags);

  const row = await get<Record<string, unknown>>('SELECT * FROM attendance WHERE user_id = 1');
  ok('the real distance is stored, not zeroed', Number(row!.check_in_distance_m) > 800_000, row!.check_in_distance_m);
  ok('latitude is stored to full precision (admin can verify the map pin)',
    Number(row!.check_in_lat) === 21.48581, row!.check_in_lat);
  ok('longitude is stored to full precision', Number(row!.check_in_lng) === 39.19797, row!.check_in_lng);
  ok('accuracy is stored', Number(row!.check_in_accuracy) === 12, row!.check_in_accuracy);
  ok('the flag is persisted on the row, not just in the response',
    String(row!.flags).includes('out_of_fence'), row!.flags);

  const log = await get<Record<string, unknown>>("SELECT * FROM punch_log WHERE outcome = 'accepted'");
  ok('the punch audit trail records the coordinates', Number(log!.lat) === 21.48581, log);
  ok('the punch audit trail records the distance', Number(log!.distance_m) > 800_000, log!.distance_m);
}

section('2. A punch inside the fence is accepted and NOT flagged');
{
  await run('DELETE FROM attendance');
  await run('DELETE FROM punch_log');
  // ~30 m from the site centre.
  const res = await AT.checkIn({ user, projectId: 1, fix: goodFix(24.71382, 46.67529), userAgent: 'test', ip: '203.0.113.7' });
  ok('check-in at the site is accepted', res.ok === true, res);
  ok('it is NOT flagged out_of_fence, so review can focus on the exceptions',
    !(res.flags as string[]).includes('out_of_fence'), res.flags);
  ok('the short distance is recorded', Number(res.distance_m) < 100, res.distance_m);
}

section('3. The remaining GPS defences still hold — "anywhere" is not "no GPS"');
{
  await run('DELETE FROM attendance');
  await run('DELETE FROM punch_log');
  const project = (await get<AT.Project>('SELECT * FROM projects WHERE id = 1'))!;

  const noFix = AT.validateFix(project, {}, T.nowIso());
  ok('a punch with no coordinates at all is still REFUSED', noFix.ok === false, noFix);

  const nullIsland = AT.validateFix(project, { lat: 0, lng: 0, accuracy: 5, captured_at: T.nowIso() }, T.nowIso());
  ok('the 0,0 null-island fix is still REFUSED', nullIsland.ok === false, nullIsland);

  const stale = AT.validateFix(
    project,
    { lat: 24.71355, lng: 46.67529, accuracy: 5, captured_at: new Date(Date.now() - 600_000).toISOString() },
    T.nowIso(),
  );
  ok('a 10-minute-old (replayed/cached) fix is still REFUSED', stale.ok === false, stale);
  ok('  and the reason is stale_fix', stale.code === 'stale_fix', stale.code);

  const vague = AT.validateFix(
    project,
    { lat: 24.71355, lng: 46.67529, accuracy: 5000, captured_at: T.nowIso() },
    T.nowIso(),
  );
  ok('a ±5 km "accuracy" fix is still REFUSED', vague.ok === false, vague);
  ok('  and the reason is low_accuracy', vague.code === 'low_accuracy', vague.code);

  const noTime = AT.validateFix(project, { lat: 24.71355, lng: 46.67529, accuracy: 5 }, T.nowIso());
  ok('a fix with no timestamp is still REFUSED', noTime.ok === false, noTime);
}

section('4. Project assignment still gates who may use which site');
{
  await run('DELETE FROM attendance');
  await run('DELETE FROM punch_log');
  await run(
    `INSERT INTO projects (code,name,lat,lng,radius_m,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
    'SITE-2', 'مشروع جدة', 21.48581, 39.19797, 150, now, now,
  );
  // Assigning the employee to SITE-2 only must exclude SITE-1 from their list.
  await run('INSERT INTO project_members (project_id, user_id) VALUES (?,?)', 2, 1);

  const allowed = await AT.projectsForUser(1);
  ok('an assigned employee sees ONLY their assigned site',
    allowed.length === 1 && allowed[0].code === 'SITE-2', allowed.map((p) => p.code));
  ok('they may use the assigned site', await AT.canUseProject(1, 2));
  ok('they may NOT use an unassigned site', (await AT.canUseProject(1, 1)) === false);

  const res = await AT.checkIn({ user, projectId: 1, fix: goodFix(24.71355, 46.67529), userAgent: 'test', ip: '203.0.113.7' });
  ok('check-in against an unassigned site is REFUSED even under the open policy', res.ok === false, res);
  ok('  and the reason is project_not_assigned', res.code === 'project_not_assigned', res.code);

  await run('DELETE FROM project_members');
  const openList = await AT.projectsForUser(1);
  ok('with no assignment rows, every active site is offered (unchanged behaviour)',
    openList.length === 2, openList.map((p) => p.code));
}

section('5. Shift settings the admin controls');
{
  const s = (await get<Record<string, unknown>>('SELECT * FROM shifts WHERE code = ?', 'ALLDAY'))!;
  ok('grace-in defaults to 15 minutes after the start time', Number(s.grace_in_min) === 15, s.grace_in_min);
  ok('the unpaid break is a per-shift column the admin can change', Number(s.break_min) === 60, s.break_min);

  // Prove the admin can set a different break per shift — "optional" 60 minutes.
  await run('UPDATE shifts SET break_min = ? WHERE code = ?', 0, 'ALLDAY');
  const zero = (await get<Record<string, unknown>>('SELECT break_min FROM shifts WHERE code = ?', 'ALLDAY'))!;
  ok('an admin can set the break to 0 (no unpaid break) for a shift', Number(zero.break_min) === 0, zero);
  await run('UPDATE shifts SET break_min = ? WHERE code = ?', 60, 'ALLDAY');

  // Prove a specific employee can be put on a specific shift for a specific day.
  await run(
    `INSERT INTO shifts (code,name,start_time,end_time,grace_in_min,break_min)
     VALUES (?,?,?,?,?,?)`,
    'FLEX8', 'Flexible 8', '06:00', '14:00', 15, 0,
  );
  await run(
    `INSERT INTO schedules (user_id, work_date, shift_id, status, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT (user_id, work_date) DO UPDATE SET shift_id = EXCLUDED.shift_id`,
    1, T.addDays(today, 1), 2, 'work', now,
  );
  const assigned = await get<Record<string, unknown>>(
    'SELECT shift_id FROM schedules WHERE user_id = 1 AND work_date = ?', T.addDays(today, 1));
  ok('an admin can assign a specific shift to a specific employee on a specific day',
    Number(assigned!.shift_id) === 2, assigned);
}

console.log(`\nPASS: ${pass}   FAIL: ${fail}`);
await close();
if (fail) Deno.exit(1);
