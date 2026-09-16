import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CLIENT_CLASSES,
  CLIENT_ENVELOPE,
  capabilityDenial,
  isCapability,
  isClientClass,
} from '../../src/http/capabilities.js';
import type { Capability, ClientClass } from '../../src/http/capabilities.js';

describe('client classes', () => {
  it('is the three enrolled client kinds', () => {
    expect([...CLIENT_CLASSES]).toEqual(['desktop', 'mobile', 'extension']);
    for (const known of CLIENT_CLASSES) expect(isClientClass(known)).toBe(true);
  });

  it('fails closed on anything else', () => {
    for (const value of ['', 'web', 'shell', 'DESKTOP', 'Desktop', 'device']) {
      expect(isClientClass(value)).toBe(false);
    }
    for (const value of [null, undefined, 42, {}, ['desktop']]) {
      expect(isClientClass(value)).toBe(false);
    }
  });
});

describe('capability envelope', () => {
  it('names an envelope for every class, drawn only from the vocabulary', () => {
    for (const clientClass of CLIENT_CLASSES) {
      const envelope = CLIENT_ENVELOPE[clientClass];
      expect(envelope.length).toBeGreaterThan(0);
      for (const capability of envelope) expect(CAPABILITIES).toContain(capability);
    }
  });

  it('grants desktop everything and nests extension inside mobile inside desktop', () => {
    expect([...CLIENT_ENVELOPE.desktop].sort()).toEqual([...CAPABILITIES].sort());
    const desktop = new Set<Capability>(CLIENT_ENVELOPE.desktop);
    const mobile = new Set<Capability>(CLIENT_ENVELOPE.mobile);
    for (const capability of CLIENT_ENVELOPE.extension) expect(mobile.has(capability)).toBe(true);
    for (const capability of CLIENT_ENVELOPE.mobile) expect(desktop.has(capability)).toBe(true);
  });

  it('keeps the extension to read + browser + chat only', () => {
    expect([...CLIENT_ENVELOPE.extension].sort()).toEqual(['browser', 'chat', 'file.read']);
  });

  it('has no duplicate entries', () => {
    for (const clientClass of CLIENT_CLASSES) {
      const envelope = CLIENT_ENVELOPE[clientClass];
      expect(new Set(envelope).size).toBe(envelope.length);
    }
  });
});

describe('capabilityDenial', () => {
  it('allows every capability of every class envelope', () => {
    for (const clientClass of CLIENT_CLASSES) {
      for (const capability of CLIENT_ENVELOPE[clientClass]) {
        expect(capabilityDenial(clientClass, capability)).toBeNull();
      }
    }
  });

  it('denies the mobile envelope by name, with the capability in the refusal', () => {
    const denied: Capability[] = ['file.write', 'roots', 'deploy', 'skill.install'];
    for (const capability of denied) {
      expect(capabilityDenial('mobile', capability)).toEqual({
        ok: false,
        reason: 'capability_denied',
        clientClass: 'mobile',
        capability,
      });
    }
    // The same four are allowed on desktop, so the denial is not vacuous.
    for (const capability of denied) expect(capabilityDenial('desktop', capability)).toBeNull();
  });

  it('denies the extension everything outside read + browser + chat', () => {
    for (const capability of ['file.write', 'roots', 'deploy', 'skill.install', 'skill.invoke', 'mcp.call', 'grants', 'skill.llm'] as Capability[]) {
      const denial = capabilityDenial('extension', capability);
      expect(denial?.reason).toBe('capability_denied');
      expect(denial?.capability).toBe(capability);
    }
    for (const capability of ['chat', 'file.read', 'browser'] as Capability[]) {
      expect(capabilityDenial('extension', capability)).toBeNull();
    }
  });

  it('denies an unknown class', () => {
    for (const clientClass of ['', 'web', 'DESKTOP', 'device']) {
      expect(capabilityDenial(clientClass, 'chat')).toEqual({
        ok: false,
        reason: 'unknown_client_class',
        clientClass,
        capability: 'chat',
      });
    }
  });

  it('denies an unknown capability rather than defaulting to allow', () => {
    for (const capability of ['', 'file.delete', 'FILE.READ', 'file', 'chat.tools']) {
      expect(capabilityDenial('desktop', capability)).toEqual({
        ok: false,
        reason: 'unknown_capability',
        clientClass: 'desktop',
        capability,
      });
    }
  });

  it('denies non-string input instead of throwing or allowing', () => {
    expect(capabilityDenial(null as unknown as ClientClass, 'chat')?.reason).toBe(
      'unknown_client_class',
    );
    expect(capabilityDenial('desktop', undefined as unknown as Capability)?.reason).toBe(
      'unknown_capability',
    );
    expect(capabilityDenial(0 as unknown as ClientClass, null as unknown as Capability)).toEqual({
      ok: false,
      reason: 'unknown_client_class',
      clientClass: 0,
      capability: null,
    });
  });

  it('carries no data beyond the two names it was asked about', () => {
    const denial = capabilityDenial('mobile', 'file.write');
    expect(denial).not.toBeNull();
    expect(Object.keys(denial ?? {}).sort()).toEqual([
      'capability',
      'clientClass',
      'ok',
      'reason',
    ]);
    expect(JSON.stringify(denial)).toBe(
      '{"ok":false,"reason":"capability_denied","clientClass":"mobile","capability":"file.write"}',
    );
  });
});

describe('capability vocabulary', () => {
  it('is a closed set of dotted names', () => {
    expect([...CAPABILITIES]).toEqual([
      'chat',
      'file.read',
      'file.write',
      'browser',
      'roots',
      'grants',
      'deploy',
      'skill.install',
      'skill.invoke',
      // M26: authoring is gated SEPARATELY from installing — writing a draft is
      // inert (nothing runs, nothing installs), so it gets its own name and is
      // denied to mobile/extension by the same allowlist mechanism.
      'skill.author',
      'mcp.call',
      // M27 S5: a skill's MODEL REACH. New name, deliberately NOT added to the
      // narrow allowlists: the runner checks it (with the session class S3
      // propagates) before it resolves a provider, so a phone's skill run
      // cannot send the user's data to a model provider.
      'skill.llm',
      // M22: the two names the vocabulary was missing (the recorded "gap").
      'provider.configure',
      'persona.run',
    ]);
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
    for (const capability of CAPABILITIES) expect(capability).toMatch(/^[a-z]+(\.[a-z]+)*$/);
  });

  it('recognizes exactly those names', () => {
    for (const capability of CAPABILITIES) expect(isCapability(capability)).toBe(true);
    for (const value of ['', 'file.delete', 'Chat', null, 7]) expect(isCapability(value)).toBe(false);
  });
});

describe('the mobile envelope is narrow BY DECISION, not by omission', () => {
  it('is exactly read + browser + chat', () => {
    // Pinned so widening it is a deliberate, reviewable change. `grants`,
    // `skill.invoke` and `mcp.call` are INDIRECT routes to capabilities mobile is
    // denied (a skill or MCP server carries its own permissions, and neither
    // module consults the session class today), so they stay out until the S4
    // wiring proves the class propagates into that execution.
    expect([...CLIENT_ENVELOPE.mobile].sort()).toEqual(['browser', 'chat', 'file.read']);
  });

  it('denies each indirect route by name, so a phone cannot reach file-write sideways', () => {
    for (const capability of ['grants', 'skill.invoke', 'mcp.call', 'file.write', 'roots', 'deploy', 'skill.install', 'skill.llm'] as Capability[]) {
      expect(capabilityDenial('mobile', capability)).toEqual({
        ok: false,
        reason: 'capability_denied',
        clientClass: 'mobile',
        capability,
      });
    }
  });

  it('leaves desktop with the full vocabulary, so nothing is denied outright', () => {
    for (const capability of CAPABILITIES) {
      expect(capabilityDenial('desktop', capability)).toBeNull();
    }
  });
});

describe('the envelope fails CLOSED on an unmapped capability or tool', () => {
  it('denies an unknown capability for EVERY class, desktop included', () => {
    // The registry-widening hole: a new tool manifest added without a mapping
    // yields '' from `capabilityForTool`, and `capabilityDenial` must refuse it
    // rather than fall through. Otherwise adding a manifest silently grants it
    // to every class with no failing suite.
    for (const clientClass of CLIENT_CLASSES) {
      expect(capabilityDenial(clientClass, 'not.a.capability')).toEqual({
        ok: false,
        reason: 'unknown_capability',
        clientClass,
        capability: 'not.a.capability',
      });
      expect(capabilityDenial(clientClass, '')).toMatchObject({
        ok: false,
        reason: 'unknown_capability',
      });
    }
  });

  it('denies an unknown client class rather than defaulting to desktop', () => {
    expect(capabilityDenial('device', 'chat')).toEqual({
      ok: false,
      reason: 'unknown_client_class',
      clientClass: 'device',
      capability: 'chat',
    });
  });
});
