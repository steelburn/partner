/**
 * M11 F2 search module (PLAN-M11.md).
 *
 * Optional API-key search backend (Tavily/Brave). Config in settings, key in
 * the OS keychain, default-deny. No table needed (schema v12 unchanged).
 */
export { createSearchManager, SEARCH_SETTINGS_KEY, KEYCHAIN_ACCOUNT } from './manager.js';
export type { SearchManager, SearchManagerOptions } from './manager.js';
export { SearchError, searchError, searchErrorStatus } from './errors.js';
export type { SearchErrorCode } from './errors.js';
