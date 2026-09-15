# VERIFY-MOBILE — M20.A responsive & touch pass

Verification record for the M20.A UI work (`PLAN-M20.md` §5/M20.A). Numbers
here are **measured**, not eyeballed: they come from evaluating element
bounding boxes in a real browser at viewer scale, plus the deterministic
`ux_audit` gate. Recorded 2026-09-12.

## How to reproduce

```bash
# an isolated DEMO core, so a live core already on :4390 is never disturbed
PORT=4391 DEMO_MODE=1 npx tsx core/src/index.ts &

# the SPA with its /v1 proxy pointed at that core (VITE_CORE_URL, added in M20.A)
cd web && VITE_CORE_URL=http://127.0.0.1:4391 npx vite &
```

Then pair the browser (`Get demo pairing code` → `Connect`), open a
conversation, and sweep widths. The measurement probe is
`docs/`-external: it is reproduced inline below so it can be pasted into a
Playwright/CDP session.

```js
// Geometry probe. Deliberately asserts composer WIDTH, not just overflow:
// at HEAD the phone layout never overflowed — it crushed content instead, so
// an overflow-only gate passed while the composer was 58px wide.
() => {
  const box = (s) => { const e = document.querySelector(s); if (!e) return null;
    const c = getComputedStyle(e); if (c.display === 'none') return null;
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) }; };
  const small = [];
  for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')) {
    const c = getComputedStyle(el);
    if (c.display === 'none' || c.visibility === 'hidden') continue;
    // Skip visually-hidden file inputs: a 1x1 input inside a <label> is the
    // CORRECT pattern; the label is the real target.
    if (el instanceof HTMLInputElement && el.type === 'file') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.bottom < 0 || r.top > innerHeight) continue;
    if (r.width < 44 || r.height < 44) small.push(el.getAttribute('aria-label') || el.tagName);
  }
  return { vw: innerWidth,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    chat: box('.chat'), form: box('.chat-form'), nav: box('.mobile-nav'),
    smallCount: small.length, small };
}
```

## Measured result — before / after

`chrome` = permanent horizontal chrome (icon rail + conversation rail).
Composer width is the number that decides whether the product is usable.

| viewport | `.chat` before | `.chat` after | composer before | composer after | chrome before | chrome after | controls < 44px before | after |
|---|---|---|---|---|---|---|---|---|
| 360 | 92 | **360** | 28 | **296** | 252 | **0** | 11 | **0** |
| 375 | 107 | **375** | 43 | **311** | 252 | **0** | 11 | **0** |
| 390 | 122 | **390** | 58 | **326** | 252 | **0** | 11 | **0** |
| 430 | 162 | **430** | 98 | **366** | 252 | **0** | 11 | **0** |
| 768 (rail open) | 432 | 432 | 368 | 368 | 280 | 280 | 12 | *(see below)* |
| 1024 (rail open) | 648 | 648 | 584 | 584 | 320 | 320 | 12 | *(see below)* |

- **`overflowX` was 0 at every width, before and after.** That is the whole
  point: the old layout never overflowed, so M12's gates passed while the
  composer sat at 58px. The new gate asserts width.
- **Phone rail overlay** (the row actions live there): rail 320px,
  `position: absolute`, delete **74×44** (was **1×19**), move 66×44, drag
  handle removed, **0** controls under 44px inside it, transcript still 390px
  behind it.
- **Tablet/desktop are unchanged** — identical numbers with the rail open, so
  the pass is additive rather than a redesign of the larger tiers.
- Phone tabs measure **5 × (78×56)** at 390px and 72×56 at 360px, i.e. all
  above the floor with room to spare.

## Deterministic gate

`ux_audit` on the new block plus the interactive bases/states it depends on
(`.btn`/`.field`/`.tab-badge`/`.side-tab`/`.notes-mini-toggle`/
`.folder-action`/`.rail-item-*`), so the States gate sees real interactive
selectors rather than a fragment:

- Contrast (APCA) — **✓** 12 pairs passing, light and dark (tab label
  inactive Lc 87.3/76.7; active tab Lc 85.5/84.5; More item Lc 93.2/91.1)
- Tokens — **✓** · States — **✓** · Slop tells — **✓**

A first run **FAILED**, and the failure is worth keeping: a speculative pair
(`--text-faint` on the dark surface) measured **Lc 49.5**, below the body
floor. That pair is *not* used by the implementation (the tab label uses
`--text-muted`), but the constraint is now written into `app.css` and
`DESIGN.md` so nobody later "quiets down" the tab bar with the wrong token.

Full-file static scan of all 8192 lines of `app.css` for the computable slop
tells: `backdrop-filter` **0**, `radial-gradient` **0**, `linear-gradient`
**0**, `filter: blur` **0**, `text-shadow` **0**, raw `letter-spacing` **0**.

## Suites

| suite | result |
|---|---|
| `npm run typecheck` | 0 errors (shared · core · web · extension) |
| `npm test` (root) | **893 passed**, 5 skipped — identical to the pre-pass baseline |
| `npx vitest run --root web` | **547 passed** (541 + 6 new `nav.test.ts`) |
| `npm run build -w web` | green |

## NOT verified here — read before trusting this pass

1. **No visual/aesthetic inspection.** The generating model in this session is
   text-only, so the render-and-inspect step was skipped by design. Everything
   above is measurement or a deterministic gate. Nobody has *looked* at this:
   hierarchy, spacing rhythm and brand fit are unjudged.
2. **The `@media (hover: none)` branch was never exercised.** The headless
   environment reports `hover: hover`, `pointer: fine`,
   `maxTouchPoints: 0`, so the no-hover rules (reveal row actions, drop the
   drag handle) could not be triggered. They are authored and syntactically
   valid; **runtime confirmation needs a real touch device or a devtools
   device-emulation session.** Phones are additionally covered by the ≤640
   path, which *was* verified.
3. **No real-device walk.** Safe-area insets (`env(safe-area-inset-*)`) are 0
   in this environment, so the notch/home-indicator padding is unproven.
   Keyboard behaviour is unproven: `100dvh` is asserted, the on-screen
   keyboard is not.
4. **The complete-stylesheet `ux_audit` run is outstanding.** The payload was
   176 KB, which is not reliably inlinable, so the gate ran on a composed,
   provably brace-balanced payload (M20.A + the interactive bases). That
   covers the new code and the States precondition; a whole-file run remains a
   manual step for whoever has a smaller-model budget or a CI hook.
5. **No automated geometry test in CI.** The web suite is Node-only (no DOM
   harness), so the numbers above are a recorded manual pass, not a regression
   gate. Turning the probe into a CI gate is a follow-up.

## Follow-ups found during this pass

- **Folder moves on touch.** HTML5 drag does not fire on touch, so the drag
  handle was removed on no-hover devices rather than left as a dead 24×24
  control. Re-filing a conversation on a phone therefore needs an explicit
  affordance (a row menu or a "Move to…" sheet). **This is a capability gap
  introduced by the removal — tracked, not silently dropped.**
- **`max-width: 100px`** in the reveal rules is a magic value inherited from
  the existing hover rule; a `--rail-action-w` token would make it systemic.
  **→ Superseded:** that recommendation was wrong — the width is *label-driven*
  (it fits the longest label, "Confirm delete"), so a token would be false
  systemisation. See *Applied recommendations §2* below.
- **Pre-existing, not introduced here:** `.preview-frame` sets
  `background: #ffffff` — the only hardcoded hex in the stylesheet. Arguably
  correct (third-party preview content should not inherit the user's theme
  canvas) but it is an off-system value and deserves a deliberate token rather
  than a literal. The five non-token `box-shadow` uses are `0 0 0 2px` **ring
  geometry** built from colour tokens, not ad-hoc elevation.
  **→ Applied:** now the `--surface-doc` token; the stylesheet has no raw hex
  left in any declaration. See *Applied recommendations §3* below.
- **Separate, higher-severity issue** (`PLAN-M20.md` §8.1): the core serves
  uploaded `text/html` inline from the SPA's own origin, where the session
  token lives. Unrelated to layout, but it is a live hole on the current
  product and should be fixed independently of this milestone.

---

# M20.A follow-up — persona cards, chat composer, attention badges

Second pass, same session and same method (measured geometry + `ux_audit`; no
vision inspection, for the reason recorded above). Recorded 2026-09-12.

## Why: three things the first pass did not reach

1. **The chat composer was still unusable.** My earlier "composer 326px" claim
   was the *container*, not the field. Measured at HEAD, the row was
   `＋ Attach` 109px + textarea **49px** + `Send` 105px: the two text buttons
   took 214px of 326px and left the control the page exists for at 15% of the
   row. **Correction to the earlier report: the field, not the container, is
   the number that matters.**
2. **Persona cards were enormous.** 488–584px tall at 390px — ~1.3 cards per
   screen — with the identity head at **247×285px** and the action set wrapped
   into a **183×78px blob indented 96px**. 52 controls under 44×44 (4 per card).
3. **A memory suggestion was undiscoverable.** The count existed only inside
   the Memory view's header ("Suggestions (N)"). Nothing anywhere else said
   anything was waiting.

## Measured result @390×844

| measure | before | after |
|---|---|---|
| chat message field | **49px** (15% of row) | **222px (62%)** |
| attach / send controls | 109×51 / 105×51 text buttons | **44×44 icons** |
| `.chat-form` | 326px | 358px (phone gutter 32→16px) |
| persona card height | 584 / 512 / 488 | **340 / 340 / 340** (~2.5 per screen) |
| `.persona-card-head` | 247×285 | **263×129** |
| card `.row-actions` | 183×78 @ x=128 | **263×44 @ x=56** (own full-width row) |
| controls <44px on Personas | **52** | **0** |
| `overflowX` | 0 | 0 |

## Attention badges — verified end to end, not just rendered

Seeded three real `partner_suggestion` entries through the app's own session
(the demo core has no provider, so automatic remember never runs), then:

- **More tab: badge `3`, `aria-label="More views — 3 waiting"`** — the point of
  the feature: previously the badge did not exist anywhere the user could see.
- Memory inside the opened sheet: badge `3`, `aria-label="Memory — 3 waiting"`.
- Chat / Notes / Files / Personas: unbadged — correct, and Files' count is
  deliberately **not** folded into More (both are visible; showing one number
  twice reads as two problems).
- **Cleared by acting:** clicking Reject moved Suggestions (3) → (2) and the
  badge 3 → 2 immediately, not at the next poll, so the
  `onAttentionChanged` path works.

## Design decisions worth stating

- **A badge must be able to clear itself.** Approvals clear by being decided,
  suggestions by being confirmed or rejected. A failed scheduled run has no
  such action — the runs panel is a history, not an inbox — so counting every
  failure forever would badge something the user can only dismiss by ignoring
  it. Failures therefore self-clear on a **24h window**. Cost, stated: a failure
  nobody noticed inside the window stops badging and can be missed. That is the
  deliberate price of not having an acknowledgement model.
- **No double counting.** A scheduled run paused on an approval *is* the pending
  approval (M14 pauses the run and queues the tool), so `queued` runs are
  excluded from the failure count. Counting both would report one decision as
  two problems. Asserted in `attention.test.ts`.
- **Only counts live in shell state.** The memory entries themselves are never
  copied into the app shell, so an unconfirmed personal fact does not sit in
  browser memory (or a devtools snapshot) merely to render a number.
- **Poll cadence split.** Approvals keep the 4s poll (a turn is blocked on the
  decision); attention rides 15s plus on-focus, plus an immediate check when a
  turn ends and a follow-up 3s later — M19 automatic remember runs *out of band*
  after the response, so a single immediate check would miss it.

## Gate

`ux_audit` **PASSED** — 18 APCA pairs (light + dark), tokens, states, slop tells.
The follow-up block itself introduces **zero colour declarations** (layout and
sizing only) and no new magic values beyond the sr-only clip pattern and
`outline-offset: 2px`, which matches the existing `.btn:focus-visible`.

**A failure worth keeping:** the first run failed *States* — "motion with no
prefers-reduced-motion fallback". That was a payload artifact (the `.btn`
transition's fallback lives elsewhere in the file), but it exposed something
real: `.more-sheet`'s rise animation first shipped with its fallback *nested*
inside the ≤640 block, so the guarantee depended on that nesting surviving a
refactor. A consolidated top-level `@media (prefers-reduced-motion: reduce)`
block now covers the M20.A motion independently of where the rules live.

## Suites

| suite | result |
|---|---|
| `npm run typecheck` | 0 errors (shared · core · web · extension) |
| `npm test` (root) | **893 passed**, 5 skipped — baseline held |
| `npx vitest run --root web` | **565 passed** (547 + 18 attention) |
| `npm run build -w web` | green |

## Still NOT verified (unchanged from above)

No visual inspection (text-only model) · no real-device walk · safe-area insets
and on-screen keyboard unproven · the `hover: none` branch not runtime-exercised
· whole-file `ux_audit` outstanding · geometry is a recorded manual pass, not a
CI gate. Add to that: **the attention badge has not been seen on a real phone
with a real notification arriving while the app is backgrounded** — the poll
only runs while the page is open, so nothing here claims background delivery.
That is exactly the D3 "no notifications in v1" decision, and it is why the
M20.B/C push work is where true notification delivery lives.

## Follow-ups

- **Folder/chat re-filing on touch** (from the previous pass) — still open: the
  drag handle is removed on no-hover devices and nothing replaced it.
- **No acknowledgement model**, so failed runs can only self-clear on time. If
  users want durable "needs attention" semantics, the shape is a per-destination
  seen/ack marker, which is a schema decision, not a UI one.
- `max-width: 100px` in the rail reveal rules: **not debt** — label-driven, see
  the correction under *Applied recommendations*.
- `.preview-frame { background: #ffffff }`: **fixed** — now `--surface-doc`.
  The stylesheet has no raw hex in any declaration.
- **Security hole, unrelated to layout** (`PLAN-M20.md` §8.1): **fixed** in the
  same session — see *Applied recommendations §1*.

---

# M20.A follow-up 2 — Memory view rework

Third pass, same session and method. Recorded 2026-09-12.

## What was wrong, measured @390×844 with real entries

**The Memory controls card (4 controls, 1483px tall — ~2 phone screens).** Each
`.mem-control-row` is a flex row of text + action, and the *copy column* was
crushed to **9–11px**:

| row | row height | text column | button |
|---|---|---|---|
| Forget everything | 198px | 50px | 109×51 |
| Forget before a date | 291px | 183px | 136×51 |
| Export | 231px | **11px** | 148×51 |
| Import | **411px** | **9px** | 151×51 |

Cause: `.mem-control-text` is `flex: 1; min-width: 0`, and **`min-width: 0` lets
a flex item shrink below its min-content width** — so the row never wrapped and
the prose absorbed the entire deficit while the buttons kept their intrinsic
width. One character per line, 363px tall.

**The same crush, worse, in entry rows.** `.mem-value` is `flex: 1;
min-width: 0` beside a fixed-width kind chip: a 42-character entry rendered a
**20px-wide value column 399px TALL**. My *first attempt at this fix did not
apply* — it targeted a `.row-actions` container that only exists elsewhere; the
real one is `.mem-actions`, inside `.mem-row-meta`. Caught by re-measuring, not
by reading.

**Suggestions: nested padding, not a component bug.** Per side = panel 32 +
card 32 + sub-panel 24 + mem-row 24 = **112px, 57% of a 390px viewport** →
text measure **135px** (~19 chars/line). Because the measure was that narrow,
each suggestion's Confirm/Edit/Reject stacked into a **148px button column**,
making one suggestion **450–471px** tall.

**Legibility floor.** The Memory view was **missed by M12's pass**: Personas
moved its meta line, hints and chips off 12px; Memory kept `.mem-privacy`,
`.mem-evidence`, `.mem-row-meta`, `.mem-chip`, `.mem-tag-inuse`, `.mem-cap-note`
and `.mem-control-copy` at 12px. DESIGN.md reserves that step for uppercase
context labels, so the same components disagreed between two views.

## Result

| measure | before | after |
|---|---|---|
| Memory controls card | 1483px | **1056px** |
| control row heights | 198 / 291 / 231 / 411 | **141 / 250 / 162 / 183** |
| control text column | 50 / 183 / **11 / 9** | **263px** (all four) |
| Suggestions panel / measure | 231 / 183 | **295 / 263** |
| suggestion value width | 135px | **231px** |
| suggestion height | 450 / 471 | **293 / 293** |
| suggestion actions | 148px stacked column | **one 44px row** (85/58/72) |
| Profile card | 3501px | **2429px** |
| Memory view total | 5436px | **4075px** (−25%) |
| controls <44px | **12** | **0** |
| body/chip copy | 12px | **14px** |
| `overflowX` | 0 | 0 |

So the view is **25% shorter while the text measure nearly doubles** and the
smallest text got larger — the height came out of nested padding and crushed
columns, not out of density.

## Gate

`ux_audit` **PASSED** — 18 APCA pairs (light + dark), tokens, states, slop
tells. The rework adds no colour declarations.

**One thin margin worth recording:** the destructive label `--danger` on the
light card surface measures **Lc 75.42** against a floor of 75. It passes, but
with almost no headroom — if the surface or danger token is ever retuned, this
pair fails first. Recorded in the M20.A follow-up 2 section of `PLAN-M20.md`.

Suites: typecheck 0 · root **893 passed** (5 skipped) · web **565 passed** ·
build green.

## Still NOT verified

Unchanged: no visual inspection (text-only model) · no real-device walk ·
safe-area insets and on-screen keyboard unproven · the `hover: none` branch not
runtime-exercised · no background/OS notification delivery · whole-file
`ux_audit` outstanding · geometry is a recorded manual pass, not a CI gate.

New, specific to this pass: **the two destructive actions were not exercised**
— I measured "Forget everything" and "Forget before a date" but did not press
them, so the arm/confirm flow is verified as rendered and touch-sized, not as
behaving. That is a deliberate choice (they are irreversible and this is a
seeded demo), and it means the confirm path stays on the manual checklist.

## Recommendation, not a change I made — **→ APPLIED**, see *Applied recommendations §2*

> Superseded later the same session: the reorder was applied after all, at the
> user's direction ("update the app as per recommendations"). Rendered order
> verified in a browser. The reasoning below is kept because it is why the
> change was safe to make.

**Ordering.** "Forget everything" is the *first* row of the Memory controls
card — the most prominent position goes to the most irreversible action, and
it sits one row above "Export", which is the action a cautious user reaches for
first. The safe convention is portability (Export/Import) first and destructive
actions last, behind space. I did **not** reorder it: that is a product
decision about a destructive flow, not a layout fix, and the discipline is to
ask rather than guess. Flagged here and in `PLAN-M20.md` §12.

---

# Applied recommendations (2026-09-12, same session)

Everything above was reported as "recommended but not applied" or "open". This
pass applies the ones that were actually mine to apply, and corrects two claims
of mine that did not survive checking.

## 1. §8.1.1 — the live hole is closed (security, not layout)

**Was:** `core/src/attachments/manager.ts` `assertAllowed()` accepts any
`text/*` upload, including `text/html`; the content route served it `inline`
with a client-declared `Content-Type` and `nosniff`. Because the SPA and the API
share an origin, and the bearer token lives in that origin's `localStorage`, a
document served there could read the token. `nosniff` defends against content
*sniffing*, not against an explicitly declared `text/html`. The realistic
trigger is not an attacker uploading a file — the partner generates an HTML/CSS
prototype (a first-class capability) and the user opens it.

**Now:** one exported policy decides the disposition —
`attachmentContentHeaders()` in `core/src/http/server.ts`:

- `image/png|jpeg|webp|gif` and `application/pdf` stay **`inline`** (the SPA
  renders them in the transcript; PDF display is a real feature).
- Everything else is forced to **`attachment`** plus
  `Content-Security-Policy: sandbox`, giving the response an opaque origin even
  if a client ignores the disposition.

The sandbox is deliberately **not** applied to the inline types: `sandbox`
blocks plugins, which would break the browser's inline PDF viewer. A security
fix must not cost a feature.

**HTML upload itself is unchanged** — the model legitimately reads attached
HTML. Only *rendering it on the app's origin* is refused, and the app's existing
safe path (`CodePreview`, `sandbox="allow-scripts"` and never
`allow-same-origin`) still previews HTML and CSS.

**No feature regression, verified:** the SPA fetches attachment bytes via
`fetch()` with a `Bearer` header (`web/src/lib/attachments.ts` →
`fetchAttachmentContent`), and `fetch()` ignores `Content-Disposition`. Only
*direct navigation* to the URL changes behaviour — which is the vector being
closed.

**Tests:** `core/test/http/attachmentContentSafety.test.ts` (new, 8 cases) —
the inline-safe allowlist including negative cases (`text/html`, `text/css`,
`application/javascript`, `image/svg+xml`, empty), case/whitespace tolerance,
header-injection safety on the filename, HTML served as `attachment` + sandbox
over HTTP, an image still `inline` with no sandbox, and SVG still refused at
upload (415 — pre-existing behaviour, now asserted). Root suite **893 → 901**.

## 2. Memory controls ordering — applied

Rendered order verified in the browser: **Export → Import → Forget before a
date → Forget everything**. Portability first, destructive last, and severity
escalates downward (a dated boundary, then everything). All danger-coloured
rows are inside `.mem-danger-group`; 32px of space separates the groups
(space → background shift → elevation, before a border).

No new heading was invented for the group: the danger-coloured actions plus the
arm/confirm pattern already carry the signal, and a kicker there would be the
tracked-out eyebrow DESIGN.md bans.

Card height 1056 → 1072px (+16px for the separation) at 390px.

## 3. `.preview-frame` — tokenised

`background: #ffffff` was the last raw hex in a declaration. It is now
`--surface-doc` (`SHARED_TOKENS.surfaceDoc`), documented as *deliberately
identical in both modes*: the sandboxed preview renders an arbitrary document
authored against a white canvas, so a theme-tinted canvas would put black
authored text on a dark surface in dark mode. Additive — no existing token
value changed, so user themes stay valid.

**The stylesheet now contains no raw hex in any declaration** (the only two
remaining matches are inside an explanatory comment).

## Two claims of mine that were WRONG — corrected

**1. "Re-filing a conversation on touch has no affordance."** This was wrong.
`.rail-item-move` is a `<select aria-label="Move <title> to folder">`, and the
`@media (hover: none)` rule reveals it — measured present at **66×44** inside
the phone rail overlay. There is no capability gap, and I built nothing for it.
The drag handle removal cost nothing: dragging was never the only path.

**2. "A `--rail-action-w` token would make `max-width: 100px` systemic."** Also
wrong, on reflection. That width is *label-driven* — it exists to fit the
longest action label ("Confirm delete"), so it is not a design decision and
turning it into a token would be false systemisation, not a fix. Left as is,
now documented as intentional rather than as outstanding debt.

## Still outstanding (unchanged, and none of it mine to close here)

No visual inspection (text-only model) · no real-device walk · safe-area insets
and keyboard unproven · `hover: none` not runtime-exercised · no background/OS
notification delivery · the two forget actions were measured but **never
pressed** · the whole-file `ux_audit` run (176 KB payload) · geometry is a
recorded manual pass, not a CI gate. The **thin contrast margin** stands:
`--danger` on the light card surface is **Lc 75.42** against a floor of 75.

## 4. A real contrast defect found while verifying — and my warning was misdirected

Checking the pair I had flagged as "thin", I measured the danger text on each
ground it actually sits on (light mode, APCA):

| pair | Lc | |
|---|---|---|
| `--danger` on `--bg` (control rows) | 80.88 | ✓ comfortable |
| `--danger` on `--surface` | 75.42 | ✓ thin |
| `--danger` on `--surface-2` (**memory entry Delete**) | **69.52** | ✗ **FAILS the 75 body floor** |

So my earlier note was aimed at the wrong pair. The control rows I warned about
measure a comfortable 80.88; the actual failure was one row away, in the
`--surface-2` **entry** rows, where a ghost Delete action sat directly on the
well.

**Root cause is a gap in the design system, not a one-off.** DESIGN.md's M12
P0.3 usage rule says light-mode *accent* text must never sit on a `--surface-2`
well. That rule was written for accent and **`--danger` was never checked as
well** — measured 69.5 there, failing. So this class of bug was reachable by
anyone following the token name rather than the rule.

**Fixed:** the entry Delete control takes its own `--bg` ground, giving
**Lc 80.88** light and **−80.54** dark (it keeps `.btn-danger`'s ghost
treatment; only its ground changes). The rule is now written into DESIGN.md for
`--danger` alongside `--accent`, with the measured numbers and an explicit
instruction to check rather than assume.

**Useful side note:** the initial audit run *failed* on this fix — but only
because I deliberately included the "before" pair (69.52) as a documented
regression guard. Re-run with the fixed state alone, all gates pass. Worth
recording because a reader would otherwise see "FAILED" beside a correct fix.

**Not swept:** this was verified where I had evidence (the Memory view). Other
`--danger`-on-a-well combinations elsewhere in the app have not been enumerated.
The DESIGN.md rule now makes them checkable; a sweep of every `.btn-danger`
placement is a separate, mechanical piece of work.

---

# M20.A follow-up 6 — one submit per question set (grouped answers)

Reported bug: a reply containing a radio/choice **and** a set of free-text
questions rendered two cards with two independent submits — **"Confirm"** and
**"Submit answers"** — and pressing either sent a user turn containing only its
own answer, silently discarding the other. The two buttons sat side by side as
if unrelated.

## Cause

`PartnerMarkdown` renders every structured block as its own segment:

```
choice → <ChoiceCard onConfirm={(labels)  => onAnswer(choiceText)} />
form   → <FormCard   onConfirm={(message) => onAnswer(message)}   />
```

Each card owned its own submit, its own validation and its own draft clearing.
Nothing existed at the *message* level, which is the only level that can see
that two containers were asked in one breath.

## Fix

- **`web/src/lib/answer-group.ts`** (new, pure, 15 tests) — the rule and the
  composition: `shouldGroupAnswers(blocks)` is `answerableCount > 1`, so a
  single-container message keeps its existing card button **byte-for-byte**
  (the common case cannot regress). `composeGroupedAnswer` joins each part's
  text with the exact string that card would have sent alone, so the wire format
  is unchanged — only the arrival is. `groupReadiness` blocks submission until
  every part is complete and returns a count-only hint.
- **`web/src/AnswerGroup.tsx`** (new) — owns the single submit; cards render
  inputs only (`showSubmit={false}`) and report their answer upward via
  `onAnswerChange`. Submission flips `answered`, which clears each card's draft
  and locks the group.
- **`ChoiceCard` / `FormCard`** — gained `showSubmit`, `onAnswerChange`,
  `answered`, and (form) `requireAllAnswers`. `onConfirm` became optional,
  because a grouped card must NOT be given a no-op handler to swallow.
- **`Markdown.tsx`** — when grouping applies, all answerable blocks render
  together at the first one's position; prose and asset containers keep theirs.

## Verified end to end through the real chat path

The demo provider cannot emit containers, so I ran a throwaway loopback
OpenAI-compatible stub returning a reply with both a `:::partner.choice` and a
`:::partner.form`, registered it as a provider, and drove the real chat route.

| observation | result |
|---|---|
| `.answer-group` instances | **1** (choice + form as sections) |
| submit buttons in the transcript | **exactly 1** — `Send answers` |
| per-card submits in the transcript | **0** (`.choice-actions button`, `.form-actions button` → empty) |
| initial state | disabled, `"2 answers still needed"` |
| after picking a choice | disabled, `"1 answer still needed"` |
| after 1 of 2 questions | disabled, `"1 answer still needed"` (`requireAllAnswers`) |
| after both questions | **enabled**, hint gone |

**The decisive check — what the one button sends.** Pressing it produced **one**
user turn (`msg msg-user` count 2→3, not two turns):

```
Postgres

Q: What problem are you solving?
A: latency spikes at peak

Q: Who is the primary user?
A: the on-call engineer
```

Previously "Confirm" would have sent only `Postgres`, and "Submit answers" only
the Q/A pairs. **All answers now arrive together.**

## A second issue found by verifying, and closed

With one prominent button the answered group stayed live and could be sent
again, posting a duplicate turn — a risk the two small buttons did not carry.
Now `answered` locks the group: button reads **"Answers sent"** and is disabled,
the hint clears, and **every input inside the group is disabled** (verified
`inputsDisabled: true`). A forced press on the locked control produced no
additional user turn (3 user turns before and after).

## Honest limitations

1. **The lock is per page session.** Whether a card was answered is not
   persisted (the transcript message carries no answered marker), so a reload
   makes an answered group answerable again. This is the pre-existing behaviour
   of the standalone cards and is unchanged by this work — fixing it properly
   means a message-level answered marker, which is a separate decision.
2. **Grouped forms require every question; standalone forms do not** (they
   accept any non-empty answer). Deliberate and documented in the prop: the
   point of one grouped submit is a complete answer set in one turn, whereas an
   unaccompanied form can send partial answers with nothing to lose alongside.
   Easy to flip if you would rather they match.
3. **No vision check** (text-only model), and the group was verified at 1280px
   in the browser — the phone layout rules were audited but not measured for
   this control.
4. **`requireAllAnswers` is not covered by a DOM test** — the gating is
   exercised through the browser above, and the composition/readiness rules are
   unit-tested, but the React wiring itself has no automated harness (the web
   suite is node-only).

Suites: typecheck 0 · root **901 passed** (5 skipped) · web **580 passed**
(+15) · build green · `ux_audit` **PASSED** (16 APCA pairs, tokens, states, slop
tells).

---

# Subagent execution wave (2026-09-12) — lanes, failures, and arbitration

Five lanes were orchestrated against the M20.A follow-ups and M20.B's scoping:
one scout (read-only), three writers, one fresh-context reviewer. This section
records what each produced, **what failed**, and what the parent verified
independently rather than accepting.

## Lane outcomes

| lane | agent | outcome |
|---|---|---|
| `m20b-scout` | scout | ✅ delivered the M20.B breakdown → now durable as `PLAN-M20-B.md` |
| `guards-writer` | worker | ✅ `web/test/security-guards.test.ts`, 19 guards |
| `danger-writer` | worker | ❌ **produced nothing** — see below |
| `answered-writer` | worker | ✅ transcript-derived answer lock |
| `final-review` | reviewer | ✅ found 2 MAJORs the parent had missed |
| `danger-writer` (retry, `fresh`) | worker | ✅ 16 selectors swept + full enumeration |

## Lane infrastructure failure (not a code failure)

The first `danger-writer` ran **49.8 s** and returned a *parent-voice review of a
different lane*, editing nothing. Run `0be515d3`, workflow
`926b28ff-c518-473e-a380-145707022f50`, cwd the repo root, isolation `none`
(the tree is dirty so worktrees were unavailable), no partial diff (verified:
`app.css` unchanged at 8615 lines, last danger content the parent's own fix).

**Cause hypothesis:** `worker` is declared `context: fork`. The child inherited
the parent transcript — whose most recent content was the parent's own triage of
the guards lane — and continued the parent's reasoning instead of executing its
prompt. The 50-second runtime is corroborating evidence: 38 selectors with
surface tracing cannot happen in 50 s.

**Remedy:** a same-protocol retry with `context: 'fresh'`, which succeeded. **No
mode switch** was made (no foreground/CLI fallback). Lesson: forked *writers*
are unreliable when the parent transcript is rich; pass `context: 'fresh'` for
mutation lanes.

## Reviewer findings and parent arbitration

The reviewer had no shell, no `ux_audit` and no browser, so its contrast figures
were hand-computed (≈81.6/≈70.9 vs the gate's 80.88/69.52 — same verdict, minor
arithmetic drift) and it explicitly listed what it could not verify. The parent
ran every gate it could not.

**Two MAJORs — both confirmed, both fixed:**

1. **`.answer-group-parts` had NO CSS rule.** The wrapper existed in the TSX
   while the CSS block put `gap` on `.answer-group` and zeroed the cards'
   margins, so the two question sets rendered with **0px separation** —
   contradicting the block's own claim that "separation is the panel's gap".
   *This was the parent's own bug and its own verification miss:* the group's box,
   buttons and inputs were measured, but never the distance **between its parts**.
   Fixed, and the lesson is recorded in the file.
2. **No test rendered `AnswerGroup`.** Deleting `showSubmit={false}` would have
   restored the original two-submit bug **with the whole suite green**. The
   reviewer also demolished the excuse used to avoid such tests: `markdown.test.ts`
   already renders these components via `renderToStaticMarkup`, so "no DOM
   harness" was a false premise. Added `web/test/answer-group-render.test.ts`
   (+10), then **falsified it**: with `showSubmit={false}` removed, 2 tests fail on
   *"not to contain 'Submit answers'"* — the bug returning. The claim was true of
   the old suite and is now closed.

**Also fixed:** the guards doc comment's false premise; the storage-census
comment which claimed it catches "any new key added anywhere" when it matches
`partner.`-prefixed literals only, and `App.tsx:888/895/984` calls
`sessionStorage` directly, bypassing the storage wrapper.

**Rejected:** nothing outright. The three nits the reviewer raised against the
guards file were **cleared in the same session** rather than deferred:

- **`declaredKeys()` duplicated in the non-vacuity proof** — `STORAGE_ALLOWLIST`
  was lifted to module scope and a shared `declaredPartnerKeys()` helper
extracted, so the proof now drives the SAME scan and the SAME list it is
proving. (Lifting it also surfaced a real bug: the regex had become
`/^partner./` instead of `/^partner\./` during the edit, which would have
false-positived on any literal merely *starting* with "partner". Fixed and
verified.)
- **Unbounded `<ReactMarkdown` slice** — `split('<ReactMarkdown').slice(1)`
  returned everything to EOF, so the LAST usage swallowed the file and a
  `rehypeSanitize` appearing anywhere later satisfied the guard. Replaced with a
  brace-depth-aware scan bounded to each opening tag, which is strictly stronger.
- **Wrong `strip`/`clobber` rationale** — corrected: those keys *override*
  inherited behaviour (element removal, id-collision handling) rather than
  loosening sanitisation; the invariant is that the schema is an *extension* of
  the default.

Also corrected: two places claimed "the components only render in a browser, so a
source assertion is the only route" — false in this repo, which renders them via
`renderToStaticMarkup`. The comments now say source assertions are used where the
property is genuinely a property of the source.

## Contrast — the sweep, verified by the gate

All 16 swept selectors now rest on `--bg`: **Lc 80.88** light / **−80.54** dark
(was 69.52 on `--surface-2`). The gate also found two **pre-existing** defects in
the attachment chip, both fixed as token-only swaps:

| element | before | after |
|---|---|---|
| `.attach-chip-preview` accent on `--surface-2` (12px) | **69.02** ✗ (violates DESIGN.md M12 P0.3, which names `--accent-hover` for surfaces) | `--accent-hover` → **77.08** ✓ |
| `.attach-chip-meta` `--text-faint` on `--surface-2` (12px) | **68.86** ✗ (faint is exempt for disabled/placeholder only; a file size is neither) | `--text-muted` → **81.40** ✓ |

## Corrections to lane claims

- **Audit-actor risk was overstated by the scout.** The audit actor is mostly a
  literal at the call site; only **7 `actorOf()` sites** would change, and **no
  test asserts a live `'web'` actor**. The "do not widen `kind`" conclusion
  stands, for the sharper reason recorded in `PLAN-M20-B.md` §2.1.
- **The sweep's "dead rules" method was unsound.** `.mem-chip-danger` and
  `.skill-chip-danger` were classified unused because no literal reference exists
  — but both are reached through **computed** class names
  (`mem-chip-${tone}`, `kindTone('rule') === 'danger'`). They pass only because
  the chip carries its own `--bg` ground, **not** because they are unused. A grep
  for a class literal cannot prove a class is dead.

## Gates at the end of the wave

typecheck **0 errors** · root suite **901 passed** (5 skipped) · web suite
**618 passed** (38 files) · web build green · `ux_audit` **PASSED** (tokens,
states, slop tells, and every contrast pair above).

## Still outstanding (unchanged and explicit)

No visual inspection is possible in this session (text-only model) — every
judgement above is measurement or a deterministic gate. Not verified: real-device
walk; safe-area insets and on-screen keyboard; the `hover: none` branch at
runtime; background/OS notification delivery; the whole-file `ux_audit`;
geometry as a CI gate. The two irreversible Memory forget actions remain
**measured but never pressed**. The census's blind spot is now **narrowed and
precisely stated**: inline key literals passed to storage calls are covered by a
new extractor (with its own non-vacuity proof), while a key held in a *variable*
— which is what the current call sites pass — remains invisible to any source
scan, and that is documented rather than pretended away. And M20.B itself was
**scoped with every gate decided** at the time of this record — it has since been
**implemented in two waves** (S1/S2/S2a/S3, then the S4/S5/S6 wiring); see
`docs/VERIFY-M20-B.md` for the current state and `PLAN-M20-B.md` §3.0 for the
slice status.

---

# M20.A follow-up — phone persona picker (reported bug, 2026-09-13)

## What was wrong, measured at HEAD @390×844

The persona list *rendered* and *responded*; it was the geometry that failed, and
there was no overflow to warn anyone — the option rects were all in the layout
tree, just painted outside a 60px window.

| measurement | value |
|---|---|
| `.picker-pop` laid out | **655px tall** (9 personas × 71px + padding) |
| painted band (`.app-topbar-right`) | **60px** — `overflow-x: auto` forces `overflow-y: auto` |
| options visible | **1 of 9** (plus a sliver of the second) |
| bar `scrollTop` after the open-time `focus()` | **65px** — the trigger left the screen |
| bar `scrollHeight` while open | **715px** (the popover grew the scroll box) |

Cause: the phone top bar is a horizontal scroller, so an absolutely positioned
popover is clipped to the bar's own band. The open-time `focus()` on the first
option then scrolled the *bar*, hiding the control the user had just pressed.

## The fix (two holes, not one)

1. **≤640 tier — the list is a bottom sheet, like the More control.** `position:
   fixed` escapes the scroll box; full width; `bottom: calc(var(--bottom-nav-h) +
   var(--safe-bottom))`; `max-height: 60dvh` + `overflow-y: auto`; rows `flex:
   none` so a bounded panel scrolls rather than squashing rows below the 44px
   floor; the scrim takes the More sheet's tint because the sheet covers 60% of
   the screen. Motion is `sheet-rise`, and `.picker-pop` joined the file's
   **top-level** reduced-motion list instead of getting a nested copy.
2. **Every width — the base popover is now height-bounded.** A landscape phone
   (844×390) is **outside the width-based ≤640 tier**, so it received the
   absolute popover with no height bound and a 655px list ran off a 390px
   viewport. `max-height: calc(100dvh - var(--topbar-compact-h) - …)` +
   `overflow-y: auto`, token-only.

## Measured after (real demo personas, same session)

| viewport | position | panel | fully in viewport | last option reachable | row height |
|---|---|---|---|---|---|
| 360×640 | fixed | 0,200 → 360,584 | ✅ | ✅ | 71px |
| 390×844 | fixed | 0,282 → 390,788 | ✅ | ✅ | 71px |
| 844×390 | absolute | 480,60 → 800,370 | ✅ | ✅ | 71px |
| 768×600 | absolute | 404,60 → 724,580 | ✅ | ✅ | 71px |
| 1280×900 | absolute | 811,57 → 1131,712 | ✅ | ✅ | 71px (unchanged desktop) |

Also verified in the browser: the bar no longer grows while the sheet is open
(`scrollHeight` 715 → **60**, `scrollTop` 60 → **0**); selecting `Researcher`
updated the trigger to `R / Suggest`; tapping the scrim closed the sheet without
selecting; `prefers-reduced-motion: reduce` gives `animation-name: none` while
the default is `sheet-rise 0.18s`.

## The guard, and its non-vacuity proof

`web/test/picker-mobile.test.ts` (**7 tests**) asserts what CSS text can carry:
the phone tier really sets `overflow-x: auto` on the bar (the cause), the phone
`.picker-pop` is `position: fixed` and anchored via `--bottom-nav-h` and capped,
the base popover is `absolute` + `calc(100dvh - …)` bounded, rows are `flex:
none`, `.picker-pop` appears in a reduced-motion block, and the phone scrim is
tinted. Comments are stripped before matching, so the fix's own prose cannot
satisfy a guard.

**Falsified, not assumed:** reverting the phone rule to `position: absolute`
failed exactly one test — "the phone list is viewport-anchored, so the bar cannot
clip it" — and the file was restored byte-identical afterwards.

## Honest limitations

1. **No vision check** — this session was text-only. Every judgement above is a
   numeric measurement (`getBoundingClientRect`, `scrollHeight`, computed style)
   or a deterministic gate. The sheet was never *seen*.
2. **The whole-file `ux_audit` is still outstanding** (191KB payload — the same
   acknowledged gap as the earlier M20.A work). The audit was run on the picker
   rules with 8 explicit APCA pairs, the states present on that surface, and the
   slop-tell scan: **PASSED** (light `Active` on the selected `--surface` row Lc
   82.97, dark −87.06; focus rings 80.37 / −88.04).
3. **Geometry is still a recorded measurement, not a CI gate.** The new test
   guards invariants in the stylesheet text; it cannot measure a viewport. Real
   geometry still needs a browser.
4. **No real-device walk** — safe-area insets and on-screen-keyboard behaviour of
   the sheet are unproven (the sheet is anchored to `--bottom-nav-h +
   --safe-bottom` and capped with `dvh` precisely so both should hold, but
   neither was exercised on hardware).
5. **Only the top-bar picker was measured.** `PersonaPicker` has exactly one call
   site (`App.tsx`), so nothing else was in scope.

Suites: typecheck 0 · root **1215 passed** + 5 skipped (150 files) · web
**642 passed** (42 files, was 635 in 41) · `ux_audit` **PASSED** (picker rules,
8 pairs).

## Environment observation — **DIAGNOSED and FIXED** (was: "undiagnosed")

*What was recorded at the time (2026-09-14), kept verbatim because the reasoning
matters more than the conclusion:*

With a **dev core already running** on :4390 (`npm run dev:core`),
`core/test/http/userPartitions.test.ts` failed **5/5** at
`(server.address() as { port: number }).port` — `address()` was `null`, i.e.
`startServer` resolved with a server that was not listening. With no dev core
running the same file passed **5/5** with no other change. The interval behaviour
is a real observation, not a guess about its cause; the config asks for `PORT:
'0'`, so an ephemeral-port clash does not obviously explain it.

*That reading was half right, and the half it got wrong is the interesting part:*
the port clash WAS the cause — but through `PORT=0` being silently ignored, not
through the port the test asked for. **The five failures were fixed in v0.1.11**,
so the old workaround ("run the root suite with no dev core up") is obsolete.

*Re-run to prove it, with the very process that used to break it*: a `tsx watch
src/index.ts` dev core (started the previous morning) was holding :4390 while
`core/test/http/userPartitions.test.ts` ran — **5/5 passed**, and a second core
told to bind 4390 in that state now says `partner-core failed to start: listen
EADDRINUSE: address already in use 127.0.0.1:4390` instead of printing an "up on
…" banner it could not honour.

**The two causes, found 2026-09-15 by starting from the observation above (two
real defects, not a test quirk):**

1. **`app.listen(port, host, callback)` calls that callback even when the bind
   FAILED** (Windows, Node 25), and `core/src/index.ts` `listen()` took readiness
   from it — so a core whose port was taken resolved `startServer`, printed "up on
   …" and served nothing, and the real `EADDRINUSE` was swallowed because its
   `reject` arrived after the promise had already settled. That is the `null`
   address: **the "ephemeral-port clash" did explain it** — just not through the
   port the test asked for. Fixed: readiness comes from the `listening` event and
   failure from `error`, so a taken port now **rejects the boot by name**
   (`core/test/listen.test.ts`).
2. **`PORT: '0'` was silently 4390.** `readInt` falls back to the default for any
   out-of-range value, so three core test files (and this one) asked for an
   ephemeral port and got the default — which is exactly why a dev core on 4390
   broke them, and why they passed on a quiet machine. `loadConfig` now REFUSES a
   malformed or out-of-range `PORT` (0 included, with the reason: the loopback
   allowlist is derived from it), and those tests bind a **named free port**
   (`freePort()` in `core/test/helpers.ts`).

Teardown in that file also needed `closeServer()` (close **and drop keep-alive
sockets**): `server.close()` alone waits for a socket to idle out, which blew the
10s hook budget and left the SQLite handles open for the temp-dir cleanup to hit
`EPERM`. Windows root suite: **1254 passed / 5 failed → 1262 passed / 0 failed**.

---


# The top bar owns the chrome — Assets + Theme moved up (reported, 2026-09-13)

## What was reported, in order (both measured)

1. *"Assets seems redundant. There's one at the top, and another near chat input."*
2. Criterion for choosing between them: **maximise chat input width**.
3. Final direction: **"move Theme and Assets to top."**

## Finding 1 — one action, three controls

| control | place | measured @390×844 | binds |
|---|---|---|---|
| `Show assets panel` | top bar icon | 49×44 at y **8–52** | `toggleAssetsLane` → `assetsLaneOpen` |
| `Assets` / `Hide Assets` | chat bar, above the composer | 73×44 at y **631–675** | same handler, same state |
| `Hide assets panel` | inside the pane (`.assets-lane-close`) | only when open | `onClose` |

The first two were on screen simultaneously, **579px apart**, and disagreed on
enabled state: the pane is conversation-scoped (`listAssets(token,
conversationId)`), so the chat-bar button is `disabled` without an active
conversation while the top-bar icon was always live.

## Finding 2 — what the width criterion actually showed

| state | chat input width |
|---|---|
| phone 390×844, pane closed | 222px |
| phone, pane open | **222px** — unchanged (`position: absolute` overlay) |
| desktop 1280×900, pane closed | 682px |
| desktop, pane open | **366px** (−316px, −46%) |

The pane's width is the only lever on input width, and the **ungated top-bar
icon** was the one control that could pull it with nothing to show: with no
conversation it opened a 300px column rendering one line, *"Open a conversation to
see its saved assets."*, for 682 → 366px of input.

## The resolution

Both controls live in the **top bar**, which is also the shell's stated design
(app.css M14: *"a slim top bar (persona picker + lane/theme controls)"*). The
assets toggle **keeps the conversation gate**, so the empty-pane width theft stays
closed. The row above the composer keeps only conversation-context — brainstorm
state + Conclude/Reopen, and the save-to-assets flash — and renders **only when it
has content**, so a plain chat has no row at all.

Implementation: `App.tsx` gained the assets toggle (gated) and a
`.topbar-theme-select`; `ChatStrip` lost 5 props (`assetsOpen`,
`onToggleAssets`, `themes`, `activeThemeId`, `onBindTheme`) and the
`ThemeProfile` import; `.chat-theme-label` / `.chat-theme-select` became
`.topbar-theme-select`.

## Measured after (styled page, real demo store)

| check | result |
|---|---|
| desktop 1280×900, conversation active | 6 controls, **523px** in a 1008px row, **no scroll**; theme select 111×25 (`preset-default`); transcript 655px |
| phone 390×844, conversation active | 6 controls, **318px** of controls in a 358px content row, **no scroll**; last control's right edge 374 ≤ 390 |
| phone, no conversation | 5 controls (theme select not rendered), assets toggle `disabled`, no scroll |
| **transcript, phone** | **513 → 565px** — the deleted row was 52px directly above the composer; the transcript→composer gap is now the composer's own 34px padding |
| **theme bind** | chose "Midnight" → select `preset-midnight`; **survived a reload** (re-opened the conversation, select still `preset-midnight` / "Midnight") |
| chat row | absent in every state above |

## The one trade the phone row forced

With the level chip present, the phone row measured **348px of controls + 40px of
8px gaps in a 358px content box**, which clipped the **mode toggle by 14px** — and
a partially cut control at rest reads as broken, not as a scrollable row. So
`.picker-trigger .picker-level` (31px + its 8px gap) is hidden at ≤640: it is the
one control whose information the picker sheet repeats for every persona.

**`Paused` deliberately does not yield.** A paused persona refuses chat, and that
state must never require a tap; the two chips were therefore split into separate
classes (`chip picker-level` vs `chip`) instead of hiding all chips.

## Guards, and their non-vacuity proofs

- `web/test/assets-lane-controls.test.ts` (**5**) — one control per concern; the
  top bar holds the assets toggle; the toggle's `disabled` expression is gated on
  `activeConversationId === null`; the theme select's `aria-label` appears exactly
  once and `ChatStrip` carries neither `onToggleAssets` nor `onBindTheme`; the pane
  keeps `/onClose`; `toggleAssetsLane` appears exactly twice.
- `web/test/picker-mobile.test.ts` (**+1**, now 8) — the level chip has its own
  class, the phone rule hides only that class, and `Paused` is not hidden.

**Falsified, not assumed:** re-wiring a second `onClick={toggleAssetsLane}` failed
**2 of 5** assets guards; merging the level chip back into `.chip` failed **1**
picker guard. Both files were restored byte-identical (verified with `diff`).

## Honest limitations

1. **No vision check** (text-only session) — every number above is a
   `getBoundingClientRect`/computed-style read. The screens were measured, never seen.
2. **Source guards, not render tests** — the web suite is node-only, so the guards
   protect the *wiring* (one control, the chip split), not the geometry. Geometry
   was measured once in a browser and is recorded here; it is not a CI gate.
3. **Dev-server trap, and it invalidated two passes:** editing `web/src/app.css`
   makes this Vite dev server serve the stylesheet **module** empty
   (`__vite__css = ""` while `?direct` still returns the full 202KB file), so the
   app silently loses **all** styling until `npm run dev:web` is restarted — a page
   reload does not fix it. The unstyled page renders 16×21px buttons in Times New
   Roman, which produced plausible-looking but meaningless geometry (once as
   "the rows fit", once as "the rows overflow"). Every number above was taken
   after a dev-server restart with a style-check (`body` font = Inter,
   `.app-topbar-right` display = flex) as the first assertion. **Restart the web
   dev server after editing app.css.**
4. **Tablet widths were not re-measured** for this change; the top bar is the same
   DOM there with an icon rail, and the theme select keeps its 168px desktop cap
   (only ≤640 is tightened to 76px).
5. **The demo conversation used to exercise the gated controls was deleted**
   afterwards (204, store back to 0 conversations) — so the bind proof above was
   the only write.

Suites: typecheck 0 · web **648 passed** (43 files, was 642 in 42).

## Tap-outside dismissal for the floating panes (M20.A follow-up 9)

Requested behaviour: *"when side panel (either side) is opened, touching outside
the panel should slide back the panel into hiding."* Verified 2026-09-14 with a
throwaway demo core (`PORT=4391 DEMO_MODE=1`) plus
`VITE_CORE_URL=http://127.0.0.1:4391 npx vite --port 5199`, paired in the
persistent browser profile, measured with `getBoundingClientRect` +
`getComputedStyle` + `elementFromPoint`.

### Measured, per tier

| viewport | state probed | measurement |
|---|---|---|
| 390×844 | rail open (left) | `.rail` absolute, z-index 30, **320×728 at x=0**; `.panel-scrim` **390×728 at y=60** (the top bar's bottom edge), z-index 25 → the toggles stay live and undimmed |
| 390×844 | tap at (370, 500) | `rail-exiting` on the workspace, **scrim gone on the tap**, `elementFromPoint` = `.chat-transcript`; then `.rail` `display:none`, `.chat` **390px wide**, toggle reads "Show conversations" |
| 390×844 | notes open (right) | `.notes-mini` absolute, z-index 30, **272×728 at x=118**; scrim 390×728 → the transcript reserves no column |
| 390×844 | tap at (30, 500) | notes `display:none`, **0** scrims, `.chat` back to 390px, toggle reads "Show notes panel" |
| 390×844 | rail open → open notes | rail closed, notes open (**1** scrim) — the two overlays overlap by 202px, so they never coexist |
| 390×844 | notes open → open rail | notes closed, rail open (**1** scrim) |
| 700×900 | notes floating + rail column | scrim present; tap dismisses the lane and the **200px rail column survives** (the mutex is tier-gated, not global) |
| 1280×900 | rail column + notes column | **0** scrims; click at (640, 500) closes nothing (288px + 232px columns unchanged) |

### Frame-by-frame exit (rAF sampling, 390×844)

Tap → `rail-exiting` → rail x: **0 → −83 (−39ms) → −204 (−72ms) → −273 (−106ms)
→ −306 (−139ms) → −319 (−173ms)** → at **208ms** the state closed
(`rail-hidden`, `display:none`). The travel is the pane's own width, i.e. the
exit mirrors the entrance; `--motion-base` is 180ms and `PANEL_EXIT_MS` is
asserted equal to it. `overflowX` was **0** at every sample (the `overflow-x:
clip` on `.chat-workspace` keeps the travel out of the document's scroll area).

### Suites and gates

**M20.A geometry gate re-checked** after the change (the added `overflow-x: clip`
and the entry/exit animations touch the workspace box): overflowX **0** and
**0** controls under 44×44 at 360/375/390/430/768/1024; `.chat` full-bleed at
every phone width (360/375/390/430); composer input **192 / 207 / 222 / 262px**
at 360/375/390/430 — the same numbers as the top-bar follow-up, so the gate
("composer width ≥ 296px at 360, ≥ 320px at 390" on `.chat-form`, measured
328/358) still holds and nothing was traded for the dismissal.

typecheck **0** · web **689 passed / 46 files** (was 673 in 45; `panels.test.ts`
+16) · `npm run build -w web` green · root suite unchanged except the
**pre-existing** Windows-only `core/test/http/userPartitions.test.ts` hook
failure (reproduced identically on a clean checkout: `EPERM` removing its temp
dir, plus a 10s `afterEach` timeout) — **since diagnosed and fixed, v0.1.11: see
“Environment observation — DIAGNOSED and FIXED” above** · `ux_audit` **PASSED** on
the new block and the extended consolidated reduced-motion block.

### Guards and falsification

`web/test/panels.test.ts` — behavioural for `floatsOverTranscript` /
`floatingPanels` / `dismissTarget` (including the load-bearing `null` on desktop,
where a tap on the transcript must never close a column); source guards for the
scrim wiring, the cascade order (the exit rule must be declared **after** the
entry rule, since both match while a pane leaves at equal specificity), the one
scrim value, and reduced-motion coverage of every moving selector; and a re-read
of `app.css` + `shared/src/theme.ts` so 640/760/180ms cannot drift.

**Falsified, not assumed:** `floatsOverTranscript` returning `true` failed **2**
tests; swapping the entry/exit animation declarations failed **2**; wiring the
scrim to `() => undefined` failed **1**. All three were reverted (the tree is
back to the reviewed diff).

### Honest limitations

1. **No vision check** (text-only session) — the proof frames are measured, never
   seen, exactly as noted above. The scrim's *tint* is therefore unverified by
   eye; it is the same expression as the More sheet and the phone persona sheet.
2. **`prefers-reduced-motion` was not runtime-exercised** — the browser was not
   switched into that mode. The branch is a single early return
   (`reduceMotion || !floatsOverTranscript(...)`) and the CSS half is asserted;
   the *wait* half is not measured.
3. **`overflow-x: clip` is Safari 16+** — older engines lose the clip (the exit
   travel could briefly extend the document's scroll area at tablet widths, which
   is the pre-change behaviour, not a new failure). Not exercised on Safari.
4. **Touch input was simulated** with a mouse click at the tap coordinates (the
   scrim is a plain `onClick` surface, so the synthetic path matches; a real
   touch was not available in this session).
5. **The `assets` pane's open path was not re-measured** at phone width (it is
   gated on an active conversation and the demo store has none) — its overlay and
   dismissal share the same `panel-scrim` + `assets-pane-exiting` rules as the
   notes lane, which *were* measured.

## Sidebar minimize toggle (M20.A follow-up 10)

Requested behaviour: *"for tablet view/desktop view, allow minimizing the side
menu to icons only, so that when toggled, we can maximize usable view."* Verified
2026-09-14 against the same throwaway demo core (`PORT=4391 DEMO_MODE=1` +
`VITE_CORE_URL=http://127.0.0.1:4391 npx vite --port 5199`), measured with
`getBoundingClientRect` / `getComputedStyle` / `elementFromPoint`.

### Measured

| viewport | state | measurement |
|---|---|---|
| 1440×900 | expanded (default) | `.app-side` **224px**, `.app-col` **1216px**, 10/10 labels + brand + group titles visible, control **49×33** at x=143 (mouse tier, no 44px floor above 1150), label "Minimize menu" `aria-pressed=false` |
| 1440×900 | after **Minimize menu** | class `app side-minimized`, `.app-side` **60px**, `.app-col` **1380px** (**+164px** reclaimed), 10/10 labels + brand + titles computed `display: none`, each `.side-tab` **44×49** at x=8, its icon at **x=22** (centred), toggle "Expand menu" `aria-pressed=true`, `overflowX` 0 |
| 1440×900 | minimized, one attention item present | memory badge **`1`, 24×28**, `display: block`, inside the 44px button **and** inside the 60px rail (`elementFromPoint` at its centre returns the badge → painted, not clipped) |
| 1440×900 | minimized after a **reload** | `sessionStorage['partner.sideMinimized'] = '1'` and the shell came back `app side-minimized` — the choice is session-persisted |
| 1024×900 | fresh load, storage key removed | **default is `app side-minimized`** (60px rail), 10/10 labels hidden, toggle **49×44** (touch floor), **0** sidebar controls under 44×44, `overflowX` 0, badge still `1` |
| 1024×900 | after **Expand menu** | `.app-side` **200px** (the ≤1150 tuning, *not* the desktop 224), labels + brand + titles visible, `.app-col` 824px, composer **450px**, `overflowX` 0 |

The attention item used for the badge row was a real one created through the
app's own API (`POST /v1/memory/profile` with `source: 'partner_suggestion'`,
HTTP **201**) — not a stubbed DOM node. Getting there also re-paired the browser
against this core: the profile's stored token belonged to an earlier demo run, and
`POST` answered **401** until the demo pairing code was re-entered. Worth knowing
before trusting a stale tab.

### Suites and gates

typecheck **0** · web **699 passed / 47 files** (was 689 in 47; the new
`sidebar-collapse.test.ts` is +10) · `npm run build -w web` green · root suite
unchanged except the **pre-existing** Windows-only
`core/test/http/userPartitions.test.ts` hook failure (identical on a clean
checkout) — **since diagnosed and fixed, v0.1.11: see “Environment observation —
DIAGNOSED and FIXED” above** · `ux_audit` **PASSED** on the new block (with the
stylesheet's global `prefers-reduced-motion` fallback included — without it the
audit correctly reports "motion with no fallback"; the sidebar adds no transition
of its own).

### Guards and falsification

`web/test/sidebar-collapse.test.ts` — the state/`--side-w` knob (no literal width
on `.app-side`), the tier changing **only the default** (a bare `.app-side` rule
in the media query fails it), the badge never being `display: none` in any block,
the 44px floor on the toggle, the *absence* of a width transition, and source
guards for the wiring (toggle inside the sidebar head, `aria-pressed`, action
label, chevron direction, `readSession`/`writeSession`, the tier-crossing effect,
the `title` on icon-only items).

**Falsified, not assumed:** adding `display: none` to the minimized badge failed
**1**; collapsing the tier rule back into a bare `.app-side` failed **1**;
removing `aria-pressed={sideMin}` failed **1**; `readSession(SIDE_MIN_KEY)` →
`null` failed **1**. All four were reverted (the tree is back to the reviewed
diff). Useful trap found while doing this: the working copy has **CRLF** endings,
so a `\n`-based mutation script silently changes nothing — the first "falsified"
attempts were no-ops until the patterns were made newline-agnostic.

### Honest limitations

1. **No vision check** (text-only session) — every number is a bounding-box or
   computed-style read; the rail's badge in its corner is measured, not seen.
2. **The 641–760 band with the sidebar expanded was not re-measured.** The
   expanded width there is the same 200px the tablet tier sets, and the composer
   was measured at 1024 (450px); at 700px an expanded sidebar would leave much
   less room, which is why the *default* at that width stays the rail.
3. **The badge corner at the 52px rail width (≤760) was not measured.** It is the
   same absolute rule that measured 24×28 inside a 44px button at 60px.
4. **`pointer: coarse` was not emulated** — the touch floor asserted here is the
   viewport-based ≤1150 rule, not the coarse-pointer one.
5. **The tier-crossing effect was exercised only by the fresh-load path** (clearing
   the stored key and reloading at 1024, which is the same code path as a resize
   across the boundary); a live drag-resize across 1150 was not performed.
