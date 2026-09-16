/**
 * Skill generation: ONE bounded one-shot model call (M26 cut B, PLAN-M26.md).
 *
 * The Studio (and, in cut C, the chat) asks a configured model to draft
 * `manifest.json` + `entry.mjs` from the owner's description. This module is
 * the whole of that call, and it deliberately has no powers beyond it:
 *
 *   bounded      the streamed reply is collected under a 256 KiB cap and a 60 s
 *                AbortSignal timeout (D10), so a runaway generation cannot fill
 *                the database or the browser. The chat spend ledger is NOT
 *                settled here - that is D10's recorded gap, shared with
 *                daily-summarize and auto-remember, not an oversight.
 *   inert        the reply becomes text for a DRAFT. Nothing is executed and
 *                nothing is installed; the one install path stays in
 *                `drafts.ts` (`promote`), which an owner act calls.
 *   deterministic on the way in and out: the prompt is `buildAuthoringPrompt`
 *                (which restates the runner's real contract) and the reply goes
 *                through `parseAuthoringReply` + `normalizeAuthoredBundle`, so
 *                the id is the draft's slug, unknown tools are dropped, and a
 *                reach this build cannot honour is refused.
 *
 * Why a canned generator is part of the LIVE path (D11): "no provider
 * configured" means the flow must still be walkable, so the core answers with
 * a deterministic pure-skill bundle carrying `model: 'demo'` - the same honesty
 * as the demo chat provider. A provider that IS configured but cannot be used
 * (no key, keychain unavailable) is a DIFFERENT case and stays a typed failure:
 * the owner expects a model-drafted skill and must be told it did not happen.
 */
import type { ChatEvent, ProviderClient, ProviderSummary } from '@partner/shared';
import { resolveChatModel } from '../gateway/resolver.js';
import { buildAuthoringPrompt, normalizeAuthoredBundle, parseAuthoringReply } from './authoring.js';
import type { GenerateInput, GeneratedBundle } from './drafts.js';
import { skillError } from './errors.js';
import { DEFAULT_RUNTIME_CAPABILITIES } from './manifest.js';
import type { RuntimeCapabilities } from './manifest.js';

/** D10: the streamed reply cap. */
export const GENERATION_REPLY_CAP_BYTES = 256 * 1024;
/** D10: the one-shot timeout. */
export const GENERATION_TIMEOUT_MS = 60_000;
/** The model name a deterministic (demo / no-provider) bundle reports. */
export const DEMO_GENERATION_MODEL = 'demo';

/**
 * The slice of the provider manager generation needs (structural - easy to
 * fake in a test, and it documents that nothing else is touched).
 */
export interface GenerationProviderSource {
  list(): ProviderSummary[];
  clientFor(id: string): Promise<ProviderClient>;
}

export type GenerationFailureCode =
  | 'no_provider'
  | 'timeout'
  | 'reply_too_large'
  | 'unusable_reply'
  | 'upstream';

export type GenerationOutcome =
  | { ok: true; bundle: GeneratedBundle }
  | { ok: false; code: GenerationFailureCode; message: string };

export interface SkillGeneratorOptions {
  providers: GenerationProviderSource;
  /** Which reaches the runtime can honour (the authoring clamp's input). */
  capabilities?: RuntimeCapabilities;
  /** Demo mode never calls a provider (D11). */
  demo: boolean;
  /** Injectable clock (epoch ms) - used for the timeout message only. */
  now?: () => number;
  /** D10 default; injectable so a test can pin the abort path promptly. */
  timeoutMs?: number;
  /** D10 default; injectable so a test can exceed the cap cheaply. */
  replyCapBytes?: number;
}

/**
 * Strip everything that could form a module specifier or break out of a
 * comment, then clamp. The owner's own words end up inside generated source,
 * so they are treated as data: quotes, backticks and asterisks cannot survive.
 */
function safeText(raw: string, cap: number): string {
  return raw
    .replace(/[^A-Za-z0-9 .,;:()\-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

/**
 * The deterministic bundle (D11): a PURE skill - no tools, no network - whose
 * result is derived from the description. It is valid by construction, so the
 * authoring flow is walkable with no provider and with no credentials.
 */
export function demoAuthoredBundle(input: GenerateInput): GeneratedBundle {
  const name = safeText(input.name, 80) || 'Untitled Skill';
  const description = safeText(input.description, 300);
  const summary = description === '' ? 'A skill drafted without a model configured.' : description;
  const manifest = {
    id: input.id,
    name: input.name.trim(),
    description: summary,
    author: 'Partner (demo)',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    permissions: { tools: [], network: false, risk: 'low' },
    budget: { timeMs: 10_000 },
  };
  const code = `/**
 * ${name}
 *
 * ${summary}
 *
 * Drafted deterministically because no model provider was used. It is a pure
 * skill: it declares no tools and cannot reach the network, so it can only
 * transform the arguments it is given.
 */
export function run(args = {}) {
  const text = typeof args.text === 'string' ? args.text : '';
  return {
    skill: ${JSON.stringify(name)},
    summary: ${JSON.stringify(summary)},
    text,
    length: text.length,
  };
}
`;
  return { manifestText: JSON.stringify(manifest, null, 2), code, model: DEMO_GENERATION_MODEL };
}

/**
 * Collect a streamed reply under the byte cap. Reads only delta text; an
 * `error` event is a failed generation, not a partial answer.
 */
async function collectReply(
  events: AsyncIterable<ChatEvent>,
  capBytes: number,
): Promise<
  { ok: true; text: string } | { ok: false; code: GenerationFailureCode; message: string }
> {
  const parts: string[] = [];
  let bytes = 0;
  for await (const event of events) {
    if (event.type === 'delta') {
      bytes += Buffer.byteLength(event.text, 'utf8');
      if (bytes > capBytes) {
        return {
          ok: false,
          code: 'reply_too_large',
          message: `the model reply passed ${capBytes} bytes - generation was stopped`,
        };
      }
      parts.push(event.text);
    } else if (event.type === 'error') {
      return { ok: false, code: 'upstream', message: 'the model provider stream failed' };
    }
  }
  const text = parts.join('').trim();
  if (text === '') {
    return { ok: false, code: 'unusable_reply', message: 'the model returned no text' };
  }
  return { ok: true, text };
}

/**
 * One bounded generation. Returns a TYPED failure instead of throwing, so a
 * caller can decide what a failure means (the route renders 400; a chat turn
 * could say so in the conversation). `createSkillGenerator` is the hook the
 * draft manager takes.
 */
export async function generateAuthoredBundle(
  options: SkillGeneratorOptions,
  input: GenerateInput,
): Promise<GenerationOutcome> {
  const capabilities = options.capabilities ?? DEFAULT_RUNTIME_CAPABILITIES;
  const demoBundle: GenerationOutcome = { ok: true, bundle: demoAuthoredBundle(input) };
  if (options.demo) return demoBundle;

  const resolved = resolveChatModel({ providers: options.providers.list(), taskClass: 'chat' });
  if (resolved.provider === null || resolved.model.trim() === '') return demoBundle;

  let client: ProviderClient;
  try {
    client = await options.providers.clientFor(resolved.provider.id);
  } catch {
    // The provider exists but cannot serve a call (no key / keychain down).
    return {
      ok: false,
      code: 'no_provider',
      message:
        'this provider cannot serve a generation call - check its key, or start from a template',
    };
  }

  const prompt = buildAuthoringPrompt({
    description: input.description,
    name: input.name,
    toolIds: input.toolIds,
    capabilities,
  });
  const timeoutMs = options.timeoutMs ?? GENERATION_TIMEOUT_MS;
  const capBytes = options.replyCapBytes ?? GENERATION_REPLY_CAP_BYTES;
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

  let outcome: Awaited<ReturnType<typeof collectReply>> | 'timeout';
  try {
    outcome = await Promise.race([
      collectReply(
        client.chatStream({
          model: resolved.model,
          messages: [
            { role: 'system', content: prompt },
            {
              role: 'user',
              content:
                'Draft the skill now, answering with the single JSON object and nothing else.',
            },
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
        message: `generation timed out after ${Math.max(1, now() - startedAt)}ms`,
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
      message: `generation timed out after ${Math.max(1, now() - startedAt)}ms`,
    };
  }
  if (!outcome.ok) return outcome;

  const parsed = parseAuthoringReply(outcome.text);
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'unusable_reply',
      message: `the model did not return a skill bundle: ${parsed.errors.join('; ')}`,
    };
  }
  const normalized = normalizeAuthoredBundle(parsed.bundle, {
    slug: input.id,
    toolIds: input.toolIds,
    capabilities,
  });
  if (!normalized.ok) {
    return {
      ok: false,
      code: 'unusable_reply',
      message: `the model drafted a bundle the core refuses: ${normalized.errors.join('; ')}`,
    };
  }
  return {
    ok: true,
    bundle: { manifestText: normalized.manifestText, code: normalized.code, model: resolved.model },
  };
}

/**
 * The `generate` hook `createSkillDraftManager` accepts. A generation failure
 * is thrown as a typed SkillError, which the loopback route already renders as
 * 400 with the message - the same shape the "no generator" refusal uses.
 */
export function createSkillGenerator(
  options: SkillGeneratorOptions,
): (input: GenerateInput) => Promise<GeneratedBundle> {
  return async (input: GenerateInput): Promise<GeneratedBundle> => {
    const outcome = await generateAuthoredBundle(options, input);
    if (outcome.ok) return outcome.bundle;
    throw skillError('invalid_input', outcome.message);
  };
}
