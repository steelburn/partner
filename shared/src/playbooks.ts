/**
 * M9 playbook + deploy-target wire contracts (PLAN-M9.md).
 *
 * Playbooks orchestrate personas + the broker into capability flows
 * (research, vibe-code, docgen, email, presentation, analysis,
 * design-prototype, ship). A persona may emit a [[partner:tool ...]]
 * directive in a reply; the core authorizes it against the persona's
 * independence level and the broker, then loops.
 */

export type PlaybookArea =
  | 'research'
  | 'vibe-code'
  | 'docgen'
  | 'email'
  | 'presentation'
  | 'analysis'
  | 'design-prototype'
  | 'ship';

export interface PlaybookSummary {
  id: string;
  name: string;
  area: PlaybookArea;
  description: string;
  /** Tool ids the playbook may use (persona level still gates execution). */
  allowedTools: string[];
  /** Default independence level used when no persona is chosen. */
  defaultIndependence: 'assist' | 'suggest' | 'auto' | 'autonomous';
  /** Rough input schema description for the Run panel. */
  inputs: Array<{ name: string; hint: string; optional?: boolean }>;
}

export interface PlaybookRunInput {
  /** Inputs per the playbook's declared schema. */
  inputs: Record<string, unknown>;
  personaId?: string;
  conversationId?: string;
}

/** One tool directive a persona requested mid-run. */
export interface PersonaToolDirective {
  toolId: string;
  args: Record<string, unknown>;
}

/** Decision the core made for a persona tool request. */
export type PersonaToolDecision =
  | { decision: 'executed'; result: Record<string, unknown> }
  | { decision: 'queued'; pendingId: string }
  | { decision: 'refused'; reason: string };

// ---------------------------------------------------------------------------
// Deploy targets
// ---------------------------------------------------------------------------

export type DeployTargetKind = 'docker-ssh';

export interface DeployProfile {
  id: string;
  name: string;
  kind: DeployTargetKind;
  host: string;
  username: string | null;
  port: number;
  remoteBaseDir: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeployProfileInput {
  name: string;
  host: string;
  username?: string;
  port?: number;
  remoteBaseDir?: string;
}

export interface PackageResult {
  profileId: string;
  /** Absolute paths under the granted project root. */
  outDir: string;
  files: string[];
  dockerfile: string;
}
