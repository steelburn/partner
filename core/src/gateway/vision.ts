/**
 * M11 multimodal helpers — now re-exported from @partner/shared so the web
 * UI and the core share ONE vision-capability source of truth: a model is
 * image-capable when the user declared it (per-provider vision ticks, or a
 * model pinned to a `vision` purpose) or its id matches the shared vision
 * hints. M24 added the declaration half; see `shared/src/vision.ts`.
 */
export {
  isImageCapableModel,
  matchesVisionHint,
  isInlineableImageMime,
  modelCapability,
  VISION_HINTS,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGES_PER_TURN,
  declaredVisionModels,
} from '@partner/shared';
export type { DeclaredVision } from '@partner/shared';
