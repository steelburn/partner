/**
 * Navigation model (M20.A) — the single source of truth for *which views exist*
 * and how they are reached on each form factor.
 *
 * Why this is a module and not inline JSX: the desktop sidebar lists every
 * view, but a phone shows only a handful of tabs plus a "More" sheet. The
 * moment those two lists are maintained separately, a view can silently become
 * unreachable on a phone — which is a real product bug that type-checks
 * perfectly. So the split is data, and `nav.test.ts` asserts that the mobile
 * tabs plus the More sheet cover exactly the full view set, each exactly once.
 *
 * Geometry notes live in app.css; this module owns only the information
 * architecture (which view, which label, which group, which tier).
 */

/** Every view in the app. Order here is the desktop sidebar order. */
export const VIEW_NAMES = [
  'chat',
  'folders',
  'notes',
  'shared',
  'personas',
  'skills',
  'playbooks',
  'files',
  'memory',
  'providers',
  'themes',
  'audit',
  'members',
] as const;

export type ViewName = (typeof VIEW_NAMES)[number];

export interface NavGroupMeta {
  name: string;
  views: ViewName[];
}

/**
 * Desktop sidebar groups.
 *
 * M31: the configuration surfaces (providers, themes, audit, members) moved
 * into a single Settings group, so the panel reads as three working groups
 * over one administrative group instead of five ad-hoc buckets. Studio is now
 * purely “things the partner is made of” (personas, skills, playbooks); Tools
 * is the partner's working data.
 *
 * M34: **Folders** joins Workspace directly under Chat — the two ways this
 * product organizes a chat session (the persona it belongs to, by way of the
 * tree under Personas, and the folder it is filed in). It is a destination,
 * not a disclosure: the folder tree and its management controls live on the
 * page, so there is one place that owns them (the M32 open end).
 */
export const NAV_GROUPS: readonly NavGroupMeta[] = [
  { name: 'Workspace', views: ['chat', 'folders', 'notes', 'shared'] },
  { name: 'Studio', views: ['personas', 'skills', 'playbooks'] },
  { name: 'Tools', views: ['files', 'memory'] },
  { name: 'Settings', views: ['providers', 'themes', 'audit', 'members'] },
] as const;

/** Human labels, shared by the sidebar, the mobile tabs and the More sheet. */
export const NAV_LABELS: Record<ViewName, string> = {
  chat: 'Chat',
  folders: 'Folders',
  notes: 'Notes',
  shared: 'Shared',
  personas: 'Personas',
  providers: 'Providers',
  themes: 'Themes',
  files: 'Files',
  skills: 'Skills',
  playbooks: 'Playbooks',
  memory: 'Memory',
  audit: 'Audit',
  members: 'Members',
};

/**
 * Phone bottom tabs, in thumb-priority order.
 *
 * Five slots is the most that stays comfortably tappable at 360px (72px per
 * slot, above `--target-min`). `files` earns a slot because it carries the
 * pending-approval badge — on a phone the approval queue is the one thing that
 * must never be more than one tap away. `chat` leads because chat is the
 * product.
 */
export const MOBILE_TABS: readonly ViewName[] = ['chat', 'notes', 'files', 'personas'] as const;

/** Everything else, reached from the More sheet. */
export const MOBILE_MORE: readonly ViewName[] = [
  'folders',
  'shared',
  'providers',
  'themes',
  'skills',
  'playbooks',
  'memory',
  'audit',
  'members',
] as const;

/** Views reachable from the phone UI (tabs + More sheet). */
export function mobileReachableViews(): ViewName[] {
  return [...MOBILE_TABS, ...MOBILE_MORE];
}

/** Views listed by the desktop sidebar. */
export function sidebarViews(): ViewName[] {
  return NAV_GROUPS.flatMap((group) => group.views);
}

/**
 * The sidebar's minimize boundary (M20.A follow-up 10).
 *
 * At or below this width the shell's sidebar has no room for labels, so the
 * **default** is the icon rail (M12: "no menu ever scrolls horizontally and the
 * chat rails keep their usable widths at smaller viewports"). It is a state
 * default, not a layout rule — above it the default is the labelled sidebar, and
 * the user's minimize toggle overrides either one, in both directions. That
 * matters most where the tier alone would be wrong: an iPad in landscape
 * reports >1150 CSS px, so it gets the labelled sidebar, and this control is
 * what returns the 164px it occupies.
 *
 * The number is mirrored by `--side-w` in app.css; `sidebar-collapse.test.ts`
 * re-reads the stylesheet so the two cannot drift.
 */
export const SIDE_RAIL_MAX_WIDTH = 1150;
