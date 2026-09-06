/**
 * Typed errors for the M14 scheduled-work surface (PLAN-M14.md).
 *
 * Codes map 1:1 onto loopback HTTP responses (mirrors M9 playbooks):
 *   invalid_input   -> 400   (bad run filters / unknown shapes)
 *   not_found       -> 404   (unknown persona/schedule/run)
 *   conflict        -> 409   (run not waiting, approval not decided)
 *   persona_paused  -> 423   (paused persona refuses scheduled work)
 *   level_refused   -> 400   (independence below auto — schedules need the
 *                             auto/autonomous envelope)
 *   no_provider     -> 501   (tool loops REQUIRE a real provider)
 *
 * Messages are always safe to surface — schedule prompts, tool results and
 * transcript content never cross an error message, audit row or log.
 */
export type ScheduleErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'persona_paused'
  | 'level_refused'
  | 'no_provider';

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;

  constructor(code: ScheduleErrorCode, message: string) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
  }
}

export function scheduleError(code: ScheduleErrorCode, message: string): ScheduleError {
  return new ScheduleError(code, message);
}

/** Loopback HTTP status for a ScheduleError code. */
export function scheduleErrorStatus(code: ScheduleErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'persona_paused':
      return 423;
    case 'no_provider':
      return 501;
    default:
      return 400;
  }
}
