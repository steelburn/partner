/**
 * M11 multimodal capability helpers (PLAN-M11.md F1/C2), shared between the
 * core and the web UI (zero runtime deps).
 *
 * Capability is DECIDED, not guessed. Two signals, in order of trust:
 *
 *  1. **A declaration** — the model ids the user marked image-capable on their
 *     provider (`ProviderSummary.visionModels`, or any model pinned to a
 *     `purpose: 'vision'` profile). The user tested the model; that beats any
 *     name. This is what makes a LiteLLM *alias* work: `model_list` names are
 *     whatever the operator typed, so nothing downstream can infer capability
 *     from them.
 *  2. **A name hint** (`VISION_HINTS`) — the zero-config default for well-known
 *     vision families, so a fresh `gpt-4o`/`gemini`/`claude` provider needs no
 *     setup to see photos.
 *
 * Hints alone were the original behaviour and it silently broke the common
 * case: an unrecognised id was treated as text-only, the image part was never
 * attached, and the model — handed only the text descriptor — answered that no
 * image had been sent. A false positive on a hint costs one rejected part; a
 * false negative drops vision entirely, which is why declarations win and why
 * the list stays loose.
 */

/**
 * Largest image payload the core will inline into a turn as an `image_url`
 * part. Owned here because BOTH sides must agree on it: the SPA encodes photos
 * down to fit it (so what you attach is what the model sees), and the core
 * refuses to inline anything bigger. Upload may still accept a larger file as
 * an attachment — it just cannot ride to the model.
 */
export const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * How many photos one turn may carry to the model. Beyond this the extras are
 * left as descriptors (which now say plainly that they were not sent). A cap
 * exists because image parts dominate a request: N photos multiply the payload
 * and the upstream's image-token billing.
 */
export const MAX_INLINE_IMAGES_PER_TURN = 4;

export const VISION_HINTS: ReadonlyArray<RegExp> = [
  /vision/i,
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-4-turbo/i,
  /o[0-9]+(-mini)?/i,
  /gemini/i,
  /claude/i,
  /llava/i,
  /qwen2.*vl/i,
  /yi-vision/i,
  /phi-3.*vision/i,
  /gguf.*(?:mmproj|vision)/i,
  /ggml-org\/gemma.*vision/i,
];

/** Model ids the user declared image-capable (arrays, sets, anything iterable). */
export type DeclaredVision = Iterable<string> | null | undefined;

/** Does this exact id appear in the declaration? (Trimmed both sides.)
 *
 * Defensive about WHAT it is handed: `isImageCapableModel` is routinely used as
 * a bare `Array.prototype.filter` callback, which passes (element, index,
 * array) — a stray index/array must not turn a capability check into a throw.
 */
function isDeclared(model: string, declared: unknown): boolean {
  if (typeof declared !== 'object' || declared === null) return false;
  const entries =
    declared instanceof Set || Array.isArray(declared)
      ? (declared as Iterable<unknown>)
      : typeof (declared as Iterable<unknown>)[Symbol.iterator] !== 'function'
        ? null
        : (declared as Iterable<unknown>);
  if (entries === null) return false;
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.trim() === model) return true;
  }
  return false;
}

/** Name-only heuristic, ignoring any declaration. Exported for provenance
 *  messages ("recognised as vision by name") — capability checks should use
 *  `isImageCapableModel`, which honours declarations. */
export function matchesVisionHint(model: string): boolean {
  return VISION_HINTS.some((hint) => hint.test(model));
}

/**
 * Can this model see an image? True when the user declared it (for the profile
 * in play) or its id matches a known vision family.
 *
 * `declared` is the owning provider's declared set — pass the result of
 * `declaredVisionModels(provider)` so purpose-`vision` profiles and explicit
 * ticks both count.
 */
export function isImageCapableModel(
  model: string | null | undefined,
  declared?: DeclaredVision,
): boolean {
  if (typeof model !== 'string' || model.trim() === '') return false;
  const trimmed = model.trim();
  if (isDeclared(trimmed, declared)) return true;
  return matchesVisionHint(trimmed);
}
/** Image mimes we will inline (matches the attachment allowlist). */
export function isInlineableImageMime(mime: string): boolean {
  return (
    mime === 'image/png' ||
    mime === 'image/jpeg' ||
    mime === 'image/webp' ||
    mime === 'image/gif'
  );
}

/** Coarse capability label for UI chips ("vision" | "text"). */
export function modelCapability(
  model: string | null | undefined,
  declared?: DeclaredVision,
): 'vision' | 'text' {
  return isImageCapableModel(model, declared) ? 'vision' : 'text';
}
