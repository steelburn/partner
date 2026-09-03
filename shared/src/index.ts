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
