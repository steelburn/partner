/**
 * Typed errors for the provider surface (M1, PLAN-M1.md).
 *
 * Codes map 1:1 onto loopback HTTP responses:
 *   invalid_kind / invalid_endpoint / invalid_input -> 400
 *   not_found                                  -> 404
 *   missing_key                                -> 409
 *   keychain_unavailable                       -> 500
 *   upstream                                   -> 502
 *
 * Messages are always safe to surface: they never contain a provider key,
 * keychain material, a pairing/session token, or an Authorization header.
 * Secrets never reach responses, logs, or audit details — logging funnels
 * through services/redaction.
 */
export type ProviderErrorCode =
  | 'invalid_kind'
  | 'invalid_endpoint'
  | 'invalid_input'
  | 'not_found'
  | 'missing_key'
  | 'keychain_unavailable'
  | 'upstream';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

export function providerError(code: ProviderErrorCode, message: string): ProviderError {
  return new ProviderError(code, message);
}
