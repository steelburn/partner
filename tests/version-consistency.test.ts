/**
 * The released version — one number, 16 fields, 11 files.
 *
 * Partner ships ONE version for the whole app: the desktop shell embeds the
 * core bundle as a resource (`tauri.conf.json` → `bundle.resources` +
 * `externalBin: binaries/partner-core`), so shell N always contains core N and
 * there is no second thing to update. That makes every field below a copy of
 * the same fact — and a release commit that updates 15 of 16 of them ships a
 * lie that the user reads:
 *
 *   v0.1.23 shipped as `Partner_0.1.22_x64-setup.exe` (fixup 28097ff) because
 *   the release commit missed `tauri.conf.json`. The package CONTAINED v0.1.23
 *   while announcing 0.1.22 — which is what the installer filename, Windows'
 *   uninstall entry and the (future) updater manifest read.
 *
 * This test is the cheap half of the guard: it reads every carrier with its own
 * parser instead of trusting `scripts/version.mjs`, so a hand edit disagrees
 * with a different implementation, and it runs on both CI runners on every push
 * to master (the other half is the v* tag guard in `windows-build.yml`, which
 * fails a release build in seconds rather than in a published artifact).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');
const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(read(file)) as Record<string, unknown>;

/** Everything the extension manifest is NOT: see the last describe block. */
const WORKSPACES = ['shared', 'core', 'web', 'extension', 'shell'];

const release = readJson('package.json').version as string;

describe('every package.json carries the release version', () => {
  it('the release version is semver', () => {
    expect(release).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(['package.json', ...WORKSPACES.map((w) => `${w}/package.json`)])(
    '%s',
    (file) => {
      expect(readJson(file).version, file).toBe(release);
    },
  );
});

describe('the desktop bundle is the release version (what a user and the updater read)', () => {
  it('tauri.conf.json — installer name, uninstall entry, updater manifest', () => {
    expect(readJson('shell/src-tauri/tauri.conf.json').version).toBe(release);
  });

  it('Cargo.toml [package] version agrees with the bundle config', () => {
    // Tauri v2 prefers tauri.conf.json, so this cannot change what ships — it
    // is what `cargo metadata` and the .exe's own file properties report, and a
    // permanent 0.0.0 there is a stale number waiting to confuse a debugger.
    const cargo = read('shell/src-tauri/Cargo.toml');
    const found = /^\[package\]\r?\n(?:(?!\[)[^\n]*\r?\n)*?version = "([^"]+)"/m.exec(cargo);
    expect(found, 'the [package] version moved — update scripts/version.mjs').toBeTruthy();
    expect(found?.[1]).toBe(release);
  });

  it('Cargo.lock pins the same version (a --locked build would otherwise break)', () => {
    const lock = read('shell/src-tauri/Cargo.lock');
    const found = /name = "partner-shell"\r?\nversion = "([^"]+)"/.exec(lock);
    expect(found, 'the partner-shell lock entry moved').toBeTruthy();
    expect(found?.[1]).toBe(release);
  });
});

describe('the core claims the release version on /v1/health and /v1/boot', () => {
  it('CORE_VERSION (core/src/config.ts)', () => {
    // This is the field the SPA displays (web/src/lib/api.ts reads it off
    // /v1/health), which is also the correct number in hosted mode — the
    // browser there talks to a core that no shell version describes.
    const found = /export const CORE_VERSION = '([^']+)'/.exec(read('core/src/config.ts'));
    expect(found, 'CORE_VERSION moved — update scripts/version.mjs').toBeTruthy();
    expect(found?.[1]).toBe(release);
  });
});

describe('the lockfile records the release version for the root and every workspace', () => {
  const lock = readJson('package-lock.json') as {
    version?: string;
    packages: Record<string, { version?: string }>;
  };

  it('root version and packages[""]', () => {
    expect(lock.version).toBe(release);
    expect(lock.packages['']?.version).toBe(release);
  });

  it.each(WORKSPACES)('packages["%s"]', (name) => {
    expect(lock.packages[name]?.version, name).toBe(release);
  });
});

describe('scripts/version.mjs is the one writer, and it is green on this tree', () => {
  it('--check exits 0 and reports every carrier file', () => {
    // execFileSync throws on a non-zero exit, so this fails loudly on drift.
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'version.mjs'), '--check'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain(`agree: ${release}`);
    // A carrier cannot be quietly dropped from the script: every file this test
    // reads independently must be one the script reports on.
    for (const file of [
      'package.json',
      'shared/package.json',
      'core/package.json',
      'web/package.json',
      'extension/package.json',
      'shell/package.json',
      'core/src/config.ts',
      'shell/src-tauri/tauri.conf.json',
      'shell/src-tauri/Cargo.toml',
      'shell/src-tauri/Cargo.lock',
      'package-lock.json',
    ]) {
      expect(out, file).toContain(file);
    }
  });

  it('refuses a decreasing version (the updater compares them)', () => {
    // 0.0.1 is lower than any released version, so the write must be refused
    // before it touches a file. `--check` afterwards proves nothing changed.
    expect(() =>
      execFileSync(process.execPath, [join(ROOT, 'scripts', 'version.mjs'), '0.0.1'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).toThrow();
    expect(readJson('package.json').version).toBe(release);
  });
});

describe('the tag build refuses a tag that disagrees with the bundle version', () => {
  it('windows-build.yml guards the v* path before the expensive steps', () => {
    // The published installer is named from tauri.conf.json, so a mistyped or
    // forgotten tag is the difference between v0.1.27 and a file called
    // Partner_0.1.26_x64-setup.exe attached to the v0.1.27 release.
    const workflow = read('.github/workflows/windows-build.yml');
    expect(workflow).toContain('GITHUB_REF_NAME');
    expect(workflow).toContain('shell/src-tauri/tauri.conf.json');
    expect(workflow).toMatch(/TAG_VERSION_MISMATCH/);
  });
});

describe('the extension is deliberately on its own track', () => {
  it('extension/manifest.json is not a carrier of the app version', () => {
    // The extension is installed and updated separately (store or sideload),
    // so its manifest version is its own 0.x line and must NOT be forced to
    // agree — it is asserted here only so a future "sync the versions" edit
    // finds this comment first.
    const manifest = readJson('extension/manifest.json');
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
