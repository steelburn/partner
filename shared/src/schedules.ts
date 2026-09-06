/**
 * M14 scheduled & autonomous work (PLAN-M14.md) — wire contracts.
 *
 * A persona may declare schedules inside its independence bundle:
 * `independence.schedules[]`. Each schedule says WHEN (a wall-clock
 * occurrence or a rolling interval) and WHAT (a prompt/brief delivered as an
 * autonomous tool-loop run). Schedule bodies are the owner's declarative
 * persona JSON — owner-only content like the rest of the persona; audit rows
 * carry ids and counts, never schedule text.
 *
 * Pure: types only, no runtime deps (shared rule). Field validation lives in
 * {@link validateSchedule} so core (persona manager) and web (editor) share
 * one rule set.
 */

/** 0 = Monday … 6 = Sunday (ISO-style week, plain number for JSON). */
export type ScheduleWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type ScheduleWhen =
  /** Fire daily at a wall-clock time in the schedule's timezone. */
  | { kind: 'daily'; hour: number; minute: number }
  /** Fire weekly on one weekday at a wall-clock time in the timezone. */
  | { kind: 'weekly'; weekday: ScheduleWeekday; hour: number; minute: number }
  /** Fire every N minutes, rolling from the previous run's anchor. */
  | { kind: 'interval'; everyMinutes: number };

export interface PersonaSchedule {
  /** Stable id, unique within the persona (uuid or client-supplied). */
  id: string;
  /** Human label — conversation title and run/audit label. 1…80 chars. */
  label: string;
  when: ScheduleWhen;
  /** The brief/task text delivered as the run's user turn. 1…4000 chars. */
  prompt: string;
  /** IANA timezone id; absent = the core's default timezone. */
  tz?: string;
  /** Default true when absent. */
  enabled?: boolean;
  /** Explicit conversation target; absent = the schedule's own thread. */
  conversationId?: string;
  /** Save the final answer as a note titled by the label. Default false. */
  saveNote?: boolean;
  /** Tool-loop round bound 1…8 (default = engine cap). */
  maxRounds?: number;
}

export const SCHEDULE_LIMITS = {
  /** Max schedules per persona. */
  maxSchedules: 20,
  labelMax: 80,
  promptMax: 4000,
  /** interval bounds, minutes. */
  intervalMin: 5,
  intervalMax: 10_080,
  /** Tool-loop round bound. */
  roundsMin: 1,
  roundsMax: 8,
} as const;

export type ScheduleValidation =
  | { ok: true; value: PersonaSchedule }
  | { ok: false; error: string };

export type ScheduleListValidation =
  | { ok: true; values: PersonaSchedule[] }
  | { ok: false; error: string };

const WEEKDAYS = new Set([0, 1, 2, 3, 4, 5, 6]);

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function clockError(field: string, label: string): string {
  return `${label} when.${field} must be an integer in range`;
}

/**
 * Validate + normalize one schedule draft. Errors are owner-facing (the
 * persona editor / API 400); message text never crosses audit.
 */
export function validateSchedule(raw: unknown, label: string): ScheduleValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${label} schedule must be an object` };
  }
  const body = raw as {
    id?: unknown;
    label?: unknown;
    when?: unknown;
    prompt?: unknown;
    tz?: unknown;
    enabled?: unknown;
    conversationId?: unknown;
    saveNote?: unknown;
    maxRounds?: unknown;
  };

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (id === '' || id.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(id)) {
    return { ok: false, error: `${label} schedule id must be 1…64 chars of [A-Za-z0-9._:-]` };
  }

  const entryLabel = typeof body.label === 'string' ? body.label.trim() : '';
  if (entryLabel === '' || entryLabel.length > SCHEDULE_LIMITS.labelMax) {
    return {
      ok: false,
      error: `${label} schedule label must be 1…${SCHEDULE_LIMITS.labelMax} chars`,
    };
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt === '' || prompt.length > SCHEDULE_LIMITS.promptMax) {
    return {
      ok: false,
      error: `${label} schedule prompt must be 1…${SCHEDULE_LIMITS.promptMax} chars`,
    };
  }

  const when = body.when;
  if (when === null || typeof when !== 'object' || Array.isArray(when)) {
    return { ok: false, error: `${label} schedule when is required` };
  }
  const kind = (when as { kind?: unknown }).kind;
  let normalizedWhen: ScheduleWhen;
  if (kind === 'daily') {
    const { hour, minute } = when as { hour?: unknown; minute?: unknown };
    if (
      !isWholeNumber(hour) ||
      hour < 0 ||
      hour > 23 ||
      !isWholeNumber(minute) ||
      minute < 0 ||
      minute > 59
    ) {
      return { ok: false, error: clockError('hour/minute', label) };
    }
    normalizedWhen = { kind: 'daily', hour, minute };
  } else if (kind === 'weekly') {
    const { weekday, hour, minute } = when as {
      weekday?: unknown;
      hour?: unknown;
      minute?: unknown;
    };
    if (!isWholeNumber(weekday) || !WEEKDAYS.has(weekday)) {
      return { ok: false, error: `${label} schedule weekday must be 0 (Monday)…6 (Sunday)` };
    }
    if (
      !isWholeNumber(hour) ||
      hour < 0 ||
      hour > 23 ||
      !isWholeNumber(minute) ||
      minute < 0 ||
      minute > 59
    ) {
      return { ok: false, error: clockError('hour/minute', label) };
    }
    normalizedWhen = { kind: 'weekly', weekday: weekday as ScheduleWeekday, hour, minute };
  } else if (kind === 'interval') {
    const { everyMinutes } = when as { everyMinutes?: unknown };
    if (
      !isWholeNumber(everyMinutes) ||
      everyMinutes < SCHEDULE_LIMITS.intervalMin ||
      everyMinutes > SCHEDULE_LIMITS.intervalMax
    ) {
      return {
        ok: false,
        error: `${label} schedule everyMinutes must be ${SCHEDULE_LIMITS.intervalMin}…${SCHEDULE_LIMITS.intervalMax}`,
      };
    }
    normalizedWhen = { kind: 'interval', everyMinutes };
  } else {
    return {
      ok: false,
      error: `${label} schedule when.kind must be daily|weekly|interval`,
    };
  }

  let tz: string | undefined;
  if (body.tz !== undefined && body.tz !== null) {
    if (typeof body.tz !== 'string') {
      return { ok: false, error: `${label} schedule tz must be an IANA timezone id` };
    }
    const candidate = body.tz.trim();
    if (candidate === '') return { ok: false, error: `${label} schedule tz must be a string` };
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    } catch {
      return { ok: false, error: `${label} schedule tz is not a valid IANA timezone: ${candidate}` };
    }
    tz = candidate;
  }

  let maxRounds: number | undefined;
  if (body.maxRounds !== undefined && body.maxRounds !== null) {
    if (!isWholeNumber(body.maxRounds)) {
      return { ok: false, error: `${label} schedule maxRounds must be an integer` };
    }
    const clamped = Math.min(
      SCHEDULE_LIMITS.roundsMax,
      Math.max(SCHEDULE_LIMITS.roundsMin, body.maxRounds),
    );
    if (clamped !== body.maxRounds) {
      return { ok: false, error: `${label} schedule maxRounds must be 1…${SCHEDULE_LIMITS.roundsMax}` };
    }
    maxRounds = clamped;
  }

  let conversationId: string | undefined;
  if (body.conversationId !== undefined && body.conversationId !== null) {
    if (typeof body.conversationId !== 'string' || body.conversationId.trim() === '') {
      return { ok: false, error: `${label} schedule conversationId must be a non-empty string` };
    }
    conversationId = body.conversationId;
  }

  const value: PersonaSchedule = {
    id,
    label: entryLabel,
    when: normalizedWhen,
    prompt,
    enabled: body.enabled !== false,
  };
  if (tz !== undefined) value.tz = tz;
  if (conversationId !== undefined) value.conversationId = conversationId;
  if (body.saveNote === true) value.saveNote = true;
  if (maxRounds !== undefined) value.maxRounds = maxRounds;
  return { ok: true, value };
}

/** Validate a whole schedules array (cap + per-entry rules). An absent/empty
 *  list normalizes to `[]` (no schedules). */
export function validateSchedules(raw: unknown, label: string): ScheduleListValidation {
  if (raw === undefined || raw === null) {
    return { ok: true, values: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: `${label} schedules must be an array` };
  }
  if (raw.length > SCHEDULE_LIMITS.maxSchedules) {
    return {
      ok: false,
      error: `${label} schedules exceeds the ${SCHEDULE_LIMITS.maxSchedules} cap`,
    };
  }
  const values: PersonaSchedule[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const result = validateSchedule(entry, `${label} schedules[${index}]`);
    if (!result.ok) return result;
    if (seen.has(result.value.id)) {
      return {
        ok: false,
        error: `${label} schedule id "${result.value.id}" is duplicated`,
      };
    }
    seen.add(result.value.id);
    values.push(result.value);
  }
  return { ok: true, values };
}

// ---------------------------------------------------------------------------
// Display-only next-run label (web schedule editor). Pure and zero-dependency
// (Intl only, like the validation above). It deliberately does NOT reproduce
// the core engine's DST-safe nextFire math (core/src/schedules/engine.ts) —
// it only labels the next civil wall-clock occurrence (today / tomorrow /
// this weekday) in the schedule's timezone, which is all a UI hint needs.
// Interval schedules return null (their next run is always "N minutes after
// the previous one finished", which needs the last-run anchor).
// ---------------------------------------------------------------------------

const NEXT_WEEKDAY_NAMES: readonly string[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

const WEEKDAY_SHORT: Readonly<Record<string, number>> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

interface WallClock {
  weekday: number;
  hour: number;
  minute: number;
}

function wallClockAt(epochMs: number, tz: string): WallClock | null {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return null;
  }
  const parts = formatter.formatToParts(new Date(epochMs));
  const read = (type: string): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  const hourRaw = read('hour');
  if (hourRaw === undefined) return null;
  // Some ICU builds emit '24' for midnight with hour12:false — normalize.
  const hour = hourRaw === '24' ? 0 : Number(hourRaw);
  const weekdayRaw = read('weekday');
  const weekday = weekdayRaw !== undefined ? WEEKDAY_SHORT[weekdayRaw] : undefined;
  if (weekday === undefined || !Number.isFinite(hour)) return null;
  return { weekday, hour, minute: Number(read('minute')) };
}

function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * A short, honest "when does this fire next" label for the schedule list,
 * e.g. `Next: today at 09:15` or `Next: Monday at 08:00`. Interval schedules
 * return null (no anchor here). Invalid/unknown timezones return null too
 * (the caller keeps showing only the static "when" summary).
 */
export function scheduleNextLabel(schedule: PersonaSchedule, nowEpochMs?: number): string | null {
  const when = schedule.when;
  if (when.kind === 'interval') return null;
  const tz = schedule.tz ?? systemTimeZone();
  const wall = wallClockAt(nowEpochMs ?? Date.now(), tz);
  if (wall === null) return null;
  const at = `${pad2(when.hour)}:${pad2(when.minute)}`;
  const passed =
    wall.hour > when.hour || (wall.hour === when.hour && wall.minute >= when.minute);
  if (when.kind === 'daily') {
    return `Next: ${passed ? 'tomorrow' : 'today'} at ${at}`;
  }
  const delta = (when.weekday - wall.weekday + 7) % 7;
  const days = delta === 0 && passed ? 7 : delta;
  if (days === 0) return `Next: today at ${at}`;
  if (days === 1) return `Next: tomorrow at ${at}`;
  const name = NEXT_WEEKDAY_NAMES[when.weekday];
  return name !== undefined ? `Next: ${name} at ${at}` : null;
}
