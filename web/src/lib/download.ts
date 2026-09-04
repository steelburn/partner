/**
 * Tiny browser-download helper (M5 Notes view).
 *
 * Both segments (notes + plans) trigger file downloads for their exports.
 * This keeps the DOM plumbing in one tested-by-use spot: build an object
 * URL, click an anchor, release. Nothing here reads, logs or prints file
 * contents — the payload is handed to the browser only.
 */

export function downloadTextFile(filename: string, text: string, mime = 'application/json'): void {
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
