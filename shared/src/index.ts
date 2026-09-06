/**
 * Partner — shared contracts and helpers (zero runtime deps).
 *
 * This package is the compile-time seam between packages: writers implement
 * these interfaces; consumers depend only on them. If a cross-package shape
 * changes, change it here first.
 */
export * from './theme.js';
export * from './redact.js';
export * from './contracts.js';
export * from './provider.js';
export * from './tools.js';
export * from './persona.js';
export * from './schedules.js';
export * from './memory.js';
export * from './notes.js';
export * from './theming.js';
export * from './browser.js';
export * from './skills.js';
export * from './playbooks.js';
export * from './folders.js';
export * from './structured.js';
export * from './attachments.js';
export * from './assets.js';
export * from './vision.js';
export * from './mcp.js';
export * from './search.js';
