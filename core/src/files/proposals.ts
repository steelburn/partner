/**
 * File-proposal manager (M2) — write-preview lifecycle reads for the web UI
 * (GET the diff payload, discard). Apply goes through the broker as the
 * `files.apply` tool (high risk, always asks) and is implemented in
 * files/tools.ts; this module never touches the filesystem.
 *
 * Views are typed over the shared FileProposal wire type + lifecycle state.
 */
import type { FileProposal } from '@partner/shared/tools.js';
import { toolError } from '../broker/errors.js';
import type { FileProposalRow, FileProposalStore } from '../stores/types.js';

export interface ProposalManagerOptions {
  store: FileProposalStore;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

/** The GET /v1/tools/proposals/:id payload: diff + metadata (no secrets). */
export interface ProposalView extends FileProposal {
  originalMtime: number;
  appliedAt: number | null;
  discardedAt: number | null;
  /** True while neither applied nor discarded. */
  open: boolean;
}

export interface ProposalManager {
  /** Full view, or null when the proposal does not exist. */
  get(id: string): ProposalView | null;
  /** Close a proposal as discarded; throws when missing or already applied. */
  discard(id: string): void;
}

function toView(row: FileProposalRow): ProposalView {
  return {
    id: row.id,
    projectId: row.projectId,
    path: row.path,
    originalContent: row.originalContent ?? '',
    proposedContent: row.proposedContent,
    createdAt: row.createdAt,
    originalMtime: row.originalMtime,
    appliedAt: row.appliedAt,
    discardedAt: row.discardedAt,
    open: row.appliedAt === null && row.discardedAt === null,
  };
}

export function createProposalManager(options: ProposalManagerOptions): ProposalManager {
  const { store } = options;
  const now = options.now ?? Date.now;

  function get(id: string): ProposalView | null {
    const row = store.findById(id);
    return row ? toView(row) : null;
  }

  function discard(id: string): void {
    const row = store.findById(id);
    if (!row) throw toolError('not_found', 'proposal not found');
    if (row.appliedAt !== null) {
      throw toolError('not_pending', 'cannot discard an already-applied proposal');
    }
    store.markDiscarded(id, now());
  }

  return { get, discard };
}
