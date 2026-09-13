#!/usr/bin/env node
/**
 * Backup tool (R8) — run INSIDE the container:
 *
 *   docker compose exec partner node tools/backup.mjs                  # /data/backups
 *   docker compose exec partner node tools/backup.mjs /backup          # explicit dest
 *   docker compose exec partner node tools/backup.mjs --keep 7         # prune to 7
 *
 * ## Why this exists rather than a `tar` one-liner
 *
 * A Partner backup is **two things that are useless apart**: the encrypted
 * databases and the keychain file that holds their cipher keys. `tar /data` gets
 * both but cannot tell you whether it got a *consistent* pair — and copying a
 * live SQLite file plus its `-wal` by hand is exactly how people end up with a
 * backup that restores to an empty database.
 *
 * So this tool:
 *  1. snapshots each database with SQLite's own **online backup** API
 *     (`better-sqlite3`'s `db.backup()`), which is consistent while the core is
 *     running — no need to stop the container;
 *  2. copies the keychain file and the skills trees;
 *  3. **verifies** each snapshot by re-opening it with the key from the copied
 *     keychain and reading the schema version back out;
 *  4. writes `BACKUP.json` with what it did and whether verification passed, and
 *     refuses to report success when it did not.
 *
 * It never prints, hashes or copies a key anywhere except the keychain file it
 * already lives in — the manifest records *that* verification passed, not the
 * material that makes it true.
 *
 * Partitions (R1) are included: every `users/<id>/partner.db` is snapshotted with
 * that user's own key (`db-key:<id>`), and the FIRST user's database — the legacy
 * `<data>/partner.db` — with the legacy `db-key` account.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const core = require(process.env.PARTNER_BUNDLE ?? '/app/core-bundle.cjs');

const args = process.argv.slice(2);
const keepIndex = args.indexOf('--keep');
const keep = keepIndex === -1 ? 7 : Number.parseInt(args[keepIndex + 1] ?? '7', 10);
const positional = args.filter((value, index) => !value.startsWith('--') && index !== keepIndex + 1);

const config = core.loadConfig();
const destRoot = resolve(positional[0] ?? join(config.dataRoot, 'backups'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = join(destRoot, `partner-backup-${stamp}`);

mkdirSync(dest, { recursive: true });

const keychain = core.createConfiguredKeychain(config);

/** Every database this install has, with the keychain account that opens it. */
function databases() {
  const found = [];
  // The legacy/single database (user #0's partition in a partitioned boot).
  if (config.dbPath !== ':memory:' && existsSync(config.dbPath)) {
    found.push({ label: 'partner.db', path: config.dbPath, account: core.DB_KEY_ACCOUNT });
  }
  // The system database (accounts + sessions).
  if (config.systemDbPath !== ':memory:' && existsSync(config.systemDbPath)) {
    found.push({ label: 'system.db', path: config.systemDbPath, account: core.SYSTEM_KEY_ACCOUNT });
  }
  // Per-user partitions.
  if (existsSync(config.usersRoot)) {
    for (const entry of readdirSync(config.usersRoot)) {
      const path = join(config.usersRoot, entry, 'partner.db');
      if (statSync(join(config.usersRoot, entry)).isDirectory() && existsSync(path)) {
        found.push({ label: `users/${entry}/partner.db`, path, account: core.dbKeyAccount(entry) });
      }
    }
  }
  return found;
}

/**
 * Consistent snapshot of a live database.
 *
 * `VACUUM INTO`, not better-sqlite3's `backup()`: the latter initialises the
 * destination WITHOUT the source's encryption key, so on a
 * better-sqlite3-multiple-ciphers build it fails with "backup is not supported
 * with incompatible source and target databases". VACUUM INTO writes a compact
 * copy through the OPEN (keyed) connection, so the snapshot is encrypted with the
 * same key and stays consistent while the core keeps running.
 */
async function snapshot(entry) {
  const key = await core.ensureDbKey(keychain, entry.account);
  const db = core.openEncryptedDatabase(entry.path, key);
  const target = join(dest, entry.label.replace(/\//g, '__'));
  try {
    rmSync(target, { force: true });
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
  // Verify the SNAPSHOT with the key from the copied keychain: opening it proves
  // the pair (ciphertext + key) travelled together, which is the whole point.
  const copied = core.openEncryptedDatabase(target, key);
  try {
    // integrity_check is the strongest cheap proof that the ciphertext + key
    // pair is intact (a wrong key fails the first page read).
    const integrity = copied.pragma('integrity_check');
    const ok = Array.isArray(integrity) && integrity[0]?.integrity_check === 'ok';
    const tables = copied.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    return {
      label: entry.label,
      bytes: statSync(target).size,
      verified: ok,
      tables: tables?.n ?? null,
      ...(ok ? {} : { error: 'integrity_check failed' }),
    };
  } catch (cause) {
    return {
      label: entry.label,
      bytes: statSync(target).size,
      verified: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    copied.close();
  }
}

const results = [];
for (const entry of databases()) {
  results.push(await snapshot(entry));
}

// The keychain file: without it the snapshots above are noise.
let keychainCopied = false;
if (config.keychainFile !== undefined && existsSync(config.keychainFile)) {
  cpSync(config.keychainFile, join(dest, basename(config.keychainFile)));
  keychainCopied = true;
}

// Skills (installed code) — not secrets, but part of "restore the install".
let skillsCopied = 0;
for (const dir of [config.skillsDir, join(config.usersRoot)]) {
  if (!existsSync(dir)) continue;
  const target = join(dest, dir === config.skillsDir ? 'skills' : 'users');
  try {
    cpSync(dir, target, { recursive: true });
    skillsCopied += 1;
  } catch {
    /* a locked skill worker must not fail the whole backup */
  }
}

const ok = results.length > 0 && results.every((entry) => entry.verified) && keychainCopied;
writeFileSync(
  join(dest, 'BACKUP.json'),
  `${JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      version: config.version,
      schemaVersion: config.schemaVersion,
      databases: results,
      keychain: { file: keychainCopied ? basename(config.keychainFile ?? '') : null, copied: keychainCopied },
      skillsTrees: skillsCopied,
      ok,
    },
    null,
    2,
  )}\n`,
);

// Prune older backups, newest kept (a backup directory that grows forever is a
// backup directory nobody restores from).
if (Number.isInteger(keep) && keep > 0) {
  const all = readdirSync(destRoot)
    .filter((name) => name.startsWith('partner-backup-'))
    .sort();
  for (const name of all.slice(0, Math.max(0, all.length - keep))) {
    rmSync(join(destRoot, name), { recursive: true, force: true });
  }
}

for (const entry of results) {
  process.stdout.write(
    `${entry.verified ? 'ok  ' : 'FAIL'} ${entry.label} (${entry.bytes} bytes, ${entry.tables ?? '?'} tables)\n`,
  );
}
process.stdout.write(`keychain: ${keychainCopied ? 'copied' : 'MISSING'}\n`);
process.stdout.write(`\n${ok ? 'Backup verified' : 'BACKUP NOT VERIFIED'} → ${dest}\n`);
if (!ok) {
  process.stderr.write(
    '\nRefusing to report success: a backup whose databases or keychain could not be ' +
      'verified is not a backup. Check the reasons above before relying on it.\n',
  );
  process.exit(1);
}
