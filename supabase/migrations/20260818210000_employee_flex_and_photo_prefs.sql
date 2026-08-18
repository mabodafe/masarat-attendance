-- Per-employee overrides used by the admin console:
--   photo_policy    NULL by default on every existing row, meaning "follow the
--                   app-wide SELFIE_MODE setting" — nobody's behaviour changes
--                   until an admin explicitly sets 'off' / 'optional' / 'required'
--                   for a specific employee.
--   flexible_punch  0 (false) by default on every existing row, meaning "stay
--                   restricted to the assigned shift's time window", exactly as
--                   before. An admin can flip this to 1 per employee to let them
--                   check in/out at any time.
--
-- Both are additive, both preserve current behaviour for every existing
-- employee, and neither backfills or rewrites any existing data.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS photo_policy TEXT
    CHECK (photo_policy IS NULL OR photo_policy IN ('off', 'optional', 'required'));

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS flexible_punch INTEGER NOT NULL DEFAULT 0;
