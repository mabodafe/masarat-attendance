# PORTING CONTRACT — read this before changing anything

You are porting ONE file of a working, verified payroll application from
Node + Express + node:sqlite to Deno + Hono + PostgreSQL.

**This system produces the hours that wages are paid from.** A behaviour change is
a payroll bug. Your job is a faithful translation, NOT an improvement.

## ABSOLUTE RULES

1. **Do not change behaviour.** Every response body, HTTP status code, error
   message string, flag name, threshold, and field name must be byte-identical to
   the original. The test suite compares exact strings.
2. **Do not refactor, rename, reorder, or "clean up".** Keep the original function
   order, the original comments, and the original variable names.
3. **Do not add features, validation, logging, or dependencies.**
4. **Do not invent SQL.** Reuse every query string verbatim except for the five
   incompatibilities listed below.
5. If something is genuinely ambiguous, leave the original behaviour and add a
   `// PORT NOTE:` comment. Do not guess.

## Source and destination

- Source tree (read-only reference): `/tmp/proj/server/`
- Destination tree: `/tmp/masarat-pg/api/`
- Already ported, read these first — they define the conventions:
  - `/tmp/masarat-pg/api/db.ts` (data layer)
  - `/tmp/masarat-pg/api/config.ts`
  - `/tmp/masarat-pg/api/lib/time.ts`, `lib/geo.ts`, `lib/auth.ts`, `lib/photos.ts`
  - `/tmp/masarat-pg/api/lib/attendance.ts` (the reference for a hard port)
  - `/tmp/masarat-pg/api/routes/auth.ts` (the reference for a Hono route file)

## The data layer — identical names, now async

```ts
import { all, get, run, tx } from '../db.ts';

const rows = await all<T>('SELECT ... WHERE x = ?', x);   // T[]
const row  = await get<T>('SELECT ... WHERE id = ?', id); // T | null
const res  = await run('UPDATE ... WHERE id = ?', id);    // { changes, lastInsertRowid, rows }
await tx(async () => { ... });                            // commit / rollback
```

`?` placeholders are converted to `$1..$n` inside `db.ts`. **Keep the `?`.**
Booleans coerce to 0/1 and `undefined` to NULL automatically, as before.

## THE ONLY FIVE SQL CHANGES ALLOWED

| SQLite (original) | Postgres (required) |
| --- | --- |
| `col IS ?` | `col IS NOT DISTINCT FROM ?` — SQLite's `IS` is null-safe equality; Postgres rejects `IS $1` outright |
| `INSERT OR IGNORE INTO t ...` | `INSERT INTO t ... ON CONFLICT DO NOTHING` |
| `INSERT OR REPLACE INTO holidays (holiday_date, name) VALUES (?,?)` | `INSERT INTO holidays (holiday_date, name) VALUES (?,?) ON CONFLICT (holiday_date) DO UPDATE SET name = EXCLUDED.name` |
| `info.lastInsertRowid` | add `RETURNING id` to the INSERT, then read `info.lastInsertRowid` (db.ts populates it from the returned row) |
| `PRAGMA table_info(...)` | use `ensureColumn()` from db.ts |

`ON CONFLICT (...) DO UPDATE/NOTHING` already present in the original is **valid
Postgres — leave it exactly as it is.**

### A sixth change, found while porting reports.js

| SQLite (original) | Postgres (required) |
| --- | --- |
| `(? IS NULL OR id = ?)` | `(?::int IS NULL OR id = ?)` |

Postgres cannot infer the type of a parameter that only ever appears inside
`$n IS NULL`, and rejects the whole statement with *"could not determine data type
of parameter"*. Add the cast matching the compared column's type (`::int` for an
integer column, `::text` for a text one). The "null means all" semantics are
unchanged. This pattern appears in several optional-filter queries — expect it.

### Already fixed globally — do NOT patch this per call site

`count()` and `sum()` are bigint in Postgres, which postgres.js returns as a
**string**. That is now handled centrally by an int8 parser in `db.ts`, so
`SELECT count(*) AS n` gives you a real `number` again, exactly as SQLite did.
Do not wrap aggregates in `Number()` — it is unnecessary.

Everything else in the SQL is already portable: no `IFNULL`, `strftime`,
`julianday`, `GROUP_CONCAT`, or `printf` exists anywhere in this codebase.

## Express → Hono mapping (use exactly this, no variations)

```ts
import { Hono } from 'npm:hono@4.6.14';
export const xRoutes = new Hono();

// express: const router = express.Router(); router.use(A.requireAuth)
xRoutes.use('*', A.requireAuth);

// express: router.get('/x', (req,res) => res.json(o))
xRoutes.get('/x', async (c) => c.json(o));

// express: res.status(400).json({ error: 'msg' })
return c.json({ error: 'msg' }, 400);

// express: res.status(201).json(o)
return c.json(o, 201);

// express: req.user
const user = c.get('user') as SessionUser;

// express: req.body?.field   -> body() helper, copy it from routes/auth.ts
const b = await body(c);

// express: req.query.foo
const foo = c.req.query('foo');

// express: req.params.id
const id = c.req.param('id');

// express: role guard middleware on one route
xRoutes.post('/x', A.requireRole('admin'), async (c) => ...);

// express: req.ip
import { clientIp } from '../lib/auth.ts';  const ip = clientIp(c);

// express: req.headers['user-agent']
const ua = c.req.header('user-agent') ?? null;
```

**Route paths keep their exact original strings**, because the frontend and the
tests call them. `/api/admin` and `/api/me` prefixes are applied in `index.ts` —
inside a route file the paths are relative, exactly as with an express Router.

### Sending a non-JSON body (the punch-photo endpoint)
```ts
return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });
```

## Async gotchas that will silently break things

- `Array.prototype.filter/map/some/every` do NOT await. Replace
  `list.some(x => await f(x))` with a `for` loop, or `await Promise.all(...)`
  then filter. `attendance.ts` shows how `canUseProject` handles this.
- Every helper that touches the database is now async, including ones in
  `lib/attendance.ts`, `lib/leave.ts`, `lib/reports.ts`. Await them all.
- Arithmetic on `Date` objects needs `.getTime()` under TypeScript.

## Types

TypeScript, but pragmatic: `Record<string, unknown>` for database rows is fine.
Do not spend effort on elaborate types. It must pass `deno check`.

## Shared environment — do not break it for everyone else

A PostgreSQL 16 cluster is already running and is SHARED with other agents and
with the test suite:

```
DATABASE_URL=postgres://masarat:localdevonly@127.0.0.1:5432/masarat_test
```

- **Never** run `pg_ctlcluster ... stop`, `service postgresql stop`, or otherwise
  shut the cluster down. Another agent stopped it and broke the build.
- If you want to run a probe, `createdb` your own throwaway database, use it, then
  `dropdb` it. Do not TRUNCATE or DROP anything in `masarat_test`.

## When you are done

1. Run `deno check <your file>` from `/tmp/masarat-pg` and fix real errors.
2. Report: the file you produced, every `// PORT NOTE:` you added, and anything
   you could not port faithfully. **Do not claim it is tested** — the shared
   122-check suite is the gate and it runs later.
