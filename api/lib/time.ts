// Direct port of server/lib/time.js. Pure functions, no I/O, no database.
// The maths is unchanged on purpose: this file decides which calendar day a punch
// belongs to and therefore which day gets paid. It is unit-tested by the suite.
//
// NOTE: dates stay 'YYYY-MM-DD' strings and timestamps stay ISO-8601 UTC strings,
// matching the Postgres schema, which deliberately keeps them as TEXT. The fixed
// company offset (TZ_OFFSET_MIN=180) is correct for Saudi Arabia — no DST.
import config from '../config.ts';

export const MS_MIN = 60_000;
const OFFSET_MS = config.tzOffsetMin * MS_MIN;

export interface LocalParts {
  date: string;
  hour: number;
  minute: number;
  minutesOfDay: number;
  hhmm: string;
  weekday: number; // 0 = Sunday
}

/** Server-authoritative "now" as an ISO UTC string. Device clocks are never used. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Company-local calendar/clock parts for a Date or ISO string. */
export function local(when: Date | string = new Date()): LocalParts {
  const d = when instanceof Date ? when : new Date(when);
  const shifted = new Date(d.getTime() + OFFSET_MS);
  const ymd = shifted.toISOString().slice(0, 10);
  const hh = shifted.getUTCHours();
  const mm = shifted.getUTCMinutes();
  return {
    date: ymd,
    hour: hh,
    minute: mm,
    minutesOfDay: hh * 60 + mm,
    hhmm: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
    weekday: shifted.getUTCDay(),
  };
}

/** 'HH:MM' -> minutes since local midnight. */
export function hhmmToMin(hhmm: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const min = Number(m[1]) * 60 + Number(m[2]);
  return min >= 0 && min < 1440 ? min : null;
}

export function minToHhmm(min: number): string {
  const v = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/** Shift the local calendar date string by whole days. */
export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isYmd(v: unknown): boolean {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

/** Inclusive list of local dates from -> to. Capped to avoid runaway ranges. */
export function dateRange(from: string, to: string, cap = 400): string[] {
  const out: string[] = [];
  let cur = from;
  while (cur <= to && out.length < cap) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/** Absolute UTC Date for a local date + minutes-of-day. */
export function localToUtc(ymd: string, minutesOfDay: number): Date {
  return new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() + minutesOfDay * MS_MIN - OFFSET_MS);
}

export function minutesBetween(aIso: string, bIso: string): number {
  return Math.round((new Date(bIso).getTime() - new Date(aIso).getTime()) / MS_MIN);
}
