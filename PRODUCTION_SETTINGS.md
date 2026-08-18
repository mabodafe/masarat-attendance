# Locked production settings — Masarat Site Attendance
Decided by Mohamed AboDaif, 2026-08-18. Every value below is verified by a test.

| Setting | Value | Meaning |
| --- | --- | --- |
| `ALLOW_OUT_OF_FENCE_WITH_FLAG` | **true** | **Open attendance.** Anyone can check in/out from anywhere. The punch is still recorded with coordinates, accuracy and true distance from the selected site, and tagged `out_of_fence` so the admin reviews it afterwards via the map link. |
| `MAX_ACCURACY_M` | 75 | A fix vaguer than ±75 m is still refused. "From anywhere" is not "without GPS". |
| `MAX_FIX_AGE_SEC` | 90 | A cached/replayed fix older than 90 s is still refused. |
| `MAX_CLOCK_SKEW_SEC` | 120 | Phone/server clock gap that raises a `clock_skew` flag. |
| Grace after start | **15 min** (`shifts.grace_in_min`) | Per shift, admin-editable. |
| Morning unpaid break | **60 min** (`shifts.break_min`) | Per shift, admin-editable — can be set to 0. |
| Rest days | **Friday only** | `import-masarat.ts --rest=5` (the default). |
| Shift assignment | Admin, per employee per day | Roster grid / `POST /api/admin/schedules`. |
| Project + location | Admin adds site with lat/lng/radius | `POST /api/admin/projects`. |
| Employee → project | Admin assigns; empty = all sites | `PATCH /api/admin/users/:id` `project_ids`. |
| `SELFIE_MODE` | `optional` | Change to `required` to deter buddy-punching (carries a privacy duty). |
| `TZ_OFFSET_MIN` / `TZ_LABEL` | 180 / Asia/Riyadh | Fixed offset; correct, Saudi Arabia has no DST. |
| `TOKEN_TTL_HOURS` | 12 | One work shift. |

## What the open-attendance choice means in practice
- An employee **can** punch from home. The system will accept it, flag it
  `out_of_fence`, and record how far away they were.
- The control is therefore **after the fact**: someone must review flagged punches.
  Admin → Attendance, filter *flagged*; and Admin → Punch log for the map link.
- Assignment still gates sites: an employee assigned to SITE-2 is **refused**
  outright on SITE-1 (`project_not_assigned`) even under the open policy.
- To tighten later, set `ALLOW_OUT_OF_FENCE_WITH_FLAG=false` and redeploy. No code
  change, and historical records are unaffected.
