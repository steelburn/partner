/**
 * M9 playbooks module index (PLAN-M9.md).
 *
 * Exposes the directive parser, the independence-level gate, the persona
 * tool loop engine, the playbook registry + manager, and the deploy-target
 * manager — plus the shared provider resolver so createCore (index.ts) and
 * the test harness (core/test/helpers.ts) wire the SAME surface.
 */
import type { Persona, ProviderClient } from '@partner/shared';
import { DEMO_MODEL, demoProvider } from '../gateway/demo.js';
import { resolveChatModel } from '../gateway/resolver.js';
import type { ProviderManager } from '../providers/providerManager.js';

export { parseReplyTools, lastDirective } from './directives.js';
export { authorizeTool } from './gate.js';
export type {
  AuthorizeContext,
  ToolGateDecision,
  ToolGateQueueReason,
  ToolGateRefuseReason,
} from './gate.js';
export {
  createToolLoop,
  summarizeToolResult,
  LOOP_MAX_ROUNDS,
  TOOL_RESULT_EXCERPT_CHARS,
  TOOL_RESULT_MESSAGE_CAP,
} from './loop.js';
export type {
  LoopEvent,
  LoopProviderResolver,
  LoopStatus,
  PlaybookChatTarget,
  ToolLoop,
  ToolLoopDeps,
  ToolLoopResult,
  ToolLoopRunRequest,
} from './loop.js';
export { PLAYBOOKS, listPlaybooks, playbookById, isTextPlaybook, isToolPlaybook } from './registry.js';
export { createPlaybookManager, buildUserMessage } from './manager.js';
export type {
  PbEvent,
  PbRunOutcome,
  PlaybookManager,
  PlaybookManagerOptions,
  PreparedPlaybookRun,
} from './manager.js';
export { createDeployManager } from './deploy.js';
export type { DeployManager, DeployManagerOptions, DeployPackageInput } from './deploy.js';
export { PlaybookError, playbookError, playbookErrorStatus } from './errors.js';
export type { PlaybookErrorCode } from './errors.js';

/**
 * Build the playbook provider resolver used by createCore/demoHarness:
 * route the persona through gateway/resolver.ts (persona-pinned/first
 * enabled provider + persona task-class model) and return a live chat client
 * for it. In demo mode an unusable/live-less resolution falls back to the
 * deterministic demo provider so TEXT playbooks run end-to-end with no
 * credentials (tool directives still resolve through the level gate — assist
 * personas refuse, and the demo provider never emits directives). Live mode
 * returns null when nothing usable is configured — tool loops then surface
 * no_provider (501), never a demo fallback.
 */
export function createPlaybookProviderResolver(deps: {
  providers: ProviderManager;
  demo: boolean;
}): (persona: Persona) => Promise<{ client: ProviderClient; model: string } | null> {
  return async (persona: Persona): Promise<{ client: ProviderClient; model: string } | null> => {
    const resolved = resolveChatModel({
      persona,
      providers: deps.providers.list(),
      taskClass: 'chat',
    });
    const usable = resolved.provider !== null && resolved.model !== '';
    if (usable && resolved.provider !== null) {
      try {
        const client: ProviderClient = await deps.providers.clientFor(resolved.provider.id);
        return { client, model: resolved.model };
      } catch {
        // Fall through — demo fallback below, or null (no_provider).
      }
    }
    if (deps.demo) return { client: demoProvider(), model: DEMO_MODEL };
    return null;
  };
}
