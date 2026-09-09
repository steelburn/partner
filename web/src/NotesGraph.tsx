/**
 * M16 F1 notes graph (PLAN-M16.md) — React Flow canvas over the note
 * relationship graph. Edge direction = who references whom (referencing note
 * → referenced note); mutual references render as ONE bidirectional edge.
 * Nodes open on double-click, drag positions persist, Auto-arrange runs the
 * deterministic layered layout, and node selection feeds the brainstorm flow.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { NoteGraph, NoteGraphNode } from '@partner/shared';
import { isSessionLost } from './lib/personas.js';
import { fetchNoteGraph, saveGraphPositions } from './lib/notes.js';
import { layOutGraph } from './lib/graph-layout.js';
import { readStoredToken } from './lib/token.js';
import { clampText } from './lib/memory-helpers.js';

export interface NotesGraphProps {
  /** True while the segment is visible (loads on first activation). */
  active: boolean;
  /** Bump to reload (after note edits elsewhere). */
  reloadTick: number;
  /** Open a note in the editor (double-click a node / single open action). */
  onOpenNote: (id: string) => void;
  /** Run a brainstorm over the currently selected note ids. */
  onBrainstorm: (noteIds: string[], title?: string) => void;
  /** Forget the session and return to the pairing gate. */
  onUnpair: () => void;
}

interface GraphNodeData {
  title: string;
  isDaily: boolean;
  tags: string[];
  // React Flow requires node data to be a record; extra keys are harmless.
  [key: string]: unknown;
}

interface FlowEdgeData {
  bidirectional: boolean;
  [key: string]: unknown;
}

type FlowNode = Node<GraphNodeData>;
type FlowEdge = Edge<FlowEdgeData>;

function toFlow(graph: NoteGraph, layout: Map<string, { x: number; y: number }>): {
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  const nodes: FlowNode[] = graph.nodes.map((row) => {
    const at = layout.get(row.id);
    return {
      id: row.id,
      position: { x: at?.x ?? 0, y: at?.y ?? 0 },
      data: { title: row.title, isDaily: row.isDaily, tags: row.tags },
    };
  });
  const edges: FlowEdge[] = graph.edges.map((edge) => {
    const edgeColor = 'var(--n-graph-edge)';
    const arrow = {
      type: MarkerType.ArrowClosed,
      width: 16,
      height: 16,
      color: edgeColor,
    };
    return {
      id: `e:${edge.source}:${edge.target}`,
      source: edge.source,
      target: edge.target,
      data: { bidirectional: edge.bidirectional },
      markerEnd: arrow,
      ...(edge.bidirectional ? { markerStart: arrow } : {}),
      style: { stroke: edgeColor },
    };
  });
  return { nodes, edges };
}

function GraphNodeView({ data }: { data: GraphNodeData }): React.JSX.Element {
  return (
    <div className="n-graph-node" title={data.title}>
      <span className="n-graph-node-title">{clampText(data.title, 46)}</span>
      {data.isDaily ? <span className="n-graph-node-daily">Daily</span> : null}
    </div>
  );
}

const nodeTypes: NodeTypes = { note: GraphNodeView };

function NotesGraphInner({
  active,
  reloadTick,
  onOpenNote,
  onBrainstorm,
  onUnpair,
}: NotesGraphProps): React.JSX.Element {
  const [graph, setGraph] = useState<NoteGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [persistBusy, setPersistBusy] = useState(false);

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

  const selectedList = useMemo(() => [...selected], [selected]);

  return (
    <div className="n-graph" aria-label="Notes relationship graph">
      <div className="n-graph-toolbar">
        <span className="n-graph-hint">
          Edges point at the note being referenced — double arrows mean the notes link each other.
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
          onClick={() => void onBrainstorm(selectedList)}
        >
          Brainstorm ({selectedList.length})
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
          <div className="n-graph-canvas">
            <ReactFlow<FlowNode, FlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onNodeDragStop={onNodeDragStop}
              nodesDraggable
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
            Double-click a node to open the note. Click to select; selected notes feed
            Brainstorm. Daily notes are marked.
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
