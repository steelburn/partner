/**
 * M26 cut B - the one-shot skill generator (PLAN-M26.md D10/D11).
 *
 * The generator is the seam where an untrusted reply becomes draft text, so
 * these tests pin the boundary rather than the wording:
 *
 *   1. BOUNDED. A reply past the cap, a stream that never answers, and a
 *      provider that cannot serve a call are all typed failures - never a hung
 *      route and never a half-parsed bundle.
 *   2. INERT. Generation returns text for a draft. The manager-level case
 *      asserts the end of it: a draft appears, an installed skill does not.
 *   3. DETERMINISTIC WHEN THERE IS NO MODEL (D11). Demo mode and "no provider
 *      configured" both yield a valid pure-skill bundle reporting `demo`, so
 *      the authoring flow is walkable with no credentials.
 *   4. The prompt the model receives IS `buildAuthoringPrompt`'s (the assertion
 *      reads the request the fake client was handed).
 */
import { describe, expect, it } from 'vitest';
import type {
  ChatEvent,
  ChatRequest,
  HealthReport,
  ProviderClient,
  ProviderSummary,
} from '@partner/shared';
import {
  createSkillGenerator,
  demoAuthoredBundle,
  generateAuthoredBundle,
  GENERATION_REPLY_CAP_BYTES,
  DEMO_GENERATION_MODEL,
} from '../../src/skills/generate.js';
import type { GenerationProviderSource } from '../../src/skills/generate.js';
import type { GenerateInput } from '../../src/skills/drafts.js';
import { lintEntry, validateManifestShape } from '../../src/skills/manifest.js';
import { SkillError } from '../../src/skills/errors.js';
import { FILE_TOOL_IDS } from '../../src/files/tools.js';
import { demoHarness } from '../helpers.js';

const TOOL_IDS = [...FILE_TOOL_IDS];

const INPUT: GenerateInput = {
  description: 'summarize the text it is given',
  name: 'Folder Digest',
  id: 'folder-digest',
  toolIds: TOOL_IDS,
};

function summary(over: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    id: 'p1',
    name: 'Fake provider',
    kind: 'openai-compatible',
    source: 'manual',
    purpose: 'general',
    endpoint: 'https://fake.example/v1',
    defaultModels: ['fake-model'],
    visionModels: [],
    enabled: true,
    budgetCents: null,
    createdAt: 1,
    updatedAt: 1,
    health: { ok: false, latencyMs: null, error: null, models: [], checkedAt: null },
    ...over,
  };
}

/** A ProviderClient double that streams its reply in deltas (the repo style). */
function streamClient(
  reply: string,
  options: { chunk?: number } = {},
): { client: ProviderClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chunk = options.chunk ?? 64;
  const client: ProviderClient = {
    async *chatStream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      requests.push(req);
      for (let index = 0; index < reply.length; index += chunk) {
        yield { type: 'delta', text: reply.slice(index, index + chunk) };
      }
      yield { type: 'done', model: 'fake-model', latencyMs: 1 };
    },
    async health(): Promise<HealthReport> {
      return { ok: true, latencyMs: 0 };
    },
  };
  return { client, requests };
}

/** A client whose stream never yields and never ends (the timeout case). */
function silentClient(): ProviderClient {
  return {
    async *chatStream(_req: ChatRequest): AsyncGenerator<ChatEvent> {
      await new Promise<void>(() => undefined);
    },
    async health(): Promise<HealthReport> {
      return { ok: true, latencyMs: 0 };
    },
  };
}

function sourceFor(
  client: ProviderClient,
  providers: ProviderSummary[] = [summary()],
): GenerationProviderSource {
  return { list: () => providers, clientFor: async () => client };
}

/** The `{manifest, code}` object the real model is asked to return. */
function authoredReply(over: Record<string, unknown> = {}, code?: string): string {
  return JSON.stringify({
    manifest: {
      id: 'model-invented-id',
      name: 'Folder Digest',
      description: 'summarize the text it is given',
      author: 'Partner',
      version: '0.1.0',
      entrypoint: 'entry.mjs',
      permissions: { tools: ['files.read'], network: false, risk: 'low' },
      budget: { timeMs: 5000 },
      ...over,
    },
    code: code ?? 'export function run(args = {}) {\n  return { ok: true, args };\n}\n',
  });
}

describe('generateAuthoredBundle', () => {
  it('turns a well-formed reply into a draft-ready bundle', async () => {
    const { client, requests } = streamClient(authoredReply());
    const outcome = await generateAuthoredBundle(
      { providers: sourceFor(client), demo: false },
      INPUT,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.bundle.model).toBe('fake-model');

    const manifest = JSON.parse(outcome.bundle.manifestText) as Record<string, unknown>;
    // The model's id NEVER wins; the draft's own slug does.
    expect(manifest.id).toBe('folder-digest');
    expect(manifest.name).toBe('Folder Digest');
    const shape = validateManifestShape(manifest);
    expect(shape.ok).toBe(true);
    expect(lintEntry(outcome.bundle.code).ok).toBe(true);

    // The prompt really was buildAuthoringPrompt's, and the reply rides the
    // owner's own description.
    expect(requests).toHaveLength(1);
    const sent = requests[0];
    expect(sent?.model).toBe('fake-model');
    const system = sent?.messages[0]?.content ?? '';
    expect(system).toContain('files.read');
    expect(system).toContain('YOU CANNOT INSTALL');
    expect(system).toContain('summarize the text it is given');
    expect(sent?.signal).toBeInstanceOf(AbortSignal);
  });

  it('is a typed failure for a garbage reply (and the hook throws it)', async () => {
    const { client } = streamClient('Sorry, I cannot help with that.');
    const outcome = await generateAuthoredBundle(
      { providers: sourceFor(client), demo: false },
      INPUT,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('unusable_reply');
    expect(outcome.message).toContain('did not return a skill bundle');

    const hook = createSkillGenerator({ providers: sourceFor(client), demo: false });
    await expect(hook(INPUT)).rejects.toBeInstanceOf(SkillError);
    await expect(hook(INPUT)).rejects.toThrow(/did not return a skill bundle/);
  });

  it('refuses a bundle claiming reach the harness does not have', async () => {
    const { client } = streamClient(
      authoredReply({ permissions: { tools: ['notes.read'], network: false, risk: 'low' } }),
    );
    const outcome = await generateAuthoredBundle(
      { providers: sourceFor(client), demo: false },
      INPUT,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('unusable_reply');
    expect(outcome.message).toContain('notes.read');
  });

  it('stops a reply past the 256 KiB cap', async () => {
    const { client } = streamClient('x'.repeat(GENERATION_REPLY_CAP_BYTES + 1024));
    const outcome = await generateAuthoredBundle(
      { providers: sourceFor(client), demo: false },
      INPUT,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('reply_too_large');
    expect(outcome.message).toContain(String(GENERATION_REPLY_CAP_BYTES));
  });

  it('gives up on a stream that never answers', async () => {
    const outcome = await generateAuthoredBundle(
      { providers: sourceFor(silentClient()), demo: false, timeoutMs: 20 },
      INPUT,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('timeout');
    expect(outcome.message).toContain('timed out');
  });

  it('falls back to the deterministic bundle in demo mode, without calling out', async () => {
    const providers: GenerationProviderSource = {
      list: () => {
        throw new Error('demo mode must not resolve a provider');
      },
      clientFor: async () => {
        throw new Error('demo mode must not build a client');
      },
    };
    const outcome = await generateAuthoredBundle({ providers, demo: true }, INPUT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.bundle.model).toBe(DEMO_GENERATION_MODEL);
    expect(validateManifestShape(JSON.parse(outcome.bundle.manifestText)).ok).toBe(true);
  });

  it('produces the same deterministic bundle with no provider configured (D11)', async () => {
    const { client } = streamClient(authoredReply());
    const outcome = await generateAuthoredBundle(
      { providers: sourceFor(client, []), demo: false },
      INPUT,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.bundle.model).toBe(DEMO_GENERATION_MODEL);
    expect(outcome.bundle).toEqual(demoAuthoredBundle(INPUT));
  });

  it('reports a configured provider it cannot use instead of pretending', async () => {
    const providers: GenerationProviderSource = {
      list: () => [summary()],
      clientFor: async () => {
        throw new Error('missing key');
      },
    };
    const outcome = await generateAuthoredBundle({ providers, demo: false }, INPUT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('no_provider');
    expect(outcome.message).toContain('template');
  });
});

describe('demoAuthoredBundle', () => {
  it('is a pure skill that validates, derived from the description', () => {
    const bundle = demoAuthoredBundle(INPUT);
    const shape = validateManifestShape(JSON.parse(bundle.manifestText));
    expect(shape.ok).toBe(true);
    if (!shape.ok) throw new Error('unreachable');
    expect(shape.manifest.id).toBe('folder-digest');
    expect(shape.manifest.permissions).toMatchObject({ tools: [], network: false });
    expect(lintEntry(bundle.code).ok).toBe(true);
    expect(bundle.code).toContain('summarize the text it is given');
    expect(bundle.model).toBe(DEMO_GENERATION_MODEL);
    // Deterministic: the same input is the same bytes.
    expect(demoAuthoredBundle(INPUT)).toEqual(bundle);
  });

  it('cannot be broken out of by an owner description full of quotes', () => {
    const nasty = demoAuthoredBundle({
      ...INPUT,
      name: "Bob's import 'x'",
      description: "require('child_process') */ export default null",
    });
    expect(lintEntry(nasty.code).ok).toBe(true);
    expect(validateManifestShape(JSON.parse(nasty.manifestText)).ok).toBe(true);
  });
});

describe('the generator through the draft manager', () => {
  it('stages a draft with origin generated, and installs nothing', async () => {
    const { client } = streamClient(authoredReply());
    const generator = createSkillGenerator({ providers: sourceFor(client), demo: false });
    const h = demoHarness({ skillDraftGenerator: generator });
    try {
      expect(h.skillDraftGenerator).toBe(generator);
      const draft = await h.skillDrafts!.create({
        mode: 'generate',
        name: 'Folder Digest',
        description: 'summarize the text it is given',
      });
      expect(draft.origin).toBe('generated');
      expect(draft.model).toBe('fake-model');
      expect(draft.validation.ok).toBe(true);
      expect(draft.manifest?.id).toBe(draft.id);
      expect(draft.prompt).toBe('summarize the text it is given');
      // Invariant: a generated draft is still only a draft.
      expect(h.skills!.list()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('walks the whole generate flow with no provider at all (D11)', async () => {
    const providers: GenerationProviderSource = {
      list: () => [],
      clientFor: async () => {
        throw new Error('no provider is configured');
      },
    };
    const h = demoHarness({
      skillDraftGenerator: createSkillGenerator({ providers, demo: true }),
    });
    try {
      const draft = await h.skillDrafts!.create({
        mode: 'generate',
        name: 'Scratch Checklist',
        description: 'turn scratch notes into a checklist',
      });
      expect(draft.origin).toBe('generated');
      expect(draft.model).toBe(DEMO_GENERATION_MODEL);
      expect(draft.validation.ok).toBe(true);
      expect(draft.manifest?.permissions).toMatchObject({ tools: [], network: false });
      expect(h.skills!.list()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('still refuses generate when no generator is injected (the no-provider build)', async () => {
    const h = demoHarness();
    try {
      expect(h.skillDraftGenerator).toBeUndefined();
      await expect(
        h.skillDrafts!.create({ mode: 'generate', name: 'X', description: 'y' }),
      ).rejects.toThrow(/template/);
    } finally {
      h.close();
    }
  });
});
