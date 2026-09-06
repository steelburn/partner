/**
 * M14 schedule engine (PLAN-M14.md S3) — PURE next-fire math.
 *
 * Deterministic by construction: everything is a function of the descriptor,
 * an IANA timezone and an anchor instant; no clock, no store, no side
 * effects. Fire times are computed on CIVIL wall-clock fields in the
 * schedule's timezone (never by adding 24h to an instant), so DST
 * transitions stay well-defined.
 *
 * Daily/weekly occurrences that fall inside a DST spring-forward gap are
 * resolved by Intl's civil-time mapping (the wall time maps forward); the
 * engine does not invent or skip an occurrence.
 */
import type { ScheduleWhen } from '@partner/shared';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const WEEKDAY_SHORT: Readonly<Record<string, number>> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

export interface CivilParts {
  year: number;
  /** 1…12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Monday … 6 = Sunday */
  weekday: number;
}

let cachedTz: string | null = null;
let cachedFormatter: Intl.DateTimeFormat | null = null;

function formatterFor(tz: string): Intl.DateTimeFormat {
  if (cachedFormatter !== null && cachedTz === tz) return cachedFormatter;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  cachedFormatter = formatter;
  cachedTz = tz;
  return formatter;
}

/** Wall-clock parts of an instant in a timezone (cached formatter). */
export function partsAt(epochMs: number, tz: string): CivilParts {
  const parts = formatterFor(tz).formatToParts(new Date(epochMs));
  const read = (type: string): number | string => {
    const part = parts.find((p) => p.type === type);
    return part ? part.value : '';
  };
  const hourRaw = read('hour');
  // Intl with hour12:false can still emit '24' for midnight in some ICU
  // builds; normalize 24 -> 0.
  const hour = hourRaw === 24 ? 0 : Number(hourRaw);
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour,
    minute: Number(read('minute')),
    weekday: WEEKDAY_SHORT[String(read('weekday'))] ?? 0,
  };
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeap(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/** Civil date arithmetic (no instants): add whole days to (year, month, day). */
function civilAddDays(year: number, month: number, day: number, delta: number): [number, number, number] {
  let y = year;
  let m = month;
  let d = day + delta;
  for (;;) {
    const dim = daysInMonth(y, m);
    if (d <= dim) break;
    d -= dim;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  for (;;) {
    if (d >= 1) break;
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    d += daysInMonth(y, m);
  }
  return [y, m, d];
}

/** Weekday (0=Mon..6=Sun) of a CIVIL day (y,m,d) in tz — via its local noon. */
function civilWeekday(y: number, m: number, d: number, tz: string): number {
  return partsAt(epochOfCivil(y, m, d, 12, 0, tz), tz).weekday;
}

/** Epoch ms of a wall-clock civil time in tz. One offset pass at the
 *  UTC-interpreted guess (mktime-style): normal times resolve exactly; a
 *  time inside a spring-forward gap maps FORWARD to the first valid instant
 *  after the gap (the ECMAScript/date-lib convention); an ambiguous
 *  fall-back time resolves to its first (DST) occurrence. Deterministic. */
export function epochOfCivil(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const at = partsAt(guess, tz);
  const offsetMs =
    Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute, 0) - guess;
  return guess - offsetMs;
}

/** Civil date (y,m,d) of the instant's wall clock in tz. */
function civilDate(epochMs: number, tz: string): [number, number, number] {
  const p = partsAt(epochMs, tz);
  return [p.year, p.month, p.day];
}

/**
 * The first occurrence of `when` strictly after `after` (epoch ms), in `tz`.
 * For a daily/weekly schedule whose candidate wall time falls in a DST gap,
 * Intl's mapping resolves the instant (deterministic per ICU).
 */
export function nextFire(when: ScheduleWhen, tz: string, after: number): number {
  if (when.kind === 'interval') {
    return after + when.everyMinutes * MS_PER_MINUTE;
  }
  const hour = when.hour;
  const minute = when.minute;
  let [y, m, d] = civilDate(after, tz);

  if (when.kind === 'daily') {
    // Candidate today; if not strictly after, roll to tomorrow (civil).
    let candidate = epochOfCivil(y, m, d, hour, minute, tz);
    if (candidate <= after) {
      [y, m, d] = civilAddDays(y, m, d, 1);
      candidate = epochOfCivil(y, m, d, hour, minute, tz);
    }
    return candidate;
  }

  // weekly: walk up to 8 civil days to find the next matching weekday whose
  // wall time is strictly after `after`.
  for (let delta = 0; delta <= 7; delta += 1) {
    const [cy, cm, cd] = delta === 0 ? [y, m, d] : civilAddDays(y, m, d, delta);
    if (civilWeekday(cy, cm, cd, tz) !== when.weekday) continue;
    const candidate = epochOfCivil(cy, cm, cd, hour, minute, tz);
    if (candidate > after) return candidate;
  }
  // Unreachable: 8 consecutive days always contain the weekday.
  return after + 7 * MS_PER_DAY;
}
