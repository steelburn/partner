/**
 * Invitations (M29) — an owner mints one from the app; a person redeems it once.
 *
 * The primitive is the same one the pairing ceremony uses (256-bit random code,
 * single use, TTL), but the important difference is WHAT the code carries: the
 * **role** and **key access** the redeemer gains, decided by the minting owner
 * and stored on the invite row. Sign-up reads them from that row — never from a
 * request body — so a redeemer cannot mint themselves an owner.
 *
 * Only the SHA-256 of the code is stored, so a leaked database cannot be replayed
 * as an invite; the code itself is returned by {@link InviteManager.mint} exactly
 * once and never logged. Redemption is a single conditional UPDATE
 * ({@link InviteStore.consume}), so two concurrent redemptions of one code cannot
 * both succeed.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { KeyAccess, UserRole } from '@partner/shared';
import type { InviteRow, InviteStore } from '../stores/types.js';

/** Default life of an invite (a day — it is handed to a person). */
export const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** SHA-256 hex of a code. The code is never stored, logged or audited. */
export function inviteCodeHash(code: string): string {
  return createHash('sha256').update(String(code), 'utf8').digest('hex');
}

/** The three ways a code can fail to resolve to a live invite. */
export type InviteLookup =
  | { ok: true; invite: InviteRow }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' };

export interface InviteManagerOptions {
  store: InviteStore;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  /** Default TTL for a minted invite (overridable per call). */
  ttlMs?: number;
  /** Injectable code generator (tests pin a known code). */
  codeFactory?: () => string;
}

export interface MintInviteInput {
  role?: UserRole;
  keyAccess?: KeyAccess;
  /** The owner who minted it; null for the loopback operator tool. */
  createdBy?: string | null;
  ttlMs?: number;
}

export interface MintedInvite {
  /** The plaintext code — the ONLY place it exists. */
  code: string;
  invite: InviteRow;
}

export interface InviteManager {
  mint(input?: MintInviteInput): MintedInvite;
  /** Every invite, newest first (the owner's admin list). */
  list(): InviteRow[];
  /** Resolve a code WITHOUT spending it (shape checks run first). */
  find(code: string): InviteLookup;
  /**
   * Spend a live invite for `userId`. False when it is already spent, expired or
   * unknown — the caller answers 401 without creating anything.
   */
  consume(inviteId: string, userId: string): boolean;
  /** Delete one invite (owner revocation). False when it did not exist. */
  revoke(id: string): boolean;
}

export function createInviteManager(options: InviteManagerOptions): InviteManager {
  const { store } = options;
  const now = options.now ?? Date.now;
  const defaultTtlMs = options.ttlMs ?? DEFAULT_INVITE_TTL_MS;
  const codeFactory = options.codeFactory ?? (() => randomBytes(32).toString('hex'));

  return {
    mint(input: MintInviteInput = {}): MintedInvite {
      const code = String(codeFactory());
      const ttlMs = input.ttlMs ?? defaultTtlMs;
      const at = now();
      const invite: InviteRow = {
        id: randomBytes(16).toString('hex'),
        codeHash: inviteCodeHash(code),
        // A loopback operator mint that names no role is a member with shared
        // access: the person the operator hands a link to should be able to chat.
        role: input.role ?? 'member',
        keyAccess: input.keyAccess ?? 'shared',
        createdBy: input.createdBy ?? null,
        createdAt: at,
        expiresAt: at + ttlMs,
        usedAt: null,
        usedBy: null,
      };
      store.insert(invite);
      return { code, invite };
    },

    list(): InviteRow[] {
      return store.list();
    },

    find(code: string): InviteLookup {
      if (typeof code !== 'string' || code.trim() === '') return { ok: false, reason: 'unknown' };
      const invite = store.findByCodeHash(inviteCodeHash(code.trim()));
      if (invite === undefined) return { ok: false, reason: 'unknown' };
      if (invite.usedAt !== null) return { ok: false, reason: 'used' };
      if (invite.expiresAt <= now()) return { ok: false, reason: 'expired' };
      return { ok: true, invite };
    },

    consume(inviteId: string, userId: string): boolean {
      return store.consume(inviteId, now(), userId);
    },

    revoke(id: string): boolean {
      return store.remove(id);
    },
  };
}
