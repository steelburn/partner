/**
 * M28-era Studio split — the empty state and the invite action that starts a draft
 * (describe it, pick a template, or write it by hand).
 *
 * It carries the milestone-s most important sentence for a new owner: a draft is
 * INERT until they install it. That belongs where someone with no drafts is
 * actually looking.
 */
import { useState } from 'react';
import type { SkillDraft } from '@partner/shared';
import { slugPreview, type TemplateOption } from '../lib/skill-studio-helpers.js';
import { createDraft } from '../lib/skills.js';
import { readStoredToken } from '../lib/token.js';

import { isSessionLost, messageOf } from './shared.js';

// ---------------------------------------------------------------------------
// Empty state — the invite action
// ---------------------------------------------------------------------------

export interface DraftEmptyStateProps {
  templates: TemplateOption[] | null;
  templatesError: string | null;
  /**
   * Is a model provider configured? `null` means "still checking" — the honest
   * third state, because claiming there is none while the probe is in flight
   * would be a lie the owner cannot see through.
   */
  providerConfigured: boolean | null;
  disabled: boolean;
  onCreated: (draft: SkillDraft) => void;
  onSessionLost: () => void;
}

type CreateMode = 'generate' | 'template' | 'manual';

/**
 * The first-run surface: describe the skill you want, start from a template the
 * core can actually honour, or open a blank draft. Generation is the only path
 * that needs a provider, so it is the only one that changes shape when none is
 * configured — the other two work with no credentials at all.
 */
export function DraftEmptyState({
  templates,
  templatesError,
  providerConfigured,
  disabled,
  onCreated,
  onSessionLost,
}: DraftEmptyStateProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState('');
  const [busy, setBusy] = useState<CreateMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options = templates ?? [];
  const selectedTemplate = options.find((option) => option.id === template) ?? null;
  const slug = slugPreview(name);
  const canDescribe = name.trim() !== '' && description.trim() !== '';
  const generating = providerConfigured === true;

  const start = async (mode: CreateMode): Promise<void> => {
    if (busy !== null || disabled) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy(mode);
    setError(null);
    try {
      const draft = await createDraft(token, {
        mode,
        name: name.trim(),
        description: description.trim(),
        ...(mode === 'generate' ? { prompt: description.trim() } : {}),
        ...(mode === 'template' ? { template } : {}),
        ...(slug !== '' ? { id: slug } : {}),
      });
      onCreated(draft);
      setName('');
      setDescription('');
      setTemplate('');
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(messageOf(cause, 'Could not create the draft.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="empty-state" aria-label="Start a skill draft">
      <p className="empty-state-title">No drafts yet</p>
      <p className="empty-state-copy">
        A draft is a skill bundle this core can hold without running it: you read the code, test
        it in the sandbox, and only then install it. Nothing in a draft runs or installs until you
        ask it to.
      </p>
      <ol className="studio-steps">
        <li>Describe the skill you want, or start from a template this build ships.</li>
        <li>Read the code and fix anything the validator names.</li>
        <li>Test-run it in the sandbox with your own args.</li>
        <li>Install it — it then appears under Installed.</li>
      </ol>

      <div className="studio-form">
        <div className="form-stack">
          <div className="form-field">
            <label className="label" htmlFor="studio-new-name">
              Name
            </label>
            <input
              id="studio-new-name"
              className="field"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={disabled || busy !== null}
              placeholder="Scratch notes to checklist"
              aria-describedby="studio-new-id"
            />
            <p id="studio-new-id" className="form-hint">
              {slug === ''
                ? 'The core turns the name into a lowercase id once you start the draft.'
                : `The core will id it “${slug}” (and make it unique if that id is taken).`}
            </p>
          </div>

          <div className="form-field">
            <label className="label" htmlFor="studio-new-description">
              Describe the skill you want
            </label>
            <textarea
              id="studio-new-description"
              className="field studio-describe"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={disabled || busy !== null}
              placeholder="Turn a folder of scratch notes into a single markdown checklist."
            />
          </div>
        </div>

        <div className="empty-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void start('generate')}
            disabled={disabled || busy !== null || !canDescribe || !generating}
            aria-busy={busy === 'generate'}
          >
            {busy === 'generate' ? 'Drafting…' : 'Generate draft'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void start('manual')}
            disabled={disabled || busy !== null || name.trim() === ''}
            aria-busy={busy === 'manual'}
          >
            {busy === 'manual' ? 'Creating…' : 'Start blank'}
          </button>
        </div>

        {providerConfigured === null ? (
          <p className="form-hint">Checking whether a model provider is configured…</p>
        ) : generating ? null : (
          <p className="form-hint">
            Connect a provider to generate, or start from a template below — the template path
            needs no model at all.
          </p>
        )}
      </div>

      <div className="studio-templates">
        <h3 className="sub-panel-title">Templates</h3>
        {templatesError !== null ? (
          <p className="row-error" role="alert">
            {templatesError}
          </p>
        ) : templates === null ? (
          <p className="skills-loading" aria-busy="true">
            Loading templates…
          </p>
        ) : options.length === 0 ? (
          <p className="studio-note">
            This build offers no templates. Describe the skill and start blank instead.
          </p>
        ) : (
          <>
            <ul className="studio-template-list">
              {options.map((option) => (
                <li key={option.id} className="studio-template">
                  <span className="studio-template-name">{option.label}</span>
                  <span className="studio-template-copy">{option.description}</span>
                  {option.reach !== '' ? (
                    <span className="studio-template-reach">{option.reach}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="form-field">
              <label className="label" htmlFor="studio-new-template">
                Template
              </label>
              <select
                id="studio-new-template"
                className="field"
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
                disabled={disabled || busy !== null}
              >
                <option value="">Choose a template</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              {selectedTemplate !== null && selectedTemplate.reach !== '' ? (
                <p className="form-hint">{selectedTemplate.reach}</p>
              ) : null}
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void start('template')}
              disabled={disabled || busy !== null || template === '' || name.trim() === ''}
              aria-busy={busy === 'template'}
            >
              {busy === 'template' ? 'Creating…' : 'Create from template'}
            </button>
          </>
        )}
      </div>

      {error !== null ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
