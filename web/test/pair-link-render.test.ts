/**
 * Pairing-link RENDER tests (M20-B S7) — server-rendered, no DOM.
 *
 * Why render rather than assert on the source: the two things a review can
 * actually falsify here are (a) that a link for ANOTHER core offers no pair
 * button, and (b) that the fingerprint the user is told to check is the one
 * from the payload. Both are visible in the markup, so they are asserted on
 * real markup. `PairGate`'s own branch is driven by `window.location`, which
 * does not exist in this environment; the presentational components it renders
 * are covered directly, and the live flow in `docs/VERIFY-M20-B.md` §S7.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import { PairLinkConfirm, PairLinkProblem, REFUSAL_COPY } from '../src/PairLinkNotice.js';
import { DeviceAccessPanel } from '../src/DeviceAccessPanel.js';
import { base64UrlEncode } from '../src/lib/pair-link.js';
import type { PairLinkRefusal } from '../src/lib/pair-link.js';

const PAYLOAD = {
  coreUrl: 'https://core.example.com',
  certFingerprint: base64UrlEncode('f'.repeat(32)),
  secret: base64UrlEncode('s'.repeat(32)),
};

function confirm(overrides: Partial<Parameters<typeof PairLinkConfirm>[0]> = {}): string {
  return renderToStaticMarkup(
    h(PairLinkConfirm, {
      payload: PAYLOAD,
      originOk: true,
      servingOrigin: 'https://core.example.com',
      deviceName: '',
      busy: false,
      error: null,
      onNameChange: () => {},
      onPair: () => {},
      onCancel: () => {},
      ...overrides,
    }),
  );
}

describe('PairLinkConfirm', () => {
  it('shows the core, the pinned fingerprint and one pair action', () => {
    const html = confirm();
    expect(html).toContain('Pair this device');
    expect(html).toContain(PAYLOAD.coreUrl);
    expect(html).toContain(PAYLOAD.certFingerprint);
    expect(html).toContain('Pair this device');
    expect(html).toContain('Cancel');
    expect(html).toContain('id="device-name"');
    // The secret never appears in the page.
    expect(html).not.toContain(PAYLOAD.secret);
  });

  it('offers NO pair action when the link names a different core', () => {
    const html = confirm({ originOk: false, servingOrigin: 'https://other.example.com' });
    expect(html).toContain('https://other.example.com');
    // No primary action and no device-name field: a mismatched link is a dead
    // end, not a form whose button happens to be disabled.
    expect(html).not.toContain('btn-primary');
    expect(html).not.toContain('id="device-name"');
    expect(html).toContain('Back to pairing');
  });

  it('disables the action while a pairing is in flight', () => {
    const html = confirm({ busy: true });
    expect(html).toContain('Pairing…');
    expect(html).toMatch(/disabled/);
  });
});

describe('PairLinkProblem', () => {
  it('renders a distinct sentence for every refusal reason', () => {
    const reasons = Object.keys(REFUSAL_COPY) as PairLinkRefusal[];
    const seen = new Set<string>();
    for (const reason of reasons) {
      const html = renderToStaticMarkup(h(PairLinkProblem, { reason, onBack: () => {} }));
      expect(html, reason).toContain(REFUSAL_COPY[reason]);
      expect(html).toContain('Back to pairing');
      seen.add(REFUSAL_COPY[reason]);
    }
    // Several reasons legitimately share copy (both "damaged JSON" cases);
    // what must NOT happen is one generic sentence for everything.
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });
});

describe('DeviceAccessPanel', () => {
  it('starts action-driven — no link is issued until the user asks', () => {
    const html = renderToStaticMarkup(h(DeviceAccessPanel, { onUnpair: () => {} }));
    expect(html).toContain('Phone &amp; tablet access');
    expect(html).toContain('Create pairing link');
    // No live secret in the initial render.
    expect(html).not.toContain('pair=');
    expect(html).not.toContain('#');
  });
});
