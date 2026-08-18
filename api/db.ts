// ===========================================================================
// Data layer — PostgreSQL (Supabase) replacement for server/db.js (node:sqlite)
//
// DESIGN DECISION THAT KEEPS THIS PORT SMALL:
// The old module exported four synchronous helpers — all(), get(), run(), tx().
// This module exports the SAME FOUR NAMES with the SAME ARGUMENT SHAPES, only
// async. That means the 172 existing call sites need `await` added and nothing
// else: no query rewriting, no ORM, no redesign. Every hand-written SQL string
// in lib/ and routes/ is reused verbatim, including its `?` placeholders, which
// are converted to Postgres `$1..$n` here.
//
// WHAT CHANGED VS SQLite, AND WHY (all verified against a live Postgres 16):
//   * `?` -> `$n`            done here, quote-aware so a `?` inside a SQL string
//                            literal is never mistaken for a placeholder.
//   * lastInsertRowid        SQLite returned it on every insert. Postgres does not.
//                            run() therefore exposes `lastInsertRowid` populated
//                            from a RETURNING clause when one is present, so the
//                            7 call sites that read it keep working.
//   * UNIQUE violation text  Postgres says "duplicate key value violates unique
//                            constraint", not "UNIQUE constraint". The old error
//                            handler grepped for the SQLite wording, so errors are
//                            normalised here with an explicit `isUniqueViolation`
//                            flag (SQLSTATE 23505) instead of string matching.
//   * PRAGMA table_info      replaced with information_schema for ensureColumn().
//   * booleans / undefined   node:sqlite rejected both; the same coercion is kept
//                            so behaviour is identical.
// ===========================================================================

import postgres from 'npm:postgres@3.4.5';

const connectionString = Deno.env.get('DATABASE_URL');
if (!connectionString) {
  throw new Error('[fatal] DATABASE_URL is not set.');
}

export const sql = postgres(connectionString, {
  // Supabase's pooler is the right target for a serverless runtime. Keep the
  // per-instance pool tiny: many short-lived isolates each holding a big pool
  // is how you exhaust a Postgres connection limit.
  max: Number(Deno.env.get('PG_POOL_MAX') ?? 3),
  idle_timeout: 20,
  connect_timeout: 10,
  // Dates and timestamps are TEXT in this schema by design (see schema comments),
  // so no date parsers are needed.
  //
  // BUT int8/bigint DOES need one. Postgres types count() and sum() as bigint, and
  // postgres.js returns bigint as a JavaScript STRING to avoid precision loss.
  // Under node:sqlite these came back as numbers, so without this every
  // `SELECT count(*) AS n` would silently start returning "17" instead of 17 —
  // breaking arithmetic (`"17" + 1` === "171") and changing JSON response bodies
  // that the frontend and the tests compare. Row counts here are employee-scale,
  // far below 2^53, so Number is safe and restores exact parity with SQLite.
  types: {
    int8AsNumber: {
      to: 20,
      from: [20],
      serialize: (x: number | string) => String(x),
      parse: (x: string) => Number(x),
    },
  },
  onnotice: () => {}, // suppress "relation already exists" chatter on boot
});

/**
 * Converts SQLite-style `?` placeholders to Postgres `$1..$n`.
 * Quote-aware: a `?` inside a single-quoted SQL literal or a double-quoted
 * identifier is left alone.
 */
export function toPgPlaceholders(text: string): string {
  let out = '';
  let n = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      out += c;
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (!inSingle && !inDouble && c === '-' && next === '-') {
      inLineComment = true;
      out += c;
      continue;
    }
    if (!inDouble && c === "'") {
      // '' is an escaped quote inside a literal
      if (inSingle && next === "'") {
        out += "''";
        i += 1;
        continue;
      }
      inSingle = !inSingle;
      out += c;
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      out += c;
      continue;
    }
    if (c === '?' && !inSingle && !inDouble) {
      n += 1;
      out += `$${n}`;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * node:sqlite refused JS booleans and undefined, so the original code normalised
 * every parameter. Kept identical: the schema still stores 0/1 integers for
 * active / must_change_password / crosses_midnight.
 */
function clean(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p === undefined) return null;
    return p;
  });
}

/** Adds a stable flag for unique-constraint violations (SQLSTATE 23505). */
function normaliseError(err: unknown): Error {
  const e = err as Error & { code?: string; isUniqueViolation?: boolean };
  if (e && e.code === '23505') e.isUniqueViolation = true;
  return e;
}

// A transaction-scoped connection, when inside tx(). postgres.js gives us a
// scoped `sql` inside its transaction callback; we stash it so that the shared
// all/get/run helpers automatically join the open transaction.
let txScope: ReturnType<typeof postgres> | null = null;
const active = () => txScope ?? sql;

export async function all<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
  try {
    const rows = await active().unsafe(toPgPlaceholders(text), clean(params) as never[]);
    return rows as unknown as T[];
  } catch (err) {
    throw normaliseError(err);
  }
}

export async function get<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T | null> {
  const rows = await all<T>(text, ...params);
  return rows.length ? rows[0] : null;
}

export interface RunResult {
  changes: number;
  /** Populated only when the statement carried a RETURNING clause. */
  lastInsertRowid: number | null;
  rows: Record<string, unknown>[];
}

export async function run(text: string, ...params: unknown[]): Promise<RunResult> {
  try {
    const rows = await active().unsafe(toPgPlaceholders(text), clean(params) as never[]);
    const arr = rows as unknown as Record<string, unknown>[];
    const first = arr.length ? arr[0] : null;
    const returnedId = first && 'id' in first ? Number(first.id) : null;
    return {
      changes: (rows as unknown as { count: number }).count ?? arr.length,
      lastInsertRowid: returnedId,
      rows: arr,
    };
  } catch (err) {
    throw normaliseError(err);
  }
}

/**
 * Same contract as the old synchronous tx(): run fn, COMMIT on return, ROLLBACK
 * on throw. Nested calls to all/get/run inside fn automatically use the
 * transaction's connection.
 */
export async function tx<T>(fn: () => Promise<T> | T): Promise<T> {
  if (txScope) return await fn(); // already inside a transaction: join it
  return await sql.begin(async (scoped) => {
    txScope = scoped as unknown as ReturnType<typeof postgres>;
    try {
      return await fn();
    } finally {
      txScope = null;
    }
  }) as T;
}

/**
 * Replaces the SQLite ensureColumn(), which used PRAGMA table_info.
 * Still additive-only and still idempotent, so the boot path is unchanged.
 */
export async function ensureColumn(table: string, column: string, ddl: string): Promise<boolean> {
  const found = await get(
    `SELECT 1 AS present FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
    table,
    column,
  );
  if (found) return false;
  await sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  console.log(`[migrate] added ${table}.${column}`);
  return true;
}

/** Applies schema.postgres.sql. Idempotent — every statement is IF NOT EXISTS. */
export async function applySchema(schemaText: string): Promise<void> {
  await sql.unsafe(schemaText);
}

export async function close(): Promise<void> {
  await sql.end({ timeout: 5 });
}
