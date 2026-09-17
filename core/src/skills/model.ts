/**
 * The ONE bounded one-shot model call in the skill-authoring path (M28 slice D;
 * extracted from M26's `generate.ts`, which now delegates here).
 *
 * WHY it is its own module: M26 needs one call to author a skill bundle, and
 * M28 needs the SAME call four more times (generate a flow, refine a flow, turn
 * code into a flow, explain a flow). Copying the stream/cap/timeout plumbing per
 * caller is how two "bounded" calls drift until one of them is not bounded any
 * more — so the bound lives in exactly one place and every caller inherits it:
 *
 *   bounded   the streamed reply is collected under a byte cap and an
 *             AbortSignal timeout, both injectable so a test can reach the
 *             refusal cheaply.
 *   typed     every failure is a NAMED outcome, never a throw: `no_model`
 *             (nothing configured, so a caller may fall back to a deterministic
 *             answer), `no_provider` (configured but unusable — a real failure
 *             the owner must be told about), `timeout`, `reply_too_large`,
 *             `upstream`, `empty_reply`.
 *   inert     the return value is TEXT. Where that text goes is the caller's
 *             decision; this module cannot execute, install or store anything.
 *
 * `no_model` and `no_provider` are deliberately DIFFERENT codes. "No provider
 * is configured" is a state the demo path answers deterministically (M26 D11),
 * while "a provider is configured but cannot serve the call" is a failure that
 * must be reported rather than papered over — collapsing them would silently
 * turn a broken key into a fabricated answer.
 */
import type { ChatEvent, ProviderClient, ProviderSummary } from '@partner/shared';
import { resolveChatModel } from '../gateway/resolver.js';

/** The streamed-reply cap (M26 D10; generous for a bundle or a graph, small for a payload). */
export const MODEL_REPLY_CAP_BYTES = 256 * 1024;
/** The one-shot timeout (M26 D10). */
export const MODEL_CALL_TIMEOUT_MS = 60_000;

/** The slice of the provider manager a call needs (structural — easy to fake). */
export interface ModelCallProviderSource {
  list(): ProviderSummary[];
  clientFor(id: string): Promise<ProviderClient>;
}

export type ModelCallFailureCode =
  | 'no_model'
  | 'no_provider'
  | 'timeout'
  | 'reply_too_large'
  | 'upstream'
  | 'empty_reply';

export type ModelCallOutcome =
  | { ok: true; text: string; model: string }
  | { ok: false; code: ModelCallFailureCode; message: string };

export interface ModelCallOptions {
  providers: ModelCallProviderSource;
  /** Injectable clock (epoch ms) — used for the timeout message only. */
  now?: () => number;
  /** Default `MODEL_CALL_TIMEOUT_MS`; injectable so a test can pin the abort path. */
  timeoutMs?: number;
  /** Default `MODEL_REPLY_CAP_BYTES`; injectable so a test can exceed it cheaply. */
  replyCapBytes?: number;
}

/**
 * Collect a streamed reply under the byte cap. Reads only delta text; an
 * `error` event is a failed call, not a partial answer.
 */
async function collectReply(
  events: AsyncIterable<ChatEvent>,
  capBytes: number,
): Promise<ModelCallOutcome> {
  const parts: string[] = [];
  let bytes = 0;
  for await (const event of events) {
    if (event.type === 'delta') {
      bytes += Buffer.byteLength(event.text, 'utf8');
      if (bytes > capBytes) {
        return {
          ok: false,
          code: 'reply_too_large',
          message: `the model reply passed ${capBytes} bytes - the call was stopped`,
        };
      }
      parts.push(event.text);
    } else if (event.type === 'error') {
      return { ok: false, code: 'upstream', message: 'the model provider stream failed' };
    }
  }
  const text = parts.join('').trim();
  if (text === '') {
    return { ok: false, code: 'empty_reply', message: 'the model returned no text' };
  }
  return { ok: true, text, model: '' };
}

/**
 * One bounded completion. `system` is the contract the caller wants followed and
 * `user` is the single instruction — kept apart so a caller never has to build
 * a message array (and never has to think about roles).
 *
 * Returns a TYPED failure instead of throwing, so each caller decides what a
 * failure means (a deterministic fallback, a 400, or a sentence in the UI).
 */
export async function runBoundedModelCall(
  options: ModelCallOptions,
  input: { system: string; user: string },
): Promise<ModelCallOutcome> {
  const resolved = resolveChatModel({ providers: options.providers.list(), taskClass: 'chat' });
  if (resolved.provider === null || resolved.model.trim() === '') {
    return {
      ok: false,
      code: 'no_model',
      message: 'no model provider is configured for this call',
    };
  }

  let client: ProviderClient;
  try {
    client = await options.providers.clientFor(resolved.provider.id);
  } catch {
    // The provider exists but cannot serve a call (no key / keychain down).
    return {
      ok: false,
      code: 'no_provider',
      message: 'this provider cannot serve a model call - check its key',
    };
  }

  const timeoutMs = options.timeoutMs ?? MODEL_CALL_TIMEOUT_MS;
  const capBytes = options.replyCapBytes ?? MODEL_REPLY_CAP_BYTES;
  const now = options.now ?? Date.now;
  const startedAt = now();

  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve('timeout');
    }, timeoutMs);
  });

  let outcome: ModelCallOutcome | 'timeout';
  try {
    outcome = await Promise.race([
      collectReply(
        client.chatStream({
          model: resolved.model,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
          signal: controller.signal,
        }),
        capBytes,
      ),
      timeout,
    ]);
  } catch {
    // An aborted upstream surfaces here; a timeout is reported as one.
    if (timedOut) {
      return {
        ok: false,
        code: 'timeout',
        message: `the model call timed out after ${Math.max(1, now() - startedAt)}ms`,
      };
    }
    return { ok: false, code: 'upstream', message: 'the model provider stream failed' };
  } finally {
    // The timer's only job is to give up; it must not outlive the call.
    if (timer !== undefined) clearTimeout(timer);
  }
  if (outcome === 'timeout') {
    return {
      ok: false,
      code: 'timeout',
      message: `the model call timed out after ${Math.max(1, now() - startedAt)}ms`,
    };
  }
  if (!outcome.ok) return outcome;
  return { ok: true, text: outcome.text, model: resolved.model };
}
