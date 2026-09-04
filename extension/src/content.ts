/**
 * Partner content script — SELF-CONTAINED classic script. NO imports, NO
 * exports (content scripts cannot be ES modules; manifest loads
 * dist/content.js at document_idle). Mirrors the pure builders in
 * src/lib/snapshot.ts and src/lib/act.ts inline — keep the constants and the
 * guard logic in sync with those files (they are the tested source of truth).
 *
 * Responsibilities:
 *  - {kind:'partner.capture'} → build {url,title,origin,selection?,text?}
 *    (body innerText ≤ 100k, selection ≤ 10k) and reply via sendResponse;
 *  - {kind:'partner.act'} → minimal safe fill/click/scroll primitives for
 *    the later scopes milestone. Only elements matching an explicit selector
 *    or [data-partner-role]; fill/click refuse while the page shows an
 *    enabled password field unless payload.allowSensitive === true.
 *
 * Page text is the user's own data (owner-facing only): it is only ever sent
 * to the local core via the extension's own message channel and never logged.
 */

(() => {
  const MAX_BODY_TEXT = 100_000;
  const MAX_SELECTION_TEXT = 10_000;
  const SENSITIVE_REFUSAL = 'sensitive_page';

  const REFUSAL_KINDS: ReadonlySet<string> = new Set(['fill', 'click']);

  function truncateText(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) : text;
  }

  function buildSnapshot(): {
    url: string;
    title: string;
    origin: string;
    selection?: string;
    text?: string;
  } {
    const out: { url: string; title: string; origin: string; selection?: string; text?: string } = {
      url: location.href,
      title: document.title,
      origin: location.origin,
    };
    const selectionText = window.getSelection()?.toString() ?? '';
    const trimmed = selectionText.trim();
    if (trimmed) out.selection = truncateText(trimmed, MAX_SELECTION_TEXT);
    const bodyText = document.body?.innerText ?? '';
    if (bodyText) out.text = truncateText(bodyText, MAX_BODY_TEXT);
    return out;
  }

  function hasEnabledPasswordField(): boolean {
    const inputs = document.querySelectorAll('input');
    for (let i = 0; i < inputs.length; i += 1) {
      const el = inputs[i] as HTMLInputElement;
      if ((el.getAttribute('type') ?? 'text').toLowerCase() === 'password' && !el.disabled) {
        return true;
      }
    }
    return false;
  }

  // ---- minimal act primitives -------------------------------------------------

  interface ActPayload {
    kind: string;
    selector?: string;
    role?: string;
    value?: string;
    deltaY?: number;
    allowSensitive?: boolean;
  }

  function findTarget(payload: ActPayload): Element | null {
    if (payload.selector) {
      try {
        return document.querySelector(payload.selector);
      } catch {
        return null; // invalid selector → treat as no target
      }
    }
    if (payload.role) {
      try {
        return document.querySelector(
          `[data-partner-role="${CSS.escape(payload.role)}"]`,
        );
      } catch {
        return null;
      }
    }
    return null;
  }

  function sensitiveRefusal(allowSensitive: boolean): string | null {
    // Mirror of lib/act.ts needsSensitiveRefusal — keep in sync.
    if (hasEnabledPasswordField() && !allowSensitive) return SENSITIVE_REFUSAL;
    return null;
  }

  function actFill(target: Element, value: string): void {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      if ((target as HTMLInputElement).type === 'password') {
        throw new Error('unsafe_target');
      }
      target.value = value;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (target instanceof HTMLElement && target.isContentEditable) {
      target.textContent = value;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    throw new Error('unsupported_target');
  }

  function handleAct(payload: ActPayload): { ok: boolean; payload?: unknown; error?: string } {
    if (typeof payload !== 'object' || payload === null || typeof payload.kind !== 'string') {
      return { ok: false, error: 'bad_act' };
    }
    if (REFUSAL_KINDS.has(payload.kind)) {
      const refusal = sensitiveRefusal(payload.allowSensitive === true);
      if (refusal) return { ok: false, error: refusal };
    }
    const target = findTarget(payload);
    try {
      switch (payload.kind) {
        case 'fill':
          if (!target) return { ok: false, error: 'no_target' };
          actFill(target, payload.value ?? '');
          return { ok: true };
        case 'click':
          if (!target) return { ok: false, error: 'no_target' };
          if (!(target instanceof HTMLElement)) return { ok: false, error: 'unsupported_target' };
          target.click();
          return { ok: true };
        case 'scroll':
          if (target) {
            (target as HTMLElement).scrollIntoView({ block: 'center' });
          } else {
            window.scrollBy({ top: payload.deltaY ?? 500, behavior: 'auto' });
          }
          return { ok: true };
        default:
          return { ok: false, error: 'bad_act' };
      }
    } catch (err) {
      const code = err instanceof Error ? err.message : 'unknown';
      return { ok: false, error: code === 'unknown' ? 'unknown' : code };
    }
  }

  // ---- message listener ---------------------------------------------------------

  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const msg = raw as { kind?: unknown; payload?: unknown };
    if (msg.kind === 'partner.capture') {
      sendResponse({ ok: true, payload: buildSnapshot() });
      return undefined;
    }
    if (msg.kind === 'partner.act') {
      sendResponse(handleAct(msg.payload as ActPayload));
      return undefined;
    }
    return undefined; // not for us
  });
})();
