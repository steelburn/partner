/**
 * Typed errors for the M11 F10 asset surface (PLAN-M11.md).
 *
 * Codes map 1:1 onto loopback HTTP responses:
 *   invalid_input -> 400 (blank title/body/kind)
 *   too_large     -> 413 (body over the cap)
 *   not_found     -> 404 (unknown asset / scoped elsewhere)
 */
export type AssetErrorCode = 'invalid_input' | 'too_large' | 'not_found';

export class AssetError extends Error {
  readonly code: AssetErrorCode;

  constructor(code: AssetErrorCode, message: string) {
    super(message);
    this.name = 'AssetError';
    this.code = code;
  }
}

export function assetError(code: AssetErrorCode, message: string): AssetError {
  return new AssetError(code, message);
}

export function assetErrorStatus(code: AssetErrorCode): number {
  switch (code) {
    case 'too_large':
      return 413;
    case 'not_found':
      return 404;
    default:
      return 400;
  }
}
