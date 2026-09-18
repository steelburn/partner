/**
 * M12 (P1.1) — hand-authored 16×16 inline icon set for nav destinations and
 * key actions. Token-styled: shapes inherit `currentColor`; size comes from
 * the `.ic` CSS class (var(--space-2) = 16px). No external deps, no raw
 * colors, no glow. Decorative only (`aria-hidden`); every icon sits beside
 * an accessible text label or has its own aria-label on the control.
 */
import type { ReactNode } from 'react';

export interface IconProps {
  className?: string;
}

const ATTRS = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: 'false',
} as const;

function Svg({ children, className }: IconProps & { children: ReactNode }) {
  return (
    <svg {...ATTRS} className={className ?? 'ic'}>
      {children}
    </svg>
  );
}

/** Chat — speech bubble with tail. */
export function IconChat(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.75 4.25c0-.83.67-1.5 1.5-1.5h7.5c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5H8.5l-3.2 2.35c-.5.37-1.3.02-1.3-.55v-1.8h-.25c-.83 0-1.5-.67-1.5-1.5Z" />
    </Svg>
  );
}

/** Sign out — a door with an arrow leaving. */
export function IconSignOut(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.6 2.9h2.2c.7 0 1.3.6 1.3 1.3v7.6c0 .7-.6 1.3-1.3 1.3H9.6" />
      <path d="M6.4 5.4 3.4 8l3 2.6" />
      <path d="M3.6 8h6.2" />
    </Svg>
  );
}

/** Shared — an arrow handing a page to someone else. */
export function IconShared(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.2 9.8 9.8 6.2" />
      <path d="M7.4 4.6 8.9 3.1a2.6 2.6 0 0 1 3.7 3.7l-1.5 1.5" />
      <path d="M8.6 11.4 7.1 12.9a2.6 2.6 0 0 1-3.7-3.7l1.5-1.5" />
    </Svg>
  );
}

/** Members — a person beside a check (an account on this Partner). */
export function IconMembers(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="5.4" r="2.3" />
      <path d="M2.3 13c.5-2.4 1.9-3.6 3.7-3.6 1.1 0 2.1.5 2.8 1.4" />
      <path d="m9.6 11.4 1.3 1.3 2.4-2.6" />
    </Svg>
  );
}

/** Notes — page with lines. */
export function IconNotes(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M5.5 6.4h5M5.5 9h5M5.5 11.6h3" />
    </Svg>
  );
}

/** Personas — two people. */
export function IconPersonas(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5.3" cy="5.2" r="2.1" />
      <path d="M2.1 12.3c.4-2.2 1.7-3.3 3.2-3.3s2.8 1.1 3.2 3.3" />
      <circle cx="11.6" cy="6.3" r="1.6" />
      <path d="M9.7 9.9c1.3-.6 2.9-.1 3.6 1" />
    </Svg>
  );
}

/** Providers — server rack. */
export function IconProviders(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="3" width="11" height="4.4" rx="1" />
      <rect x="2.5" y="8.6" width="11" height="4.4" rx="1" />
      <path d="M5 5.2h.01M5 10.8h.01M7.2 5.2h3.8M7.2 10.8h3.8" />
    </Svg>
  );
}

/** Files — folder. */
export function IconFiles(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.25 6.2 4.5 4.45c.2-.26.5-.4.82-.4h2.9L10 6.2h2.75V11c0 .83-.67 1.5-1.5 1.5h-7a1.5 1.5 0 0 1-1.5-1.5Z" />
      <path d="M2.75 6.2h10.5" />
    </Svg>
  );
}

/** Memory — chip with pins. */
export function IconMemory(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.75" y="5.5" width="10.5" height="5" rx="1" />
      <path d="M5.25 3.4v2.1M8 3.4v2.1M10.75 3.4v2.1M5.25 10.5v2.1M8 10.5v2.1M10.75 10.5v2.1" />
      <circle cx="8" cy="8" r="0.8" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Themes — half-filled contrast circle. */
export function IconThemes(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3.25a4.75 4.75 0 1 0 .01 9.5A4.75 4.75 0 0 1 8 3.25Z" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="4.75" />
    </Svg>
  );
}

/** Skills — puzzle piece. */
export function IconSkills(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.3 6.6V4.9c0-.75.6-1.35 1.35-1.35h1.35V4.9a1.05 1.05 0 0 0 2.1 0V3.55H11c.75 0 1.35.6 1.35 1.35v1.6h-1.1a1.2 1.2 0 0 0 0 2.4h1.1v1.6c0 .75-.6 1.35-1.35 1.35H9.6v-1.1a1.05 1.05 0 0 0-2.1 0v1.1H4.65c-.75 0-1.35-.6-1.35-1.35V9.8h1.1a1.2 1.2 0 0 0 0-2.4Z" />
    </Svg>
  );
}

/** Playbooks — play mark. */
export function IconPlaybooks(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.1 4.05c0-.63.68-1.02 1.23-.7l5.1 3.15c.52.32.52 1.08 0 1.4L7.33 11.3c-.55.34-1.23-.05-1.23-.7Z" />
    </Svg>
  );
}

/** Audit — shield with check. */
export function IconAudit(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.2 13 3.9v4.3c0 3.1-2 5.2-5 6.6-3-1.4-5-3.5-5-6.6V3.9Z" />
      <path d="m6 8 1.4 1.4L10.2 6.7" />
    </Svg>
  );
}

/** ＋Note — quick capture (page + plus). */
export function IconNoteAdd(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M8 5.4v5.2M5.4 8h5.2" />
    </Svg>
  );
}

/** Send — paper plane. */
export function IconSend(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m13.2 3.6-9.4 4.9c-.6.3-.55 1.17.06 1.4l2.6.95 1.5 3.4c.25.57 1.07.53 1.26-.08L13.9 4.6c.17-.55-.35-1.07-.7-1Z" />
      <path d="m6.5 10.8 2-1.9" />
    </Svg>
  );
}

/** Save to Assets — into a tray. */
export function IconSave(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.5v6.4M5.5 6.3 8 8.9l2.5-2.6" />
      <path d="M3.4 10.2v2.4h9.2v-2.4" />
    </Svg>
  );
}

/** Chevron left. */
export function IconChevronLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9.8 4.2-4 3.8 4 3.8" />
    </Svg>
  );
}

/** Chevron right. */
export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.2 4.2l4 3.8-4 3.8" />
    </Svg>
  );
}

/** Chevron down — the sidebar Chat section's expand/collapse disclosure. */
export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4.2 6.2 3.8 4 3.8-4" />
    </Svg>
  );
}

/** Full width (focus mode) — corners outward. */
export function IconMaximize(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.75 6.5V2.75H6.5M9.5 2.75h3.75V6.5M13.25 9.5v3.75H9.5M6.5 13.25H2.75V9.5" />
    </Svg>
  );
}

/** Side-by-side (exit focus mode) — corners inward. */
export function IconMinimize(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.5 2.75v3.75H2.75M9.5 2.75v3.75h3.75M13.25 9.5H9.5v3.75M6.5 13.25V9.5H2.75" />
    </Svg>
  );
}

/** Conversations rail — left panel with a split line. */
export function IconPanelLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 3.5h10a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z" />
      <path d="M6.4 3.5v9" />
    </Svg>
  );
}

/** Notes lane — right panel with a split line. */
export function IconPanelRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 3.5h10a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z" />
      <path d="M9.6 3.5v9" />
    </Svg>
  );
}

/** M20.A phone nav — "More" (overflow): three dots, the standard overflow
 *  affordance for a bottom tab bar that cannot hold every destination. */
export function IconMore(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="3.4" cy="8" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="12.6" cy="8" r="1.05" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** M20.A phone nav sheet close. */
export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8" />
      <path d="M12 4l-8 8" />
    </Svg>
  );
}

/** M20.A phone composer — attach (paperclip). Standard single-use affordance
 *  so the composer can drop the "＋ Attach" text on a narrow row and give the
 *  reclaimed width to the message field. */
export function IconAttach(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M11.8 4.9 6.6 10a2.1 2.1 0 0 0 2.9 3l5-5a3.5 3.5 0 0 0-4.9-4.9L4.3 8.4a4.6 4.6 0 0 0 6.5 6.5l3.8-3.8" />
    </Svg>
  );
}
