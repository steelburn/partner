/**
 * Typed errors for the M8 skills surface (PLAN-M8.md).
 *
 * Codes map 1:1 onto loopback HTTP responses via {@link skillErrorStatus}:
 *   invalid_input            -> 400  (malformed manifest / catalog entry)
 *   network_not_supported    -> 400  (network:true refused in M8)
 *   not_found                -> 404  (unknown skill / catalog id / draft)
 *   conflict                 -> 409  (already installed; disable/enable of the
 *                                     same state; disabled invoke; a write to an
 *                                     already-installed draft)
 *   permission_change        -> 409  (M26 D6: an install/update that WIDENS a
 *                                     skill's permissions needs re-consent)
 *
 * Messages are always safe to surface — they never contain skill code, skill
 * logs, invocation args/results, secrets, file content, or a draft's source.
 */
export type SkillErrorCode =
  | 'invalid_input'
  | 'network_not_supported'
  | 'not_found'
  | 'conflict'
  | 'permission_change';

export class SkillError extends Error {
  readonly code: SkillErrorCode;

  constructor(code: SkillErrorCode, message: string) {
    super(message);
    this.name = 'SkillError';
    this.code = code;
  }
}

export function skillError(code: SkillErrorCode, message: string): SkillError {
  return new SkillError(code, message);
}

/** Loopback HTTP status for a SkillError code. */
export function skillErrorStatus(code: SkillErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'conflict':
    case 'permission_change':
      return 409;
    case 'network_not_supported':
    case 'invalid_input':
      return 400;
  }
}
