/**
 * M16 F1 notes graph (PLAN-M16.md) + M17 project scoping (PLAN-M17).
 *
 * React Flow canvas over the note relationship graph. Edge direction = who
 * references whom (referencing note → referenced note); mutual references
 * render as ONE bidirectional edge. Nodes open on double-click, drag
 * positions persist, Auto-arrange runs the deterministic layered layout, node
 * selection feeds the brainstorm flow, and dragging a connector between two
 * nodes writes a wiki-link into the source note (the graph's edges ARE note
 * links — see note-relate.ts).
 *
 * M17: the canvas can be scoped to a project subtree (or Inbox). A scoped
 * read returns the in-scope subgraph plus one-hop `externalNodes` — notes in
 * other projects linked to/from an in-scope note. Those render dimmed as
 * "ghosts" (never persisted, never draggable-to-save) behind a client toggle.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  BrainstormSessionSummary,
  Folder,
  NoteGraph,
  NoteGraphEdge,
  NoteGraphNode,
} from '@partner/shared';
import { isSessionLost } from './lib/personas.js';
import {
  concludeBrainstorm,
  fetchNoteGraph,
  getNote,
  listNotes,
  reopenBrainstorm,
  saveGraphPositions,
  updateNote,
} from './lib/notes.js';
import { layOutGraph } from './lib/graph-layout.js';
import {
  appendWikiLink,
  hasWikiLink,
  isLinkedAlready,
  isLinkableTitle,
} from './lib/note-relate.js';
import { folderTreeRows, scopeLabel, type NotesScope } from './lib/note-helpers.js';
import { readStoredToken } from './lib/token.js';
import { clampText } from './lib/memory-helpers.js';
import { timeAgo } from './lib/persona-helpers.js';

export interface NotesGraphProps {
  /** True while the segment is visible (loads on first activation). */
  active: boolean;
  /** Bump to reload (after note edits elsewhere). */
  reloadTick: number;
  /** Open a note in the editor (double-click a node / single open action). */
  onOpenNote: (id: string) => void;
  /** Run (or reopen) a brainstorm over the currently selected note ids. */
  onBrainstorm: (noteIds: string[], title?: string) => void;
  /** Open an existing brainstorm conversation (linked-session row). */
  onOpenConversation?: (conversationId: string) => void;
  /** Forget the session and return to the pairing gate. */
  onUnpair: () => void;
  /** A connector drag wrote into a note — refresh the notes list/editor. */
  onNoteMutated?: () => void;
  /** M17: the shared Projects/Folders tree. */
  folders?: readonly Folder[];
  /** M17: active project scope (defaults to all notes). */
  scope?: NotesScope;
  /** M17: change the active project scope. */
  onScopeChange?: (scope: NotesScope) => void;
  /** M17: create a project from the graph selector. */
  onCreateProject?: (name: string) => Promise<void> | void;
}

/** Deterministic note-set identity — mirrors core brainstormSetKey. */
function noteSetKey(noteIds: readonly string[]): string {
  return [...new Set(noteIds)].sort().join('\u0000');
}

/** Per-node brainstorm badge state (count + whether every path is concluded). */
interface NodeBrainstormInfo {
  count: number;
  concluded: boolean;
}

interface GraphNodeData {
  title: string;
  isDaily: boolean;
  tags: string[];
  /** M17: project names this note belongs to (ghosts show their own). */
  folderNames: string[];
  /** M17: true for a dimmed ghost outside the active scope. */
  external: boolean;
  brainstormCount: number;
  brainstormsConcluded: boolean;
  // React Flow requires node data to be a record; extra keys are harmless.
  [key: string]: unknown;
}

interface FlowEdgeData {
  bidirectional: boolean;
  [key: string]: unknown;
}

type FlowNode = Node<GraphNodeData>;
type FlowEdge = Edge<FlowEdgeData>;

/** note id → linked brainstorm badge state (M16 follow-up linkage). */
function brainstormInfoByNote(
  brainstorms: readonly BrainstormSessionSummary[],
): Map<string, NodeBrainstormInfo> {
  const byNote = new Map<string, NodeBrainstormInfo>();
  for (const session of brainstorms) {
    for (const noteId of session.noteIds) {
      const current = byNote.get(noteId) ?? { count: 0, concluded: true };
      current.count += 1;
      if (!session.concluded) current.concluded = false;
      byNote.set(noteId, current);
    }
  }
  return byNote;
}

/** One edge recipe for both the graph load and an optimistically drawn
 *  connector, so a fresh drag looks identical to the persisted edge. */
const EDGE_ARROW = {
  type: MarkerType.ArrowClosed,
  width: 16,
  height: 16,
  color: 'var(--n-graph-edge)',
};

function flowEdge(source: string, target: string, bidirectional: boolean): FlowEdge {
  return {
    id: `e:${source}:${target}`,
    source,
    target,
    data: { bidirectional },
    markerEnd: EDGE_ARROW,
    ...(bidirectional ? { markerStart: EDGE_ARROW } : {}),
    style: { stroke: 'var(--n-graph-edge)' },
  };
}

function toFlow(
  graph: NoteGraph,
  layout: Map<string, { x: number; y: number }>,
  nodes: readonly NoteGraphNode[],
  edges: readonly NoteGraphEdge[],
  folderNamesById: Map<string, string[]>,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const info = brainstormInfoByNote(graph.brainstorms ?? []);
  const flowNodes: FlowNode[] = nodes.map((row) => {
    const at = layout.get(row.id);
    const badge = info.get(row.id);
    return {
      id: row.id,
      // The 'note' type selects GraphNodeView below — without it React Flow
      // falls back to its unstyled default node (empty box, no title).
      type: 'note',
      position: { x: at?.x ?? 0, y: at?.y ?? 0 },
      data: {
        title: row.title,
        isDaily: row.isDaily,
        tags: row.tags,
        folderNames: folderNamesById.get(row.id) ?? [],
        external: row.external === true,
        brainstormCount: badge?.count ?? 0,
        brainstormsConcluded: badge?.concluded ?? false,
      },
    };
  });
  const flowEdges: FlowEdge[] = edges.map((edge) =>
    flowEdge(edge.source, edge.target, edge.bidirectional),
  );
  return { nodes: flowNodes, edges: flowEdges };
}

function GraphNodeView({ data }: { data: GraphNodeData }): React.JSX.Element {
  return (
    <div
      className={data.external ? 'n-graph-node n-graph-node-external' : 'n-graph-node'}
      title={data.title}
    >
      {/* Layout ranks left→right with the referencing note before its
       * targets, so each note exposes its outgoing side (Right) and its
       * incoming side (Left). React Flow only draws edges between nodes
       * that declare Handles — without them the edges silently vanish. */}
      <Handle type="target" position={Position.Left} className="n-graph-handle" />
      <span className="n-graph-node-title">{clampText(data.title, 46)}</span>
      {data.external ? <span className="n-graph-node-badge">Other project</span> : null}
      {data.isDaily ? <span className="n-graph-node-daily">Daily</span> : null}
      {data.folderNames.length > 0 ? (
        <span className="n-graph-node-folders">
          {data.folderNames.slice(0, 2).map((name) => (
            <span key={name} className="n-graph-node-folder">
              {clampText(name, 18)}
            </span>
          ))}
        </span>
      ) : null}
      {data.brainstormCount > 0 ? (
        <span
          className={
            data.brainstormsConcluded
              ? 'n-graph-node-brainstorm is-concluded'
              : 'n-graph-node-brainstorm'
          }
          title={
            data.brainstormsConcluded
              ? `${data.brainstormCount} concluded brainstorm${data.brainstormCount === 1 ? '' : 's'}`
              : `${data.brainstormCount} brainstorm${data.brainstormCount === 1 ? '' : 's'} linked to this note`
          }
        >
          Brainstorm {data.brainstormCount}
        </span>
      ) : null}
      <Handle type="source" position={Position.Right} className="n-graph-handle" />
    </div>
  );
}

const nodeTypes: NodeTypes = { note: GraphNodeView };

/** M17: scope -> /v1/notes/graph query params. */
function graphScopeFilter(scope: NotesScope): { folderId?: string; unfiled?: boolean } {
  if (scope.kind === 'inbox') return { unfiled: true };
  if (scope.kind === 'folder') return { folderId: scope.folderId };
  return {};
}

function NotesGraphInner({
  active,
  reloadTick,
  onOpenNote,
  onBrainstorm,
  onOpenConversation,
  onUnpair,
  onNoteMutated,
  folders,
  scope,
  onScopeChange,
  onCreateProject,
}: NotesGraphProps): React.JSX.Element {
  const [graph, setGraph] = useState<NoteGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [persistBusy, setPersistBusy] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // M16 follow-up: connector drags (link write busy/notice/error).
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  // M17: external (ghost) toggle, the "Link to note…" picker, and the inline
  // new-project composer.
  const [showExternal, setShowExternal] = useState(true);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [allTitles, setAllTitles] = useState<string[] | null>(null);
  const [linkQuery, setLinkQuery] = useState('');
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectBusy, setNewProjectBusy] = useState(false);

  const effectiveScope: NotesScope = scope ?? { kind: 'all' };
  const scopeKind = effectiveScope.kind;
  const scopeFolderId = effectiveScope.kind === 'folder' ? effectiveScope.folderId : '';
  const allFolders = folders ?? [];
  const treeRows = useMemo(() => folderTreeRows(allFolders), [allFolders]);
  const folderNameById = useMemo(
    () => new Map(allFolders.map((folder) => [folder.id, folder.name])),
    [allFolders],
  );

  const inScopeNodes = graph?.nodes ?? [];
  const externalNodes = useMemo(() => graph?.externalNodes ?? [], [graph]);
  const visibleNodes = useMemo(
    () => (showExternal ? [...inScopeNodes, ...externalNodes] : [...inScopeNodes]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, showExternal],
  );
  const externalIds = useMemo(() => new Set(externalNodes.map((row) => row.id)), [externalNodes]);
  const nodeById = useMemo(
    () => new Map(visibleNodes.map((row) => [row.id, row])),
    [visibleNodes],
  );
  const inScopeIds = useMemo(() => new Set(inScopeNodes.map((row) => row.id)), [inScopeNodes]);
  // Ghost nodes show the project(s) that own them; unfiled reads as Inbox.
  const folderNamesById = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const row of visibleNodes) {
      const ids = row.folderIds ?? [];
      const names = ids.map((id) => folderNameById.get(id) ?? '').filter((name) => name !== '');
      map.set(row.id, names.length > 0 ? names : ['Inbox']);
    }
    return map;
  }, [visibleNodes, folderNameById]);

  const load = useCallback(async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    try {
      const fetched = await fetchNoteGraph(token, graphScopeFilter(effectiveScope));
      setGraph(fetched);
      setError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not load the notes graph.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onUnpair, scopeKind, scopeFolderId]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load, reloadTick]);

  const persistPositions = async (
    positions: Array<{ noteId: string; x: number; y: number }>,
  ): Promise<void> => {
    if (positions.length === 0 || persistBusy) return;
    const token = readStoredToken();
    if (!token) return;
    setPersistBusy(true);
    try {
      await saveGraphPositions(token, positions);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      // Non-fatal: the canvas still shows the drag; it just won't persist.
    } finally {
      setPersistBusy(false);
    }
  };

  // (Re)build the flow when the graph arrives, the ghost toggle changes, or
  // the user auto-arranges. Only non-external positions ever persist.
  const arrange = useCallback(
    (preserve: boolean): void => {
      if (graph === null) return;
      const visibleIds = new Set(visibleNodes.map((row) => row.id));
      const visibleEdges = graph.edges.filter(
        (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
      );
      const layout = layOutGraph(visibleNodes, visibleEdges).reduce(
        (map, entry) => {
          map.set(entry.id, { x: entry.x, y: entry.y });
          return map;
        },
        new Map<string, { x: number; y: number }>(),
      );
      const flow = toFlow(graph, layout, visibleNodes, visibleEdges, folderNamesById);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      if (preserve) return;
      // Auto-arrange: persist the freshly computed positions (drop old ones),
      // skipping ghosts (their positions are display-only).
      const positions = visibleNodes.flatMap((row) => {
        if (externalIds.has(row.id)) return [];
        const at = layout.get(row.id);
        return at === undefined
          ? []
          : [{ noteId: row.id, x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10 }];
      });
      void persistPositions(positions);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, visibleNodes, externalIds, folderNamesById],
  );

  useEffect(() => {
    if (graph !== null) arrange(true);
  }, [graph, arrange]);

  const toggleSelect = useCallback((id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => toggleSelect(node.id),
    [toggleSelect],
  );
  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_event, node) => onOpenNote(node.id),
    [onOpenNote],
  );
  const onNodeDragStop = useCallback(
    (_event: unknown, node: FlowNode, _nodes: FlowNode[]) => {
      // M17: ghosts are display-only — never persist their position.
      if (externalIds.has(node.id)) return;
      void persistPositions([
        {
          noteId: node.id,
          x: Math.round(node.position.x * 10) / 10,
          y: Math.round(node.position.y * 10) / 10,
        },
      ]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [externalIds],
  );

  // -------------------------------------------------------------------------
  // Connector drags: an edge is a wiki-link, so the write lands in the note
  // the drag started from (source = referencing note, matching the arrows).
  // -------------------------------------------------------------------------

  /** Write `[[target title]]` into the source note, then refresh from core. */
  const linkNotes = useCallback(
    async (sourceId: string, sourceTitle: string, targetTitle: string): Promise<void> => {
      const token = readStoredToken();
      if (!token) {
        onUnpair();
        return;
      }
      const shortSource = clampText(sourceTitle, 40);
      const shortTarget = clampText(targetTitle, 40);
      setLinkBusy(true);
      setLinkError(null);
      setLinkNotice(null);
      let sessionLost = false;
      try {
        // Read the live body first: the canvas never carries note content.
        const source = await getNote(token, sourceId);
        if (hasWikiLink(source.content, targetTitle)) {
          setLinkNotice(`“${shortSource}” already links “${shortTarget}”.`);
        } else {
          await updateNote(token, sourceId, {
            title: source.title,
            content: appendWikiLink(source.content, targetTitle),
            tags: source.tags,
            isDaily: source.isDaily,
          });
          setLinkNotice(
            `Linked “${shortSource}” → “${shortTarget}” — a [[link]] was added to “${shortSource}”.`,
          );
        }
      } catch (cause) {
        if (isSessionLost(cause)) {
          sessionLost = true;
          onUnpair();
        } else {
          setLinkError(cause instanceof Error ? cause.message : 'Could not link the notes.');
        }
      } finally {
        setLinkBusy(false);
      }
      if (sessionLost) return;
      // Refresh either way: it draws the persisted edge, or reverts the
      // optimistic one when the write failed.
      if (onNoteMutated !== undefined) onNoteMutated();
      else await load();
    },
    [load, onNoteMutated, onUnpair],
  );

  /** Refuse self-loops, unknown nodes, unlinkable titles and existing edges. */
  const isValidConnection = useCallback(
    (connection: FlowEdge | Connection): boolean => {
      if (graph === null) return false;
      const sourceId = connection.source;
      const targetId = connection.target;
      if (sourceId === null || targetId === null || sourceId === targetId) return false;
      if (!nodeById.has(sourceId)) return false;
      const target = nodeById.get(targetId);
      if (target === undefined) return false;
      return isLinkableTitle(target.title) && !isLinkedAlready(graph.edges, sourceId, targetId);
    },
    [graph, nodeById],
  );

  const onConnect = useCallback(
    (connection: Connection): void => {
      if (graph === null || linkBusy) return;
      const sourceId = connection.source;
      const targetId = connection.target;
      if (sourceId === null || targetId === null || sourceId === targetId) return;
      const source = nodeById.get(sourceId);
      const target = nodeById.get(targetId);
      if (source === undefined || target === undefined) return;
      if (!isLinkableTitle(target.title)) {
        setLinkError(
          `“${clampText(target.title, 40)}” can’t be linked — its title contains “]”. Rename it first.`,
        );
        return;
      }
      if (isLinkedAlready(graph.edges, sourceId, targetId)) {
        setLinkNotice(
          `“${clampText(source.title, 40)}” already links “${clampText(target.title, 40)}”.`,
        );
        return;
      }
      // Draw immediately; the reload below replaces it with core's truth.
      setEdges((current) => addEdge(flowEdge(source.id, target.id, false), current));
      void linkNotes(source.id, source.title, target.title);
    },
    [graph, linkBusy, linkNotes, nodeById, setEdges],
  );

  const selectedList = useMemo(() => [...selected], [selected]);
  const brainstorms = useMemo(() => graph?.brainstorms ?? [], [graph]);

  // M17: the "Link to note…" picker targets exactly ONE in-scope note (a
  // ghost source is fine too, but the primary flow is in-scope -> ghost).
  const selectedInScope = useMemo(
    () => selectedList.filter((id) => inScopeIds.has(id)),
    [selectedList, inScopeIds],
  );

  // M16 follow-up: an ACTIVE session for exactly this selection reopens in
  // place; a concluded one never blocks a fresh brainstorm.
  const matchingActive = useMemo(() => {
    if (selectedList.length === 0) return null;
    const key = noteSetKey(selectedList);
    return (
      brainstorms.find((session) => !session.concluded && noteSetKey(session.noteIds) === key) ?? null
    );
  }, [brainstorms, selectedList]);

  // Sessions linked to the one selected note (newest first, as served).
  const selectedSessions = useMemo(() => {
    if (selectedList.length !== 1) return [];
    const noteId = selectedList[0];
    return brainstorms.filter((session) => session.noteIds.includes(noteId));
  }, [brainstorms, selectedList]);

  const flipSession = async (
    conversationId: string,
    action: 'conclude' | 'reopen',
  ): Promise<void> => {
    if (sessionBusy) return;
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    setSessionBusy(true);
    setSessionError(null);
    try {
      if (action === 'conclude') await concludeBrainstorm(token, conversationId);
      else await reopenBrainstorm(token, conversationId);
      await load();
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setSessionError(
        cause instanceof Error ? cause.message : 'Could not update the brainstorm.',
      );
    } finally {
      setSessionBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // M17 "Link to note…" picker: load every note title, filter as you type,
  // then write the chosen [[Title]] into the selected source note.
  // -------------------------------------------------------------------------

  const openLinkPicker = async (): Promise<void> => {
    setLinkPickerOpen((open) => !open);
    setLinkQuery('');
    setLinkError(null);
    if (allTitles !== null) return;
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    try {
      const list = await listNotes(token);
      setAllTitles(list.map((row) => row.title));
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setAllTitles([]);
      setLinkError(cause instanceof Error ? cause.message : 'Could not load note titles.');
    }
  };

  const filteredTitles = useMemo(() => {
    if (allTitles === null) return [];
    const query = linkQuery.trim().toLocaleLowerCase();
    const sourceId = selectedInScope.length === 1 ? selectedInScope[0] : null;
    const source = sourceId !== null ? nodeById.get(sourceId) : undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const title of allTitles) {
      if (source !== undefined && title === source.title) continue;
      if (query !== '' && !title.toLocaleLowerCase().includes(query)) continue;
      const key = title.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(title);
      if (out.length >= 12) break;
    }
    return out;
  }, [allTitles, linkQuery, selectedInScope, nodeById]);

  const linkToTitle = (title: string): void => {
    const sourceId = selectedInScope.length === 1 ? selectedInScope[0] : null;
    if (sourceId === null) return;
    const source = nodeById.get(sourceId);
    if (source === undefined) return;
    setLinkPickerOpen(false);
    setLinkQuery('');
    void linkNotes(source.id, source.title, title);
  };

  const scopeSelectValue =
    effectiveScope.kind === 'folder' ? `folder:${effectiveScope.folderId}` : effectiveScope.kind;

  const changeScope = (value: string): void => {
    if (onScopeChange === undefined) return;
    if (value === 'all') onScopeChange({ kind: 'all' });
    else if (value === 'inbox') onScopeChange({ kind: 'inbox' });
    else if (value.startsWith('folder:')) {
      onScopeChange({ kind: 'folder', folderId: value.slice('folder:'.length) });
    }
  };

  const createProject = async (): Promise<void> => {
    const name = newProjectName.trim();
    if (name.length === 0 || newProjectBusy || onCreateProject === undefined) return;
    setNewProjectBusy(true);
    try {
      await onCreateProject(name);
      setNewProjectName('');
      setNewProjectOpen(false);
    } finally {
      setNewProjectBusy(false);
    }
  };

  return (
    <div className="n-graph" aria-label="Notes relationship graph">
      <div className="n-graph-scope" aria-label="Project scope">
        <label className="label n-scope-label" htmlFor="n-graph-scope">
          Project
        </label>
        <select
          id="n-graph-scope"
          className="field n-scope-select"
          value={scopeSelectValue}
          onChange={(event) => changeScope(event.target.value)}
          disabled={onScopeChange === undefined}
          aria-label={`Graph project scope — now ${scopeLabel(effectiveScope, allFolders)}`}
        >
          <option value="all">All notes</option>
          <option value="inbox">Inbox</option>
          {treeRows.map(({ folder, depth }) => (
            <option key={folder.id} value={`folder:${folder.id}`}>
              {`${'— '.repeat(depth)}${folder.name}`}
            </option>
          ))}
        </select>
        <label className="n-graph-toggle">
          <input
            type="checkbox"
            checked={showExternal}
            onChange={(event) => setShowExternal(event.target.checked)}
          />
          Show notes from other projects
        </label>
        {onCreateProject !== undefined ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setNewProjectOpen((open) => !open);
              setNewProjectName('');
            }}
            aria-expanded={newProjectOpen}
          >
            {newProjectOpen ? 'Cancel project' : 'New project'}
          </button>
        ) : null}
      </div>
      {newProjectOpen && onCreateProject !== undefined ? (
        <form
          className="n-scope-new"
          onSubmit={(event) => {
            event.preventDefault();
            void createProject();
          }}
        >
          <input
            className="field"
            type="text"
            value={newProjectName}
            disabled={newProjectBusy}
            onChange={(event) => setNewProjectName(event.target.value)}
            placeholder="Project name"
            aria-label="New project name"
            spellCheck={false}
          />
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={newProjectBusy || newProjectName.trim().length === 0}
            aria-busy={newProjectBusy}
          >
            {newProjectBusy ? 'Creating…' : 'Create project'}
          </button>
        </form>
      ) : null}
      <div className="n-graph-toolbar">
        <span className="n-graph-hint">
          Drag from a note’s right dot to another note’s left dot to link them — the link is
          written into the note you dragged from. Double arrows mean the notes link each other.
          Dimmed notes belong to other projects.
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => arrange(false)}
          disabled={graph === null}
        >
          Auto-arrange
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            const single = selectedList.length === 1 ? selectedList[0] : null;
            if (single !== null) {
              const node = nodeById.get(single);
              if (node) void onOpenNote(node.id);
            }
          }}
          disabled={selectedList.length !== 1}
        >
          Open selected
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void openLinkPicker()}
          disabled={selectedInScope.length !== 1 || linkBusy}
          aria-expanded={linkPickerOpen}
          title={
            selectedInScope.length === 1
              ? 'Write a [[link]] from the selected note to another note'
              : 'Select exactly one note in this project to link it'
          }
        >
          Link to note…
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={selectedList.length === 0}
          onClick={() => {
            if (matchingActive !== null) onOpenConversation?.(matchingActive.conversationId);
            else void onBrainstorm(selectedList);
          }}
          title={
            matchingActive !== null
              ? 'Open the existing brainstorm for this selection'
              : 'Start a brainstorm over the selected notes'
          }
        >
          {matchingActive !== null
            ? `Open brainstorm (${selectedList.length})`
            : `Brainstorm (${selectedList.length})`}
        </button>
        {selectedList.length > 0 ? (
          <button
            type="button"
            className="btn-link btn-sm"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
        ) : null}
      </div>
      {linkPickerOpen ? (
        <div className="n-link-picker" role="dialog" aria-label="Link to a note">
          <input
            className="field n-link-picker-input"
            type="search"
            value={linkQuery}
            autoFocus
            placeholder="Search note titles…"
            aria-label="Search note titles to link"
            onChange={(event) => setLinkQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setLinkPickerOpen(false);
                setLinkQuery('');
              } else if (event.key === 'Enter' && filteredTitles.length > 0) {
                event.preventDefault();
                linkToTitle(filteredTitles[0] as string);
              }
            }}
          />
          {allTitles === null ? (
            <p className="n-muted-line" aria-busy="true">
              Loading note titles…
            </p>
          ) : filteredTitles.length === 0 ? (
            <p className="n-muted-line">No matching notes.</p>
          ) : (
            <ul className="n-link-picker-list" role="listbox" aria-label="Matching notes">
              {filteredTitles.map((title) => (
                <li key={title}>
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    className="n-link-picker-item"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      linkToTitle(title);
                    }}
                  >
                    <span className="wiki-suggest-brackets">[[</span>
                    {title}
                    <span className="wiki-suggest-brackets">]]</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {selectedList.length === 1 && selectedSessions.length > 0 ? (
        <div className="n-graph-sessions" aria-label="Brainstorms linked to this note">
          <div className="n-graph-sessions-head">
            <span className="n-graph-sessions-title">Linked brainstorms</span>
            <span className="n-graph-sessions-count chip">{selectedSessions.length}</span>
          </div>
          <ul className="n-graph-session-list">
            {selectedSessions.map((session) => (
              <li key={session.conversationId} className="n-graph-session">
                <span className="n-graph-session-main">
                  <span className="n-graph-session-name">
                    {session.title ?? 'Brainstorm'}
                  </span>
                  <span className="n-graph-session-meta">
                    {session.concluded ? 'Concluded' : 'Active'} · {timeAgo(session.updatedAt)}
                  </span>
                </span>
                <span className="n-graph-session-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => onOpenConversation?.(session.conversationId)}
                    disabled={onOpenConversation === undefined}
                    aria-label={`Open brainstorm ${session.title ?? ''}`.trim()}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={sessionBusy}
                    aria-busy={sessionBusy}
                    onClick={() =>
                      void flipSession(
                        session.conversationId,
                        session.concluded ? 'reopen' : 'conclude',
                      )
                    }
                    aria-label={`${session.concluded ? 'Reopen' : 'Conclude'} brainstorm ${
                      session.title ?? ''
                    }`.trim()}
                  >
                    {session.concluded ? 'Reopen' : 'Conclude'}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {sessionError !== null ? (
            <p className="row-error" role="alert">
              {sessionError}
            </p>
          ) : null}
        </div>
      ) : null}
      {linkNotice !== null ? (
        <p className="n-graph-notice" role="status">
          {linkNotice}
        </p>
      ) : null}
      {linkError !== null ? (
        <p className="row-error" role="alert">
          {linkError}
        </p>
      ) : null}
      {error !== null ? (
        <p className="row-error" role="alert">
          {error}
        </p>
      ) : graph === null ? (
        <p className="n-muted-line" aria-busy="true">
          Loading graph…
        </p>
      ) : (
        <>
          <div className="n-graph-canvas" aria-busy={linkBusy}>
            <ReactFlow<FlowNode, FlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onNodeDragStop={onNodeDragStop}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              nodesDraggable
              nodesConnectable={!linkBusy}
              edgesReconnectable={false}
              deleteKeyCode={null}
              fitView
              minZoom={0.2}
              maxZoom={2.5}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          <p className="n-graph-foot">
            Double-click a node to open the note. Drag between nodes to add a [[link]] to the
            source note — edges here are your notes&apos; wiki-links, so remove one by editing that
            link out of the note. Click to select; selected notes feed Brainstorm. A linked
            brainstorm reopens on the same selection until it is concluded. Daily notes are
            marked; dimmed “other project” notes are one hop outside the active project and
            never move your saved layout.
          </p>
        </>
      )}
    </div>
  );
}

/** M16 F1 wrapper: ReactFlowProvider keeps hook context valid. */
export default function NotesGraph(props: NotesGraphProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <NotesGraphInner {...props} />
    </ReactFlowProvider>
  );
}

// Marker arrow colour rides the token (declared in app.css alongside the
// graph classes). Type re-export for tests that build nodes/edges.
export type { FlowEdge, FlowNode, NoteGraphNode };
