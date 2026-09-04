/**
 * Partner action popup (ESM module, loaded from popup.html).
 *
 * No HTTP to the core: every core interaction goes through the background
 * service worker, which owns the native-messaging port
 * (chrome.runtime.sendMessage → background → com.partner.core). Captures run
 * in the active tab's content script (chrome.tabs.sendMessage, granted by the
 * "activeTab" permission when the action was clicked).
 *
 * Scope is managed server-side (core web UI at http://127.0.0.1:4390) — the
 * core's NM command set has no scope-set command, so this popup only shows a
 * quick read and links to the web UI to change it.
 *
 * Page text (capture/analyze payloads) is owner data: it is shown to the user
 * only and never logged.
 */

import { isCaptureReply, nmRequest, stateRequest } from './lib/messages.js';
import type { PartnerRuntimeMessage, PartnerRuntimeReply, TabReply } from './lib/messages.js';
import { scopeLabel } from './lib/scope.js';
import type { SiteScope } from './lib/scope.js';

const WEB_UI = 'http://127.0.0.1:4390';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const statusDot = el<HTMLSpanElement>('statusDot');
const statusText = el<HTMLParagraphElement>('statusText');
const pairBtn = el<HTMLButtonElement>('pairBtn');
const codeRow = el<HTMLParagraphElement>('codeRow');
const codeText = el<HTMLElement>('codeText');
const manualRow = el<HTMLParagraphElement>('manualRow');
const codeInput = el<HTMLInputElement>('codeInput');
const submitPair = el<HTMLButtonElement>('submitPair');
const pageLine = el<HTMLParagraphElement>('pageLine');
const partnerBtn = el<HTMLButtonElement>('partnerBtn');
const pageResult = el<HTMLParagraphElement>('pageResult');
const replyBox = el<HTMLDivElement>('replyBox');
const scopeLine = el<HTMLParagraphElement>('scopeLine');
const blockedLine = el<HTMLParagraphElement>('blockedLine');
const denyNote = el<HTMLSpanElement>('denyNote');
const openWeb = el<HTMLAnchorElement>('openWeb');
const scopeLink = el<HTMLAnchorElement>('scopeLink');

openWeb.href = WEB_UI;
scopeLink.href = WEB_UI;

let activeTabId: number | undefined;
let activeOrigin: string | null = null;

function setStatus(kind: 'ok' | 'bad' | 'off' | 'busy', text: string): void {
  statusDot.className = `dot ${kind === 'busy' ? 'off' : kind}`;
  statusText.textContent = text;
}

function setResult(message: string, tone: 'ok' | 'warn' | 'danger' | 'plain'): void {
  pageResult.textContent = message;
  pageResult.className = tone === 'plain' ? '' : tone;
  replyBox.className = 'reply hidden';
  replyBox.textContent = '';
}

function showReply(text: string): void {
  pageResult.textContent = '';
  pageResult.className = '';
  replyBox.textContent = text;
  replyBox.className = 'reply';
}

function runtimeSend(msg: PartnerRuntimeMessage): Promise<PartnerRuntimeReply | undefined> {
  return chrome.runtime.sendMessage(msg) as Promise<PartnerRuntimeReply | undefined>;
}

function denyIsScopeDenial(error: string | undefined): boolean {
  return (
    error === 'denied_scope' ||
    error === 'denied_origin' ||
    error === 'blocked_origin' ||
    error === 'not_paired'
  );
}

// ---------------------------------------------------------------------------
// Connection + pairing
// ---------------------------------------------------------------------------

async function refreshConnection(): Promise<{ paired: boolean; native: boolean; lastDeny: string | null }> {
  const reply = await runtimeSend(stateRequest());
  if (reply?.kind === 'state.reply') {
    denyNote.classList.toggle('hidden', reply.lastDeny === null);
    denyNote.textContent =
      reply.lastDeny === null ? '' : `Badge “!” = action denied for scope`;
    return { paired: reply.paired, native: reply.native, lastDeny: reply.lastDeny };
  }
  return { paired: false, native: false, lastDeny: null };
}

async function probeCore(): Promise<void> {
  setStatus('busy', 'Contacting the Partner core…');
  pairBtn.disabled = true;
  const state = await refreshConnection();
  // Hello also refreshes the persisted pairing state in the background.
  const hello = await runtimeSend(nmRequest('hello', {}));
  if (hello?.kind === 'nm.reply' && hello.ok) {
    // hello proves REACHABILITY only — pairing is a separate step (M7
    // review finding 2: the core answers hello before any pair exchange).
    if (state.paired) {
      setStatus('ok', 'Paired with the Partner core');
      pairBtn.classList.add('hidden');
    } else {
      setStatus('bad', 'Core reachable — pair below to continue.');
      pairBtn.disabled = false;
      pairBtn.textContent = 'Pair with core';
    }
  } else {
    const error = hello?.kind === 'nm.reply' ? hello.error : undefined;
    if (error === 'native_unavailable' || !state.native) {
      setStatus('bad', 'Core not reachable — is the native host running?');
      pairBtn.disabled = false;
    } else {
      setStatus('bad', `Core error: ${error ?? 'unreachable'}`);
      pairBtn.disabled = false;
    }
  }
}

/** Submit a pairing code to the core; updates UI on the result. */
async function submitPairCode(code: string): Promise<void> {
  pairBtn.disabled = true;
  submitPair.disabled = true;
  setStatus('busy', 'Pairing…');
  const reply = await runtimeSend(nmRequest('pair', { code }));
  if (reply?.kind === 'nm.reply' && reply.ok) {
    setStatus('ok', 'Paired with the Partner core');
    pairBtn.classList.add('hidden');
    manualRow.classList.add('hidden');
    codeInput.value = '';
    void refreshScopeRead();
  } else {
    const error = reply?.kind === 'nm.reply' ? (reply.error ?? 'failed') : 'no reply';
    setStatus('bad', `Pairing failed: ${error}`);
    pairBtn.disabled = false;
    submitPair.disabled = false;
  }
}

pairBtn.addEventListener('click', () => {
  pairBtn.disabled = true;
  pairBtn.textContent = 'Requesting…';
  void runtimeSend(nmRequest('pair.code', {})).then(async (reply) => {
    pairBtn.textContent = 'Pair with core';
    if (reply?.kind === 'nm.reply' && reply.ok) {
      const payload = (reply.payload ?? {}) as { code?: unknown };
      const code = typeof payload.code === 'string' ? payload.code : '';
      // Demo: the core hands us the dev code — auto-pair with it.
      if (code) {
        codeRow.classList.remove('hidden');
        codeText.textContent = code;
        await submitPairCode(code);
        return;
      }
      setStatus('ok', 'Pairing request accepted (demo).');
      pairBtn.disabled = false;
      return;
    }
    const error = reply?.kind === 'nm.reply' ? (reply.error ?? 'failed') : 'no reply';
    if (error === 'live_mode' || error === 'not_paired') {
      // Live core: the desktop shows a code — ask the user to type it in.
      setStatus('bad', 'Enter the pairing code shown by the Partner desktop.');
      manualRow.classList.remove('hidden');
      codeInput.focus();
    } else {
      setStatus('bad', `Pairing failed: ${error}`);
    }
    pairBtn.disabled = false;
  });
});

submitPair.addEventListener('click', () => {
  const code = codeInput.value.trim();
  if (code.length === 0) {
    codeInput.focus();
    return;
  }
  void submitPairCode(code);
});

codeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    const code = codeInput.value.trim();
    if (code.length > 0) void submitPairCode(code);
  }
});

// ---------------------------------------------------------------------------
// This page: capture → analyze
// ---------------------------------------------------------------------------

async function captureActiveTab(): Promise<TabReply | undefined> {
  if (activeTabId === undefined) return undefined;
  try {
    return (await chrome.tabs.sendMessage(activeTabId, { kind: 'partner.capture' })) as TabReply;
  } catch {
    return undefined;
  }
}

partnerBtn.addEventListener('click', () => {
  partnerBtn.disabled = true;
  setResult('Capturing this page…', 'plain');
  void (async () => {
    const capture = await captureActiveTab();
    if (!capture || !isCaptureReply(capture)) {
      setResult(
        'Could not read this page. Reload the tab (content script loads at page load), or open a normal http(s) page.',
        'warn',
      );
      partnerBtn.disabled = false;
      return;
    }
    const reply = await runtimeSend(nmRequest('page.analyze', capture.payload));
    if (!reply || reply.kind !== 'nm.reply') {
      setResult('No reply from the core.', 'danger');
      partnerBtn.disabled = false;
      return;
    }
    if (reply.ok) {
      const payload = (reply.payload ?? {}) as { reply?: unknown };
      const text =
        typeof payload.reply === 'string'
          ? payload.reply
          : JSON.stringify(reply.payload ?? {}, null, 2);
      showReply(text);
      partnerBtn.disabled = false;
      return;
    }
    const error = reply.error ?? 'unknown';
    if (denyIsScopeDenial(error)) {
      setResult(
        `Action denied by scope (${error}). Open the scope for this site and allow read + act.`,
        'danger',
      );
    } else {
      setResult(`Core error: ${error}`, 'danger');
    }
    partnerBtn.disabled = false;
  })();
});

// ---------------------------------------------------------------------------
// Active-tab scope quick read
// ---------------------------------------------------------------------------

function applyScopeReply(payload: unknown): void {
  const p = (payload ?? {}) as {
    origin?: unknown;
    scope?: unknown;
    blocked?: unknown;
    reason?: unknown;
  };
  const scope = typeof p.scope === 'string' ? (p.scope as SiteScope) : null;
  if (scope) {
    scopeLine.textContent = activeOrigin
      ? `${activeOrigin} → ${scopeLabel(scope)}`
      : `${scopeLabel(scope)}`;
    scopeLine.classList.remove('muted');
  } else {
    scopeLine.textContent = 'No scope info from the core.';
  }
  if (p.blocked === true) {
    blockedLine.textContent =
      'This origin is on the built-in blocklist — no scope can override it here.';
    blockedLine.classList.remove('hidden');
  } else {
    blockedLine.classList.add('hidden');
  }
}

async function refreshScopeRead(): Promise<void> {
  if (!activeOrigin) return;
  const reply = await runtimeSend(nmRequest('scope.get', { origin: activeOrigin }));
  if (reply?.kind === 'nm.reply') {
    if (reply.ok) applyScopeReply(reply.payload);
    else if (reply.error === 'not_paired') scopeLine.textContent = 'Pair with the core to see scope.';
    else scopeLine.textContent = `Scope read failed (${reply.error ?? 'unknown'}).`;
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function enablePartnerButton(on: boolean): void {
  partnerBtn.disabled = !on;
  partnerBtn.title = on ? '' : 'Requires a web page and the core';
}

function initTab(tabUrl: string | undefined, tabId: number | undefined): void {
  if (!tabUrl) {
    pageLine.textContent = 'No readable active tab.';
    enablePartnerButton(false);
    return;
  }
  let url: URL;
  try {
    url = new URL(tabUrl);
  } catch {
    pageLine.textContent = tabUrl;
    enablePartnerButton(false);
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    pageLine.textContent = `${url.hostname} — not a web page (${url.protocol}//)`;
    scopeLine.textContent = 'No scope for non-web pages.';
    enablePartnerButton(false);
    return;
  }
  activeTabId = tabId;
  activeOrigin = url.origin;
  pageLine.textContent = `${url.hostname} — web page`;
  enablePartnerButton(true);
  void refreshScopeRead();
}

void (async () => {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  initTab(tab?.url, tab?.id);
  await probeCore();
})();
