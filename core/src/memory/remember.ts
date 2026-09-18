/**
 * M19 automatic remember (PLAN-M19.md).
 *
 * After a persisted persona turn, the core asks the persona's model — out of
 * band, AFTER the client's response has ended — whether the exchange holds
 * anything durable about the user worth remembering. Findings are filed as
 * `partner_suggestion` / `suggested` profile entries, waiting for the user to
 * confirm, edit or reject them in the Memory view.
 *
 * Scope: the extractor labels each finding `global` (true of the user in
 * every conversation: name, role, language, standing tone/format rules) or
 * `persona` (only meaningful while chatting with this persona). Global
 * findings are filed with `personaScope: null` so they tailor every persona;
 * persona findings stay scoped to the persona that heard them. The whole
 * extraction stays gated on that persona's private-memory toggle — the
 * toggle is the conversation-level consent, and nothing is applied until the
 * user confirms the suggestion.
 *
 * Discipline:
 *   - The extractor instruction is FIXED and never user-derived; the
 *     transcript is user data that only ever sits in the payload.
 *   - The cheap resolver is preferred, but when it yields no usable target
 *     the manager rides the provider client + model that actually served the
 *     turn (`RememberInput.fallbackTarget`) — a turn that streamed always
 *     remains eligible for remembering.
 *   - Parsing is defensive: fences stripped, first '[' → last ']', kind
 *     whitelist, scope whitelist (unknown/missing -> persona), length caps, an
 *     obvious-secret filter, and dedupe against every existing entry the
 *     persona would honor — global + same-scope, rejected included — so a
 *     fact the user rejected anywhere is never re-suggested.
 *   - Review-before-suggest: the payload lists what is already known (the
 *     confirmed and still-pending entries the persona would honor, global +
 *     its own scope, bounded and value-capped) so the model does not propose
 *     it again in fresh wording. The deterministic dedupe above stays the
 *     guarantee — the listing is only a hint; a fact already known or already
 *     suggested is filtered out even when the model repeats it.
 *   - Audit rows carry ids/counts/model only — never the fact text.
 *   - Demo / no-provider turns skip entirely (returns a typed outcome).
 *
 * `enqueue()` runs extraction fire-and-forget (the chat route never waits);
 * `idle()` awaits in-flight work so tests are deterministic.
 */
import type {
  ChatEvent,
  ProfileEntry,
  ProfileEntryInput,
  ProfileEntryKind,
  ProviderClient,
} from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import { memoryError } from './errors.js';
import { PROFILE_KINDS } from './profile.js';
import type { ProfileManager } from './profile.js';

/** At most this many facts are filed per turn. */
export const REMEMBER_MAX_ITEMS = 3;
/** Longest value/evidence we store from a model reply. */
export const REMEMBER_VALUE_CAP = 300;
export const REMEMBER_EVIDENCE_CAP = 200;
/** Per-message transcript cap fed to the extractor (prompt stays bounded). */
export const REMEMBER_INPUT_CAP = 4000;
/** Most existing facts listed for the extractor's pre-suggestion review. */
export const REMEMBER_KNOWN_MAX = 40;
/** Longest value shown per already-known fact in that listing. */
export const REMEMBER_KNOWN_VALUE_CAP = 160;
/** Fixed lead-in for the already-known listing (never user-derived). */
export const REMEMBER_KNOWN_HEADER =
  'ALREADY KNOWN (never return these again, in any wording):';
/**
 * Fixed lead-in for the rejected listing. Rejected facts are not "known" —
 * they are the user's explicit NO — but the extractor still needs to see them,
 * or it proposes the same fact again in fresh wording (the deterministic
 * dedupe only catches reworded matches approximately). The listing is
 * same-scope + global, so one persona's rejection never leaks another
 * persona's private memory.
 */
export const REMEMBER_REJECTED_HEADER =
  'REJECTED (the user declined these — never suggest them again, not even reworded):';

/** Where a remembered fact applies: every persona (`global`) or only one. */
export type RememberScope = 'global' | 'persona';
/** Whitelist for the extractor's `scope` field; unknown -> `persona`. */
export const REMEMBER_SCOPES: readonly RememberScope[] = ['global', 'persona'];

/**
 * Which scopes this turn may file. Computed by the caller from the user-level
 * global consent ({@link MemorySettings.autoRememberGlobal}) plus the
 * persona's own `memory.personaMemory` flag, so global detection can run with
 * the persona toggle off and persona detection can run with global off.
 * Findings for a disallowed scope are dropped (never filed, never audited as
 * content). Omitted -> both allowed (keeps direct manager callers at M19
 * behaviour).
 */
export interface RememberPolicy {
  /** File global (`personaScope: null`) findings. */
  global: boolean;
  /** File persona-scoped findings for this persona. */
  persona: boolean;
}

export const REMEMBER_DEFAULT_POLICY: RememberPolicy = { global: true, persona: true };

/**
 * Fixed extractor instruction — NEVER user-derived. The transcript only ever
 * appears as the user payload after this instruction.
 */
export const REMEMBER_SYSTEM_PROMPT =
  'You maintain a private memory of the USER for one AI partner persona. ' +
  'From the conversation turn below, extract durable, user-specific facts worth remembering ' +
  'in future chats: name, role, language, tone/format/workflow preferences, standing do/don\'t ' +
  'rules, and stable style notes. Return ONLY a JSON array of at most ' +
  String(REMEMBER_MAX_ITEMS) +
  ' objects, each {"kind":"preference"|"identity"|"rule"|"style","value":"<short fact>",' +
  '"scope":"global"|"persona","evidence":"<why>"}. Use "global" for a durable truth about ' +
  'the user that applies in EVERY conversation (name, role, language, tone/verbosity/format ' +
  'defaults, standing rules); use "persona" when it only matters while working with this ' +
  'persona. Return [] when nothing is worth keeping. Never include secrets ' +
  '(passwords, API keys, tokens, payment data), transient task details, or facts about anyone ' +
  'other than the user. A list of facts that are already known, and a list of facts the user ' +
  'has REJECTED, may follow the transcript: never return any of them, not even reworded.';

/** The chat client a persona's extraction rides, plus the concrete model id. */
export interface RememberTarget {
  client: ProviderClient;
  model: string;
}

export interface RememberInput {
  personaId: string;
  userText: string;
  assistantText: string;
  conversationId?: string | null;
  /**
   * The provider client + model that actually served this turn. Used only
   * when {@link RememberManagerOptions.providerResolver} cannot resolve a
   * target (no cheap/chat model configured, or a provider with no default
   * models where the turn carried an explicit model). Chat worked, so
   * extraction must too — otherwise auto-remember silently never runs.
   */
  fallbackTarget?: RememberTarget;
  /** Which scopes may be filed (default: both). */
  policy?: RememberPolicy;
}

export interface RememberCandidate {
  kind: ProfileEntryKind;
  value: string;
  /** `global` = every persona; `persona` = only the extracting persona. */
  scope: RememberScope;
  key?: string;
  evidence?: string;
}

export type RememberOutcome =
  | { status: 'saved'; suggested: number; entryIds: string[] }
  | { status: 'empty' }
  | { status: 'skipped'; reason: 'demo' | 'no_provider' | 'no_text' | 'disabled' }
  | { status: 'error' };

export interface RememberManager {
  /**
   * Extract + file suggestions for one finished turn. Never rejects; typed
   * outcomes cover every expected condition.
   */
  extract(input: RememberInput): Promise<RememberOutcome>;
  /** Fire-and-forget wrapper around {@link extract}; tracked by {@link idle}. */
  enqueue(input: RememberInput): void;
  /** Resolves when no extraction is in flight (test determinism). */
  idle(): Promise<void>;
}

export interface RememberManagerOptions {
  profile: ProfileManager;
  audit: AuditService;
  /** Demo mode never calls a provider. */
  demo: boolean;
  /** Resolve the chat client (cheap task class) for a persona, or null. */
  providerResolver: (personaId: string) => RememberTarget | null | Promise<RememberTarget | null>;
}

function trimToCap(text: unknown, cap: number): string {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  return trimmed.length > cap ? trimmed.slice(0, cap) : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strong, conservative secret/credential detector for candidate values. */
export function looksLikeSecret(value: string): boolean {
  const text = value.trim();
  if (text === '') return false;
  if (/(?:sk|pk|rk)-[A-Za-z0-9]{16,}/.test(text)) return true;
  if (/(?:password|passwd|pwd|secret|api[ _-]?key|access[ _-]?token|private[ _-]?key)\s*[:=]/i.test(text)) {
    return true;
  }
  // Payment-card-like digit runs (13–19 digits, optionally spaced/dashed).
  if (/\b(?:\d[ -]?){13,19}\b/.test(text)) return true;
  // A long opaque token with no whitespace.
  if (/\b[A-Za-z0-9_-]{40,}\b/.test(text)) return true;
  return false;
}

/**
 * Normalized value used for dedupe: case/space-insensitive, with surrounding
 * quotes and trailing sentence punctuation ignored, so "Tabs." and "tabs"
 * are the same fact.
 */
function dedupeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.!?;:,]+$/, '')
    .trim();
}

/**
 * Render the fixed "already known" block the extractor reviews BEFORE
 * suggesting. Rejected entries stay out (they are not known facts — they are
 * filtered deterministically), and the listing is bounded + value-capped so
 * the prompt stays small. Values collapse whitespace so a stored multi-line
 * fact cannot fake the block's structure. Returns '' when nothing is known.
 */
export function formatKnownBlock(entries: readonly ProfileEntry[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of entries) {
    if (lines.length >= REMEMBER_KNOWN_MAX) break;
    const key = dedupeKey(entry.value);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    lines.push(
      `- ${trimToCap(entry.value.replace(/\s+/g, ' '), REMEMBER_KNOWN_VALUE_CAP)}`,
    );
  }
  return lines.length === 0 ? '' : `${REMEMBER_KNOWN_HEADER}\n${lines.join('\n')}`;
}

/**
 * Render the fixed "rejected" block. Same shape as {@link formatKnownBlock}
 * (bounded, value-capped, whitespace-collapsed) but behind its own header, so
 * the model can tell "already known" from "the user said no" and never
 * re-asks either. Returns '' when nothing has been rejected.
 */
export function formatRejectedBlock(entries: readonly ProfileEntry[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of entries) {
    if (lines.length >= REMEMBER_KNOWN_MAX) break;
    const key = dedupeKey(entry.value);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    lines.push(
      `- ${trimToCap(entry.value.replace(/\s+/g, ' '), REMEMBER_KNOWN_VALUE_CAP)}`,
    );
  }
  return lines.length === 0 ? '' : `${REMEMBER_REJECTED_HEADER}\n${lines.join('\n')}`;
}

/**
 * Parse a model reply into validated candidates. Pure + defensive: malformed
 * replies yield [] (never throw). Exported for tests.
 */
export function parseRememberReply(text: string): RememberCandidate[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  // Strip markdown fences line-wise, then take the outermost JSON array.
  const unfenced = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('```'))
    .join('\n');
  const start = unfenced.indexOf('[');
  const end = unfenced.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1)) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: RememberCandidate[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (out.length >= REMEMBER_MAX_ITEMS) break;
    if (!isRecord(item)) continue;
    const kind = typeof item.kind === 'string' ? item.kind : '';
    if (!(PROFILE_KINDS as readonly string[]).includes(kind)) continue;
    const value = trimToCap(item.value, REMEMBER_VALUE_CAP);
    if (value === '') continue;
    // Unknown or missing scope is persona (the conservative default: a fact
    // is never broadcast to every persona unless the model says so).
    const rawScope = typeof item.scope === 'string' ? item.scope.trim().toLowerCase() : '';
    const scope: RememberScope = (REMEMBER_SCOPES as readonly string[]).includes(rawScope)
      ? (rawScope as RememberScope)
      : 'persona';
    const key = trimToCap(item.key, 60);
    const evidence = trimToCap(item.evidence, REMEMBER_EVIDENCE_CAP);
    const dedupe = dedupeKey(value);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      kind: kind as ProfileEntryKind,
      value,
      scope,
      ...(key !== '' ? { key } : {}),
      ...(evidence !== '' ? { evidence } : {}),
    });
  }
  return out;
}

/** Join every delta of a provider reply (mirrors the episode summarizer). */
async function collectReply(events: AsyncIterable<ChatEvent>): Promise<string | null> {
  const parts: string[] = [];
  for await (const event of events) {
    if (event.type === 'delta') {
      parts.push(event.text);
    } else if (event.type === 'error') {
      throw memoryError('upstream', 'remember provider stream failed');
    }
  }
  const text = parts.join('');
  return text.trim() === '' ? null : text;
}

export function createRememberManager(options: RememberManagerOptions): RememberManager {
  const { profile, audit } = options;
  const demo = options.demo;
  const resolver = options.providerResolver;

  let inFlight = 0;
  let drainWaiters: Array<() => void> = [];

  function track(promise: Promise<unknown>): void {
    inFlight += 1;
    // extract() is typed never to reject; the catch keeps a truly unexpected
    // throw from surfacing as an unhandled rejection on the fire-and-forget path.
    void promise.catch(() => undefined).finally(() => {
      inFlight -= 1;
      if (inFlight === 0 && drainWaiters.length > 0) {
        const waiters = drainWaiters;
        drainWaiters = [];
        for (const resolve of waiters) resolve();
      }
    });
  }

  function idle(): Promise<void> {
    if (inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      drainWaiters.push(resolve);
    });
  }

  async function extract(input: RememberInput): Promise<RememberOutcome> {
    const personaId = typeof input.personaId === 'string' ? input.personaId.trim() : '';
    const userText = trimToCap(input.userText, REMEMBER_INPUT_CAP);
    const assistantText = trimToCap(input.assistantText, REMEMBER_INPUT_CAP);
    const policy = input.policy ?? REMEMBER_DEFAULT_POLICY;
    if (personaId === '') return { status: 'skipped', reason: 'no_text' };
    if (demo) return { status: 'skipped', reason: 'demo' };
    if (!policy.global && !policy.persona) return { status: 'skipped', reason: 'disabled' };
    if (userText === '' && assistantText === '') {
      return { status: 'skipped', reason: 'no_text' };
    }

    let target: RememberTarget | null = null;
    let resolverFailed = false;
    try {
      target = await resolver(personaId);
    } catch {
      resolverFailed = true;
    }
    // A turn that streamed through a provider always has a usable target;
    // prefer the resolver's (cheap) model, but never skip extraction merely
    // because that model could not be resolved on its own.
    if (target === null) target = input.fallbackTarget ?? null;
    if (target === null) {
      return resolverFailed ? { status: 'error' } : { status: 'skipped', reason: 'no_provider' };
    }

    // Everything the persona would honor — global + its own scope — across
    // confirmed, pending and rejected entries.
    const scoped = profile
      .list({ includeRejected: true })
      .filter((entry) => entry.personaScope === null || entry.personaScope === personaId);
    // Review-before-suggest: show the model what is already known (confirmed
    // and still-pending, newest first so the cap keeps the freshest facts) so
    // it does not propose the same fact in new wording. Rejected values ride a
    // separate block so the model also does not re-ask a fact the user already
    // declined — the deterministic dedupe below stays the guarantee, but this
    // stops the awkward reworded re-ask from ever reaching the user.
    const byNewest = (a: ProfileEntry, b: ProfileEntry): number => b.updatedAt - a.updatedAt;
    const knownBlock = formatKnownBlock(
      scoped.filter((entry) => entry.status !== 'rejected').sort(byNewest),
    );
    const rejectedBlock = formatRejectedBlock(
      scoped.filter((entry) => entry.status === 'rejected').sort(byNewest),
    );

    let reply: string | null;
    try {
      reply = await collectReply(
        target.client.chatStream({
          model: target.model,
          messages: [
            { role: 'system', content: REMEMBER_SYSTEM_PROMPT },
            {
              role: 'user',
              content:
                `USER:\n${userText}\n\nPARTNER:\n${assistantText}` +
                (knownBlock === '' ? '' : `\n\n${knownBlock}`) +
                (rejectedBlock === '' ? '' : `\n\n${rejectedBlock}`),
            },
          ],
        }),
      );
    } catch {
      return { status: 'error' };
    }
    if (reply === null) return { status: 'empty' };

    const candidates = parseRememberReply(reply)
      .filter((candidate) =>
        candidate.scope === 'global' ? policy.global : policy.persona,
      )
      .filter(
        (candidate) => !looksLikeSecret(candidate.value) && !looksLikeSecret(candidate.evidence ?? ''),
      );
    if (candidates.length === 0) return { status: 'empty' };

    // Dedupe against every existing entry the persona would honor: global
    // facts and its own scoped facts, rejected included (a fact the user
    // rejected — anywhere — is never re-suggested), and pending suggestions
    // already waiting for review (the same fact is never suggested twice).
    // The same value is never filed on both scopes either: a global fact
    // keeps a persona candidate from duplicating it, and vice versa.
    const existing = new Set(scoped.map((entry) => dedupeKey(entry.value)));

    const entryIds: string[] = [];
    let globalSuggested = 0;
    for (const candidate of candidates) {
      const dedupe = dedupeKey(candidate.value);
      if (existing.has(dedupe)) continue;
      existing.add(dedupe);
      try {
        const entry = profile.add({
          kind: candidate.kind,
          value: candidate.value,
          ...(candidate.key !== undefined ? { key: candidate.key } : {}),
          ...(candidate.evidence !== undefined ? { evidence: candidate.evidence } : {}),
          source: 'partner_suggestion',
          // `global` files personaScope null so the fact tailors every
          // persona once confirmed; `persona` stays private to this one.
          personaScope: candidate.scope === 'global' ? null : personaId,
        } satisfies ProfileEntryInput);
        entryIds.push(entry.id);
        if (candidate.scope === 'global') globalSuggested += 1;
      } catch {
        // A single bad candidate must not sink the batch.
      }
    }

    audit.log('web', 'memory.remember', `${personaId}/${target.model}`, {
      personaId,
      conversationId: input.conversationId ?? null,
      candidates: candidates.length,
      suggested: entryIds.length,
      globals: globalSuggested,
      personaScoped: entryIds.length - globalSuggested,
      // Ids only — never the fact text.
      entryIds,
    });
    if (entryIds.length === 0) return { status: 'empty' };
    return { status: 'saved', suggested: entryIds.length, entryIds };
  }

  function enqueue(input: RememberInput): void {
    track(extract(input));
  }

  return { extract, enqueue, idle };
}
