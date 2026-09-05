/**
 * M11 F11 folders module (PLAN-M11.md).
 *
 * Folders organize conversations into a user tree. Everything needed to wire
 * the surface in one place: manager + errors. The folders table + row store
 * live in core/src/stores (schema v12).
 */
export { createFolderManager } from './manager.js';
export type { FolderManager, FolderManagerOptions } from './manager.js';
export { FolderError, folderError, folderErrorStatus } from './errors.js';
export type { FolderErrorCode } from './errors.js';
