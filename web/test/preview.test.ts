import { describe, expect, it } from 'vitest';
import { buildPreviewDoc, blockedSummary } from '../src/lib/preview.js';
import { source } from './helpers/css.js';

describe('M11 F12 preview builder', () => {
  it('removes scripts by default and keeps them with allowScripts', () => {
    const src = '<p>hi</p><script>alert(1)</script>';
    const { doc } = buildPreviewDoc(src);
    expect(doc).not.toContain('script');
    const armed = buildPreviewDoc(src, { allowScripts: true }).doc;
    expect(armed).toContain('<script>alert(1)</script>');
  });

  it('injects a network-blocking CSP meta', () => {
    const { doc } = buildPreviewDoc('<p>hello</p>');
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain("default-src 'none'");
    expect(doc).toMatch(/<!DOCTYPE html>/);
  });

  it('strips external http(s) refs and reports them', () => {
    const src = '<img src="data:image/png;base64,AAAA"><link rel="stylesheet" href="https://evil.example/x.css">';
    const { doc, report } = buildPreviewDoc(src);
    expect(doc).toContain('data:image/png;base64,AAAA');
    expect(doc).not.toContain('evil.example');
    expect(report.blocked).toContain('https://evil.example/x.css');
    expect(blockedSummary(report)).toContain('1 external resource');
  });

  it('caps pathological documents', () => {
    const { doc } = buildPreviewDoc('<p>' + 'a'.repeat(2_000_000) + '</p>');
    expect(doc.length).toBeLessThan(1_100_000);
  });
});

/**
 * The inline viewer's pane is a browser viewport, so it must be sized like one
 * (M11 follow-up): tall enough to read a real page, never taller than the window
 * it is read in. Guarded here because the failure mode is silent — a fixed
 * 320px strip still "works" and just cuts every document in half.
 */
describe('inline preview pane geometry (app.css)', () => {
  const css = source('src/app.css');
  const frame = /\n\.md-code-preview-frame\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

  it('sizes the frame as a screen-like viewport, not a short strip', () => {
    const height = /height:\s*min\(\s*(\d+)px\s*,\s*(\d+)vh\s*\)/.exec(frame);
    expect(height, `no screen-like height in .md-code-preview-frame: ${frame.trim()}`).not.toBeNull();
    const [, capPx, capVh] = height as unknown as [string, string, string];
    expect(Number(capPx)).toBeGreaterThanOrEqual(600);
    expect(Number(capVh)).toBeGreaterThanOrEqual(70);
  });

  it('keeps the pane inside the window on every tier', () => {
    // A viewport unit cap is what stops a laptop-sized pane from overrunning a
    // short window; a bare px height (the old 320px strip) would not.
    expect(frame).toContain('vh');
    expect(frame).not.toMatch(/height:\s*\d+px\s*;/);
  });
});
