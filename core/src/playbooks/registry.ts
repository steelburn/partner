/**
 * M9 playbook registry (PLAN-M9.md).
 *
 * The eight capability playbooks as declarative {@link PlaybookSummary}
 * metadata (id/name/area/description/allowedTools/defaultIndependence/
 * inputs). Execution is generic:
 *
 *   - TEXT playbooks (research, docgen, email, presentation, analysis,
 *     design-prototype) run through a generic prompt builder that composes
 *     the persona prompt + an input summary (loading note content when the
 *     inputs carry a noteId) and, when inputs.saveNote is true, save the
 *     final text as a note (title from the playbook name).
 *   - vibe-code + ship are persona tool loops over a project root: the same
 *     loop machinery with the playbook's file-tool envelope and a persona
 *     prompt that instructs editing — no special-casing beyond defaults.
 *
 * The registry itself is catalog-independent: prompts are built from these
 * summaries (never from an external skill catalog).
 */
import type { PlaybookArea, PlaybookSummary } from '@partner/shared';

export const TEXT_PLAYBOOK_AREAS: readonly PlaybookArea[] = [
  'research',
  'docgen',
  'email',
  'presentation',
  'analysis',
  'design-prototype',
];

/** File-tool ids a persona-loop playbook (vibe-code/ship) may declare. */
const PROJECT_TOOLS: readonly string[] = [
  'files.list',
  'files.read',
  'files.search',
  'files.edit',
  'files.apply',
  'files.delete',
];

export const PLAYBOOKS: readonly PlaybookSummary[] = [
  {
    id: 'research',
    name: 'Research',
    area: 'research',
    description:
      'Turn sources (a pasted brief, an existing note, or your own notes) into a structured research summary with citations to what you actually read.',
    allowedTools: [],
    defaultIndependence: 'suggest',
    inputs: [
      { name: 'topic', hint: 'What to research', optional: true },
      { name: 'sourceText', hint: 'Pasted source material to work from', optional: true },
      { name: 'noteId', hint: 'Existing note id to summarize/extend', optional: true },
      { name: 'saveNote', hint: 'Save the result as a note', optional: true },
    ],
  },
  {
    id: 'docgen',
    name: 'Docgen',
    area: 'docgen',
    description:
      'Draft a polished markdown document (spec, guide, proposal, README) from a short brief, in the persona’s voice.',
    allowedTools: [],
    defaultIndependence: 'assist',
    inputs: [
      { name: 'prompt', hint: 'What the document should cover', optional: true },
      { name: 'docType', hint: 'e.g. spec | guide | proposal', optional: true },
      { name: 'noteId', hint: 'Existing note to expand into a document', optional: true },
      { name: 'saveNote', hint: 'Save the result as a note', optional: true },
    ],
  },
  {
    id: 'email',
    name: 'Email draft',
    area: 'email',
    description:
      'Draft a clear, voice-matched email from a one-line intent. Sending stays with you (your mail client) — this produces the draft.',
    allowedTools: [],
    defaultIndependence: 'assist',
    inputs: [
      { name: 'prompt', hint: 'Who it is to and what it should say', optional: true },
      { name: 'tone', hint: 'formal | warm | direct (default: persona voice)', optional: true },
      { name: 'noteId', hint: 'Context note', optional: true },
    ],
  },
  {
    id: 'presentation',
    name: 'Presentation',
    area: 'presentation',
    description:
      'Turn an outline or topic into a crisp slide deck skeleton: story arc, per-slide bullets and the visual each slide needs.',
    allowedTools: [],
    defaultIndependence: 'assist',
    inputs: [
      { name: 'prompt', hint: 'Topic, audience and desired takeaway', optional: true },
      { name: 'slides', hint: 'Target number of slides', optional: true },
      { name: 'noteId', hint: 'Existing note to turn into a deck outline', optional: true },
      { name: 'saveNote', hint: 'Save the outline as a note', optional: true },
    ],
  },
  {
    id: 'analysis',
    name: 'Analysis',
    area: 'analysis',
    description:
      'Analyse data you paste (CSV/TSV) or keep in a note: structure, summary stats, trends and honest caveats. No cloud — local only.',
    allowedTools: [],
    defaultIndependence: 'assist',
    inputs: [
      { name: 'csv', hint: 'Pasted CSV/TSV data', optional: true },
      { name: 'question', hint: 'What you want to know about the data', optional: true },
      { name: 'noteId', hint: 'Note whose content is the dataset', optional: true },
      { name: 'saveNote', hint: 'Save the analysis as a note', optional: true },
    ],
  },
  {
    id: 'design-prototype',
    name: 'Design prototype',
    area: 'design-prototype',
    description:
      'Turn a token spec or brief into a design-prototype spec and token-only HTML/CSS sketch — no invented colors, no glow.',
    allowedTools: [],
    defaultIndependence: 'assist',
    inputs: [
      { name: 'brief', hint: 'What is being designed and for whom', optional: true },
      { name: 'tokens', hint: 'Design tokens (colors/type/spacing)', optional: true },
      { name: 'noteId', hint: 'Existing spec note to prototype from', optional: true },
      { name: 'saveNote', hint: 'Save the prototype spec as a note', optional: true },
    ],
  },
  {
    id: 'vibe-code',
    name: 'Vibe-code',
    area: 'vibe-code',
    description:
      'Work through a coding task on one of your project roots. Reads/search/edit through the broker — every write is a reviewed proposal; nothing applies without you.',
    allowedTools: [...PROJECT_TOOLS],
    defaultIndependence: 'auto',
    inputs: [
      { name: 'projectId', hint: 'Project root to work in' },
      { name: 'task', hint: 'What to build or change' },
    ],
  },
  {
    id: 'ship',
    name: 'Ship',
    area: 'ship',
    description:
      'Package a built app for a deploy-target profile (container-ready bundle: Dockerfile + build script + README). Live push/deploy stays environment-gated and documented.',
    allowedTools: [...PROJECT_TOOLS],
    defaultIndependence: 'auto',
    inputs: [
      { name: 'projectId', hint: 'Project root whose app is being shipped' },
      { name: 'task', hint: 'Ship intent (build + package + validate)', optional: true },
    ],
  },
];

const BY_ID = new Map<string, PlaybookSummary>(PLAYBOOKS.map((p) => [p.id, p]));

/** Registry metadata for the GET /v1/playbooks listing. */
export function listPlaybooks(): readonly PlaybookSummary[] {
  return PLAYBOOKS;
}

/** One playbook summary, or null when the id is unknown. */
export function playbookById(id: string): PlaybookSummary | null {
  if (typeof id !== 'string') return null;
  return BY_ID.get(id) ?? null;
}

/** True for the text playbooks (generic prompt-builder execution). */
export function isTextPlaybook(area: PlaybookArea): boolean {
  return TEXT_PLAYBOOK_AREAS.includes(area);
}

/** True for the persona tool-loop playbooks (vibe-code + ship). */
export function isToolPlaybook(area: PlaybookArea): boolean {
  return area === 'vibe-code' || area === 'ship';
}
