/**
 * hello-skill (M8 sample) — pure skill, no tools, no network.
 *
 * Demonstrates the smallest possible skill: export a run(args) function and
 * return a JSON-serializable result. Imported by the worker harness, which
 * provides the `partner` global — this entry does not need it.
 */
export function run(args = {}) {
  const name = args && typeof args.name === 'string' && args.name !== '' ? args.name : 'world';
  return { hello: `from ${name}` };
}
