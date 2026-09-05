import { describe, expect, it } from 'vitest';
import { buildPreviewDoc, blockedSummary } from '../src/lib/preview.js';

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
