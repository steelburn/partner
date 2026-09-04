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
