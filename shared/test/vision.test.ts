/**
 * M23 — vision capability is DECIDED, not guessed.
 *
 * `isImageCapableModel` decides whether an attached photo is sent to a model at
 * all, so a wrong "no" is silent data loss: the persona is handed the text
 * descriptor and reports that no image arrived. Behind an OpenAI-compatible
 * gateway (LiteLLM) the model ids are operator-chosen aliases, so a name-only
 * heuristic is guaranteed to be wrong for some real deployment. These tests pin
 * the declaration winning, and pin the trap that bit first: the function is
 * used as a bare `filter` callback, so it must survive extra arguments.
 */
import { describe, expect, it } from 'vitest';
import {
  declaredVisionModels,
  isImageCapableModel,
  matchesVisionHint,
  MAX_INLINE_IMAGE_BYTES,
  modelCapability,
} from '../src/index.js';

describe('isImageCapableModel — name heuristic (unchanged default)', () => {
  it('recognises the known vision families', () => {
    for (const id of ['gpt-4o', 'gpt-4.1-mini', 'gemini-2.0-flash', 'claude-sonnet-4']) {
      expect(isImageCapableModel(id)).toBe(true);
    }
  });

  it('says no for a text model, an empty id and a non-string', () => {
    expect(isImageCapableModel('llama-3.1-8b')).toBe(false);
    expect(isImageCapableModel('   ')).toBe(false);
    expect(isImageCapableModel(null)).toBe(false);
    expect(isImageCapableModel(undefined)).toBe(false);
  });

  it('says no for a capable model it cannot recognise by name', () => {
    // The bug: real vision models whose ids carry no hint.
    for (const id of ['pixtral-12b', 'minicpm-v-2.6', 'my-photo-model', 'alias-1']) {
      expect(matchesVisionHint(id)).toBe(false);
      expect(isImageCapableModel(id)).toBe(false);
    }
  });
});

describe('isImageCapableModel — declarations win', () => {
  it('treats a declared id as capable whatever its name', () => {
    expect(isImageCapableModel('my-photo-model', ['my-photo-model'])).toBe(true);
    expect(isImageCapableModel('pixtral-12b', new Set(['pixtral-12b']))).toBe(true);
  });

  it('trims both sides so a saved id with whitespace still matches', () => {
    expect(isImageCapableModel('  alias-1  ', ['alias-1'])).toBe(true);
    expect(isImageCapableModel('alias-1', ['  alias-1 '])).toBe(true);
  });

  it('never un-declares a hint match: a declared list only adds capability', () => {
    expect(isImageCapableModel('gpt-4o', [])).toBe(true);
    expect(isImageCapableModel('gpt-4o', ['other'])).toBe(true);
  });

  it('ignores an empty or absent declaration', () => {
    expect(isImageCapableModel('llama-3.1-8b', [])).toBe(false);
    expect(isImageCapableModel('llama-3.1-8b', null)).toBe(false);
    expect(isImageCapableModel('llama-3.1-8b', undefined)).toBe(false);
  });

  it('survives being used as a bare Array#filter callback', () => {
    // filter passes (element, index, array): the index/array must not be
    // treated as a declaration, and must not throw.
    const models = ['gpt-4o', 'llama-3.1-8b', 'pixtral-12b'];
    expect(() => models.filter(isImageCapableModel)).not.toThrow();
    expect(models.filter((m) => isImageCapableModel(m))).toEqual(['gpt-4o']);
    // A number/array/true as the second argument is simply "no declaration".
    expect(isImageCapableModel('llama-3.1-8b', 2 as unknown as Iterable<string>)).toBe(false);
    expect(isImageCapableModel('llama-3.1-8b', true as unknown as Iterable<string>)).toBe(false);
    expect(isImageCapableModel('gpt-4o', 0 as unknown as Iterable<string>)).toBe(true);
  });

  it('labels capability for the UI from the same decision', () => {
    expect(modelCapability('pixtral-12b')).toBe('text');
    expect(modelCapability('pixtral-12b', ['pixtral-12b'])).toBe('vision');
  });
});

describe('declaredVisionModels', () => {
  it('returns the explicit ticks', () => {
    expect(
      declaredVisionModels({
        purpose: 'general',
        defaultModels: ['a', 'b'],
        visionModels: ['b'],
      }),
    ).toEqual(['b']);
  });

  it('treats every model pinned to a vision purpose as declared', () => {
    // The M13 purpose bundle asks the user to pin models to a purpose: pinning
    // to Vision IS the declaration that they can see.
    expect(
      declaredVisionModels({ purpose: 'vision', defaultModels: ['alias-1', 'alias-2'] }),
    ).toEqual(['alias-1', 'alias-2']);
  });

  it('merges, de-duplicates and drops blanks', () => {
    expect(
      declaredVisionModels({
        purpose: 'vision',
        defaultModels: ['alias-1', ' shared '],
        visionModels: ['alias-1', '', '  '],
      }),
    ).toEqual(['alias-1', 'shared']);
  });

  it('is empty for a missing profile or missing lists', () => {
    expect(declaredVisionModels(null)).toEqual([]);
    expect(declaredVisionModels(undefined)).toEqual([]);
    expect(declaredVisionModels({ purpose: 'general' })).toEqual([]);
  });
});

describe('MAX_INLINE_IMAGE_BYTES', () => {
  it('is the budget both sides encode to, and stays under the upload cap', () => {
    expect(MAX_INLINE_IMAGE_BYTES).toBe(3 * 1024 * 1024);
    expect(MAX_INLINE_IMAGE_BYTES).toBeLessThan(8 * 1024 * 1024);
  });
});
