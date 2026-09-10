/**
 * M5 notes + plans wire contracts (PLAN-M5.md).
 *
 * Notes: local markdown with wiki-links and tags. Plans: structured
 * goals -> milestones -> tasks (status + optional owner persona). All
 * content stays local to the core and appears in the UI as the user's own
 * data; audit/logs never carry note/plan bodies.
 */

export interface NoteSummary {
  id: string;
  title: string;
  tags: string[];
  isDaily: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Note extends NoteSummary {
  content: string;
}

export interface NoteInput {
  title: string;
  content?: string;
  tags?: string[];
  isDaily?: boolean;
}

export interface NoteLinkInfo {
  /** Target note id when the link resolved; null = dangling. */
  toNoteId: string | null;
  toTitle: string;
}

export interface TagCount {
  tag: string;
  count: number;
}

export type TaskStatus = 'open' | 'done' | 'blocked';

export interface PlanTask {
  id: string;
  title: string;
  status: TaskStatus;
  /** Optional persona that owns this task (stored; execution later). */
  ownerPersonaId?: string;
  /** Optional note explaining a status change. */
  note?: string;
}

export interface PlanMilestone {
  id: string;
  title: string;
  tasks: PlanTask[];
}

export interface PlanDocument {
  milestones: PlanMilestone[];
}

export interface PlanSummary {
  id: string;
  title: string;
  description: string | null;
  /** Total task count / done count for progress displays. */
  taskCount: number;
  doneCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Plan extends PlanSummary {
  document: PlanDocument;
}

export interface PlanInput {
  title: string;
  description?: string;
}

export interface TaskStatusInput {
  status: TaskStatus;
  note?: string;
}

export interface NotesExportBundle {
  schema: 'notes/v1';
  exportedAt: number;
  notes: Note[];
}

// ---------------------------------------------------------------------------
// M16 F1/F2/F3 (PLAN-M16.md) — relationship graph, versions, brainstorm.
// ---------------------------------------------------------------------------

export interface NoteGraphNode {
  id: string;
  title: string;
  tags: string[];
  isDaily: boolean;
  /** Last persisted canvas position (null = never dragged/auto-arranged). */
  x: number | null;
  y: number | null;
}

export interface NoteGraphEdge {
  /** The referencing note. */
  source: string;
  /** The referenced note. */
  target: string;
  /** True when the target also links the source (mutual refs collapse to one
   *  bidirectional edge rendered with arrowheads at both ends). */
  bidirectional: boolean;
}

export interface NoteGraph {
  nodes: NoteGraphNode[];
  edges: NoteGraphEdge[];
  /** Brainstorm sessions linked to the graph's notes (newest first). Each
   *  carries its source note ids so the canvas can badge nodes and resolve
   *  "open the brainstorm for this selection" without a second request. */
  brainstorms?: BrainstormSessionSummary[];
}

export type NoteVersionWriter =
  | 'user'
  | 'capture'
  | 'promote'
  | 'playbook'
  | 'schedule'
  | 'summarize'
  | 'restore'
  | 'brainstorm';

export interface NoteVersionSummary {
  id: string;
  noteId: string;
  seq: number;
  createdAt: number;
  writer: NoteVersionWriter;
  /** True when this version's title differs from the previous version's. */
  titleChanged: boolean;
}

export interface NoteVersion extends NoteVersionSummary {
  title: string;
  content: string;
  tags: string[];
}

export interface GraphPositionInput {
  noteId: string;
  x: number;
  y: number;
}

export interface BrainstormRequest {
  /** Notes/captures to brainstorm over (capped at 20 by the core). */
  noteIds: string[];
  /** Optional conversation title; a default is derived when absent. */
  title?: string;
}

export interface BrainstormResult {
  conversationId: string;
  personaId: string;
  /** Note ids whose excerpts were bundled into the first user turn. */
  used: number;
  /** Note ids truncated to the per-note excerpt cap. */
  truncated: number;
  /** True when an existing ACTIVE brainstorm for the same note set was
   *  reopened instead of a new conversation being created (M16 follow-up). */
  reused: boolean;
}

/**
 * M16 follow-up: a brainstorm conversation linked back to the note/capture
 * nodes it was started from. Sessions are keyed by the exact source-id set:
 * starting a brainstorm over the same set reopens the ACTIVE session; once it
 * is concluded a fresh session is created and the concluded one stays
 * reopenable from the graph. Owner data — note ids and titles only, never
 * note bodies (which live in the conversation).
 */
export interface BrainstormSessionSummary {
  conversationId: string;
  title: string | null;
  personaId: string;
  /** Source note/capture ids this session was started from. */
  noteIds: string[];
  /** True once the owner has concluded the path (further clicks start new). */
  concluded: boolean;
  /** Bundle counts from the original run (0 when unknown/legacy). */
  used: number;
  truncated: number;
  createdAt: number;
  updatedAt: number;
}
