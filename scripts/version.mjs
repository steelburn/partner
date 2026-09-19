#!/usr/bin/env node
/**
 * scripts/version.mjs — the ONE writer of the Partner release version.
 *
 * Partner ships ONE version number for the whole app. The desktop shell does
 * not host an independently-updated core: `tauri.conf.json` embeds the core
 * bundle (`core-bundle.cjs` + vendored natives) as `bundle.resources` and
 * registers `binaries/partner-core` as `externalBin`, so shell N always
 * contains core N by construction. Independent versioning would invent a
 * version matrix that the updater cannot compare and a user cannot read — so
 * every field below moves together or the release is wrong.
 *
 * That makes the number a fact that 16 fields in 11 files must agree on, which
 * is exactly the kind of fact a hand-edited release commit gets wrong. It did:
 * v0.1.23 shipped as `Partner_0.1.22_x64-setup.exe` (fixup 28097ff) because
 * `tauri.conf.json` was the one field the release commit missed — and that
 * field is what the installer name, Windows' uninstall entry and the future
 * updater manifest read.
 *
 * Usage:
 *   node scripts/version.mjs             # report every carrier; exit 1 on drift
 *   node scripts/version.mjs --check     # the same, spelled for CI
 *   node scripts/version.mjs 0.1.27      # write 0.1.27 into every carrier
 *
 * Not carriers, deliberately: `extension/manifest.json` (its own 0.x track — the
 * extension is installed and updated separately from the desktop app), the
 * schema version (`/v1/health.schemaVersion`, a data-format number), and any
 * build identity (a git SHA is a build stamp, not a release number).
 *
 * Guards that consume this file, so drift fails on the next push instead of in
 * a published artifact:
 *   * `tests/version-consistency.test.ts` — the root suite, both CI runners.
 *   * `windows-build.yml` tag guard — fails a v* build in seconds.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SEMVER = /^\d+\.\d+\.\d+$/;
const at = (file) => join(ROOT, file);

/**
 * One version field: `(prefix)(version)(suffix)`, matched exactly `count`
 * times. The match count is asserted, so if a field moves (or a package.json
 * grows a dependency literally named "version") the script stops with a loud
 * message instead of silently bumping the wrong thing or nothing at all.
 */
function field(pattern, count = 1) {
  const re = new RegExp(pattern, 'gm');
  return {
    read(text, file) {
      return matched(re, text, count, file)[0][2];
    },
    patch(text, version, file) {
      let out = '';
      let at = 0;
      for (const m of matched(re, text, count, file)) {
        out += text.slice(at, m.index) + m[1] + version + m[3];
        at = m.index + m[0].length;
      }
      // Only the version group is rewritten, so line endings (CRLF here),
      // indentation and comments survive untouched.
      return out + text.slice(at);
    },
  };
}

function matched(re, text, count, file) {
  const found = [...text.matchAll(re)];
  if (found.length !== count) {
    throw new Error(
      `${file}: expected ${count} version field match(es), found ${found.length}. ` +
        'The field moved — fix the carrier in scripts/version.mjs.',
    );
  }
  return found;
}

const PACKAGE_FILES = [
  'package.json',
  'shared/package.json',
  'core/package.json',
  'web/package.json',
  'extension/package.json',
  'shell/package.json',
];

/** Every field the released version lives in. Order = report order. */
export const CARRIERS = [
  ...PACKAGE_FILES.map((file) => ({
    file,
    label: '"version"',
    field: field('(\\s*"version": ")([^"]*)(")'),
  })),
  {
    file: 'core/src/config.ts',
    label: 'CORE_VERSION',
    // The core's own claim about itself: GET /v1/health + /v1/boot. The SPA
    // displays THIS (web/src/lib/api.ts), which is also correct in hosted mode
    // where the browser talks to a core that no shell version describes.
    field: field("(export const CORE_VERSION = ')([^']*)(';)"),
  },
  {
    file: 'shell/src-tauri/tauri.conf.json',
    label: 'bundle version',
    // Load-bearing: installer filename, Windows uninstall entry, updater
    // manifest. Tauri v2 prefers this over Cargo.toml.
    field: field('(\\s*"version": ")([^"]*)(")'),
  },
  {
    file: 'shell/src-tauri/Cargo.toml',
    label: '[package] version',
    // Cargo's fallback for the bundle version, and what `cargo metadata` and
    // the .exe's file properties report. Kept equal so the crate is honest
    // rather than a stale 0.0.0.
    field: field('(^\\[package\\]\\r?\\n(?:(?!\\[)[^\\n]*\\r?\\n)*?version = ")([^"]*)(")'),
  },
  {
    file: 'shell/src-tauri/Cargo.lock',
    label: 'partner-shell entry',
    // Pinned by the lockfile for path packages too, so a bump that skips it
    // breaks a `--locked` build later.
    field: field('(name = "partner-shell"\\r?\\nversion = ")([^"]*)(")'),
  },
  {
    file: 'package-lock.json',
    label: 'root + packages[""]',
    field: field('("name": "partner",\\r?\\n\\s*"version": ")([^"]*)(")', 2),
  },
  ...['shared', 'core', 'web', 'extension', 'shell'].map((name) => ({
    file: 'package-lock.json',
    label: `@partner/${name}`,
    field: field(`("name": "@partner/${name}",\\r?\\n\\s*"version": ")([^"]*)(")`),
  })),
];

/**
 * Read every carrier from disk. Throws if any field cannot be located.
 */
export function readCarriers() {
  const cache = new Map();
  const textOf = (file) => {
    if (!cache.has(file)) cache.set(file, readFileSync(at(file), 'utf8'));
    return cache.get(file);
  };
  return CARRIERS.map((c) => ({
    file: c.file,
    label: c.label,
    value: c.field.read(textOf(c.file), c.file),
  }));
}

function writeCarriers(version) {
  const files = [...new Set(CARRIERS.map((c) => c.file))];
  const changed = [];
  for (const file of files) {
    const before = readFileSync(at(file), 'utf8');
    let after = before;
    for (const c of CARRIERS.filter((c) => c.file === file)) {
      after = c.field.patch(after, version, c.file);
    }
    if (after !== before) writeFileSync(at(file), after);
    changed.push({ file, touched: after !== before });
  }
  // Self-check: the whole point of this script is that the tree AGREES.
  const drifted = readCarriers().filter((c) => c.value !== version);
  if (drifted.length > 0) {
    throw new Error(
      `wrote ${version} but ${drifted.length} carrier(s) still disagree: ` +
        drifted.map((c) => `${c.file} (${c.label}) = ${c.value}`).join('; '),
    );
  }
  return changed;
}

/**
 * True when `target` is not older than `current`. Equal is allowed and
 * expected: that is the REPAIR path (`node scripts/version.mjs 0.1.26` after a
 * hand edit left one carrier behind). Older is refused — the updater compares
 * these numbers, so a decreasing version is an update that never arrives.
 */
function notOlder(current, target) {
  const key = (v) => v.split('.').map(Number);
  const [a, b] = [key(current), key(target)];
  for (let i = 0; i < 3; i += 1) {
    if (b[i] !== a[i]) return b[i] > a[i];
  }
  return true;
}

function report(entries, expected) {
  const width = Math.max(...entries.map((c) => c.file.length));
  for (const c of entries) {
    const mark = c.value === expected ? '  ' : '!!';
    console.log(`${mark} ${c.file.padEnd(width)}  ${c.label.padEnd(22)} ${c.value}`);
  }
  const drifted = entries.filter((c) => c.value !== expected);
  if (drifted.length === 0) {
    console.log(`\nAll ${entries.length} fields across ${new Set(entries.map((c) => c.file)).size} files agree: ${expected}`);
    return 0;
  }
  console.error(
    `\n${drifted.length} of ${entries.length} fields disagree with package.json (${expected}).` +
      `\nThe desktop bundle, the core's /v1/health claim and every installer name must agree.` +
      `\nFix: node scripts/version.mjs ${expected}`,
  );
  return 1;
}

const arg = process.argv[2];

function main() {
  const entries = readCarriers();
  const current = entries.find((c) => c.file === 'package.json').value;

  if (arg === undefined || arg === '--check') {
    process.exit(report(entries, current));
  }

  if (!SEMVER.test(arg)) {
    console.error(`Not a semver release version: ${arg} (expected x.y.z)`);
    process.exit(2);
  }
  if (!notOlder(current, arg)) {
    console.error(
      `${arg} is older than the current ${current}.\n` +
        'The updater compares these numbers, so a decreasing version is an update that\n' +
        'never arrives. Fixups ride the NEXT release (v0.1.23 precedent); if you really\n' +
        'mean to go backwards, edit the carriers by hand.',
    );
    process.exit(2);
  }

  console.log(`${current} -> ${arg}\n`);
  for (const { file, touched } of writeCarriers(arg)) {
    console.log(`  ${file}${touched ? '' : '  (already correct)'}`);
  }
  console.log(
    `\nWrote ${entries.length} fields across ${new Set(entries.map((c) => c.file)).size} files. Next, in this commit:` +
      `\n  1. CHANGELOG.md — a new "## [${arg}] — <date>" section (and PLAN.md §15 / README status if the release completes a milestone)` +
      `\n  2. git commit -m "release: v${arg} — <what shipped>"` +
      `\n  3. git tag -a v${arg} && git push origin master v${arg}` +
      `\n     (windows-build.yml builds the NSIS installer, guards tag == bundle version, and posts it to the release)`,
  );
}

// Only when run as a program: importing this module (the version guard test)
// must never print a report or exit the host process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
