/**
 * M16 F1 notes graph (PLAN-M16.md) — React Flow canvas over the note
 * relationship graph. Edge direction = who references whom (referencing note
 * → referenced note); mutual references render as ONE bidirectional edge.
 * Nodes open on double-click, drag positions persist, Auto-arrange runs the
 * deterministic layered layout, node selection feeds the brainstorm flow,
 * and dragging a connector between two nodes writes a wiki-link into the
 * source note (the graph's edges ARE note links — see note-relate.ts).
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
import type { BrainstormSessionSummary, NoteGraph, NoteGraphNode } from '@partner/shared';
import { isSessionLost } from './lib/personas.js';
import {
  concludeBrainstorm,
  fetchNoteGraph,
  getNote,
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

function toFlow(graph: NoteGraph, layout: Map<string, { x: number; y: number }>): {
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  const info = brainstormInfoByNote(graph.brainstorms ?? []);
  const nodes: FlowNode[] = graph.nodes.map((row) => {
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
        brainstormCount: badge?.count ?? 0,
        brainstormsConcluded: badge?.concluded ?? false,
      },
    };
  });
  const edges: FlowEdge[] = graph.edges.map((edge) =>
    flowEdge(edge.source, edge.target, edge.bidirectional),
  );
  return { nodes, edges };
}

function GraphNodeView({ data }: { data: GraphNodeData }): React.JSX.Element {
  return (
    <div className="n-graph-node" title={data.title}>
      {/* Layout ranks left→right with the referencing note before its
       * targets, so each note exposes its outgoing side (Right) and its
       * incoming side (Left). React Flow only draws edges between nodes
       * that declare Handles — without them the edges silently vanish. */}
      <Handle type="target" position={Position.Left} className="n-graph-handle" />
      <span className="n-graph-node-title">{clampText(data.title, 46)}</span>
      {data.isDaily ? <span className="n-graph-node-daily">Daily</span> : null}
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

function NotesGraphInner({
  active,
  reloadTick,
  onOpenNote,
  onBrainstorm,
  onOpenConversation,
  onUnpair,
  onNoteMutated,
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

  const load = useCallback(async (): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    try {
      const fetched = await fetchNoteGraph(token);
      setGraph(fetched);
      setError(null);
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not load the notes graph.');
    }
  }, [onUnpair]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load, reloadTick]);

  // (Re)build the flow when the graph arrives or the user auto-arranges.
  const arrange = useCallback(
    (preserve: boolean): void => {
      if (graph === null) return;
      const layout = layOutGraph(graph.nodes, graph.edges).reduce(
        (map, entry) => {
          map.set(entry.id, { x: entry.x, y: entry.y });
          return map;
        },
        new Map<string, { x: number; y: number }>(),
      );
      const flow = toFlow(graph, layout);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      if (preserve) return;
      // Auto-arrange: persist the freshly computed positions (drop old ones).
      const positions = graph.nodes.flatMap((row) => {
        const at = layout.get(row.id);
        return at === undefined
          ? []
          : [{ noteId: row.id, x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10 }];
      });
      void persistPositions(positions);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph],
  );

  const persistPositions = async (positions: Array<{ noteId: string; x: number; y: number }>): Promise<void> => {
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

  useEffect(() => {
    if (graph !== null) arrange(true);
  }, [graph, arrange]);

  const toggleSelect = useCallback(
    (id: string): void => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [],
  );

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
      void persistPositions([
        { noteId: node.id, x: Math.round(node.position.x * 10) / 10, y: Math.round(node.position.y * 10) / 10 },
      ]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // -------------------------------------------------------------------------
  // Connector drags: an edge is a wiki-link, so the write lands in the note
  // the drag started from (source = referencing note, matching the arrows).
  // -------------------------------------------------------------------------

  /** Write `[[target title]]` into the source note, then refresh from core. */
  const linkNotes = useCallback(
    async (
      sourceId: string,
      sourceTitle: string,
      targetTitle: string,
    ): Promise<void> => {
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
      if (!graph.nodes.some((row) => row.id === sourceId)) return false;
      const target = graph.nodes.find((row) => row.id === targetId);
      if (target === undefined) return false;
      return isLinkableTitle(target.title) && !isLinkedAlready(graph.edges, sourceId, targetId);
    },
    [graph],
  );

  const onConnect = useCallback(
    (connection: Connection): void => {
      if (graph === null || linkBusy) return;
      const sourceId = connection.source;
      const targetId = connection.target;
      if (sourceId === null || targetId === null || sourceId === targetId) return;
      const source = graph.nodes.find((row) => row.id === sourceId);
      const target = graph.nodes.find((row) => row.id === targetId);
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
    [graph, linkBusy, linkNotes, setEdges],
  );

  const selectedList = useMemo(() => [...selected], [selected]);
  const brainstorms = useMemo(() => graph?.brainstorms ?? [], [graph]);

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

  return (
    <div className="n-graph" aria-label="Notes relationship graph">
      <div className="n-graph-toolbar">
        <span className="n-graph-hint">
          Drag from a note’s right dot to another note’s left dot to link them — the link is
          written into the note you dragged from. Double arrows mean the notes link each other.
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
              const node = graph?.nodes.find((row) => row.id === single);
              if (node) void onOpenNote(node.id);
            }
          }}
          disabled={selectedList.length !== 1}
        >
          Open selected
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
            marked.
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
