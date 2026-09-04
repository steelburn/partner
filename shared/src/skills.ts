/**
 * M8 skill wire contracts (PLAN-M8.md).
 *
 * Skills are capability bundles: declarative manifest + one entrypoint that
 * runs in a worker and may ONLY request broker-mediated tools over IPC.
 * Installed skills are user-scoped (this core's profile). Manifest
 * permissions drive default-deny installs and the runtime ceiling.
 */
import type { ToolId, ToolRisk } from './tools.js';

export type SkillSource = 'local';

export type SkillStatus = 'installed' | 'disabled';

export interface SkillPermissions {
  /** Tools the skill may request (all are files.* in M8). */
  tools: ToolId[];
  /** Network capability is reserved (false in M8). */
  network: boolean;
  /** Whole-skill risk ceiling applied to every tool call. */
  risk: ToolRisk;
}

export interface SkillBudget {
  /** Worker wall-clock budget in ms (default 30s). */
  timeMs: number;
  /** Optional token ceiling for tool-call charges (default off). */
  maxTokens?: number;
}

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  entrypoint: string;
  permissions: SkillPermissions;
  budget: SkillBudget;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  source: SkillSource;
  status: SkillStatus;
  sha256: string;
  installedAt: number;
  updatedAt: number;
}

export interface SkillDetail extends SkillSummary {
  manifest: SkillManifest;
}

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  permissions: SkillPermissions;
}

export interface SkillInvokeInput {
  /** Free-form JSON args for the skill (server caps size). */
  args?: unknown;
  personaId?: string;
}

export interface SkillInvocationMeta {
  id: string;
  skillId: string;
  personaId: string | null;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean;
  toolCalls: number;
  error: string | null;
  ms: number | null;
}
