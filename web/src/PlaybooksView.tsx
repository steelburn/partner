import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from 'react';
import type {
  ConversationSummary,
  DeployProfile,
  NoteSummary,
  Persona,
  PlaybookSummary,
} from '@partner/shared';
import type { ProjectRoot } from '@partner/shared/src/tools.js';
import { ApiRequestError } from './lib/api.js';
import { readStoredToken } from './lib/token.js';
import { listNotes } from './lib/notes.js';
import { listRoots, listPending } from './lib/tools.js';
import { conversationTitle, levelLabel, sortConversations } from './lib/persona-helpers.js';
import {
  areaLabel,
  areaTone,
  describeInputs,
  inputKind,
  noteInputNames,
  personaToolMarkerText,
  runStatusLabel,
  validateAbsoluteDir,
  validateHostInput,
  validateJsonText,
  validatePortInput,
  validateProfileName,
  type PlaybookInputKind,
} from './lib/playbook-helpers.js';
import {
  createDeployProfile,
  deleteDeployProfile,
  listDeployProfiles,
  listPlaybooks,
  packageProfile,
  resumeRun,
  runPlaybook,
  type PlaybookRunEvent,
  type PlaybookRunStatus,
  type StreamPlaybookRunResult,
} from './lib/playbooks.js';

export interface PlaybooksViewProps {
  /** Personas the run panel can route through (null while the shell loads). */
  personas: Persona[] | null;
  /** Conversations a run may target (persists into one when selected). */
  conversations: ConversationSummary[] | null;
  /** Forget the session and return to the pairing gate (auth failure). */
  onUnpair: () => void;
  /** True while this view is the visible one (drives loads + queue polling). */
  active?: boolean;
}

function isSessionLost(cause: unknown): boolean {
  return cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403);
}

// ---------------------------------------------------------------------------
// Shared little pieces
// ---------------------------------------------------------------------------

function EmptyState({ text }: { text: string }) {
  return (
    <p className="chat-empty" role="status">
      {text}
    </p>
  );
}

function ViewAlert({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="pb-alert" role="alert">
      <span className="pb-alert-text">{text}</span>
      {onRetry ? (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Playbook Run segment
// ---------------------------------------------------------------------------

type Segment = 'run' | 'deploy';

/** One transcript row: streaming text bubbles, markers, status/error lines. */
interface RunRow {
  key: string;
  kind: 'text' | 'marker' | 'status' | 'error';
  text: string;
}

type RunPhase = 'idle' | 'streaming' | 'waiting' | 'done';

interface WaitingMeta {
  runId: string | null;
  pendingId: string;
}

/**
 * M9 Playbook Run panel (PLAN-M9.md): pick a playbook from the registry,
 * route through a persona (optional conversation target), fill the declared
 * input schema (note hints become note pickers), then stream the run —
 * deltas render as text bubbles, loop rounds and persona-tool decisions as
 * muted markers. A queued persona tool pauses the run: the transcript shows
 * the approval hint, this panel watches the approval queue, and the run
 * resumes automatically once the human decides it (manual Continue as
 * fallback). Save-as-note shows the applied state when the terminal
 * done_meta reports the created note.
 *
 * Redaction: transcript text, tool markers and inputs are owner data that
 * render on the page only — never logged, echoed into errors, or copied
 * into labels. Errors name fields and ids, never content.
 */
function RunSegment({
  personas,
  conversations,
  onUnpair,
  active,
}: {
  personas: Persona[] | null;
  conversations: ConversationSummary[] | null;
  onUnpair: () => void;
  active: boolean;
}) {
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessionLost, setSessionLost] = useState(false);

  const [personaId, setPersonaId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [saveNote, setSaveNote] = useState(false);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);

  const [rows, setRows] = useState<RunRow[]>([]);
  const [phase, setPhase] = useState<RunPhase>('idle');
  const [runError, setRunError] = useState<string | null>(null);
  const [waitMeta, setWaitMeta] = useState<WaitingMeta | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [noteApplied, setNoteApplied] = useState<{ id: string; title: string | null } | null>(
    null,
  );

  const nextKey = useRef(0);
  const textKeyRef = useRef<string | null>(null);
  const waitMetaRef = useRef<WaitingMeta | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const selected = playbooks?.find((p) => p.id === selectedId) ?? null;
  const defaultPersonaId = personas?.[0]?.id ?? '';
  const effectivePersonaId = personaId || defaultPersonaId;

  // Default the persona select to the shell's first persona once loaded.
  useEffect(() => {
    if (personas !== null && personas.length > 0 && personaId === '') {
      setPersonaId(personas[0]!.id);
    }
  }, [personas, personaId]);

  const personaName =
    personas?.find((p) => p.id === effectivePersonaId)?.name ?? null;

  // Load the registry whenever the segment becomes visible.
  useEffect(() => {
    if (!active) return;
    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    let cancelled = false;
    listPlaybooks(token)
      .then((list) => {
        if (cancelled) return;
        setPlaybooks(list);
        setLoadError(null);
        setSelectedId((prev) =>
          prev !== null && list.some((p) => p.id === prev) ? prev : (list[0]?.id ?? null),
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (isSessionLost(cause)) setSessionLost(true);
        else setLoadError(cause instanceof Error ? cause.message : 'Could not load playbooks.');
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const resetTranscript = useCallback((): void => {
    setRows([]);
    setRunError(null);
    setNoteApplied(null);
    setWaitMeta(null);
    waitMetaRef.current = null;
    textKeyRef.current = null;
  }, []);

  const setWaiting = useCallback((meta: WaitingMeta | null): void => {
    waitMetaRef.current = meta;
    setWaitMeta(meta);
  }, []);

  const appendRow = useCallback((row: Omit<RunRow, 'key'>): void => {
    const key = `row-${++nextKey.current}`;
    setRows((prev) => [...prev, { key, ...row }]);
  }, []);

  const applyEvent = useCallback(
    (event: PlaybookRunEvent): void => {
      switch (event.type) {
        case 'delta':
          setRows((prev) => {
            const openKey = textKeyRef.current;
            if (openKey === null) {
              const key = `row-${++nextKey.current}`;
              textKeyRef.current = key;
              return [...prev, { key, kind: 'text', text: event.text }];
            }
            return prev.map((row) =>
              row.key === openKey ? { ...row, text: row.text + event.text } : row,
            );
          });
          break;
        case 'loop_step': {
          textKeyRef.current = null;
          appendRow({
            kind: 'marker',
            text:
              event.message && event.message.length > 0
                ? event.message
                : `Loop round ${event.round}`,
          });
          break;
        }
        case 'persona_tool': {
          textKeyRef.current = null;
          appendRow({
            kind: 'marker',
            text: personaToolMarkerText(event.toolId, event.decision, {
              personaName: personaName ?? undefined,
              reason: event.reason,
            }),
          });
          break;
        }
        case 'done': {
          textKeyRef.current = null;
          break;
        }
        case 'done_meta': {
          textKeyRef.current = null;
          if (event.pendingId !== null) {
            // The run pauses until the human decides this approval row.
            setWaiting({ runId: event.runId, pendingId: event.pendingId });
            setPhase('waiting');
            break;
          }
          const status: PlaybookRunStatus = event.status ?? 'done';
          if (event.noteId !== null) {
            setNoteApplied({ id: event.noteId, title: event.noteTitle });
            appendRow({
              kind: 'status',
              text:
                event.noteTitle && event.noteTitle.length > 0
                  ? `Saved as note — ${event.noteTitle}`
                  : 'Saved as note.',
            });
          } else {
            appendRow({ kind: 'status', text: `${runStatusLabel(status)}.` });
          }
          break;
        }
        case 'error': {
          textKeyRef.current = null;
          setRunError(event.message);
          appendRow({ kind: 'error', text: event.message });
          break;
        }
      }
    },
    [appendRow, personaName, setWaiting],
  );

  const openStream = useCallback(
    async (
      open: (signal: AbortSignal) => Promise<StreamPlaybookRunResult>,
      options: { reset: boolean },
    ): Promise<void> => {
      const controller = new AbortController();
      abortRef.current = controller;
      setPhase('streaming');
      if (options.reset) resetTranscript();
      try {
        const result = await open(controller.signal);
        if (!result.ok) {
          setRunError(result.message);
          setPhase('idle');
          return;
        }
        // A run that paused on a queued tool stays waiting (its queue poll
        // resumes it); anything else is a finished run.
        setPhase((prev) =>
          prev === 'streaming' && waitMetaRef.current === null ? 'done' : prev,
        );
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'AbortError') {
          setPhase('idle');
          return;
        }
        setRunError('Lost connection to the Partner core while the playbook ran.');
        setPhase('idle');
      }
    },
    [resetTranscript],
  );

  const handleRun = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (selected === null || phase === 'streaming') return;
    const errors: Record<string, string> = {};
    const inputs: Record<string, unknown> = {};
    for (const input of selected.inputs) {
      const raw = inputValues[input.name] ?? '';
      const trimmed = raw.trim();
      if (inputKind(input) === 'note') {
        if (trimmed.length === 0) {
          if (!input.optional) errors[input.name] = `${input.name} is required.`;
          continue;
        }
        inputs[input.name] = trimmed;
        continue;
      }
      if (trimmed.length === 0) {
        if (!input.optional) errors[input.name] = `${input.name} is required.`;
        continue;
      }
      if (inputKind(input) === 'json') {
        const error = validateJsonText(trimmed);
        if (error !== null) {
          errors[input.name] = error;
          continue;
        }
        try {
          inputs[input.name] = JSON.parse(trimmed) as unknown;
        } catch {
          inputs[input.name] = trimmed;
        }
      } else {
        inputs[input.name] = trimmed;
      }
    }
    setInputErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    void openStream(
      (signal) =>
        runPlaybook({
          token,
          playbookId: selected.id,
          inputs,
          personaId: effectivePersonaId.length > 0 ? effectivePersonaId : undefined,
          conversationId: conversationId.length > 0 ? conversationId : undefined,
          saveNote,
          signal,
          // consumeRunStream already delivers every frame (incl. done_meta)
          // to onEvent — registering onDoneMeta here too would apply each
          // terminal meta twice and duplicate the transcript rows.
          onEvent: applyEvent,
        }),
      { reset: true },
    );
  };

  const stopRun = (): void => {
    abortRef.current?.abort();
  };

  /** Continue a paused run once the queued tool decision has landed. */
  const continueRun = useCallback(async (): Promise<void> => {
    const meta = waitMetaRef.current;
    if (meta === null || meta.runId === null || resumeBusy) return;
    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    setResumeBusy(true);
    setWaiting(null);
    appendRow({ kind: 'marker', text: 'Run continuing…' });
    try {
      await openStream(
        (signal) =>
          resumeRun(meta.runId as string, meta.pendingId, {
            token,
            signal,
            // Same single-delivery rule as the run path above.
            onEvent: applyEvent,
          }),
        { reset: false },
      );
    } finally {
      setResumeBusy(false);
    }
  }, [appendRow, applyEvent, openStream, resumeBusy, setWaiting]);

  // While a run waits on a queued tool, watch the approval queue: when the
  // row leaves (approved and executed, or denied) the run resumes here.
  useEffect(() => {
    if (!active || waitMeta === null || waitMeta.runId === null) return;
    const { pendingId } = waitMeta;
    const token = readStoredToken();
    if (!token) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      if (stopped) return;
      const current = readStoredToken();
      if (!current) return;
      void listPending(current)
        .then((pending) => {
          if (stopped) return;
          if (!pending.some((row) => row.id === pendingId)) {
            window.clearInterval(timer);
            void continueRun();
          }
        })
        .catch(() => undefined);
    }, 2500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [active, waitMeta, continueRun]);

  // Abort the stream when the panel unmounts.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Load notes lazily: only when the selected playbook declares a note input.
  const wantsNotes = selected !== null && noteInputNames(selected.inputs).length > 0;
  useEffect(() => {
    if (!active || !wantsNotes) return;
    const token = readStoredToken();
    if (!token) return;
    let cancelled = false;
    listNotes(token)
      .then((list) => {
        if (cancelled) return;
        setNotes(list);
        setNotesError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (isSessionLost(cause)) setSessionLost(true);
        else setNotesError(cause instanceof Error ? cause.message : 'Could not load notes.');
      });
    return () => {
      cancelled = true;
    };
  }, [active, wantsNotes]);

  const busy = phase === 'streaming';
  const sortedConversations = useMemo(
    () => (conversations === null ? [] : sortConversations(conversations)),
    [conversations],
  );

  const setInput = (name: string, value: string): void => {
    setInputValues((prev) => ({ ...prev, [name]: value }));
    setInputErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  if (sessionLost) {
    return (
      <div className="run-panel">
        <ViewAlert text="Your session with the Partner core has expired." onRetry={onUnpair} />
      </div>
    );
  }

  return (
    <div className="run-panel">
      {loadError !== null ? (
        <ViewAlert text={loadError} onRetry={() => void runSegmentReload(setPlaybooks, setSelectedId, setLoadError, setSessionLost)} />
      ) : playbooks === null ? (
        <EmptyState text="Loading playbooks…" />
      ) : playbooks.length === 0 ? (
        <EmptyState text="No playbooks registered yet." />
      ) : (
        <div className="pb-columns">
          <div className="pb-list-col">
            <h2 className="pb-list-title">Playbooks</h2>
            <ul className="pb-list" aria-label="Playbook registry">
              {playbooks.map((playbook) => {
                const tone = areaTone(playbook.area);
                const pressed = playbook.id === selectedId;
                return (
                  <li key={playbook.id}>
                    <button
                      type="button"
                      className={`pb-card${pressed ? ' pb-card-active' : ''}`}
                      aria-pressed={pressed}
                      disabled={busy}
                      onClick={() => setSelectedId(playbook.id)}
                    >
                      <span className="pb-card-head">
                        <span className={`pb-area pb-area-${tone}`}>
                          {areaLabel(playbook.area)}
                        </span>
                        <span className="pb-level">
                          {levelLabel(playbook.defaultIndependence)}
                        </span>
                      </span>
                      <span className="pb-card-name">{playbook.name}</span>
                      <span className="pb-card-desc">{playbook.description}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="pb-run-col">
            {selected === null ? (
              <EmptyState text="Pick a playbook from the list." />
            ) : (
              <form className="run-form" onSubmit={handleRun}>
                <div className="run-form-head">
                  <h2 className="sub-panel-title">{selected.name}</h2>
                  <p className="sub-panel-copy">{selected.description}</p>
                  <p className="pb-hint">
                    {describeInputs(selected.inputs)}
                    {selected.allowedTools.length > 0
                      ? ` · tools: ${selected.allowedTools.join(', ')}`
                      : ''}
                  </p>
                </div>

                <div className="form-row">
                  <div className="form-field">
                    <label className="label" htmlFor="pb-persona">
                      Persona
                    </label>
                    <select
                      id="pb-persona"
                      className="field"
                      value={effectivePersonaId}
                      disabled={busy || (personas ?? []).length === 0}
                      onChange={(event) => setPersonaId(event.target.value)}
                    >
                      {(personas ?? []).length === 0 ? (
                        <option value="">Playbook default</option>
                      ) : null}
                      {(personas ?? []).map((persona) => (
                        <option key={persona.id} value={persona.id}>
                          {persona.name}
                          {persona.paused ? ' (paused)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field">
                    <label className="label" htmlFor="pb-conversation">
                      Conversation target
                    </label>
                    <select
                      id="pb-conversation"
                      className="field"
                      value={conversationId}
                      disabled={busy}
                      onChange={(event) => setConversationId(event.target.value)}
                    >
                      <option value="">None — run only</option>
                      {sortedConversations.map((conversation) => (
                        <option key={conversation.id} value={conversation.id}>
                          {conversationTitle(conversation)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {selected.inputs.length > 0 ? (
                  <div className="form-stack">
                    <h3 className="pb-fields-title">Inputs</h3>
                    {selected.inputs.map((input) => {
                      const kind: PlaybookInputKind = inputKind(input);
                      const error = inputErrors[input.name];
                      const noteId = `pb-input-${selected.id}-${input.name}`;
                      const notePick = kind === 'note';
                      const json = kind === 'json';
                      const multiline = kind === 'textarea';
                      return (
                        <div className="form-field" key={input.name}>
                          <label className="label" htmlFor={noteId}>
                            {input.name}
                            {input.optional ? (
                              <span className="label-optional"> optional</span>
                            ) : null}
                          </label>
                          {notePick ? (
                            notesError !== null ? (
                              <p className="form-hint">{notesError}</p>
                            ) : notes === null ? (
                              <p className="form-hint">Loading notes…</p>
                            ) : (
                              <select
                                id={noteId}
                                className="field"
                                value={inputValues[input.name] ?? ''}
                                disabled={busy}
                                onChange={(event) => setInput(input.name, event.target.value)}
                              >
                                <option value="">
                                  {input.optional ? 'None' : 'Pick a note…'}
                                </option>
                                {notes.map((note) => (
                                  <option key={note.id} value={note.id}>
                                    {note.title.length > 0 ? note.title : '(untitled note)'}
                                  </option>
                                ))}
                              </select>
                            )
                          ) : json || multiline ? (
                            <textarea
                              id={noteId}
                              className="field pb-textarea"
                              rows={json ? 5 : 3}
                              value={inputValues[input.name] ?? ''}
                              disabled={busy}
                              placeholder={json ? '{ … }' : input.hint}
                              onChange={(event) => setInput(input.name, event.target.value)}
                            />
                          ) : (
                            <input
                              id={noteId}
                              className="field"
                              type="text"
                              value={inputValues[input.name] ?? ''}
                              disabled={busy}
                              placeholder={input.hint}
                              onChange={(event) => setInput(input.name, event.target.value)}
                            />
                          )}
                          <p className="pb-field-hint">{input.hint}</p>
                          {error ? (
                            <p className="form-error" role="alert">
                              {error}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                <label className="pb-check">
                  <input
                    type="checkbox"
                    checked={saveNote}
                    disabled={busy}
                    onChange={(event) => setSaveNote(event.target.checked)}
                  />
                  <span>Save the result as a note</span>
                </label>

                <div className="form-actions">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={busy || playbooks.length === 0}
                  >
                    {busy ? 'Running…' : 'Run playbook'}
                  </button>
                  {busy ? (
                    <button type="button" className="btn btn-secondary" onClick={stopRun}>
                      Stop
                    </button>
                  ) : null}
                  {phase === 'waiting' && waitMeta?.runId !== null ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={resumeBusy}
                      onClick={() => void continueRun()}
                    >
                      {resumeBusy ? 'Continuing…' : 'Continue run'}
                    </button>
                  ) : null}
                </div>

                <div className="run-transcript-wrap">
                  {rows.length === 0 && phase === 'idle' && runError === null ? (
                    <EmptyState text="The transcript streams here when you run the playbook." />
                  ) : (
                    <div
                      className="run-transcript"
                      aria-live="polite"
                      aria-label="Run transcript"
                    >
                      {rows.map((row) => {
                        if (row.kind === 'text') {
                          return (
                            <div key={row.key} className="msg msg-assistant">
                              {row.text}
                            </div>
                          );
                        }
                        if (row.kind === 'error') {
                          return (
                            <div
                              key={row.key}
                              className="msg msg-system pb-marker-error"
                              role="alert"
                            >
                              {row.text}
                            </div>
                          );
                        }
                        if (row.kind === 'status') {
                          return (
                            <div key={row.key} className="msg msg-system pb-status">
                              {row.text}
                            </div>
                          );
                        }
                        return (
                          <div key={row.key} className="msg msg-system pb-marker">
                            {row.text}
                          </div>
                        );
                      })}
                      {busy && rows[rows.length - 1]?.kind === 'text' ? (
                        <div className="msg msg-assistant" aria-hidden="true">
                          …
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>

                <div className="run-status" aria-live="polite">
                  {runError !== null ? (
                    <span className="run-status-text pb-run-error">{runError}</span>
                  ) : noteApplied !== null ? (
                    <span className="pb-run-note">
                      Saved as note{noteApplied.title ? ` — ${noteApplied.title}` : ''}.
                    </span>
                  ) : phase === 'streaming' ? (
                    <span className="run-status-text">Running…</span>
                  ) : null}
                </div>

                {phase === 'waiting' ? (
                  <div className="waiting-box" role="status">
                    <span className="waiting-text">
                      Waiting on your approval in the queue — a persona tool needs it to
                      continue.
                    </span>
                    {waitMeta?.runId === null ? (
                      <span className="pb-hint">
                        (The run has no resume id — approve it in Files, then start again.)
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Reload the playbook registry after a load error (Run segment). */
async function runSegmentReload(
  setPlaybooks: Dispatch<SetStateAction<PlaybookSummary[] | null>>,
  setSelectedId: Dispatch<SetStateAction<string | null>>,
  setLoadError: Dispatch<SetStateAction<string | null>>,
  setSessionLost: Dispatch<SetStateAction<boolean>>,
): Promise<void> {
  const token = readStoredToken();
  if (!token) {
    setSessionLost(true);
    return;
  }
  try {
    const list = await listPlaybooks(token);
    setPlaybooks(list);
    setLoadError(null);
    setSelectedId((prev) =>
      prev !== null && list.some((p) => p.id === prev) ? prev : (list[0]?.id ?? null),
    );
  } catch (cause) {
    if (isSessionLost(cause)) setSessionLost(true);
  }
}

// ---------------------------------------------------------------------------
// Deploy targets segment
// ---------------------------------------------------------------------------

interface PackageState {
  busy: boolean;
  error: string | null;
  result: { outDir: string; files: string[]; dockerfile: string } | null;
  outDir: string;
  projectDir: string;
}

/** Preview cap for a generated Dockerfile (monospace, truncated). */
const DOCKERFILE_MAX = 4000;

function truncatedPreview(text: string): string {
  return text.length > DOCKERFILE_MAX ? `${text.slice(0, DOCKERFILE_MAX)}\n… (truncated)` : text;
}

function freshPackageState(projectDir: string): PackageState {
  return {
    busy: false,
    error: null,
    result: null,
    outDir: '',
    projectDir,
  };
}

/**
 * M9 Deploy targets panel (PLAN-M9.md + PLAN §6.1): saved profiles
 * (name + host + user/port/base dir), a validated add form, two-step delete,
 * and per-profile Package — pick the project root, give an out dir, and the
 * core builds a container-ready bundle (Dockerfile + core bundle + web dist
 * + README) into a folder under a granted root. Live ship to the host stays
 * environment-gated; this panel bundles locally only.
 */
function DeploySegment({ onUnpair, active }: { onUnpair: () => void; active: boolean }) {
  const [profiles, setProfiles] = useState<DeployProfile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionLost, setSessionLost] = useState(false);
  const [roots, setRoots] = useState<ProjectRoot[] | null>(null);

  // Add-form fields (no secrets: a profile never carries passwords/keys).
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [port, setPort] = useState('');
  const [baseDir, setBaseDir] = useState('');
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [armed, setArmed] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [packageState, setPackageState] = useState<Record<string, PackageState>>({});

  const load = useCallback(async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    try {
      const [profileList, rootList] = await Promise.all([
        listDeployProfiles(token),
        listRoots(token),
      ]);
      setProfiles(profileList);
      setRoots(rootList);
      setLoadError(null);
    } catch (cause) {
      if (isSessionLost(cause)) setSessionLost(true);
      else setLoadError(cause instanceof Error ? cause.message : 'Could not load deploy targets.');
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  if (sessionLost) {
    return (
      <div className="deploy-panel">
        <ViewAlert text="Your session with the Partner core has expired." onRetry={onUnpair} />
      </div>
    );
  }

  const defaultProjectDir = roots?.[0]?.path ?? '';

  const handleAdd = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    const errors: Record<string, string> = {};
    const nameError = validateProfileName(name);
    if (nameError) errors.name = nameError;
    const hostError = validateHostInput(host);
    if (hostError) errors.host = hostError;
    const portError = validatePortInput(port);
    if (portError) errors.port = portError;
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const created = await createDeployProfile(token, {
        name: name.trim(),
        host: host.trim(),
        ...(username.trim().length > 0 ? { username: username.trim() } : {}),
        ...(port.trim().length > 0 ? { port: Number(port) } : {}),
        ...(baseDir.trim().length > 0 ? { remoteBaseDir: baseDir.trim() } : {}),
      });
      setProfiles((prev) => [...(prev ?? []), created]);
      setName('');
      setHost('');
      setUsername('');
      setPort('');
      setBaseDir('');
    } catch (cause) {
      if (isSessionLost(cause)) setSessionLost(true);
      else setFormError(cause instanceof Error ? cause.message : 'Could not save the profile.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (profileId: string): Promise<void> => {
    if (deleting[profileId]) return;
    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    setDeleting((prev) => ({ ...prev, [profileId]: true }));
    setFormError(null);
    try {
      await deleteDeployProfile(token, profileId);
      setProfiles((prev) => prev?.filter((profile) => profile.id !== profileId) ?? prev);
      setArmed((prev) => {
        const next = { ...prev };
        delete next[profileId];
        return next;
      });
    } catch (cause) {
      if (isSessionLost(cause)) setSessionLost(true);
      else setFormError(cause instanceof Error ? cause.message : 'Could not delete the profile.');
    } finally {
      setDeleting((prev) => ({ ...prev, [profileId]: false }));
    }
  };

  const handlePackage = async (profile: DeployProfile): Promise<void> => {
    const state = packageState[profile.id];
    if (!state || state.busy) return;
    const projectDir = state.projectDir.trim();
    const outDir = state.outDir.trim();
    const projectError = validateAbsoluteDir(projectDir);
    const outError = validateAbsoluteDir(outDir);
    if (projectError !== null || outError !== null) {
      setPackageState((prev) => ({
        ...prev,
        [profile.id]: {
          ...prev[profile.id]!,
          error: projectError ?? outError,
        },
      }));
      return;
    }
    const token = readStoredToken();
    if (!token) {
      setSessionLost(true);
      return;
    }
    setPackageState((prev) => ({
      ...prev,
      [profile.id]: { ...prev[profile.id]!, busy: true, error: null, result: null },
    }));
    try {
      const result = await packageProfile(token, profile.id, { projectDir, outDir });
      setPackageState((prev) => ({
        ...prev,
        [profile.id]: { ...prev[profile.id]!, busy: false, result },
      }));
    } catch (cause) {
      if (isSessionLost(cause)) {
        setSessionLost(true);
        return;
      }
      setPackageState((prev) => ({
        ...prev,
        [profile.id]: {
          ...prev[profile.id]!,
          busy: false,
          error: cause instanceof Error ? cause.message : 'Could not package the project.',
        },
      }));
    }
  };

  return (
    <div className="deploy-panel">
      <p className="sub-panel-copy">
        Saved deploy targets: an SSH + Docker host your apps can be bundled for. Packaging only
        builds the bundle locally — live ship to the host is environment-gated and stays out of
        this milestone.
      </p>

      {loadError !== null ? <ViewAlert text={loadError} onRetry={() => void load()} /> : null}
      {formError !== null ? (
        <p className="form-error" role="alert">
          {formError}
        </p>
      ) : null}

      <div className="deploy-columns">
        <div className="deploy-list-col">
          <h2 className="pb-list-title">Profiles</h2>
          {profiles === null ? (
            <EmptyState text="Loading profiles…" />
          ) : profiles.length === 0 ? (
            <EmptyState text="No deploy profiles yet — add one to package a project for it." />
          ) : (
            <ul className="pb-list" aria-label="Deploy profiles">
              {profiles.map((profile) => {
                const packState =
                  packageState[profile.id] ?? freshPackageState(defaultProjectDir);
                const armedDelete = armed[profile.id] === true;
                const open = openId === profile.id;
                return (
                  <li key={profile.id} className="deploy-card">
                    <div className="deploy-card-head">
                      <span className="pb-card-name">{profile.name}</span>
                      <span className="pb-area pb-area-neutral">{profile.kind}</span>
                    </div>
                    <p className="deploy-card-meta">{profile.host}</p>
                    <div className="form-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={deleting[profile.id] === true || packState.busy}
                        onClick={() => {
                          if (armedDelete) void handleDelete(profile.id);
                          else setArmed((prev) => ({ ...prev, [profile.id]: true }));
                        }}
                      >
                        {deleting[profile.id] === true
                          ? 'Deleting…'
                          : armedDelete
                            ? 'Confirm delete'
                            : 'Delete'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={packState.busy || armedDelete}
                        onClick={() => {
                          setOpenId((prev) => (prev === profile.id ? null : profile.id));
                          setPackageState((prev) => ({
                            ...prev,
                            [profile.id]:
                              prev[profile.id] ?? freshPackageState(defaultProjectDir),
                          }));
                        }}
                      >
                        {packState.busy ? 'Packaging…' : 'Package'}
                      </button>
                    </div>
                    {armedDelete ? (
                      <p className="skill-uninstall-warn" role="alert">
                        Delete this profile? Profiles only describe a host — deleting one never
                        touches the machine.
                      </p>
                    ) : null}
                    {open ? (
                      <div className="sub-panel">
                        <h3 className="sub-panel-title">Package for {profile.name}</h3>
                        {roots !== null && roots.length > 0 ? (
                          <div className="form-field">
                            <label className="label" htmlFor={`pb-pkg-root-${profile.id}`}>
                              Project root
                            </label>
                            <select
                              id={`pb-pkg-root-${profile.id}`}
                              className="field"
                              value={packState.projectDir || defaultProjectDir}
                              disabled={packState.busy}
                              onChange={(event) =>
                                setPackageState((prev) => ({
                                  ...prev,
                                  [profile.id]: {
                                    ...prev[profile.id]!,
                                    projectDir: event.target.value,
                                  },
                                }))
                              }
                            >
                              {roots.map((root) => (
                                <option key={root.id} value={root.path}>
                                  {root.label} — {root.path}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : (
                          <div className="form-field">
                            <label className="label" htmlFor={`pb-pkg-root-${profile.id}`}>
                              Project root (absolute path under a granted root)
                            </label>
                            <input
                              id={`pb-pkg-root-${profile.id}`}
                              className="field"
                              type="text"
                              value={packState.projectDir}
                              disabled={packState.busy}
                              placeholder="/home/me/projects/foo"
                              onChange={(event) =>
                                setPackageState((prev) => ({
                                  ...prev,
                                  [profile.id]: {
                                    ...prev[profile.id]!,
                                    projectDir: event.target.value,
                                  },
                                }))
                              }
                            />
                          </div>
                        )}
                        <div className="form-field">
                          <label className="label" htmlFor={`pb-pkg-out-${profile.id}`}>
                            Out dir (absolute)
                          </label>
                          <input
                            id={`pb-pkg-out-${profile.id}`}
                            className="field"
                            type="text"
                            value={packState.outDir}
                            disabled={packState.busy}
                            placeholder="/home/me/projects/foo/dist-deploy"
                            onChange={(event) =>
                              setPackageState((prev) => ({
                                ...prev,
                                [profile.id]: {
                                  ...prev[profile.id]!,
                                  outDir: event.target.value,
                                },
                              }))
                            }
                          />
                        </div>
                        <div className="form-actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={packState.busy}
                            onClick={() => void handlePackage(profile)}
                          >
                            {packState.busy ? 'Packaging…' : 'Build bundle'}
                          </button>
                        </div>
                        {packState.error ? (
                          <p className="form-error" role="alert">
                            {packState.error}
                          </p>
                        ) : null}
                        {packState.result ? (
                          <div className="pb-pkg-result">
                            <p className="sub-panel-copy">
                              Bundled into{' '}
                              <span className="pb-path">{packState.result.outDir}</span>. Live
                              ship is environment-gated — nothing was pushed to {profile.host}.
                            </p>
                            <ul className="pb-file-list" aria-label="Bundled files">
                              {packState.result.files.map((file) => (
                                <li key={file} className="pb-path">
                                  {file}
                                </li>
                              ))}
                            </ul>
                            <h4 className="pb-fields-title">Dockerfile</h4>
                            <pre className="pb-pre">{truncatedPreview(packState.result.dockerfile)}</pre>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="deploy-add-col">
          <h2 className="pb-list-title">Add profile</h2>
          <form className="form-stack" onSubmit={(event) => void handleAdd(event)}>
            <div className="form-field">
              <label className="label" htmlFor="dp-name">
                Name
              </label>
              <input
                id="dp-name"
                className="field"
                type="text"
                value={name}
                placeholder="prod"
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
              />
              {formErrors.name ? (
                <p className="form-error" role="alert">
                  {formErrors.name}
                </p>
              ) : null}
            </div>
            <div className="form-field">
              <label className="label" htmlFor="dp-host">
                Host
              </label>
              <input
                id="dp-host"
                className="field"
                type="text"
                value={host}
                placeholder="enter.ne1.dev"
                disabled={saving}
                onChange={(event) => setHost(event.target.value)}
              />
              {formErrors.host ? (
                <p className="form-error" role="alert">
                  {formErrors.host}
                </p>
              ) : null}
            </div>
            <div className="form-row">
              <div className="form-field">
                <label className="label" htmlFor="dp-user">
                  Username
                </label>
                <input
                  id="dp-user"
                  className="field"
                  type="text"
                  value={username}
                  placeholder="root"
                  disabled={saving}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>
              <div className="form-field">
                <label className="label" htmlFor="dp-port">
                  Port
                </label>
                <input
                  id="dp-port"
                  className="field"
                  type="text"
                  inputMode="numeric"
                  value={port}
                  placeholder="22"
                  disabled={saving}
                  onChange={(event) => setPort(event.target.value)}
                />
                {formErrors.port ? (
                  <p className="form-error" role="alert">
                    {formErrors.port}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="form-field">
              <label className="label" htmlFor="dp-basedir">
                Remote base dir
              </label>
              <input
                id="dp-basedir"
                className="field"
                type="text"
                value={baseDir}
                placeholder="/opt/apps (optional)"
                disabled={saving}
                onChange={(event) => setBaseDir(event.target.value)}
              />
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Add profile'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Playbooks view shell
// ---------------------------------------------------------------------------

/**
 * M9 Playbooks view (tenth tab): the registry + Run panel and the Deploy
 * targets panel behind two text segments (both stay mounted; open package
 * forms and transcripts survive a flip).
 */
export default function PlaybooksView({
  personas,
  conversations,
  onUnpair,
  active,
}: PlaybooksViewProps) {
  const [segment, setSegment] = useState<Segment>('run');
  const runActive = active === true && segment === 'run';
  const deployActive = active === true && segment === 'deploy';

  return (
    <section className="playbooks" aria-label="Playbooks">
      <div className="playbooks-panel">
        <h1 className="playbooks-title">Playbooks</h1>
        <p className="playbooks-intro">
          Personas as doers: named flows that orchestrate the broker into capabilities —
          research, vibe-code, docgen, email drafts, presentations, analysis, design
          prototypes and ship. Runs stream here with loop and tool markers; persona tool
          approvals land in the Files queue.
        </p>
        <div className="seg-tabs" role="group" aria-label="Playbooks segments">
          <button
            type="button"
            className="btn"
            aria-pressed={segment === 'run'}
            onClick={() => setSegment('run')}
          >
            Playbooks
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={segment === 'deploy'}
            onClick={() => setSegment('deploy')}
          >
            Deploy targets
          </button>
        </div>
        <div className={runActive ? 'pb-seg pb-seg-active' : 'pb-seg'}>
          <RunSegment
            personas={personas}
            conversations={conversations}
            onUnpair={onUnpair}
            active={runActive}
          />
        </div>
        <div className={deployActive ? 'pb-seg pb-seg-active' : 'pb-seg'}>
          <DeploySegment onUnpair={onUnpair} active={deployActive} />
        </div>
      </div>
    </section>
  );
}
