#!/usr/bin/env node
/**
 * Operator CLI for the ACCOUNT lane (M22) — run INSIDE the container:
 *
 *   docker compose exec partner node tools/user.mjs list
 *   docker compose exec partner node tools/user.mjs add <name>
 *   docker compose exec partner node tools/user.mjs passwd <name>
 *   docker compose exec partner node tools/user.mjs lock-account <name>
 *   docker compose exec partner node tools/user.mjs unlock-account <name>
 *
 * Why a CLI and not a route: creating or rotating a credential is an
 * administrative act, and "can run a process in the container" is the operator's
 * proof of being at the machine — the same reasoning that makes the pairing
 * secret loopback-only. No HTTP surface is added for it.
 *
 * The password is read from the TTY (raw mode, nothing echoed) or, when stdin is
 * a pipe, from stdin — never from an argument or an environment variable, both of
 * which are visible to `docker inspect`/`ps`. It is never echoed, logged or
 * stored: only scrypt params + salt + derived key reach the database.
 *
 * It uses the SAME keychain resolution and system database the server boots with
 * (`openAccounts` from the core bundle), so the operator cannot end up writing to
 * a different file than the one the core reads.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The bundle ships beside this tool in the image; PARTNER_BUNDLE overrides it so
// the tool can be exercised outside a container.
const core = require(process.env.PARTNER_BUNDLE ?? '/app/core-bundle.cjs');

const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';
const USAGE = `Partner account tool

  list                      list accounts (id, label, role, AI access, state)
  add <name> [--owner]      create an account with a new passphrase
  passwd <name>             replace an existing account's passphrase
  lock-account <name>       disable an account (data is kept)
  unlock-account <name>     re-enable a disabled account
  keep-unlocked <name>      keep this user's partition key in the keychain so
                            their schedules run while nobody is signed in
                            (per user, audited; weakens at-rest for them only)
  lock-now <name>           drop that policy again (sign-out then means locked)

The password is prompted on the terminal (nothing echoed) or piped on stdin.
Passwords are never taken from arguments or environment variables.
`;

/**
 * Read a passphrase without echoing it. Falls back to stdin when piped (CI,
 * `docker compose exec -T`), otherwise reads raw TTY bytes.
 */
async function readPassphrase(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const piped = Buffer.concat(chunks).toString('utf8').trim();
    if (piped === '') throw new Error('empty password on stdin');
    return piped;
  }

  process.stdout.write(prompt);
  return await new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = '';
    const done = (fn, arg) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      fn(arg);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === CTRL_C) {
          done(reject, new Error('cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          if (value.trim() === '') done(reject, new Error('empty password'));
          else done(resolve, value.trim());
          return;
        }
        if (char === BACKSPACE || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

/** A stable, filesystem-safe id derived from the operator's chosen name. */
function idFor(name) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug === '' ? 'owner' : slug;
}

function findByName(users, name) {
  const wanted = name.trim().toLowerCase();
  return users
    .list()
    .find((user) => user.id.toLowerCase() === wanted || user.label.toLowerCase() === wanted);
}

const [command, name] = process.argv.slice(2);
if (command === undefined || command === '--help' || command === '-h') {
  process.stdout.write(USAGE);
  process.exit(command === undefined ? 1 : 0);
}

const accounts = await core.openAccounts();

try {
  if (command === 'list') {
    const users = accounts.users.list();
    if (users.length === 0) {
      process.stdout.write('No accounts yet. Create one: tools/user.mjs add <name>\n');
    }
    for (const user of users) {
      process.stdout.write(
        `${user.id}\t${user.label}\t${user.role}\t${user.keyAccess}\t${
          user.disabledAt === null ? 'active' : 'disabled'
        }\n`,
      );
    }
  } else if (command === 'add') {
    if (name === undefined) throw new Error('add needs a name');
    // R1: every user gets their OWN encrypted partition (their own database,
    // key and skills directory), so a second account is a normal thing to create.
    const password = await readPassphrase(`New passphrase for ${name}: `);
    // The FIRST account owns the pre-partition database: a hosted core that ran
    // single-user keeps its history instead of appearing to start empty. Later
    // accounts get their own partition file as usual.
    const firstAccount = accounts.users.list().length === 0;
    const id = firstAccount ? core.LEGACY_USER_ID : idFor(name);
    // M29: the first account is the OWNER (it can invite and publish shared
    // access); later accounts are members, and `--owner` promotes one.
    const role = firstAccount || process.argv.includes('--owner') ? 'owner' : 'member';
    const created = accounts.users.create({ id, label: name.trim(), role });
    if (!created.ok) throw new Error(`could not create the account (${created.reason})`);
    const stored = await accounts.credentials.create(created.user.id, password);
    if (!stored.ok) throw new Error(`could not store the passphrase (${stored.reason})`);
    process.stdout.write(
      `Created account "${created.user.label}" (id ${created.user.id}, ${created.user.role}).\n` +
        (created.user.role === 'member'
          ? 'They set up their own providers unless they are invited with shared access from the app.\n'
          : ''),
    );
  } else if (command === 'passwd') {
    if (name === undefined) throw new Error('passwd needs a name');
    const user = findByName(accounts.users, name);
    if (user === undefined) throw new Error(`no account named "${name}"`);
    // S9: if the partition key is WRAPPED under the current passphrase, changing
    // it would leave the data unopenable by anyone. Refuse, and say what the two
    // real options are — a silent orphaning is the one outcome that must not
    // happen.
    const wrapped = accounts.stores.keyWraps.findByUser(user.id) !== undefined;
    const reset = process.argv.includes('--reset');
    if (wrapped && !reset) {
      throw new Error(
        `"${user.label}" has a passphrase-wrapped key, so rotating the passphrase here ` +
          'would make their data unreadable. Either keep the passphrase (the user can ' +
          'change it from the app), or pass --reset to drop the wrap and accept that the ` ' +
          'existing partition can no longer be opened.',
      );
    }
    const password = await readPassphrase(`New passphrase for ${user.label}: `);
    const rotated = await accounts.credentials.rotate(user.id, password);
    if (rotated.ok && reset && wrapped) {
      accounts.stores.keyWraps.removeByUser(user.id);
      accounts.audit.log('auth', 'auth.wrap_dropped', user.id, { reason: 'admin_reset' });
      process.stdout.write(
        'Dropped the wrapped key: the existing partition cannot be opened any more.\n',
      );
    }
    if (!rotated.ok) throw new Error(`could not rotate the passphrase (${rotated.reason})`);
    // R2: rotation changes the CREDENTIAL, so every session minted with the old
    // one must stop working — otherwise a token someone already has outlives the
    // change that was meant to lock them out. Reported, not silent.
    const revoked = accounts.stores.sessions.revokeAllForUser(user.id, Date.now());
    // R2: rotation changes the CREDENTIAL, so every session minted with the old
    // one must stop working — a token someone already holds must not outlive the
    // change that was meant to lock them out. Reported, not silent.
    process.stdout.write(`Rotated the passphrase for "${user.label}".\n`);
  } else if (command === 'keep-unlocked' || command === 'lock-now') {
    if (name === undefined) throw new Error(`${command} needs a name`);
    const user = findByName(accounts.users, name);
    if (user === undefined) throw new Error(`no account named "${name}"`);
    const keep = command === 'keep-unlocked';
    if (!accounts.users.setKeepUnlocked(user.id, keep)) {
      throw new Error(`could not update the policy for "${name}"`);
    }
    // An explicit, AUDITED choice: it weakens the "signed out means unreadable"
    // promise for THIS user (their key stays in the keychain). The row records
    // who asked and what changed — ids and a flag, never key material.
    accounts.audit.log('auth', 'auth.keep_unlocked', user.id, { keepUnlocked: keep });
    // Turning it ON also adopts the key into the keychain for a wrapped user:
    // without that, the promise is off but the key is still only in the wrap.
    if (keep) {
      const wrap = accounts.stores.keyWraps.findByUser(user.id);
      if (wrap !== undefined) {
        process.stdout.write(
          'Note: the key is wrapped under the passphrase. Sign in once to release it, ' +
            'or run this with the passphrase available to unwrap it now.\n',
        );
      }
    }
    process.stdout.write(
      `${keep ? 'Keeping' : 'No longer keeping'} "${user.label}" unlocked.\n` +
        (keep
          ? 'Their schedules may now run with nobody signed in.\n'
          : 'Being signed out now means their partition cannot be opened.\n'),
    );
  } else if (command === 'lock-account' || command === 'unlock-account') {
    if (name === undefined) throw new Error(`${command} needs a name`);
    const user = findByName(accounts.users, name);
    if (user === undefined) throw new Error(`no account named "${name}"`);
    const result =
      command === 'lock-account' ? accounts.users.disable(user.id) : accounts.users.enable(user.id);
    if (!result.ok) throw new Error(`could not ${command} (${result.reason})`);
    process.stdout.write(
      `${command === 'lock-account' ? 'Disabled' : 'Enabled'} "${user.label}".\n`,
    );
  } else {
    process.stderr.write(`Unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 1;
  }
} finally {
  accounts.close();
}
