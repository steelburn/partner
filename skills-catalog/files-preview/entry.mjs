/**
 * files-preview (M8 sample) — demonstrates BROKER ENFORCEMENT.
 *
 * The manifest declares tools ['files.read'] at risk 'medium'. Its entry
 * requests files.read through the worker harness' `partner.tools.exec`
 * global for the {projectId, path} pair it receives in args. The request is
 * REFUSED with tool_denied until the USER has granted files.read for that
 * project root — skills are non-interactive, so a missing grant is a hard
 * deny (default-deny; the grant must exist before invocation).
 *
 * The path stays inside the granted root because the broker's files.read
 * resolves it against the canonical root (files/paths.ts) — this skill can
 * never name a path outside the root the user granted.
 */
export async function run(args = {}) {
  const { projectId, path } = args;
  if (typeof projectId !== 'string' || projectId === '') {
    throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' });
  }
  if (typeof path !== 'string' || path === '') {
    throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' });
  }
  const result = await globalThis.partner.tools.exec('files.read', { projectId, path });
  return {
    bytes: typeof result.bytes === 'number' ? result.bytes : 0,
    chars: typeof result.content === 'string' ? result.content.length : 0,
  };
}
