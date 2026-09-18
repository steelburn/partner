/**
 * M29 — the multi-user lifecycle, over real HTTP.
 *
 * Five behaviours this file exists to pin, each of which is a claim the product
 * makes to a person:
 *
 *  1. SIGN OUT actually ends the session AND closes the partition (the key
 *     leaves memory), so "signed out" means unreadable, not merely unreachable.
 *  2. An OWNER mints an invitation from the app — no shell — and only an owner
 *     can; the redeemer cannot escalate the role the invite carries.
 *  3. An invited MEMBER with `keyAccess: 'shared'` chats through the
 *     deployment's published provider/search configuration without configuring
 *     anything, while a member with `'own'` (or one who configures their own)
 *     does not inherit it.
 *  4. FILE ISOLATION: each account's file tools see their OWN directory under
 *     the deployment volume, and the roots surface is read-only in login mode.
 *  5. SHARING: a note (or asset) handed to another account is a SNAPSHOT in the
 *     system database — the grantee reads it without ever opening the owner's
 *     partition, and cannot reach anything that was not shared.
 *
 * It runs the whole boot (`startServer`) because delegation, the rails and the
 * system stores are half the feature: none of this is observable in a unit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { Server } from 'node:http';
import { loadConfig, openAccounts, startServer } from '../../src/index.js';
import type { CoreBundle } from '../../src/index.js';
import { closeServer, freePort, removeTempRoot } from '../helpers.js';

const dirs: string[] = [];
const servers: Server[] = [];
const bundles: CoreBundle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await closeServer(server);
  for (const bundle of bundles.splice(0)) bundle.close();
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'partner-m29-'));
  dirs.push(dir);
  return dir;
}

async function bootLoginCore(dir: string, options: { fixedRoot?: boolean } = {}) {
  const port = await freePort();
  let fixedRoot: string | undefined;
  if (options.fixedRoot === true) {
    fixedRoot = join(dir, 'files');
    mkdirSync(fixedRoot, { recursive: true });
  }
  const config = {
    ...loadConfig({
      DEMO_MODE: '0',
      AUTH_MODE: 'login',
      SIGNUP_MODE: 'invite',
      KEYCHAIN_KIND: 'file',
      KEYCHAIN_FILE: join(dir, 'keychain.json'),
      DB_PATH: join(dir, 'partner.db'),
      DATA_ROOT: dir,
      PORT: String(port),
      SCHEDULER_TICK_MS: '0',
      ...(fixedRoot === undefined ? {} : { FIXED_ROOTS: fixedRoot }),
    }),
  };
  const { bundle, server, accounts } = await startServer(config);
  bundles.push(bundle);
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the core resolved without a listening socket');
  }
  return { config, bundle, server, accounts, origin: `127.0.0.1:${address.port}` };
}

async function addUser(
  config: ReturnType<typeof loadConfig>,
  name: string,
  role?: 'owner' | 'member',
  keyAccess?: 'own' | 'shared',
  password = `${name}-passphrase`,
) {
  const accounts = await openAccounts(config);
  try {
    const created = accounts.users.create({
      id: name,
      label: name,
      ...(role === undefined ? {} : { role }),
      ...(keyAccess === undefined ? {} : { keyAccess }),
    });
    if (!created.ok) throw new Error(`could not create ${name}: ${created.reason}`);
    const stored = await accounts.credentials.create(created.user.id, password);
    if (!stored.ok) throw new Error(`could not store the credential: ${stored.reason}`);
  } finally {
    accounts.close();
  }
  return { name, password };
}

async function signIn(bundle: CoreBundle, origin: string, name: string, password?: string) {
  const res = await request(bundle.app)
    .post('/v1/auth/session')
    .set('Host', origin)
    .send({ username: name, password: password ?? `${name}-passphrase` });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.token as string;
}

function authed(token: string, origin: string): Record<string, string> {
  return { Host: origin, Authorization: `Bearer ${token}` };
}

describe('M29 sign out', () => {
  it('revokes the session and CLOSES the partition, and a new sign-in reopens it', async () => {
    const dir = tempDir();
    const { config, bundle, origin, accounts } = await bootLoginCore(dir);
    await addUser(config, 'owner', 'owner');
    const token = await signIn(bundle, origin, 'owner');
    expect((await request(bundle.app).get('/v1/notes').set(authed(token, origin))).status).toBe(200);
    expect(accounts?.rails.openUserIds()).toContain('owner');

    const out = await request(bundle.app)
      .post('/v1/auth/signout')
      .set(authed(token, origin))
      .send({});
    expect(out.status).toBe(204);

    // The token is dead…
    const after = await request(bundle.app).get('/v1/notes').set(authed(token, origin));
    expect(after.status).toBe(401);
    // …and the partition is closed, so the key is not in memory.
    expect(accounts?.rails.openUserIds()).not.toContain('owner');
    expect(accounts?.vault.isUnlocked('owner')).toBe(false);

    // A fresh sign-in unlocks and serves again.
    const again = await signIn(bundle, origin, 'owner');
    expect((await request(bundle.app).get('/v1/notes').set(authed(again, origin))).status).toBe(200);
  });

  it('is also reachable as DELETE /v1/session (the pair-again path)', async () => {
    const dir = tempDir();
    const { config, bundle, origin } = await bootLoginCore(dir);
    await addUser(config, 'owner', 'owner');
    const token = await signIn(bundle, origin, 'owner');
    expect(
      (await request(bundle.app).delete('/v1/session').set(authed(token, origin))).status,
    ).toBe(204);
    expect((await request(bundle.app).get('/v1/notes').set(authed(token, origin))).status).toBe(401);
  });
});

describe('M29 the account lane', () => {
  it('reports the caller’s role and key access, and never a credential', async () => {
    const dir = tempDir();
    const { config, bundle, origin } = await bootLoginCore(dir);
    await addUser(config, 'owner', 'owner');
    await addUser(config, 'ama', 'member', 'shared');

    const ownerToken = await signIn(bundle, origin, 'owner');
    const owner = await request(bundle.app).get('/v1/account').set(authed(ownerToken, origin));
    expect(owner.status).toBe(200);
    expect(owner.body.user).toMatchObject({ id: 'owner', role: 'owner', keyAccess: 'own' });
    expect(JSON.stringify(owner.body)).not.toContain('passphrase');

    const amaToken = await signIn(bundle, origin, 'ama');
    const ama = await request(bundle.app).get('/v1/account').set(authed(amaToken, origin));
    expect(ama.body.user).toMatchObject({ id: 'ama', role: 'member', keyAccess: 'shared' });
  });

  it('lists accounts for an owner only', async () => {
    const dir = tempDir();
    const { config, bundle, origin } = await bootLoginCore(dir);
    await addUser(config, 'owner', 'owner');
    await addUser(config, 'ama', 'member', 'shared');
    const ownerToken = await signIn(bundle, origin, 'owner');
    const amaToken = await signIn(bundle, origin, 'ama');

    const mine = await request(bundle.app).get('/v1/users').set(authed(ownerToken, origin));
    expect(mine.status).toBe(200);
    expect((mine.body.users as Array<{ id: string }>).map((u) => u.id).sort()).toEqual([
      'ama',
      'owner',
    ]);
    const refused = await request(bundle.app).get('/v1/users').set(authed(amaToken, origin));
    expect(refused.status).toBe(403);
    expect(refused.body.reason).toBe('owner_required');
  });
});

describe('M29 owner-minted invitations', () => {
  it('only the owner may mint, and the invite carries the role and key access', async () => {
    const dir = tempDir();
    const { config, bundle, origin } = await bootLoginCore(dir);
    await addUser(config, 'owner', 'owner');
    await addUser(config, 'ama', 'member', 'own');
    const ownerToken = await signIn(bundle, origin, 'owner');
    const amaToken = await signIn(bundle, origin, 'ama');

    const refused = await request(bundle.app)
      .post('/v1/invites')
      .set(authed(amaToken, origin))
      .send({});
    expect(refused.status).toBe(403);

    const minted = await request(bundle.app)
      .post('/v1/invites')
      .set(authed(ownerToken, origin))
      .send({ role: 'member', keyAccess: 'shared' });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    expect(minted.body.role).toBe('member');
    expect(minted.body.keyAccess).toBe('shared');
    expect(String(minted.body.url)).toContain('#signup=');

    // The redeemer cannot escalate: the role in the BODY is ignored.
    const redeemed = await request(bundle.app)
      .post('/v1/auth/signup')
      .set('Host', origin)
      .send({
        code: String(minted.body.code),
        username: 'bo',
        password: 'bo-passphrase',
        role: 'owner',
        keyAccess: 'own',
      });
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(201);

    const boToken = await signIn(bundle, origin, 'bo');
    const account = await request(bundle.app).get('/v1/account').set(authed(boToken, origin));
    expect(account.body.user).toMatchObject({ role: 'member', keyAccess: 'shared' });
  });

  it('lists and revokes invitations, and never echoes a code', async () => {
    const dir = tempDir();
    const { config, bundle, origin } = await bootLoginCore(dir);
    await addUser(config, 'owner', 'owner');
    const ownerToken = await signIn(bundle, origin, 'owner');

    const minted = await request(bundle.app)
      .post('/v1/invites')
      .set(authed(ownerToken, origin))
      .send({});
    const code = String(minted.body.code);
    const listed = await request(bundle.app).get('/v1/invites').set(authed(ownerToken, origin));
    expect(listed.status).toBe(200);
    expect(listed.body.invites).toHaveLength(1);
    expect(listed.body.invites[0]).toMatchObject({ id: minted.body.id, state: 'pending' });
    expect(JSON.stringify(listed.body)).not.toContain(code);

    const revoked = await request(bundle.app)
      .delete(`/v1/invites/${String(minted.body.id)}`)
      .set(authed(ownerToken, origin));
    expect(revoked.status).toBe(204);
    const after = await request(bundle.app).get('/v1/invites').set(authed(ownerToken, origin));
    expect(after.body.invites).toHaveLength(0);

    // The revoked code cannot be redeemed.
    const attempt = await request(bundle.app)
      .post('/v1/auth/signup')
      .set('Host', origin)
      .send({ code, username: 'bo', password: 'bo-passphrase' });
    expect(attempt.status).toBe(401);
    expect(attempt.body.reason).toBe('unknown');
  });
});

describe('M29 shared access', () => {
  it('a member with shared access sees the owner’s published provider; one with own does not', async () => {
    const dir = tempDir();
    const { config, bundle, origin } = await bootLoginCore(dir);
    await addUser(config, 'owner', 'owner');
    await addUser(config, 'ama', 'member', 'shared');
    await addUser(config, 'bo', 'member', 'own');
    const ownerToken = await signIn(bundle, origin, 'owner');
    const amaToken = await signIn(bundle, origin, 'ama');
    const boToken = await signIn(bundle, origin, 'bo');

    // The owner configures one provider and stores its key.
    const provider = await request(bundle.app)
      .post('/v1/providers')
      .set(authed(ownerToken, origin))
      .send({ name: 'Owner Gateway', endpoint: 'https://api.example.invalid/v1', defaultModels: ['m1'] });
    expect(provider.status, JSON.stringify(provider.body)).toBe(201);
    const providerId = String(provider.body.id);
    expect(
      (
        await request(bundle.app)
          .post(`/v1/providers/${providerId}/key`)
          .set(authed(ownerToken, origin))
          .send({ key: 'sk-owner-secret' })
      ).status,
    ).toBe(204);

    // Before publishing, nobody sees anything.
    expect(
      ((await request(bundle.app).get('/v1/providers').set(authed(amaToken, origin))).body
        .providers as unknown[]).length,
    ).toBe(0);

    const published = await request(bundle.app)
      .put('/v1/shared-access')
      .set(authed(ownerToken, origin))
      .send({});
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.providerCount).toBe(1);
    expect(JSON.stringify(published.body)).not.toContain('sk-owner-secret');

    // The shared member sees it; the own-keys member does not.
    const amaProviders = await request(bundle.app).get('/v1/providers').set(authed(amaToken, origin));
    expect((amaProviders.body.providers as Array<{ name: string }>).map((p) => p.name)).toContain(
      'Owner Gateway',
    );
    const boProviders = await request(bundle.app).get('/v1/providers').set(authed(boToken, origin));
    expect(boProviders.body.providers).toHaveLength(0);

    // Only the owner may publish…
    const refused = await request(bundle.app)
      .put('/v1/shared-access')
      .set(authed(amaToken, origin))
      .send({});
    expect(refused.status).toBe(403);

    // …and clearing it takes the fallback away again, for everyone.
    const cleared = await request(bundle.app)
      .delete('/v1/shared-access')
      .set(authed(ownerToken, origin));
    expect(cleared.status).toBe(204);
    const after = await request(bundle.app).get('/v1/providers').set(authed(amaToken, origin));
    expect(after.body.providers).toHaveLength(0);
  });

  it('an own-keys member who configures their own provider stops riding the shared one', async () => {
    const dir = tempDir();
    const { config, bundle, origin } = await bootLoginCore(dir);
    await addUser(config, 'owner', 'owner');
    // This member is 'shared' but adds their own provider — own setup wins.
    await addUser(config, 'ama', 'member', 'shared');
    const ownerToken = await signIn(bundle, origin, 'owner');
    const amaToken = await signIn(bundle, origin, 'ama');

    const provider = await request(bundle.app)
      .post('/v1/providers')
      .set(authed(ownerToken, origin))
      .send({ name: 'Owner Gateway', endpoint: 'https://api.example.invalid/v1' });
    await request(bundle.app)
      .post(`/v1/providers/${String(provider.body.id)}/key`)
      .set(authed(ownerToken, origin))
      .send({ key: 'sk-owner-secret' });
    await request(bundle.app).put('/v1/shared-access').set(authed(ownerToken, origin)).send({});

    // The member adds their own.
    const mine = await request(bundle.app)
      .post('/v1/providers')
      .set(authed(amaToken, origin))
      .send({ name: 'My Own', endpoint: 'https://api.mine.invalid/v1' });
    expect(mine.status).toBe(201);

    const list = await request(bundle.app).get('/v1/providers').set(authed(amaToken, origin));
    expect((list.body.providers as Array<{ name: string }>).map((p) => p.name)).toEqual([
      'My Own',
    ]);
  });
});

describe('M29 per-user file roots', () => {
  it('each account sees ONLY its own directory under the deployment volume, and cannot add roots', async () => {
    const dir = tempDir();
    const { config, bundle, origin } = await bootLoginCore(dir, { fixedRoot: true });
    await addUser(config, 'owner', 'owner');
    await addUser(config, 'ama', 'member', 'own');
    const ownerToken = await signIn(bundle, origin, 'owner');
    const amaToken = await signIn(bundle, origin, 'ama');

    for (const [token, id] of [
      [ownerToken, 'owner'],
      [amaToken, 'ama'],
    ] as const) {
      const res = await request(bundle.app).get('/v1/roots').set(authed(token, origin));
      expect(res.status).toBe(200);
      expect(res.body.rootsFixed).toBe(true);
      const roots = res.body.roots as Array<{ path: string }>;
      expect(roots).toHaveLength(1);
      const first = roots[0] as { path: string };
      expect(first.path).toBe(join(dir, 'files', id));
      expect(existsSync(first.path)).toBe(true);
      // Adding a root is refused (the deployment owns the list).
      const add = await request(bundle.app)
        .post('/v1/roots')
        .set(authed(token, origin))
        .send({ label: 'sneaky', path: dir });
      expect(add.status).toBe(403);
      expect(add.body.error).toBe('roots_fixed');
    }
  });
});

describe('M29 sharing notes and assets', () => {
  async function bootWithTwoUsers() {
    const dir = tempDir();
    const boot = await bootLoginCore(dir);
    await addUser(boot.config, 'owner', 'owner');
    await addUser(boot.config, 'ama', 'member', 'shared');
    await addUser(boot.config, 'bo', 'member', 'own');
    const ownerToken = await signIn(boot.bundle, boot.origin, 'owner');
    const amaToken = await signIn(boot.bundle, boot.origin, 'ama');
    const boToken = await signIn(boot.bundle, boot.origin, 'bo');
    return { ...boot, ownerToken, amaToken, boToken };
  }

  it('copies a note to another account, who can read and import it, and cannot reach anything else', async () => {
    const { bundle, origin, ownerToken, amaToken, boToken } = await bootWithTwoUsers();

    const note = await request(bundle.app)
      .post('/v1/notes')
      .set(authed(ownerToken, origin))
      .send({ title: 'Trip plan', content: 'Reykjavik in March' });
    expect(note.status).toBe(201);
    const noteId = String(note.body.id);

    // A second, unshared note is the control.
    await request(bundle.app)
      .post('/v1/notes')
      .set(authed(ownerToken, origin))
      .send({ title: 'Private', content: 'do not share' });

    const share = await request(bundle.app)
      .post('/v1/shares')
      .set(authed(ownerToken, origin))
      .send({ kind: 'note', resourceId: noteId, grantee: 'ama' });
    expect(share.status, JSON.stringify(share.body)).toBe(201);
    const shareId = String(share.body.share.id);

    // The grantee lists and reads it.
    const received = await request(bundle.app)
      .get('/v1/shares/received')
      .set(authed(amaToken, origin));
    expect(received.status).toBe(200);
    expect(received.body.shares).toHaveLength(1);
    expect(received.body.shares[0]).toMatchObject({ title: 'Trip plan', ownerLabel: 'owner' });

    const detail = await request(bundle.app)
      .get(`/v1/shares/received/${shareId}`)
      .set(authed(amaToken, origin));
    expect(detail.status).toBe(200);
    expect(detail.body.share.body).toBe('Reykjavik in March');

    // A THIRD user cannot read a share that is not theirs, and the owner's own
    // partition is untouched (the unshared note is not visible through the share
    // API at all).
    expect(
      (await request(bundle.app).get(`/v1/shares/received/${shareId}`).set(authed(boToken, origin)))
        .status,
    ).toBe(404);
    expect(
      JSON.stringify(
        (await request(bundle.app).get('/v1/shares/received').set(authed(boToken, origin))).body,
      ),
    ).not.toContain('Private');

    // Import copies it into the grantee's OWN notes.
    const imported = await request(bundle.app)
      .post(`/v1/shares/${shareId}/import`)
      .set(authed(amaToken, origin));
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    const amaNotes = await request(bundle.app).get('/v1/notes').set(authed(amaToken, origin));
    expect(JSON.stringify(amaNotes.body)).toContain('Shared: Trip plan');

    // The owner's rows never leaked into the grantee's partition.
    expect(JSON.stringify(amaNotes.body)).not.toContain('Private');
  });

  it('refreshing pushes the owner’s current edit into the copy; revoking removes it', async () => {
    const { bundle, origin, ownerToken, amaToken } = await bootWithTwoUsers();
    const note = await request(bundle.app)
      .post('/v1/notes')
      .set(authed(ownerToken, origin))
      .send({ title: 'Draft', content: 'v1' });
    const noteId = String(note.body.id);
    const share = await request(bundle.app)
      .post('/v1/shares')
      .set(authed(ownerToken, origin))
      .send({ kind: 'note', resourceId: noteId, grantee: 'ama' });
    const shareId = String(share.body.share.id);

    await request(bundle.app)
      .put(`/v1/notes/${noteId}`)
      .set(authed(ownerToken, origin))
      .send({ content: 'v2' });
    const refreshed = await request(bundle.app)
      .post(`/v1/shares/${shareId}/refresh`)
      .set(authed(ownerToken, origin))
      .send({});
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    const afterRefresh = await request(bundle.app)
      .get(`/v1/shares/received/${shareId}`)
      .set(authed(amaToken, origin));
    expect(afterRefresh.body.share.body).toBe('v2');

    const revoked = await request(bundle.app)
      .delete(`/v1/shares/${shareId}`)
      .set(authed(ownerToken, origin));
    expect(revoked.status).toBe(204);
    expect(
      (
        await request(bundle.app)
          .get('/v1/shares/received')
          .set(authed(amaToken, origin))
      ).body.shares,
    ).toHaveLength(0);
    expect(
      (await request(bundle.app).get(`/v1/shares/received/${shareId}`).set(authed(amaToken, origin)))
        .status,
    ).toBe(404);
  });

  it('a user cannot share a resource they do not own', async () => {
    const { bundle, origin, ownerToken, amaToken } = await bootWithTwoUsers();
    const note = await request(bundle.app)
      .post('/v1/notes')
      .set(authed(ownerToken, origin))
      .send({ title: 'Owner only', content: 'secret' });
    const noteId = String(note.body.id);

    // ama names the owner's note id; readOwn runs against AMA's partition, where
    // nothing has that id — a 404, never a cross-partition read.
    const attempt = await request(bundle.app)
      .post('/v1/shares')
      .set(authed(amaToken, origin))
      .send({ kind: 'note', resourceId: noteId, grantee: 'bo' });
    expect(attempt.status).toBe(404);
  });

  it('shares an asset by conversation id, and the copy is readable', async () => {
    const { bundle, origin, ownerToken, amaToken } = await bootWithTwoUsers();
    const conversation = await request(bundle.app)
      .post('/v1/conversations')
      .set(authed(ownerToken, origin))
      .send({ title: 'Chat' });
    expect(conversation.status, JSON.stringify(conversation.body)).toBe(201);
    const conversationId = String(conversation.body.id);
    const asset = await request(bundle.app)
      .post(`/v1/conversations/${conversationId}/assets`)
      .set(authed(ownerToken, origin))
      .send({ items: [{ kind: 'custom', title: 'Answer', body: 'the asset body' }] });
    expect(asset.status, JSON.stringify(asset.body)).toBe(201);
    const listed = asset.body.assets as Array<{ id: string }>;
    const assetId = String((listed[0] as { id: string }).id);

    const share = await request(bundle.app)
      .post('/v1/shares')
      .set(authed(ownerToken, origin))
      .send({ kind: 'asset', resourceId: assetId, conversationId, grantee: 'ama' });
    expect(share.status, JSON.stringify(share.body)).toBe(201);
    const shareId = String(share.body.share.id);

    const detail = await request(bundle.app)
      .get(`/v1/shares/received/${shareId}`)
      .set(authed(amaToken, origin));
    expect(detail.status).toBe(200);
    expect(detail.body.share).toMatchObject({ kind: 'asset', title: 'Answer' });
    expect(detail.body.share.body).toBe('the asset body');
  });
});
