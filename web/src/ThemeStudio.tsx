import { useEffect, useRef, useState } from 'react';
import { TOKENS, type ThemeMode, type ThemeTokens } from '@partner/shared';
import type { ThemeProfile, ThemeSaveInput } from '@partner/shared';
import { isSessionLost } from './lib/personas.js';
import { downloadTextFile } from './lib/download.js';
import {
  COLOR_TOKEN_GROUPS,
  TOKEN_LABELS,
  TOKEN_VAR_NAMES,
  colorValueHint,
  mergeTokensWithDefaults,
  normalizeHexColor,
  parseIssueToken,
  plausibleColorOverrides,
  reportTokenGroups,
  sameColorTokens,
  sharedTokenReadout,
  themeExportFile,
  themeName,
  validateThemeFile,
  validateThemeFileSize,
  type ThemeColorKey,
  type ThemeTokenPair,
} from './lib/theme-helpers.js';
import {
  activateTheme,
  createTheme,
  deleteTheme,
  updateTheme,
  type ThemeSaveResult,
} from './lib/themes.js';
import { readStoredToken } from './lib/token.js';
import type { ThemeReport } from '@partner/shared';

export interface ThemeStudioProps {
  /** Every theme (presets + customs); null while the shell still loads them. */
  themes: ThemeProfile[] | null;
  /** Load-failure text for the list itself; shown with a retry action. */
  loadError: string | null;
  /** Id of the theme currently applied (resolved persona -> global). */
  activeThemeId: string | null;
  /** Tokens currently previewed on the document (non-null while a draft previews). */
  preview: ThemeTokenPair | null;
  /** The App shell owns document application; it applies this pair on change. */
  onPreviewChange: (next: ThemeTokenPair | null) => void;
  /** Forget the session and return to the pairing gate (auth failure). */
  onUnpair: () => void;
  /** Re-fetch the theme list. */
  onRefresh: () => void;
  /** Themes mutated (create/update/delete/activate/import) — refetch list + active. */
  onThemesChanged: () => void;
  /** True while this view is the visible one. */
  active?: boolean;
}

/** An unsaved theme under construction (create) or an edit copy (edit). */
interface ThemeDraft {
  kind: 'create' | 'edit';
  /** Edit target id (null while creating). */
  themeId: string | null;
  /** Snapshot of the tokens the draft started from — for the dirty check. */
  base: ThemeTokenPair;
  name: string;
  light: Record<ThemeColorKey, string>;
  dark: Record<ThemeColorKey, string>;
}

function draftFromProfile(profile: ThemeProfile): ThemeDraft {
  return {
    kind: 'edit',
    themeId: profile.id,
    base: { light: profile.light, dark: profile.dark },
    name: profile.name,
    light: { ...profile.light },
    dark: { ...profile.dark },
  };
}

function draftFromDefaults(): ThemeDraft {
  return {
    kind: 'create',
    themeId: null,
    base: { light: { ...TOKENS.light }, dark: { ...TOKENS.dark } },
    name: '',
    light: { ...TOKENS.light },
    dark: { ...TOKENS.dark },
  };
}

function isDraftDirty(draft: ThemeDraft): boolean {
  return (
    !sameColorTokens(draft.base.light, draft.light) || !sameColorTokens(draft.base.dark, draft.dark)
  );
}

/**
 * The preview payload for a draft: resolved light/dark tokens using ONLY the
 * values that are plausible colors (an in-progress invalid value never
 * reaches the document — that key falls back to the mode default instead).
 * Returns null when the draft is untouched (nothing would change on screen).
 */
function previewPairFor(draft: ThemeDraft): ThemeTokenPair | null {
  if (!isDraftDirty(draft)) return null;
  return {
    light: mergeTokensWithDefaults(plausibleColorOverrides(draft.light), 'light'),
    dark: mergeTokensWithDefaults(plausibleColorOverrides(draft.dark), 'dark'),
  };
}

/** A safe download filename from a theme name. */
function themeFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug.length > 0 ? slug : 'theme'}.json`;
}

/**
 * M6 Theme Studio (PLAN-M6.md). Left: the theme list (immutable presets +
 * customs) with Activate / Edit / Delete / Export; right: a draft editor for
 * the light+dark COLOR tokens with live preview, inline save reports and
 * export/import. The studio never writes document vars itself — it hands the
 * resolved draft pair to the App shell (single writer), so the header mode
 * toggle always flips light/dark against whatever is currently applied.
 */
export default function ThemeStudio({
  themes,
  loadError,
  activeThemeId,
  preview,
  onPreviewChange,
  onUnpair,
  onRefresh,
  onThemesChanged,
  active,
}: ThemeStudioProps) {
  const [draft, setDraft] = useState<ThemeDraft | null>(null);

  // Refresh once when the view becomes visible (keeps badges current after
  // persona binding changes elsewhere).
  useEffect(() => {
    if (!active) return;
    onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Keep the shell's applied tokens in step with the open draft. Only the
  // visible studio pushes previews; the shell clears them when it hides.
  useEffect(() => {
    if (!active) return;
    onPreviewChange(draft === null ? null : previewPairFor(draft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, draft]);

  const presets: ThemeProfile[] = [];
  const customs: ThemeProfile[] = [];
  for (const theme of themes ?? []) {
    (theme.source === 'preset' ? presets : customs).push(theme);
  }

  const handleSessionLost = (): void => onUnpair();

  // Save wrapper: a successful save ends the live preview so the app returns
  // to the real active theme (the saved theme is applied only once
  // activated); a successful CREATE also becomes an edit of the saved
  // profile (clean baseline) so the next click updates instead of
  // silently creating a duplicate.
  const handleEditorSave = async (next: ThemeDraft): Promise<ThemeSaveResult> => {
    const result = await performSave(next, onUnpair, onThemesChanged);
    if (result.ok) {
      onPreviewChange(null);
      if (next.kind === 'create') {
        setDraft(draftFromProfile(result.profile));
      }
    }
    return result;
  };

  // Activating from the list also ends any live draft preview so the screen
  // visibly switches to the newly active theme.
  const handleThemeActivated = (): void => {
    onPreviewChange(null);
    onThemesChanged();
  };

  return (
    <section className="themes" aria-label="Theme studio">
      <div className="themes-panel">
        <h1 className="themes-title">Themes</h1>
        <p className="themes-intro">
          Partner&apos;s look is a token set — pick a preset, tweak the color tokens in the
          studio, and save only themes that pass the core&apos;s contrast gate. Themes apply
          globally or per persona.
        </p>

        {loadError !== null ? (
          <div className="themes-alert" role="alert">
            <p className="themes-alert-text">{loadError}</p>
            <button type="button" className="btn btn-secondary" onClick={onRefresh}>
              Try again
            </button>
          </div>
        ) : null}

        {themes === null && loadError === null ? (
          <p className="themes-loading" aria-busy="true">
            Loading themes…
          </p>
        ) : themes !== null ? (
          <div className="theme-workspace">
            <section className="card theme-list-card" aria-label="Theme list">
              <div className="section-head">
                <h2 className="card-title">Theme list</h2>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    setDraft(draftFromDefaults());
                  }}
                >
                  New theme
                </button>
              </div>
              <p className="themes-meta">
                {activeThemeId
                  ? `Now applying: ${themeName(activeThemeId, themes)}`
                  : 'Applying the built-in default'}
                {preview !== null ? ' — previewing an unsaved draft' : ''}
              </p>

              {themes.length === 0 ? (
                <div className="empty-state">
                  <p className="empty-state-title">No saved themes yet</p>
                  <p className="empty-state-copy">
                    Create one from the default tokens, or bind personas below once you do.
                  </p>
                </div>
              ) : (
                <ul className="theme-list">
                  {presets.length > 0 ? (
                    <li className="theme-list-group">
                      <h3 className="theme-list-group-title">Built-in</h3>
                      <ul className="theme-group-list">
                        {presets.map((theme) => (
                          <li key={theme.id}>
                            <ThemeRow
                              theme={theme}
                              activeId={activeThemeId}
                              onActivated={handleThemeActivated}
                              onSessionLost={handleSessionLost}
                            />
                          </li>
                        ))}
                      </ul>
                    </li>
                  ) : null}
                  {customs.length > 0 ? (
                    <li className="theme-list-group">
                      <h3 className="theme-list-group-title">Your themes</h3>
                      <ul className="theme-group-list">
                        {customs.map((theme) => (
                          <li key={theme.id}>
                            <ThemeRow
                              theme={theme}
                              activeId={activeThemeId}
                              onEdit={(profile) => setDraft(draftFromProfile(profile))}
                              onDeleted={onThemesChanged}
                              onActivated={handleThemeActivated}
                              onSessionLost={handleSessionLost}
                            />
                          </li>
                        ))}
                      </ul>
                    </li>
                  ) : null}
                </ul>
              )}
            </section>

            <section className="card theme-editor" aria-label="Theme studio editor">
              {draft === null ? (
                <div className="empty-state">
                  <p className="empty-state-title">No theme open</p>
                  <p className="empty-state-copy">
                    Press <strong>New theme</strong> to start from the default tokens, or{' '}
                    <strong>Edit</strong> on one of your themes. Color changes preview live and
                    the header Light/Dark toggle flips the draft between modes.
                  </p>
                </div>
              ) : (
                <DraftEditor
                  draft={draft}
                  onChangeDraft={setDraft}
                  onSave={handleEditorSave}
                  onClose={() => setDraft(null)}
                  onSessionLost={handleSessionLost}
                />
              )}
            </section>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Theme list row
// ---------------------------------------------------------------------------

interface ThemeRowProps {
  theme: ThemeProfile;
  activeId: string | null;
  /** Editing is only offered for customs (presets read-only). */
  onEdit?: (profile: ThemeProfile) => void;
  /** Delete is only offered for customs (presets read-only). */
  onDeleted?: () => void;
  onActivated: () => void;
  onSessionLost: () => void;
}

function ThemeRow({
  theme,
  activeId,
  onEdit,
  onDeleted = () => undefined,
  onActivated,
  onSessionLost,
}: ThemeRowProps) {
  const [busy, setBusy] = useState<null | 'activate' | 'delete'>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isActive = theme.id === activeId;

  const handleActivate = async (): Promise<void> => {
    if (busy !== null) return;
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setBusy('activate');
    setError(null);
    try {
      await activateTheme(token, theme.id);
      onActivated();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not activate the theme.');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (isActive || busy !== null) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    const token = readStoredToken();
    if (!token) {
      onSessionLost();
      return;
    }
    setConfirming(false);
    setBusy('delete');
    setError(null);
    try {
      await deleteTheme(token, theme.id);
      onDeleted();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not delete the theme.');
    } finally {
      setBusy(null);
    }
  };

  const exportTheme = (): void => {
    downloadTextFile(
      themeFileName(theme.name),
      themeExportFile({ name: theme.name, light: theme.light, dark: theme.dark }),
    );
  };

  const idle = busy === null;
  const custom = theme.source === 'custom';

  return (
    <article className="theme-row">
      <div className="theme-row-head">
        <span className="theme-row-name">{theme.name}</span>
        {isActive ? <span className="chip chip-accent">Active</span> : null}
      </div>
      <div className="theme-row-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void handleActivate()}
          disabled={!idle || isActive}
          aria-busy={busy === 'activate'}
          title={isActive ? 'This theme is already active.' : undefined}
        >
          {busy === 'activate' ? 'Activating…' : isActive ? 'Active' : 'Activate'}
        </button>
        {custom && onEdit ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onEdit(theme)}
            disabled={!idle}
          >
            Edit
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={exportTheme}
          disabled={!idle}
        >
          Export
        </button>
        {custom ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm btn-danger"
            onClick={() => void handleDelete()}
            disabled={!idle || isActive}
            aria-busy={busy === 'delete'}
            aria-label={
              confirming
                ? `Confirm deleting theme ${theme.name}`
                : `Delete theme ${theme.name}`
            }
            title={isActive ? 'The active theme cannot be deleted.' : undefined}
          >
            {busy === 'delete' ? 'Deleting…' : confirming ? 'Confirm delete' : 'Delete'}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="row-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Save (create/update) — shared by the editor and the import path
// ---------------------------------------------------------------------------

async function performSave(
  draft: ThemeDraft,
  onUnpair: () => void,
  onThemesChanged: () => void,
): Promise<ThemeSaveResult> {
  const token = readStoredToken();
  if (!token) {
    onUnpair();
    throw new Error('session-lost');
  }
  const input: ThemeSaveInput = {
    name: draft.name.trim(),
    light: mergeTokensWithDefaults(draft.light, 'light'),
    dark: mergeTokensWithDefaults(draft.dark, 'dark'),
  };
  const result =
    draft.kind === 'create'
      ? await createTheme(token, input)
      : await updateTheme(token, draft.themeId ?? '', input);
  if (result.ok) onThemesChanged();
  return result;
}

// ---------------------------------------------------------------------------
// Draft editor
// ---------------------------------------------------------------------------

interface DraftEditorProps {
  draft: ThemeDraft;
  onChangeDraft: (next: ThemeDraft) => void;
  onSave: (draft: ThemeDraft) => Promise<ThemeSaveResult>;
  onClose: () => void;
  onSessionLost: () => void;
}

function DraftEditor({ draft, onChangeDraft, onSave, onClose, onSessionLost }: DraftEditorProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ThemeReport | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const editing = draft.kind === 'edit';
  const dirty = isDraftDirty(draft);
  const idPrefix = editing ? `theme-edit-${draft.themeId}` : 'theme-new';

  const setToken = (mode: ThemeMode, key: ThemeColorKey, value: string): void => {
    const nextMode = { ...draft[mode], [key]: value };
    const next: ThemeDraft =
      mode === 'light'
        ? { ...draft, light: nextMode as Record<ThemeColorKey, string> }
        : { ...draft, dark: nextMode as Record<ThemeColorKey, string> };
    onChangeDraft(next);
  };

  const resetMode = (mode: ThemeMode): void => {
    const next: ThemeDraft = { ...draft, [mode]: { ...TOKENS[mode] } };
    onChangeDraft(next);
  };

  const handleSave = async (): Promise<void> => {
    if (busy) return;
    if (draft.name.trim().length === 0) {
      setError('Give the theme a name before saving.');
      return;
    }
    setBusy(true);
    setError(null);
    setReport(null);
    setSavedNote(null);
    setImportError(null);
    try {
      const result = await onSave(draft);
      if (!result.ok) {
        setReport(result.report);
        setError(
          result.report === null
            ? result.message
            : null,
        );
        setSavedNote(null);
        return;
      }
      setSavedNote(editing ? 'Theme updated.' : 'Theme saved.');
    } catch (cause) {
      if (isSessionLost(cause)) {
        onSessionLost();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not save the theme.');
    } finally {
      setBusy(false);
    }
  };

  const handleImportFile = async (file: File | undefined): Promise<void> => {
    setImportError(null);
    setError(null);
    setReport(null);
    if (!file) return;
    let text = '';
    try {
      text = await file.text();
    } catch {
      setImportError('Could not read the selected file.');
      return;
    }
    const sizeError = validateThemeFileSize(text);
    if (sizeError !== null) {
      setImportError(sizeError);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setImportError('The file is not valid JSON.');
      return;
    }
    const shapeError = validateThemeFile(parsed);
    if (shapeError !== null) {
      setImportError(shapeError);
      return;
    }
    const fileTheme = parsed as { name: string; light: ThemeTokens; dark: ThemeTokens };
    // Load the file INTO the editor as a new draft (validated client-side);
    // saving it runs the same core contrast gate as any other create. The
    // baseline stays the canonical defaults so the imported tokens count as
    // an edit and preview live before saving.
    const next = draftFromDefaults();
    next.name = fileTheme.name;
    next.light = { ...fileTheme.light };
    next.dark = { ...fileTheme.dark };
    onChangeDraft(next);
    setSavedNote('Loaded from file — review it, then press “Create theme” to save.');
    setReport(null);
    setError(null);
    setImportError(null);
  };

  // Token paths the save report blocked, for per-field markers ('dark.textMuted').
  const errorTokens = new Set((report?.errors ?? []).map((issue) => issue.token));
  const errorCount = report?.errors?.length ?? 0;

  return (
    <div className="theme-editor-inner">
      <div className="section-head theme-editor-head">
        <div>
          <h2 className="card-title">{editing ? 'Edit theme' : 'New theme'}</h2>
          <p className="theme-editor-sub">
            {editing
              ? `Editing “${draft.name}” — unsaved changes preview live.`
              : 'Start from the default preset tokens.'}
          </p>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => importRef.current?.click()}
            disabled={busy}
          >
            Import
          </button>
          <input
            ref={importRef}
            className="theme-file-input"
            type="file"
            accept=".json,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Allow re-picking the same file on the next import.
              event.target.value = '';
              void handleImportFile(file);
            }}
            aria-label="Import a theme JSON file"
            tabIndex={-1}
          />
        </div>
      </div>

      <div className="form-stack">
        <div className="form-field">
          <label className="label" htmlFor={`${idPrefix}-name`}>
            Theme name
          </label>
          <input
            id={`${idPrefix}-name`}
            className="field"
            type="text"
            value={draft.name}
            onChange={(event) => onChangeDraft({ ...draft, name: event.target.value })}
            disabled={busy}
            placeholder="My calm theme"
            aria-required="true"
          />
        </div>

        <div className="theme-modes">
          <ThemeModeBlock
            title="Light"
            mode="light"
            draft={draft}
            prefix={idPrefix}
            busy={busy}
            errorTokens={errorTokens}
            onToken={setToken}
            onReset={resetMode}
          />
          <ThemeModeBlock
            title="Dark"
            mode="dark"
            draft={draft}
            prefix={idPrefix}
            busy={busy}
            errorTokens={errorTokens}
            onToken={setToken}
            onReset={resetMode}
          />
        </div>

        <details className="theme-readonly">
          <summary className="theme-readonly-summary">Fixed system tokens (read-only)</summary>
          <p className="theme-readonly-copy">
            Spacing, type, radius, elevation and motion stay on the shared system constants; M6
            edits the color tokens only.
          </p>
          {sharedTokenReadout().map((section) => (
            <section className="theme-readonly-section" key={section.title}>
              <h4 className="theme-readonly-title">{section.title}</h4>
              <ul className="theme-readonly-list">
                {section.rows.map((row) => (
                  <li className="theme-readonly-row" key={row.name}>
                    <code className="theme-readonly-name">{row.name}</code>
                    <span className="theme-readonly-value">{row.value}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </details>

        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={busy} aria-busy={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create theme'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            {dirty ? 'Discard' : 'Close'}
          </button>
        </div>

        <div className="form-feedback" aria-live="polite">
          {importError !== null ? (
            <p className="form-error" role="alert">
              {importError}
            </p>
          ) : null}
          {error !== null ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {savedNote !== null ? (
            <p className="success-note" role="status">
              {savedNote}
            </p>
          ) : null}
        </div>
      </div>
      {report !== null && errorCount > 0 ? (
        <ReportPanel report={report} errorCount={errorCount} onClose={() => setReport(null)} />
      ) : null}
    </div>
  );
}

function ReportPanel({
  report,
  errorCount,
  onClose,
}: {
  report: ThemeReport;
  errorCount: number;
  onClose: () => void;
}) {
  const groups = reportTokenGroups(report);
  if (groups.length === 0) return null;
  return (
    <div className="theme-report" role="alert">
      <div className="theme-report-head">
        <p className="theme-report-title">
          Not saved — the core found {errorCount} contrast or lint{' '}
          {errorCount === 1 ? 'error' : 'errors'}.
        </p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
          Dismiss
        </button>
      </div>
      <p className="theme-report-copy">
        Every failing token is listed below with the measured pair. Fix the value and save
        again — the preview keeps showing your draft.
      </p>
      <ul className="theme-report-list">
        {groups.map((group) => {
          const parsed = parseIssueToken(group.token);
          const heading = parsed
            ? `${parsed.mode === 'light' ? 'Light' : 'Dark'} · ${TOKEN_LABELS[parsed.key]}`
            : group.token;
          return (
            <li className="theme-report-item" key={group.token}>
              <p className="theme-report-token">{heading}</p>
              <ul className="theme-report-issues">
                {group.issues.map((issue, index) => (
                  <li className="theme-report-issue" key={`${group.token}-${index}`}>
                    <span className="theme-report-message">{issue.message}</span>
                    {typeof issue.apca === 'number' ? (
                      <span className="chip">APCA {Math.round(Math.abs(issue.apca))}</span>
                    ) : null}
                    {typeof issue.wcag === 'number' ? (
                      <span className="chip">WCAG {issue.wcag.toFixed(2)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One light/dark color-token block
// ---------------------------------------------------------------------------

interface ThemeModeBlockProps {
  title: string;
  mode: ThemeMode;
  draft: ThemeDraft;
  prefix: string;
  busy: boolean;
  /** Token paths ('dark.textMuted') blocked by the last save report. */
  errorTokens: ReadonlySet<string>;
  onToken: (mode: ThemeMode, key: ThemeColorKey, value: string) => void;
  onReset: (mode: ThemeMode) => void;
}

function ThemeModeBlock({
  title,
  mode,
  draft,
  prefix,
  busy,
  errorTokens,
  onToken,
  onReset,
}: ThemeModeBlockProps) {
  const tokens = draft[mode] as Record<ThemeColorKey, string>;
  return (
    <section className="theme-mode" aria-label={`${title} color tokens`}>
      <div className="theme-mode-head">
        <h3 className="theme-mode-title">{title}</h3>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onReset(mode)}
          disabled={busy}
          aria-label={`Reset ${title.toLowerCase()} tokens to defaults`}
        >
          Reset to defaults
        </button>
      </div>
      {COLOR_TOKEN_GROUPS.map((group) => (
        <section className="theme-editor-group" key={group.group}>
          <h4 className="theme-editor-group-title">{group.group}</h4>
          <ul className="theme-fields">
            {group.keys.map((key) => {
              const value = tokens[key];
              const hint = colorValueHint(value);
              const hex = normalizeHexColor(value);
              const id = `${prefix}-${mode}-${key}`;
              const blocked = errorTokens.has(`${mode}.${key}`);
              return (
                <li className={`theme-field${blocked ? ' theme-field-error' : ''}`} key={key}>
                  <div className="theme-field-line">
                    <label className="theme-field-label" htmlFor={id}>
                      <span className="theme-field-token">{TOKEN_LABELS[key]}</span>
                      <code className="theme-field-var">{TOKEN_VAR_NAMES[key]}</code>
                    </label>
                    <div className="theme-field-inputs">
                      <input
                        id={id}
                        className={`field theme-field-hex${hint !== null ? ' theme-field-invalid' : ''}`}
                        type="text"
                        value={value}
                        onChange={(event) => onToken(mode, key, event.target.value)}
                        disabled={busy}
                        spellCheck={false}
                        autoComplete="off"
                        aria-invalid={hint !== null}
                        aria-label={`${title} ${TOKEN_LABELS[key]}`}
                      />
                      <input
                        className="theme-swatch"
                        type="color"
                        value={hex ?? '#ffffff'}
                        onChange={(event) => onToken(mode, key, event.target.value)}
                        disabled={busy || hex === null}
                        aria-hidden="true"
                        tabIndex={-1}
                        title={hex === null ? 'Not a hex color — the field keeps the current value.' : undefined}
                      />
                    </div>
                  </div>
                  {hint !== null ? (
                    <p className="theme-field-hint">{hint}</p>
                  ) : null}
                  {blocked ? (
                    <p className="theme-field-error-note">Blocked by the save report — see below.</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}
