/**
 * M11 multimodal capability helpers (PLAN-M11.md F1/C2), shared between the
 * core and the web UI (zero runtime deps).
 *
 * A model is treated as image-capable when its id matches known vision
 * families. Loose on purpose: false positives only send an image a provider
 * may not accept (rare); false negatives would silently drop vision, which
 * is worse for the persona.
 */
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

export function isImageCapableModel(model: string | null | undefined): boolean {
  if (typeof model !== 'string' || model.trim() === '') return false;
  return VISION_HINTS.some((hint) => hint.test(model));
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
export function modelCapability(model: string | null | undefined): 'vision' | 'text' {
  return isImageCapableModel(model) ? 'vision' : 'text';
}
