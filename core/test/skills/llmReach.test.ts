/**
 * M27 S5 - model reach from a skill: `partner.llm.complete`, DECLARED and
 * BOUNDED (PLAN-M27.md S5 + decisions D11/D12/D13).
 *
 * A skill could not call a model at all before this slice (the worker's
 * `partner` global was `log` + `tools.exec`), and `SkillBudget.maxTokens` had
 * been declared and validated since M8 and never read. What these tests pin:
 *
 *   - the reach EXISTS when the manifest declares it: a skill completes a model
 *     call, gets the text back, and the prompt really reaches the provider —
 *     which is the honest cost of the capability;
 *   - it is NOT ambient: `permissions.llm: false` and an absent field both
 *     refuse `llm_not_declared` and never reach a provider;
 *   - it is BOUNDED by the skill's own token ceiling, accumulated across every
 *     call in one invocation, and past it the INVOCATION fails
 *     `budget_exceeded` with the worker killed — not a partial success. A
 *     declaration with no ceiling gets the documented default instead of
 *     running unbounded, and the install summary states the number that binds;
 *   - it is CLASS-gated (`skill.llm`, desktop only): a mobile session's skill
 *     run is refused before a provider is even resolved;
 *   - it never grows a content channel: the audit row and the invocation meta
 *     row carry the model id and token counts, never the prompt or the answer.
 *
 * Nothing here touches the network: the provider is a FAKE ProviderClient
 * scripted per test, injected through the runner's `llm` resolver — the same
 * seam `createCore` fills with `createSkillLlmResolver(providerManager)`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatEvent, ChatRequest, ProviderClient, SkillDetail, SkillManifest } from '@partner/shared';
import { demoHarness, makeTempRoot, removeTempRoot } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { createSkillRunner } from '../../src/skills/runner.js';
import type { SkillRunner } from '../../src/skills/runner.js';
import {
  DEFAULT_SKILL_LLM_MAX_TOKENS,
  MAX_SKILL_LLM_PROMPT_BYTES,
} from '../../src/skills/llm.js';
import type { SkillLlmResolver } from '../../src/skills/llm.js';
import { permissionSummary } from '../../src/skills/runtime.js';

const LLM_ID = 'llm-summariser';
const MODEL = 'gpt-4.1';
const PROVIDER_ID = 'prov-test';
/** Distinctive strings: the leak assertions search the audit/meta rows for them. */
const PROMPT = 'PROMPT-MARKER read these notes and summarise them';
const COMPLETION = 'COMPLETION-MARKER the notes say the cat sat';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

/** The entry that exercises the verb: catch, report, or return the text. */
const ENTRY = `export async function run(args = {}) {
  try {
    const call = { prompt: args.prompt };
    if (args.maxTokens !== undefined) call.maxTokens = args.maxTokens;
    const out = await globalThis.partner.llm.complete(call);
    globalThis.partner.log('llm.complete returned');
    return { summary: out.text, totalTokens: out.usage ? out.usage.totalTokens : null };
  } catch (err) {
    globalThis.partner.log('llm.complete refused: ' + err.code);
    return { refused: err.code };
  }
}`;

/** Builds a prompt from a byte count, so the payload never rides the args cap. */
const BIG_PROMPT_ENTRY = `export async function run(args = {}) {
  try {
    await globalThis.partner.llm.complete({ prompt: 'x'.repeat(args.bytes) });
    return { sent: true };
  } catch (err) {
    return { refused: err.code };
  }
}`;

interface FakeCall {
  model: string;
  prompt: string;
}

interface FakeProvider {
  client: ProviderClient;
  calls: FakeCall[];
}

interface FakeReply {
  text?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** false = the provider reports NO usage event at all. */
  usage?: boolean;
  error?: boolean;
}

/** A scripted provider client: no network, no key, deterministic events. */
function fakeProvider(reply: FakeReply = {}): FakeProvider {
  const calls: FakeCall[] = [];
  const text = reply.text ?? COMPLETION;
  const totalTokens = reply.totalTokens ?? 18;
  const client: ProviderClient = {
    async *chatStream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      calls.push({
        model: req.model,
        prompt: req.messages.map((message) => message.content).join('\n'),
      });
      if (reply.error === true) {
        yield { type: 'error', message: 'provider blew up' };
        return;
      }
      yield { type: 'delta', text };
      if (reply.usage !== false) {
        yield {
          type: 'usage',
          promptTokens: reply.promptTokens ?? Math.max(1, totalTokens - 7),
          completionTokens: reply.completionTokens ?? 7,
          totalTokens,
        };
      }
      yield { type: 'done', model: req.model, latencyMs: 1 };
    },
    async health() {
      return { ok: true, latencyMs: 1 };
    },
  };
  return { client, calls };
}

function resolverFor(fake: FakeProvider): SkillLlmResolver {
  return () => ({ client: fake.client, model: MODEL, providerId: PROVIDER_ID });
}

interface Env {
  h: Harness;
  runner: SkillRunner;
  /** Redacted lines the runner's sink received. */
  lines(): string[];
  close(): void;
}

/**
 * The harness owns the real stores (audit, invocations, spend ledger, broker)
 * and a store dir this test controls; the runner under test is the REAL one,
 * built with a fake model provider — the only thing replaced — plus a line sink
 * so a test can see whether the worker ever resumed after a call.
 */
function buildEnv(llm?: SkillLlmResolver | null): Env {
  const storeDir = makeTempRoot();
  dirs.push(storeDir);
  const h = demoHarness({ skills: { storeDir } });
  const lines: string[] = [];
  const runner = createSkillRunner({
    dataDir: storeDir,
    broker: h.broker as NonNullable<Harness['broker']>,
    audit: h.audit,
    invocations: h.skillInvocationStore,
    spendLedger: h.spendLedger,
    log: (line) => {
      lines.push(line);
    },
    ...(llm === undefined || llm === null ? {} : { llm }),
  });
  return {
    h,
    runner,
    lines: () => lines,
    close(): void {
      h.close();
    },
  };
}

/** Install (through the manager's one door) an authored llm fixture. */
function installSkill(
  h: Harness,
  options: {
    id?: string;
    code?: string;
    llm?: boolean | undefined;
    maxTokens?: number;
  } = {},
): SkillDetail {
  const id = options.id ?? LLM_ID;
  const permissions: SkillManifest['permissions'] = {
    tools: [],
    network: false,
    risk: 'low',
    ...(options.llm === undefined ? {} : { llm: options.llm }),
  };
  const manifest: SkillManifest = {
    id,
    name: 'LLM Summariser',
    description: 'summarises text with the configured model',
    author: 'tests',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    permissions,
    budget:
      options.maxTokens === undefined
        ? { timeMs: 5000 }
        : { timeMs: 5000, maxTokens: options.maxTokens },
  };
  const skills = h.skills;
  if (skills === undefined) throw new Error('the skills manager is unwired in this harness');
  skills.installFromBundle({ manifest, code: options.code ?? ENTRY }, { update: false, source: 'authored' });
  const detail = skills.get(id);
  if (detail === null) throw new Error(`skill ${id} did not install`);
  return detail;
}

function meta(env: Env, id: string): unknown {
  return env.h.skillInvocationStore.listBySkill(id, 10);
}

function llmAuditRows(env: Env): Array<{ target: string; actor: string; details: Record<string, unknown> }> {
  return env.h.audit
    .list(500)
    .filter((row) => row.action === 'skill.llm')
    .map((row) => ({
      target: row.target,
      actor: row.actor,
      details: JSON.parse(row.details) as Record<string, unknown>,
    }));
}

/** The lines an owner reads before installing, for one manifest. */
function installSummary(options: { llm: boolean; maxTokens?: number }): string[] {
  return permissionSummary({
    id: 'x',
    name: 'X',
    description: 'x',
    author: 'tests',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    permissions: { tools: [], network: false, risk: 'low', llm: options.llm },
    budget:
      options.maxTokens === undefined
        ? { timeMs: 5000 }
        : { timeMs: 5000, maxTokens: options.maxTokens },
  });
}

describe('M27 S5 - a declared llm skill completes a model call', () => {
  it('returns the model text, and the prompt really reaches the provider', async () => {
    const fake = fakeProvider({ totalTokens: 18, promptTokens: 11, completionTokens: 7 });
    const env = buildEnv(resolverFor(fake));
    try {
      const detail = installSkill(env.h, { llm: true, maxTokens: 1000 });
      const out = await env.runner.invoke(detail, { prompt: PROMPT });

      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result).toEqual({ summary: COMPLETION, totalTokens: 18 });
      // The reach is real: one call, to the resolved model, carrying the prompt
      // the skill built (the whole point of the capability, and its cost).
      expect(fake.calls).toEqual([{ model: MODEL, prompt: PROMPT }]);
      expect(env.h.audit.list(500).some((row) => row.action === 'skill.invoke')).toBe(true);
    } finally {
      env.close();
    }
  });

  it('answers a refusal the skill can catch (upstream) without failing the run', async () => {
    const fake = fakeProvider({ error: true });
    const env = buildEnv(resolverFor(fake));
    try {
      const detail = installSkill(env.h, { llm: true, maxTokens: 1000 });
      const out = await env.runner.invoke(detail, { prompt: PROMPT });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result).toEqual({ refused: 'upstream' });
      // The worker survived a provider failure, so the skill chose what to do.
      expect(env.lines().join('\n')).toContain('llm.complete refused: upstream');
    } finally {
      env.close();
    }
  });
});

describe('M27 S5 - the declaration is required, never implied', () => {
  it('refuses llm: false AND an absent field with llm_not_declared', async () => {
    const fake = fakeProvider();
    const env = buildEnv(resolverFor(fake));
    try {
      const off = installSkill(env.h, { id: 'llm-off', llm: false, maxTokens: 1000 });
      const absent = installSkill(env.h, { id: 'llm-absent', maxTokens: 1000 });

      for (const detail of [off, absent]) {
        const out = await env.runner.invoke(detail, { prompt: PROMPT });
        expect(out.ok).toBe(true);
        if (out.ok) expect(out.result).toEqual({ refused: 'llm_not_declared' });
      }
      // Neither reached a provider, and neither left a model-call audit row.
      expect(fake.calls).toEqual([]);
      expect(llmAuditRows(env)).toEqual([]);
    } finally {
      env.close();
    }
  });

  it('refuses a malformed request with bad_params (the core validates, not the worker)', async () => {
    const fake = fakeProvider();
    const env = buildEnv(resolverFor(fake));
    try {
      const detail = installSkill(env.h, { llm: true, maxTokens: 1000 });
      const out = await env.runner.invoke(detail, { prompt: PROMPT, maxTokens: -1 });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result).toEqual({ refused: 'bad_params' });
      expect(fake.calls).toEqual([]);
    } finally {
      env.close();
    }
  });
});

describe('M27 S5 - the token ceiling bounds the invocation', () => {
  it('fails the invocation budget_exceeded MID-RUN and kills the worker', async () => {
    // Usage past the declared 1000-token ceiling: the skill's own second half
    // must never run, and no partial success may come back.
    const fake = fakeProvider({ totalTokens: 5000, promptTokens: 4000, completionTokens: 1000 });
    const env = buildEnv(resolverFor(fake));
    try {
      const detail = installSkill(env.h, { llm: true, maxTokens: 1000 });
      const out = await env.runner.invoke(detail, { prompt: PROMPT });

      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error).toBe('budget_exceeded');
        // A FAILURE carries no result at all - there is no partial success path.
        expect(Object.keys(out).sort()).toEqual(['error', 'meta', 'ok']);
        expect(out.meta).toMatchObject({ ok: false, error: 'budget_exceeded' });
      }
      // The worker was KILLED, not answered: it never resumed after the call, so
      // neither the success nor the catch branch of the entry ran.
      const logs = env.lines().join('\n');
      expect(logs).not.toContain('llm.complete returned');
      expect(logs).not.toContain('llm.complete refused');

      // The spend still happened, so it is still accounted and traced: the
      // ceiling bounds the run, it does not erase what the provider charged.
      const rows = llmAuditRows(env);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.details).toMatchObject({ model: MODEL, totalTokens: 5000 });
      expect(env.h.skillInvocationStore.listBySkill(LLM_ID, 10)).toMatchObject([
        { skillId: LLM_ID, ok: 0, error: 'budget_exceeded' },
      ]);
    } finally {
      env.close();
    }
  });

  it('uses the documented default ceiling when the manifest declares none', async () => {
    // No budget.maxTokens: the default must BIND, not the sky.
    const under = fakeProvider({ totalTokens: DEFAULT_SKILL_LLM_MAX_TOKENS - 1 });
    const underEnv = buildEnv(resolverFor(under));
    try {
      const detail = installSkill(underEnv.h, { id: 'llm-default', llm: true });
      expect(detail.manifest.budget.maxTokens).toBeUndefined();
      const out = await underEnv.runner.invoke(detail, { prompt: PROMPT });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result).toMatchObject({ summary: COMPLETION });
    } finally {
      underEnv.close();
    }

    const over = fakeProvider({ totalTokens: DEFAULT_SKILL_LLM_MAX_TOKENS + 1 });
    const overEnv = buildEnv(resolverFor(over));
    try {
      const detail = installSkill(overEnv.h, { id: 'llm-default', llm: true });
      const out = await overEnv.runner.invoke(detail, { prompt: PROMPT });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toBe('budget_exceeded');
    } finally {
      overEnv.close();
    }
  });

  it('accumulates tokens across EVERY call in one invocation', async () => {
    // Three calls of 400 tokens each: 1200 > the 1000 ceiling, even though no
    // single call passed it.
    const fake = fakeProvider({ totalTokens: 400, promptTokens: 390, completionTokens: 10 });
    const env = buildEnv(resolverFor(fake));
    try {
      const detail = installSkill(env.h, {
        llm: true,
        maxTokens: 1000,
        code: `export async function run() {
  try {
    for (let i = 0; i < 3; i++) await globalThis.partner.llm.complete({ prompt: 'call ' + i });
    return { calls: 3 };
  } catch (err) {
    return { refused: err.code };
  }
}`,
      });
      const out = await env.runner.invoke(detail, { prompt: PROMPT });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toBe('budget_exceeded');
      // Two calls were accounted before the third broke the ceiling.
      expect(llmAuditRows(env)).toHaveLength(3);
    } finally {
      env.close();
    }
  });

  it('lets a per-call maxTokens tighten the ceiling, never raise it', async () => {
    const fake = fakeProvider({ totalTokens: 10, promptTokens: 5, completionTokens: 5 });
    const env = buildEnv(resolverFor(fake));
    try {
      const detail = installSkill(env.h, { llm: true, maxTokens: 1000 });
      // The invocation ceiling is 1000, but the CALL asked for at most 5.
      const out = await env.runner.invoke(detail, { prompt: PROMPT, maxTokens: 5 });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toBe('budget_exceeded');
    } finally {
      env.close();
    }
  });

  it('states the binding ceiling in the install summary (declared and default)', () => {
    const declared = installSummary({ llm: true, maxTokens: 2500 });
    expect(declared.some((line) => line.includes('2500 model tokens per invocation'))).toBe(true);
    const fallback = installSummary({ llm: true });
    expect(
      fallback.some((line) =>
        line.includes(
          `${DEFAULT_SKILL_LLM_MAX_TOKENS} model tokens per invocation (the default ceiling)`,
        ),
      ),
    ).toBe(true);
    // A skill with no model reach says nothing about tokens.
    expect(installSummary({ llm: false }).some((line) => line.includes('model tokens'))).toBe(false);
  });
});

describe('M27 S5 - the session class gates the reach', () => {
  it('denies a mobile (and extension) session skill.llm, before a provider is resolved', async () => {
    const fake = fakeProvider();
    const env = buildEnv(resolverFor(fake));
    try {
      const detail = installSkill(env.h, { llm: true, maxTokens: 1000 });

      for (const clientClass of ['mobile', 'extension']) {
        const out = await env.runner.invoke(detail, { prompt: PROMPT }, { clientClass });
        expect(out.ok).toBe(true);
        if (out.ok) expect(out.result).toEqual({ refused: 'capability_denied' });
      }
      // The refusal is BEFORE the provider: a phone's skill run cannot send the
      // user's data to a model on the phone's behalf.
      expect(fake.calls).toEqual([]);
      expect(llmAuditRows(env)).toEqual([]);

      // The same call from the desktop class works, so the class is the cause.
      const desktop = await env.runner.invoke(detail, { prompt: PROMPT }, { clientClass: 'desktop' });
      expect(desktop.ok).toBe(true);
      if (desktop.ok) expect(desktop.result).toMatchObject({ summary: COMPLETION });
      expect(fake.calls).toHaveLength(1);
    } finally {
      env.close();
    }
  });

  it('keeps the desktop envelope when no class is given (a persona/schedule run)', async () => {
    const fake = fakeProvider();
    const env = buildEnv(resolverFor(fake));
    try {
      const detail = installSkill(env.h, { llm: true, maxTokens: 1000 });
      const out = await env.runner.invoke(detail, { prompt: PROMPT });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result).toMatchObject({ summary: COMPLETION });
    } finally {
      env.close();
    }
  });
});

describe('M27 S5 - no usable model configuration', () => {
  it('answers no_provider when the resolver finds nothing, and when it is absent', async () => {
    // (a) the production shape with no provider configured / no key usable.
    const empty = buildEnv(() => null);
    try {
      const detail = installSkill(empty.h, { llm: true, maxTokens: 1000 });
      const out = await empty.runner.invoke(detail, { prompt: PROMPT });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result).toEqual({ refused: 'no_provider' });
      expect(empty.lines().join('\n')).toContain('llm.complete refused: no_provider');
      expect(llmAuditRows(empty)).toEqual([]);
    } finally {
      empty.close();
    }

    // (b) a build with no model reach wired at all.
    const none = buildEnv(null);
    try {
      const detail = installSkill(none.h, { llm: true, maxTokens: 1000 });
      const out = await none.runner.invoke(detail, { prompt: PROMPT });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result).toEqual({ refused: 'no_provider' });
    } finally {
      none.close();
    }
  });
});

describe('M27 S5 - the trace carries counts, never content', () => {
  it('audits one row per call with the model id and token counts', async () => {
    const fake = fakeProvider({ totalTokens: 18, promptTokens: 11, completionTokens: 7 });
    const env = buildEnv(resolverFor(fake));
    try {
      const detail = installSkill(env.h, { llm: true, maxTokens: 1000 });
      await env.runner.invoke(detail, { prompt: PROMPT });

      const rows = llmAuditRows(env);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.target).toBe(`${LLM_ID}/${MODEL}`);
      expect(rows[0]?.actor).toBe('skill');
      expect(rows[0]?.details).toMatchObject({
        skillId: LLM_ID,
        model: MODEL,
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      });
      expect(typeof rows[0]?.details.ms).toBe('number');
    } finally {
      env.close();
    }
  });

  it('never lets the prompt or the completion reach audit, the meta row or the log sink', async () => {
    const fake = fakeProvider();
    const env = buildEnv(resolverFor(fake));
    try {
      const detail = installSkill(env.h, { llm: true, maxTokens: 1000 });
      const out = await env.runner.invoke(detail, { prompt: PROMPT });

      const audit = JSON.stringify(env.h.audit.list(500));
      expect(audit).not.toContain(PROMPT);
      expect(audit).not.toContain(COMPLETION);
      // The invocation meta row (and the response's copy of it) holds counts.
      const invocations = JSON.stringify(meta(env, LLM_ID));
      expect(invocations).not.toContain(PROMPT);
      expect(invocations).not.toContain(COMPLETION);
      expect(out.ok).toBe(true);
      expect(JSON.stringify(out.meta)).not.toContain(PROMPT);
      expect(JSON.stringify(out.meta)).not.toContain(COMPLETION);
      // The prompt rides the request to the provider and NOWHERE else.
      expect(env.lines().join('\n')).not.toContain(PROMPT);
      expect(env.lines().join('\n')).not.toContain(COMPLETION);
    } finally {
      env.close();
    }
  });

  it('charges the provider rolling window with the tokens spent (D13)', async () => {
    // gpt-4.1 is priced at 4.0 USD/1M blended -> 5000 tokens = 2 cents.
    const fake = fakeProvider({ totalTokens: 5000, promptTokens: 4000, completionTokens: 1000 });
    const env = buildEnv(resolverFor(fake));
    try {
      const detail = installSkill(env.h, { llm: true, maxTokens: 10_000 });
      const out = await env.runner.invoke(detail, { prompt: PROMPT });
      expect(out.ok).toBe(true);
      expect(env.h.spendLedger.spent(PROVIDER_ID)).toBe(2);
      expect(llmAuditRows(env)[0]?.details.cents).toBe(2);
    } finally {
      env.close();
    }
  });
});

describe('M27 S5 - the reach is still bounded when the provider says nothing', () => {
  it('bounds a prompt past the byte cap (caps_exceeded) and a silent provider', async () => {
    const fake = fakeProvider();
    const env = buildEnv(resolverFor(fake));
    try {
      const detail = installSkill(env.h, {
        llm: true,
        maxTokens: 1000,
        code: BIG_PROMPT_ENTRY,
      });
      const big = await env.runner.invoke(detail, { bytes: MAX_SKILL_LLM_PROMPT_BYTES + 1 });
      expect(big.ok).toBe(true);
      if (big.ok) expect(big.result).toEqual({ refused: 'caps_exceeded' });
      expect(fake.calls).toEqual([]);

      // One byte under the cap still reaches the provider.
      const under = await env.runner.invoke(detail, { bytes: 1024 });
      expect(under.ok).toBe(true);
      if (under.ok) expect(under.result).toEqual({ sent: true });
      expect(fake.calls).toHaveLength(1);
    } finally {
      env.close();
    }
  });

  it('accounts a conservative estimate when a stream reports no usage at all', async () => {
    // A provider that reports nothing must not make the ceiling unbounded: the
    // stream is still settled (and traced as an estimate).
    const fake = fakeProvider({ usage: false, text: COMPLETION });
    const env = buildEnv(resolverFor(fake));
    try {
      const detail = installSkill(env.h, { llm: true, maxTokens: 1000 });
      const out = await env.runner.invoke(detail, { prompt: PROMPT });
      expect(out.ok).toBe(true);
      const rows = llmAuditRows(env);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.details).toMatchObject({ model: MODEL, estimated: true });
      expect(rows[0]?.details.totalTokens as number).toBeGreaterThan(0);
      // The skill still gets the text; only the accounting is an estimate.
      if (out.ok) expect(out.result).toMatchObject({ summary: COMPLETION });
    } finally {
      env.close();
    }
  });

  it('falls back to the estimate and trips when the estimate passes the ceiling', async () => {
    const fake = fakeProvider({ usage: false, text: 'x'.repeat(64 * 1024) });
    const env = buildEnv(resolverFor(fake));
    try {
      // 64 KiB of reply is ~16k estimated tokens, well past a 100-token ceiling.
      const detail = installSkill(env.h, { llm: true, maxTokens: 100 });
      const out = await env.runner.invoke(detail, { prompt: PROMPT });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toBe('budget_exceeded');
      expect(env.lines().join('\n')).not.toContain('llm.complete returned');
    } finally {
      env.close();
    }
  });
});

describe('M27 S5 - the worker protocol', () => {
  it('rejects a call the worker cannot form without a core round trip', async () => {
    const fake = fakeProvider();
    const env = buildEnv(resolverFor(fake));
    try {
      const detail = installSkill(env.h, {
        llm: true,
        maxTokens: 1000,
        code: 'export async function run() { try { await globalThis.partner.llm.complete({}); return { sent: true }; } catch (err) { return { refused: err.code }; } }',
      });
      const out = await env.runner.invoke(detail, {});
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result).toEqual({ refused: 'bad_params' });
      expect(fake.calls).toEqual([]);
    } finally {
      env.close();
    }
  });
});
