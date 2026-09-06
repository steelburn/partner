/**
 * M14 scheduled & autonomous work (PLAN-M14.md) — module surface.
 */
export {
  createScheduleManager,
  SCHEDULE_USER_TURN_CAP,
  SCHEDULE_NOTE_TEXT_CAP,
} from './manager.js';
export type {
  ScheduleManager,
  ScheduleManagerOptions,
  ScheduleRunReason,
  ScheduleRunView,
} from './manager.js';
export { ScheduleError, scheduleError, scheduleErrorStatus } from './errors.js';
export type { ScheduleErrorCode } from './errors.js';
export { nextFire, partsAt, epochOfCivil } from './engine.js';
export type { CivilParts } from './engine.js';
