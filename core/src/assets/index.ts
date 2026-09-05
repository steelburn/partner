/**
 * M11 F10 assets module (PLAN-M11.md).
 *
 * Typed saved artifacts per conversation; promote bridges into Notes (F6).
 * Table + row store live in core/src/stores (schema v12).
 */
export { createAssetManager, MAX_ASSET_BODY_CHARS } from './manager.js';
export type { AssetManager, AssetManagerOptions } from './manager.js';
export { AssetError, assetError, assetErrorStatus } from './errors.js';
export type { AssetErrorCode } from './errors.js';
