/**
 * M5 plans module index (PLAN-M5.md).
 *
 * Re-exports the plan manager + typed errors.
 */
export { PlanError, planError, planErrorStatus } from './errors.js';
export type { PlanErrorCode } from './errors.js';

export {
  createPlanManager,
  validateDocument,
  planSearchText,
  parseDocumentStored,
  TASK_STATUSES,
} from './manager.js';
export type {
  PlanExportBundle,
  PlanManager,
  PlanManagerOptions,
  PlanPatch,
} from './manager.js';
export type { TaskStatusInput } from '@partner/shared';
