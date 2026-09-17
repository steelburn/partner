/**
 * M26-era create form, extracted so TWO surfaces can mount it (the review fix
 * that made a second draft possible at all).
 *
 * WHY it is its own file: the only door to a new draft used to be the EMPTY
 * state, which renders when `drafts.length === 0`. The moment an owner had one
 * draft, generate / start-blank / create-from-template all became unreachable —
 * the only way back was to discard everything, which is not a flow. The rail's
 * "New draft" action therefore opens the same form, and the form is one
 * component so the two doors cannot drift (same ids, same validation rules, same
 * provider honesty).
 *
 * It owns no state that survives the mount: after a create, the container
 * adopts the returned draft and unmounts this (the empty state or the compose
 * card is replaced by the draft's editor in the same tick).
 */
import { useState } from 'react';
import type { SkillDraft } from '@partner/shared';
import { slugPreview, type TemplateOption } from '../lib/skill-studio-helpers.js';
import { createDraft } from '../lib/skills.js';
import { readStoredToken } from '../lib/token.js';

import { isSessionLost, messageOf } from './shared.js';

// ---------------------------------------------------------------------------
// The three doors: describe it, start blank, or start from a template
// ---------------------------------------------------------------------------

export interface DraftComposerProps {
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
 * Generation is the only path that needs a provider, so it is the only one that
 * changes shape when none is configured — the other two work with no credentials
 * at all.
 */
export function DraftComposer({
  templates,
  templatesError,
  providerConfigured,
  disabled,
  onCreated,
  onSessionLost,
}: DraftComposerProps) {
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
    <>
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
    </>
  );
}
