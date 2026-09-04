/**
 * note-echo (M8 sample) — a PURE skill: no tools, no network.
 *
 * Proves the runtime path for skills that only transform their args. Nothing
 * here can touch the filesystem, the network or the browser: the manifest
 * declares tools [] and network false, and the broker would refuse any tool
 * request this code tried to make anyway (default-deny).
 */
export function run(args = {}) {
  const entries = Object.entries(args ?? {});
  const parts =
    entries.length === 0
      ? ['no arguments']
      : entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return {
    note: `note-echo received ${entries.length} argument(s): ${parts.join('; ')}`,
    argumentCount: entries.length,
  };
}
