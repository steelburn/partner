/**
 * Browser + desktop download helper (M16 F5, PLAN-M16.md).
 *
 * In a plain browser the export path is a Blob + <a download> click. In the
 * PACKAGED desktop app that click is a no-op: the Tauri WebView2 window
 * wires no download handling, so the shell exposes a native save-dialog
 * command (`save_text_file`) over the Tauri bridge and every text export
 * routes through it. Both Notes export and Assets -> Export share this one
 * function, so one fix covers every text download in the desktop app.
 *
 * The blob fallback stays for dev/browser/extension use. Nothing here reads,
 * logs or prints file contents — the payload is handed to the native dialog
 * or the browser only.
 */

export const MAX_NATIVE_SAVE_CHARS = 50 * 1024 * 1024;

/** True when the page runs inside the packaged Tauri shell (native bridge
 *  present). Kept injectable for tests. */
export function isPartnerShell(host: unknown = typeof window !== 'undefined' ? window : null): boolean {
  const candidate = host as { __TAURI__?: { core?: { invoke?: unknown } } } | null;
  return (
    candidate !== null &&
    typeof candidate.__TAURI__?.core?.invoke === 'function'
  );
}

/** Save one text file through the native save dialog (shell command). The
 *  shell writes ONLY to the path the user picked in its dialog. Resolves
 *  true when the user confirmed a path, false when they cancelled. */
export async function saveTextFileNative(
  filename: string,
  text: string,
  options: { invoke?: unknown } = {},
): Promise<boolean> {
  if (text.length > MAX_NATIVE_SAVE_CHARS) {
    throw new Error(`Files larger than ${MAX_NATIVE_SAVE_CHARS} characters need the browser path.`);
  }
  const invokeFn = options.invoke ?? (window as { __TAURI__?: { core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } } }).__TAURI__?.core?.invoke;
  if (typeof invokeFn !== 'function') {
    throw new Error('The Partner shell bridge is unavailable.');
  }
  const result = (await invokeFn('save_text_file', {
    defaultName: filename,
    content: text,
  })) as { saved: boolean; path?: string } | undefined;
  return result?.saved === true;
}

/** Download (or native-save) a text file. Desktop: native dialog when the
 *  shell is present; otherwise the classic blob download. */
export async function downloadTextFile(
  filename: string,
  text: string,
  mime = 'application/json',
): Promise<boolean> {
  if (isPartnerShell()) {
    try {
      return await saveTextFileNative(filename, text);
    } catch {
      // Native path failed (bridge missing/cancelled) — fall back to the
      // browser download so pure-browser usage keeps working.
    }
  }
  downloadBlob(filename, text, mime);
  return true;
}

/** Classic browser path (kept synchronous for the pre-M16 call sites; the
 *  async wrapper above calls it directly). */
export function downloadBlob(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
