/**
 * Per-conversation UI memory (session-scoped, client-side only).
 *
 * Chat view surfaces that hold a transient "what the user picked" state lose
 * it the moment the active conversation changes: views stay mounted and swap
 * the conversationId prop, so any per-conversation choice (an explicit model
 * pick, ticked choice-card options, an open asset) must be keyed by the
 * conversation to survive "move to another chat and come back".
 *
 * This is intentionally a plain module-level store: one writer process, no
 * React context gymnastics, no persistence to the core (no wire change). It
 * is NOT durable across reloads — that is fine for the ask ("when I move away
 * and return", within a session).
 */
export interface ModelPick {
  providerId: string;
  model: string;
}

/** Multi choices hold an ordered string array; single a label or null. */
export interface ChoiceSelection {
  single: string | null;
  multi: string[];
}

/** Multi-question form drafts hold one free-text answer per question. */
export interface FormDraft {
  answers: string[];
}

/** Scorecard drafts hold one optional 1..scale score per item (null = unrated). */
export interface ScorecardDraft {
  scores: (number | null)[];
}

const modelPicks = new Map<string, ModelPick>();
const choiceSelections = new Map<string, Map<string, ChoiceSelection>>();
const formDrafts = new Map<string, Map<string, FormDraft>>();
const scorecardDrafts = new Map<string, Map<string, ScorecardDraft>>();
const assetOpens = new Map<string, string | null>();

export const conversationUi = {
  // ---- model picker ----------------------------------------------------
  getModelPick(conversationId: string | null): ModelPick | null {
    if (conversationId === null) return null;
    return modelPicks.get(conversationId) ?? null;
  },
  /** `pick` of null stores Auto (an explicit reset). */
  setModelPick(conversationId: string | null, pick: ModelPick | null): void {
    if (conversationId === null) return;
    if (pick === null) modelPicks.delete(conversationId);
    else modelPicks.set(conversationId, pick);
  },
  // ---- choice cards (:::partner.choice single/multi) --------------------
  /** Stable per-card key: the card's own identity (mode + title + options). */
  getChoiceKey(mode: 'single' | 'multi', title: string | null, options: string[]): string {
    return `${mode}\u001f${title ?? ''}\u001f${options.join('\u001f')}`;
  },
  getChoice(
    conversationId: string | null,
    key: string,
  ): ChoiceSelection | null {
    if (conversationId === null) return null;
    return choiceSelections.get(conversationId)?.get(key) ?? null;
  },
  setChoice(
    conversationId: string | null,
    key: string,
    selection: ChoiceSelection | null,
  ): void {
    if (conversationId === null) return;
    if (selection === null) {
      const cards = choiceSelections.get(conversationId);
      cards?.delete(key);
      if (cards !== undefined && cards.size === 0) choiceSelections.delete(conversationId);
      return;
    }
    let cards = choiceSelections.get(conversationId);
    if (cards === undefined) {
      cards = new Map<string, ChoiceSelection>();
      choiceSelections.set(conversationId, cards);
    }
    cards.set(key, selection);
  },
  // ---- multi-question forms (:::partner.form) ---------------------------
  /** Stable per-form key: the form's own identity (title + questions). */
  getFormKey(title: string | null, questions: string[]): string {
    return `${title ?? ''}\u001f${questions.join('\u001f')}`;
  },
  getForm(conversationId: string | null, key: string): FormDraft | null {
    if (conversationId === null) return null;
    return formDrafts.get(conversationId)?.get(key) ?? null;
  },
  setForm(conversationId: string | null, key: string, draft: FormDraft | null): void {
    if (conversationId === null) return;
    if (draft === null) {
      const forms = formDrafts.get(conversationId);
      forms?.delete(key);
      if (forms !== undefined && forms.size === 0) formDrafts.delete(conversationId);
      return;
    }
    let forms = formDrafts.get(conversationId);
    if (forms === undefined) {
      forms = new Map<string, FormDraft>();
      formDrafts.set(conversationId, forms);
    }
    forms.set(key, draft);
  },
  // ---- scorecards (:::partner.scorecard) --------------------------------
  /** Stable per-scorecard key: its own identity (title + scale + items). */
  getScorecardKey(title: string | null, scale: number, items: string[]): string {
    return `${title ?? ''}\u001f${scale}\u001f${items.join('\u001f')}`;
  },
  getScorecard(conversationId: string | null, key: string): ScorecardDraft | null {
    if (conversationId === null) return null;
    return scorecardDrafts.get(conversationId)?.get(key) ?? null;
  },
  setScorecard(conversationId: string | null, key: string, draft: ScorecardDraft | null): void {
    if (conversationId === null) return;
    if (draft === null) {
      const cards = scorecardDrafts.get(conversationId);
      cards?.delete(key);
      if (cards !== undefined && cards.size === 0) scorecardDrafts.delete(conversationId);
      return;
    }
    let cards = scorecardDrafts.get(conversationId);
    if (cards === undefined) {
      cards = new Map<string, ScorecardDraft>();
      scorecardDrafts.set(conversationId, cards);
    }
    cards.set(key, draft);
  },
  // ---- assets lane open row ---------------------------------------------
  getAssetOpen(conversationId: string | null): string | null {
    if (conversationId === null) return null;
    return assetOpens.get(conversationId) ?? null;
  },
  setAssetOpen(conversationId: string | null, assetId: string | null): void {
    if (conversationId === null) return;
    if (assetId === null) assetOpens.delete(conversationId);
    else assetOpens.set(conversationId, assetId);
  },
  /** Forget every slot for a conversation (used when it is deleted). */
  forget(conversationId: string | null): void {
    if (conversationId === null) return;
    modelPicks.delete(conversationId);
    choiceSelections.delete(conversationId);
    formDrafts.delete(conversationId);
    scorecardDrafts.delete(conversationId);
    assetOpens.delete(conversationId);
  },
};
