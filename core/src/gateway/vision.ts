/**
 * M11 multimodal helpers — now re-exported from @partner/shared so the web
 * UI and the core share ONE vision-capability source of truth (a model is
 * image-capable when its id matches the shared vision hints).
 */
export { isImageCapableModel, isInlineableImageMime, modelCapability, VISION_HINTS } from '@partner/shared';
