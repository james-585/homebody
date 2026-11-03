# HomeBody design system (proposal for M2)

Status: **Proposal. Direction questions 1 to 4 decided by James on 2026-11-03, in chat (see Decisions); questions 5 and 6 still open.** Author: product-designer, 2026-11-03. Branch `claude/design-system-m2`.
Source: the "HomeBody Premium Design" canvas (four dark boards: Train, Live workout, Rest timer, Progress, each with four accent options). This document is the design system that earlier specs call `docs/design/system.md`. Machine-readable values are in [tokens.json](tokens.json); every contrast figure below was computed from that file.
Scope: docs only. Nothing here changes `index.html`, `src/`, `sw.js` or tests. Implementation is staged (section 7) and each stage needs its own task plan and human approval.
Principles served: 2 (estimates labelled, safety copy visible), 5 (offline: no remote fonts or assets), 7 (logging speed: one tap per set at "same as last time"), and the accessibility rules in the product-designer brief.

## Decisions (James, 2026-11-03, in chat)

Relayed to product-designer by the coordinating session. Each stage still needs its own task plan and approval.

1. **Accent: ship the four-colour picker** (ember, amber, green, blue, as on the canvas), not ember only. Ember is the default. The picker is part of the M2 token plan (sections 2.2 and 7.2).
2. **Light theme: yes, as a full peer.** New installs follow the system setting; existing users keep their current choice (section 4).
3. **Keep Oswald.** The timer and stepper jitter is fixed with fixed-width digit cells (section 2.3).
4. **Before M2: stage A only** (token aliases, zero visual change), and only if the architect can fit it into an existing M1 task safely. Otherwise it is the first M2 task (section 7.2).

Not yet decided: Q5 (kcal headline) and Q6 (FAB outside workouts), section 8.

---

## 1. Direction

**A tool for the garage, not a dashboard.** HomeBody is used at arm's length, in glare, with one chalky thumb, between sets. "Premium" here means calm, confident and fast, not decorated:

- **One job per screen, one big action.** Each screen answers one question (What today? Log this set. How long do I rest? Am I getting stronger?) and puts its single primary action in a 60 to 72 px accent bar in the bottom third, where the thumb already is.
- **Huge numerals and few words.** Oswald numerals at 60 to 92 px for the values that change mid-set (weight, reps, rest time). Readable from a phone propped on the floor.
- **Warm, dark, quiet ground.** Near-black brown ground, one warm accent, no gradients, no glow, no emoji. Separation comes from strong borders and spacing, not from shadows (shadows disappear on dark grounds and in sunlight).
- **Honest by design.** Estimates are marked with `~` and the word "est." and they explain their rule. Grades say what they are not. Safety copy is on screen, never hidden behind an icon.
- **Motivation without manipulation.** Real PRs and weekly consistency are celebrated. Rest days are neutral, never "missed". There are no streak penalties.
- **Two themes, both measured.** Dark is the default look. Light is a full peer for daylight and glare, not an afterthought.

---

## 2. Tokens

Naming: `--<group>-<key>`, for example `--color-text-muted`, `--space-4`, `--radius-xl`, `--z-sheet`. Values come from [tokens.json](tokens.json). Rules:
- **Every colour is opaque.** No `rgba()` tints behind text, so every pair is measurable. Tints are their own hex tokens (`*-bg`).
- **Components use tokens only.** A hex value in a component rule is a review finding.
- Themes switch on the existing `[data-theme="light"]` attribute on `<html>`. Accent switches on `[data-accent="…"]` (section 2.2).

### 2.1 Colour

| Token | Role | Dark | Light |
| --- | --- | --- | --- |
| `--color-ground` | page background | `#0E0C0A` | `#F5F0E9` |
| `--color-surface` | cards, sheets, bars, toasts | `#181512` | `#FFFFFF` |
| `--color-surface-2` | raised controls (stepper buttons, secondary fill), chart tracks | `#221E1A` | `#EDE5DA` |
| `--color-border` | **decorative only**: dividers, card edges | `#2C2620` | `#DDD3C7` |
| `--color-border-strong` | **functional edges**: secondary buttons, inputs, open chips, unselected toggles | `#7A6A5A` | `#7A6A5A` |
| `--color-text` | all primary text, icons | `#F4EFE8` | `#1A1410` |
| `--color-text-muted` | labels, metadata, captions | `#B5A89A` | `#5E5044` |
| `--color-focus` | focus ring (2 px, 2 px offset) | `#F4EFE8` | `#1A1410` |
| `--color-scrim` | behind sheets and dialogs (opacity from `--scrim-opacity`) | `#000000` at 0.6 | `#1A1410` at 0.4 |
| `--color-success` / `-ink` / `-bg` / `-border` | done, saved, PR, on track | `#5DBE8A` / `#8FD3AE` / `#1B2A22` / `#3C7A5A` | `#2D7A50` / `#22603F` / `#E3F1E8` / `#2D7A50` |
| `--color-warning` / `-ink` / `-bg` | paused, needs attention, estimate caveat | `#F0B84A` / `#F0B84A` / `#2A2414` | `#93590F` / `#7A4A0C` / `#FBEBD0` |
| `--color-danger` / `-ink` / `-bg` | not saved, destructive | `#FF6B6B` / `#FF8A80` / `#2E1A18` | `#B42318` / `#B42318` / `#FBE4E1` |
| `--color-info` / `-ink` / `-bg` | neutral notices, tips | `#6AA7FF` / `#9CC4FF` / `#16202E` | `#2F6BC4` / `#245AA8` / `#E2ECFA` |
| `--color-data-2` | second data series, highlighted stat | `#E0A15A` | `#93590F` |
| `--color-data-track` | empty part of bars and rings | `#221E1A` | `#EDE5DA` |

How the colours are used:
- **Solid** (`--color-success` and the others): markers, bar fills, 2 px edges. **Ink** (`-ink`): text in that colour. **Bg**: tinted fills that carry `--color-text` or the ink.
- **Accent is for action and "current", never for state.** Done, saved, warning and error states use semantic colours plus a shape and words. Ember and danger red are close in hue, so danger is always paired with the circle-`!` marker and words, and a destructive button is never a filled accent-like bar outside a confirm dialog (section 3.1).
- **Muted text is for labels, never for values or instructions.** Anything the user must act on uses `--color-text`.

### 2.2 Accent

The canvas offers four. One is active at a time; the light theme uses a deeper value of the same hue so it passes on light grounds.

| Option | Dark `--color-accent` / `--color-on-accent` | Light | Collides with |
| --- | --- | --- | --- |
| **Ember (default)** | `#FF5A2C` / `#0E0C0A` | `#C2410C` / `#FFFFFF` | danger (hue); managed by marker shapes and words |
| Amber | `#E0A15A` / `#0E0C0A` | `#93590F` / `#FFFFFF` | warning and `--color-data-2` (same value in dark) |
| Green | `#5DBE8A` / `#0E0C0A` | `#2D7A50` / `#FFFFFF` | success (same value): "current" and "done" would look alike |
| Blue | `#6AA7FF` / `#0E0C0A` | `#2F6BC4` / `#FFFFFF` | info (same value) |

**Decided: all four ship as a user choice (Decision 1).** In light, amber's accent equals light `--color-warning` and `--color-data-2` (`#93590F`), green's equals light `--color-success`, and blue's equals light `--color-info` solid. Every accent passes every accent pair in both themes (measured, section 5.1, "Accent options"). The caveats below are rules the components must follow, so the picker never breaks "colour is never the only signal".

**Rules for every accent**
- Accent means **action or current**, never a state. State always has a marker shape (2.10) and words.
- "Current" always has a shape cue as well as colour: the current set chip has a 2 px edge and the word "NOW"; the current progress segment is 8 px tall where the others are 5 px; the current tab has a 3 px top bar and `aria-current`.
- Accent text is allowed only for links and short labels. Values and instructions use `--color-text`.

**Per accent (ratios from section 5.1; dark / light)**

| Accent | Label on fill | Accent text on surface | Accent vs track (rings, bars) | Caveat and rule |
| --- | --- | --- | --- | --- |
| **Ember** (default) | 6.28 / 5.18 | 5.85 / 5.18 | 5.32 / 4.15 | **Close in hue to danger** (`#FF6B6B` / `#B42318`). Danger is always the circle-`!` marker plus words. Destructive buttons are outlined in danger, never filled, except the confirm button inside a confirm dialog. The save-problem bar is identified by its marker and title, not its edge colour. Light: accent text on the ground is 4.57, the tightest pass in the system; prefer fills to accent text. |
| **Amber** | 8.75 / 5.71 | 8.15 / 5.71 | 7.42 / 4.58 | **Same value as `--color-data-2`** (both themes) and **close to warning** (`#F0B84A` dark; identical `#93590F` light). When amber is active, `--color-data-2` switches to the ember values (dark `#FF5A2C`, light `#C2410C`; vs track 5.32 / 4.15, as text on surface 5.85 / 5.18), so two chart series never share a colour. Warning keeps the diamond marker and words; warning notices use `--color-warning-bg` fill, which an accent element never uses. |
| **Green** | 8.55 / 5.24 | 7.96 / 5.24 | 7.25 / 4.19 | **Same value as success**, so "current" and "done" share a colour. Done is carried by the tick, the tinted `--color-success-bg` fill and the word "done" in the accessible name. Current is carried by the 2 px edge on a plain surface plus "NOW". Done progress segments stay success and the current segment is the taller one. The PR badge keeps its star. This board must be reviewed with a colour-blindness simulation before it ships (section 7.1). |
| **Blue** | 7.98 / 5.22 | 7.43 / 5.22 | 6.77 / 4.18 | **Same value as info.** Info notices keep the `i` marker and `--color-info-bg` fill, and never use a button-like accent fill. With blue active, the info marker and edge use `--color-text` so a tip never looks like an action. |

**Picker structure (M2 token plan)**
- **Tokens.** `:root` holds ember. Each other accent is one block: `[data-accent="amber"]`, `[data-accent="green"]` and `[data-accent="blue"]`, each with a `[data-theme="light"]` variant. Each block sets only `--color-accent` and `--color-on-accent`, plus the per-accent overrides above (amber: `--color-data-2`; blue: info marker). Components never read the accent name, only the tokens. Values are in tokens.json under `accent`.
- **Attribute.** `data-accent` sits on `<html>` next to `data-theme`. It is set before first paint, from the stored setting, in the same place the theme is applied today, so nothing flashes.
- **Setting.** Profile, then Appearance: Theme (System, Dark, Light) and Accent. If no value is stored it means ember, so existing data needs no migration step. Whether the value lives in the main document or a separate settings key is for storage-sync-engineer and the architect to decide.
- **Picker UI.** A radio group of four 48 px swatches, each with its name written under it (Ember, Amber, Green, Blue) so the choice is not colour-only. The selected swatch has a tick and a 2 px `--color-focus` ring. Next to the group is a live preview of a primary button and a current set chip. The change applies at once, and is never offered or applied during a workout (the setting is unreachable under the workout layer).
- **Tests.** The contrast check in section 5.1 runs against computed styles for every accent in both themes (four accents by two themes), plus golden screenshots of Workout and Train for each.

### 2.3 Type

Fonts are already self-hosted (`fonts/oswald-latin.woff2`, Oswald 400 to 700 variable; `fonts/inter-latin.woff2`, Inter 400 to 600 variable; `fonts/SOURCES.md`). **No Google Fonts link.** The canvas `<link href="https://fonts.googleapis.com/…">` must not be copied. Inter above 600 is not in the file, so the system never asks for Inter 700.

- `--font-display`: `'Oswald', 'Arial Narrow', system-ui, sans-serif`
- `--font-body`: `'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`
- `--font-mono`: `ui-monospace, SFMono-Regular, Menlo, monospace` (version hash only)

| Token | Use | Family / weight | Size rem (px) | Line height | Tracking | Case |
| --- | --- | --- | --- | --- | --- | --- |
| `timer` | rest countdown | Oswald 700 | 5.75 (92) | 1 | 0.01em | none |
| `numeral` | stepper values | Oswald 700 | 3.75 (60) | 1.05 | 0 | none |
| `display` | exercise name in workout | Oswald 700 | 2.5 (40) | 1.05 | 0 | upper |
| `title-l` | page title | Oswald 600 | 2.25 (36) | 1.05 | 0.01em | upper |
| `title-m` | hero card title | Oswald 700 | 1.875 (30) | 1.1 | 0 | upper |
| `stat` | stat numbers | Oswald 700 | 1.875 (30) | 1.1 | 0 | none |
| `clock` | workout elapsed time | Oswald 700 | 1.625 (26) | 1 | 0.02em | none |
| `title-s` | card and list headings | Oswald 600 | 1.25 (20) | 1.2 | 0 | upper |
| `button-l` | 72 px buttons | Oswald 700 | 1.375 (22) | 1 | 0.1em | upper |
| `button-m` | 60 px buttons | Oswald 700 | 1.125 (18) | 1 | 0.08em | upper |
| `button-s` | 44 to 48 px buttons | Oswald 600 | 0.875 (14) | 1 | 0.08em | upper |
| `body-l` | inputs, key sentences | Inter 400/500 | 1 (16) | 1.5 | 0 | none |
| `body` | list rows | Inter 400/500 | 0.9375 (15) | 1.45 | 0 | none |
| `body-s` | secondary lines | Inter 400 | 0.875 (14) | 1.4 | 0 | none |
| `caption` | notes under charts | Inter 400 | 0.8125 (13) | 1.4 | 0 | none |
| `eyebrow` | section labels | Inter 600 | 0.75 (12) | 1.3 | 0.14em | upper |
| `tab` | bottom-nav labels | Oswald 600 | 0.75 (12) | 1.2 | 0.1em | upper |

Rules:
- **Minimum text size is 12 px (0.75rem).** The canvas's 11 px labels (set-chip "SET 1", stat labels, tab labels, week letters) move to 12 px. Contrast is not the problem: `#B5A89A` on `#0E0C0A` is 8.40:1. Size at arm's length is the problem. Measured: "PROGRESS" as a 12 px tab label is 61.1 px wide, so it fits a quarter of a 375 px nav (about 90 px after the nav's 8 px side padding).
- **Sizes are in rem**, so they follow the user's text size. Display sizes (`timer`, `numeral`) are capped with `min(<rem>, <px x 1.25>)` so they cannot overflow the controls around them, and pinch-zoom (K28) covers further enlargement. All other text grows freely (section 5.3).
- **Oswald has no tabular figures in our subset (measured).** With `font-variant-numeric: tabular-nums`, a "1" is still 38.5 px and a "0" 55 px wide at 100 px. A centred `1:11` (135.5 px at 92 px) and `0:00` (181.1 px) would make the rest timer jitter by about 46 px. Rule: timer and stepper digits sit in fixed-width cells (`display:inline-block; width:0.56em; text-align:center` per digit; the implementer measures the widest Oswald digit). Inter does honour `tnum` (measured 64.7 px for both "1" and "0" at 100 px), so tables and lists in Inter use `tabular-nums`.
- **Never truncate exercise names.** "KB ROMANIAN DEADLIFT" at `display` (40 px) is 394.7 px wide, more than the 335 px content width at 375. It wraps to two lines. At three or more lines it steps down to `title-m`.
- Uppercase is visual only (`text-transform`). Names are stored and read in their real case.

### 2.4 Spacing

A 4 px base with half steps the canvas uses: `--space-0-5` 2, `-1` 4, `-1-5` 6, `-2` 8, `-2-5` 10, `-3` 12, `-4` 16, `-5` 20, `-6` 24, `-7` 28, `-8` 32, `-10` 40, `-12` 48 (px).
- Page gutter `--space-gutter` 20 px at every width. Content max-width is 520 px, centred on wider screens.
- Top padding is `max(16px, env(safe-area-inset-top))`, not the canvas's fixed 52 px. Bottom padding is the nav height plus `--safe-bottom`.
- Between adjacent tap targets there is at least `--target-gap-min` (8 px).

### 2.5 Radii

`--radius-xs` 4 (bars, segments), `-s` 10 (tags, small inputs), `-m` 14 (44 to 48 px buttons, inputs, list cards), `-l` 18 (60 px buttons, set chips), `-xl` 22 (72 px buttons, cards), `-2xl` 28 (hero card, sheet top corners), `-pill` 999.
These consolidate the canvas's 3, 8, 14, 16, 17, 18, 20, 22, 24, 26 and 28. The current app uses 8 (buttons), 14 (cards) and 20 (sheets).

### 2.6 Elevation

| Level | Use | Dark | Light |
| --- | --- | --- | --- |
| 0 | page content | none | none |
| 1 | cards | `--color-surface` + 1 px `--color-border`, no shadow | same |
| 2 | floating: toast, update card, save-problem bar | `0 8px 24px #0000008C, 0 2px 6px #00000066` | `0 6px 20px #1A14102E, 0 1px 3px #1A14101F` |
| 3 | sheets and dialogs | `0 -8px 40px #00000099` + scrim | `0 -8px 32px #1A141033` + scrim |

The surface-to-ground step is only 1.07:1 (dark) and 1.13:1 (light). **Floating layers are separated by an edge, not a shadow.** The save-problem bar and the update card keep their 2 px coloured edge, and a toast has a 4 px left edge in its state colour.

### 2.7 Motion

| Token | Value | Use |
| --- | --- | --- |
| `--dur-press` | 100 ms | press feedback (scale 0.97, opacity) |
| `--dur-fast` | 150 ms | fades: bars, toasts out |
| `--dur-base` | 200 ms | enter: cards, toasts in |
| `--dur-sheet` | 280 ms | sheets up and down |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | enter |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | exit |
| `--ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | moves |

Rules:
- **No overshoot.** This retires the `cubic-bezier(0.34,1.56,0.64,1)` bounce on `.m-toast` and `.modal-sheet`. Bounce reads as wobble on a phone propped on the floor.
- **Nothing moves under the thumb.** No layout animation in workout mode. The rest ring updates once per second with no transition between steps.
- **Reduced motion** (`prefers-reduced-motion: reduce`): no transforms, scale, slide or parallax. Opacity changes are instant or at most 150 ms. Looping exercise demos (`@keyframes squat-down` and the others) start paused, with a Play button. PR celebrations become a static badge. Haptics and sound are separate settings and do not follow this query.
- **Haptics and sound** are opt-in settings (Profile, then Feedback), each with its own off switch. The rest-end cue is the only sound by default, and only if sound is on.

### 2.8 Z-index layers

Current layers in `index.html` (measured, M1) and the proposed M2 scale. **M1 values stay unchanged.** Stage A (section 7) only names them.

| Token | Current value (what uses it) | Proposed M2 | Change and reason |
| --- | --- | --- | --- |
| `--z-sticky-inner` | 10 `.wm-sticky-name` | 10 | none |
| `--z-sticky-sub` | 40 `.ex-search-bar`, `.plan-tabs` | 40 | none |
| `--z-header` | 50 `.page-header` | 50 | none |
| `--z-page-fab` | 90 `.timer-fab` | (retire) | merged into page-float |
| `--z-nav` | 100 `.bottom-nav` | 100 | none |
| `--z-page-float` | 150 `#hb-update` | 150 | **The FAB moves here when no workout is active.** It then sits under every sheet, which fixes K23 (FAB over "Confirm Import"). |
| `--z-sheet` | 200 `.modal-overlay`, `.modal-sheet` | 200 | none |
| `--z-workout` | 9000 `.show-workout-overlay`, 9200 `#m-ex-sheet`, 9300 `#m-howto-modal`, 9500 `.wm-overlay` | 9500 | Collapse into one workout layer. Check whether How-to (9300) can open over the workout (9500); if it can, it is hidden today. Verify before renumbering. |
| `--z-workout-float` | 9599 FAB backdrop, 9600 `#m-fab-tray` | 9600 | FAB at this level only while a workout is active |
| `--z-workout-sheet` | 9700 timer sheet | 9700 | none |
| `--z-dialog` | 9800 confirm, 9900 and 9999 script modals, 9998 `.show-wkt-overlay` | 9800 | **9900, 9998 and 9999 move under toasts.** Today a toast raised from a script modal is hidden behind it. |
| `--z-tutorial` | 9850 to 9852 | 9850 (+1, +2 internal) | none |
| `--z-toast` | 9950 `.toast-container` / `#m-toasts` | 9950 | none |
| `--z-save-bar` | 10000 `#hb-save` | 10000 | none. Top of the stack, pushes content down instead of covering it (write-failure-banner.md) |

Rule: a new layer takes a token, never a literal. Anything full-screen added later joins the save-bar push list (write-failure-banner.md, "Layers the push rule moves").

### 2.9 Touch targets

| Token | Size | Use |
| --- | --- | --- |
| `--target-min` | 44 px | links, tertiary text buttons, nav items outside workout (never smaller) |
| `--target-default` | 48 px | every button and row by default, save-bar and update-card buttons |
| `--target-workout` | 64 px | stepper buttons, any control used mid-set |
| `--target-hero` | 72 px | Log set, Skip rest, primary workout action |

In workout mode nothing tappable is under 48 px except Finish (44 px). Finish is deliberately small and placed top-right, away from the thumb, and it always confirms.

### 2.10 Icons

Inline SVG, 24 px on a 24 grid, 2 px stroke, `currentColor`, `aria-hidden="true"` (the label carries the meaning). They replace emoji in UI chrome (K13, K24: the calendar emoji renders as "July 17" on Apple). State markers are fixed shapes: **circle with `!`** for not saved or error, **diamond** for paused or warning, **tick** for done or saved, **`i` in a circle** for info, **star** for a PR.

---

## 3. Components

Every component lists its sizes, tokens and states. Common states:
- **Pressed**: scale 0.97 and `--dur-press`; no scale under reduced motion.
- **Focus-visible**: 2 px `--color-focus` outline, 2 px offset.
- **Busy**: label changes (`Saving…`), full colour, `aria-disabled="true"`, `pointer-events:none`. Never dimmed and never the `disabled` attribute (rule from update-notice.md and write-failure-banner.md).
- **Disabled**: only where an action is truly unavailable. 40% opacity, plus a reason in words nearby.

### 3.1 Buttons

| Variant | Fill / label / edge | Use |
| --- | --- | --- |
| Primary | `--color-accent` / `--color-on-accent` / none | the one main action per screen or card |
| Secondary | transparent (on ground) or `--color-surface-2` (in a card) / `--color-text` / 1.5 px `--color-border-strong` | alternatives: Quick log, Later, Retry |
| Ghost | transparent / `--color-text` / none, underline on focus | Skip set, See all; minimum 44 px tall |
| Destructive | `--color-danger-bg` / `--color-danger-ink` / 1.5 px `--color-danger` | Delete, Discard. **Filled `--color-danger` with `--color-on-accent` label only as the confirm button inside a confirm dialog.** |

| Size | Height | Radius | Type |
| --- | --- | --- | --- |
| L | 72 px | `--radius-xl` | `button-l` |
| M | 60 px | `--radius-l` | `button-m` |
| S | 48 px (44 px only for ghost or Finish) | `--radius-m` | `button-s` |

Primary is full-width in workout mode and placed bottom-most. In two-button rows the primary is on the right, nearest the right thumb (existing rule). Measured: "LOG SET 12" at `button-l` is 119.1 px and "SKIP REST" 112.5 px, so both fit a full-width button at 200% text (238 / 225 px against 335 px).

### 3.2 Stepper (weight, reps)

```
375 px
+---------------------------------------------+  card: --color-surface, --radius-xl,
|  +------+          WEIGHT          +------+ |  1px --color-border, padding 12
|  |  -   |        16  kg            |  +   | |  buttons 64x64 --color-surface-2,
|  +------+   last: <reps> x <load>  +------+ |  --radius-l, glyph --color-text 26px
+---------------------------------------------+
   ^ 64 px          ^ numeral 60px      ^ 64 px   middle area 183 px at 375, 198 at 390
```
- **Values are "same as last time" by default**, so logging an unchanged set is **one tap** (Log set). One adjustment plus Log is two taps (principle 7).
- **Step size comes from the user's equipment.** Weight steps to the next or previous implement in their ladder, not a fixed increment. Reps step by 1. A bodyweight exercise has no weight stepper.
- **Tap the numeral to type**: it opens a numeric input (`inputmode="decimal"`, 48 px, `body-l`). Long-press repeats at a fixed rate with no acceleration.
- States: default; at limit (that button is `aria-disabled`, glyph in `--color-text-muted`, and a polite status says "Lightest available" or similar); changed from last time (a small `--color-accent` dot plus the word "changed" beside the label, not colour alone); busy (never: stepping is local).
- Accessibility: buttons are labelled "Decrease weight" and so on. The value is in an `aria-live="polite"` element announcing "16 kilograms". `role="spinbutton"` is not used, because the buttons are separate targets.
- Fit (measured): "102.5" plus " kg" at `numeral` is about 160 px, within the 183 px middle area at 375. At 200% it would not fit, hence the display-size cap (2.3).

### 3.3 Set chips

```
+--------+ +========+ +--------+ +- - - - +
| SET 1 ✓| | SET 2  | | SET 3  | | SET 4  |
|17 × 16 | |  NOW   | |17 × 16 | |SKIPPED |
+--------+ +========+ +--------+ +- - - - +
  done      current    planned    skipped
```
| State | Fill / edge | Label | Marker |
| --- | --- | --- | --- |
| Done | `--color-success-bg` / 1.5 px `--color-success-border` | `--color-success-ink` "SET n", value in `--color-text` | **tick** (fixes the canvas, where done is colour-only) |
| Current | `--color-surface` / 2 px `--color-accent` | "SET n" plus "NOW" in `--color-text` | thicker edge |
| Planned | `--color-surface` / 1 px `--color-border` | `--color-text-muted` | none |
| Skipped | `--color-surface` / 1.5 px dashed `--color-border-strong` | "SKIPPED" | dashed edge |
| PR | as Done | as Done | **star** plus the word "PR" in the accessible name |

- Height 56 px, minimum width 72 px, `--radius-l`. Tapping a done chip opens that set for editing.
- **The chip row scrolls horizontally, and the text never shrinks.** Measured: "12 × 102.5" is 64.3 px at 16 px Oswald. A quarter-width canvas chip at 375 has about 74 px inside its border, so it fits at 100% but not at 150% (96 px) or 200% (129 px), and six or more sets do not fit in four columns anyway. So chips size to their content (minimum 72 px), the row scrolls, and the current chip is scrolled into view.
- Accessible name: "Set 1, done, 17 reps at 16 kilograms" (example only).

### 3.4 Cards

`--color-surface`, 1 px `--color-border`, `--radius-xl` (hero `--radius-2xl`), padding 16 to 22 px. Anatomy: eyebrow, title, meta line, optional actions. Cards do not nest. A tappable card has one clear target: either the whole card (a chevron shows it) or its buttons, never both.

### 3.5 List rows

Minimum 48 px tall (the canvas uses 42 px; raise it). Separated by 1 px `--color-border`. Name in `body` 500 `--color-text`, detail in `body-s` `--color-text-muted`, right-aligned with `tabular-nums` (Inter). A tappable row has a chevron and the full row is the target.

### 3.6 Tab bar

Four tabs as the app has today: Train, Progress, Plans, Profile. Height 64 px plus the safe area. Icon 24 px plus the `tab` label (12 px). The current tab uses `--color-accent` for icon and label **plus** `aria-current="page"` and a 3 px top indicator bar, so the state is not carried by colour alone. Inactive tabs use `--color-text-muted` (7.82:1). Hidden during a workout.

### 3.7 Progress ring and bars

- **Ring** (rest timer 272 px with 12 px stroke; grade 96 px with 9 px stroke): track `--color-data-track`, value `--color-accent` (timer) or a semantic colour (grade), round caps. The number is always in the centre in words or digits. The ring is `aria-hidden` and the container has `role="timer"` or `role="img"` with a full label.
- **Bars** (score rows, weekly volume): 6 px, `--radius-xs`, value text always beside the bar. Thresholds coloured by the semantic palette also show the number.
- **Segmented progress** (exercise n of m): 5 px segments. Done segments are `--color-success`, current `--color-accent` and 8 px tall (a shape cue, needed when green is the accent), upcoming `--color-data-track`. The eyebrow text "EXERCISE 2 OF 6" is the accessible source.
- **Charts** (per-lift trend, volume per muscle): the line is `--color-accent` and a comparison series uses `--color-data-2` with a different dash. **Estimated values are dashed and labelled "est."** Sparse data (fewer points than the chart needs; the threshold comes from training-scientist) shows the points without a trend line and says why.

### 3.8 Rest timer

```
         REST                         eyebrow
   Set 1 logged: <reps> × <load>      body, --color-text
        .-''''''-.
      /    1:12    \                  timer, digits in fixed cells
      \   of 2:00  /                  caption
        '-......-'
 [  − 15 s  ]   [  + 15 s  ]          M secondary, 60 px
 UP NEXT  <Exercise>   Set 2 of 4     card
 Pain or dizziness? Stop and see a professional.   safety line, body-s, --color-text
 [=========== SKIP REST ===========]  L primary, 72 px
```
- Starts automatically on Log set. Ending: the digits read 0:00 and the label says "Rest done", plus the sound and haptic cues if those are on. Nothing flashes.
- The adjustment step (the canvas shows 15 s) is a UI convenience, not a training rule. Default rest durations come from training-scientist (principle 3).
- **Safety line:** always visible on the rest screen. Same copy as onboarding, from CLAUDE.md principle 2. Not muted, not behind an icon.

### 3.9 Banners and bars (the save-problem bar as a system component)

One **Bar** component with variants. The approved save-problem bar (write-failure-banner.md) is its first instance. Mapping:

| Bar part | Approved spec | System token |
| --- | --- | --- |
| Fill | `--surface` | `--color-surface` |
| Edge, not saved | 2 px `--danger` | 2 px `--color-danger` (7.04:1 dark, 5.80:1 light vs ground) |
| Edge, paused | 2 px `--warning` | 2 px `--color-warning` (10.84 / 5.04) |
| Edge, saved | 2 px `--signal` | 2 px `--color-success` |
| Markers | circle `!`, diamond, tick | system state markers (2.10) |
| Title / body | Oswald 700 1rem / Inter 0.85rem, `--text` | `title-s` at 1rem, `body-s`, `--color-text`; **never muted** |
| Buttons | `.btn-primary` / `.btn-secondary`, 48 px | Primary / Secondary, size S (48 px) |
| Shadow | toast shadow; lighter in light theme | elevation 2 |
| Layer | z 10000, pushes content down via `--hb-bar-h` | `--z-save-bar` |
| Motion | 150 ms opacity; none when reduced | `--dur-fast`; K41: hide by opacity and keep height until `visibility` flips |

Other variants use the same anatomy: **Update card** (bottom, `--z-page-float`, 2 px `--color-accent` edge) and **Inline notice** (inside a page, for example a backup reminder: `--color-info-bg` fill, `i` marker, no shadow). Bar copy rules: no jargon, fixed strings via `textContent`, a marker shape plus words.

### 3.10 Sheets and modals

- **Bottom sheet**: `--color-surface`, top corners `--radius-2xl`, grab handle 36 by 4 px in `--color-border-strong`, elevation 3 plus scrim, `--z-sheet` (or `--z-workout-sheet` in a workout), max-height `calc(92dvh - var(--hb-bar-h))`. The primary action is pinned to the sheet bottom. Close with a 48 px button labelled "Close" (not a bare ✕) or Escape. A swipe-down close is allowed only where nothing is lost.
- **Confirm dialog**: centred, `--radius-xl`, title plus one sentence plus two S buttons. Destructive confirms put the cancel action on the left and the confirm (filled danger) on the right, labelled with the verb ("Delete workout", never "OK").
- The FAB is never above a sheet (2.8). Focus moves into a sheet on open and returns to its opener on close.

### 3.11 Toasts

`--color-surface`, a 4 px left edge in the state colour plus the marker, `body-s` `--color-text`, elevation 2, `--z-toast`, bottom lane above the nav. In 200 ms, out 150 ms, about 3 s on screen. The container gets `role="status"` (K21). **A toast never claims "saved" before the store confirms it** (K26): until then it says "Logged".

### 3.12 Empty, loading, error and offline states

| State | Pattern | Example copy (placeholder) |
| --- | --- | --- |
| First run | One card, one primary button, no stats (zeros read as failure) | "Set up your equipment" / START |
| Empty list | Icon, one sentence on what goes here, one action | "No plans yet." / CREATE PLAN |
| Not enough data | The chart frame with the reason, no fake line | "Log this lift <n> more times to see a trend." (n from training-scientist) |
| Loading (over 300 ms only) | Skeleton blocks in `--color-surface-2`, no shimmer under reduced motion | none |
| Error in a section | Inline notice (danger), what happened and the one thing to do | "Couldn't load history. Your data is unchanged." / TRY AGAIN |
| Offline | **Nothing.** HomeBody works offline. Only features that need the network (none today) say so | none |
| Rest day | Neutral card, no penalty language | "Rest day. Next session: <day>." |

### 3.13 Form inputs

48 px tall, `--color-ground` fill (`--color-surface` inside sheets), 1.5 px `--color-border-strong` edge (the current `--border` edge is 1.31:1 and fails, measured), `--radius-m`, `body-l` 16 px (also stops iOS zoom on focus). The label sits above in `eyebrow` style, in `--color-text`, not muted. Focus: 2 px `--color-accent` edge plus the focus ring. Error: 2 px `--color-danger` edge, a circle-`!` marker and a message below in `--color-danger-ink`, linked with `aria-describedby`. Number fields use `inputmode="decimal"`.

### 3.14 Estimate label and safety line

- **Estimate**: `~` prefix, the word "est." in the label, and an `i` button (44 px) that opens the rule and its source (principle 6). Used for kcal, 1RM, strength level, readiness and grade. The canvas's "~28.3k KCAL BURNED (EST.)" is the right pattern. Until K9 has a source, the kcal stat should not be shown as a headline (Q5).
- **Safety line**: `body-s`, `--color-text`, optional `i` marker. It appears on the rest screen, the readiness screen at the start of a session, and the top of every exercise how-to sheet.

---

## 4. Light theme

The canvas is dark only. Proposal, all values measured (section 5):

```
Train, light, 375 px
+-------------------------------------------+  ground #F5F0E9
| SUNDAY 1 NOVEMBER          eyebrow #5E5044 |
| TODAY                    title-l #1A1410   |
| +---------------------------------------+ |  surface #FFFFFF, border #DDD3C7
| | <PLAN NAME> · DAY <N>                 | |
| | <SESSION NAME>                        | |
| | <n> exercises · about <m> min         | |
| | [====== START SESSION ======] [QUICK] | |  primary #C2410C / white label;
| +---------------------------------------+ |  secondary edge #7A6A5A
|  M   T   W   T   F   S   S                 |  done: accent fill + tick; today: 2px
| (✓) ( ) ( ) (✓) ( ) (✓) [ ]               |  #1A1410 ring; others: no edge
+-------------------------------------------+
```
- **Ground is warm paper, not white.** `#F5F0E9`, with cards in white (`#FFFFFF`). This keeps the brand warmth and reduces glare bloom compared with an all-white screen.
- **Accent deepens** to `#C2410C` with a white label (5.18:1). The bright `#FF5A2C` is only 2.74:1 on the light ground and 3.11:1 on white, so it is not used in the light theme.
- **Data series and warnings deepen** (`#93590F`); success `#2D7A50`; danger `#B42318`.
- **Fixes K24's dark leftovers.** No header gradient (the current light theme ends in navy `#0a1828` on Train and Profile); headers sit on `--color-ground`.
- **Theme choice** is in Profile: System (default for new installs, follows `prefers-color-scheme`), Dark, Light. Existing users keep their current setting. `<meta name="theme-color">` follows the active theme.
- Tightest margin: ember accent text on the light ground is 4.57:1. Do not lighten it, and prefer accent fills over accent text in light.

---

## 5. Accessibility, measured

### 5.1 Contrast (WCAG 2.x relative luminance; computed from tokens.json)

Method: the sRGB to linear formula from WCAG 2.x, ratio (L1 + 0.05) / (L2 + 0.05), over every pair below, using a script run against `docs/design/tokens.json` (the script is not committed: docs only; the formula and pairs are listed here so anyone can re-run them). Requirements: text 4.5:1. Large text (24 px and up, or 18.66 px bold and up) and UI or graphics 3:1. "n/a" means decorative: nothing relies on that edge.

#### Text

| Pair | Need | Dark | Light |
| --- | --- | --- | --- |
| text on ground | 4.5 | 17.07 pass | 16.09 pass |
| text on surface | 4.5 | 15.90 pass | 18.24 pass |
| text on surface-2 (stepper glyphs, secondary label) | 4.5 | 14.47 pass | 14.61 pass |
| text-muted on ground | 4.5 | 8.40 pass | 6.84 pass |
| text-muted on surface | 4.5 | 7.82 pass | 7.76 pass |
| text-muted on surface-2 | 4.5 | 7.12 pass | 6.21 pass |
| success-ink on success-bg (done chip label) | 4.5 | 8.64 pass | 6.40 pass |
| text on success-bg (done chip value) | 4.5 | 13.10 pass | 15.64 pass |
| success-ink on surface | 4.5 | 10.47 pass | 7.47 pass |
| warning-ink on warning-bg | 4.5 | 8.57 pass | 6.36 pass |
| warning-ink on surface | 4.5 | 10.10 pass | 7.47 pass |
| danger-ink on danger-bg | 4.5 | 7.20 pass | 5.41 pass |
| danger-ink on surface | 4.5 | 7.97 pass | 6.57 pass |
| text on danger-bg | 4.5 | 14.37 pass | 15.01 pass |
| info-ink on info-bg | 4.5 | 9.18 pass | 5.68 pass |
| info-ink on surface | 4.5 | 10.18 pass | 6.77 pass |
| data-2 as stat text on surface | 4.5 | 8.15 pass | 5.71 pass |
| data-2 as stat text on ground | 4.5 | 8.75 pass | 5.04 pass |

#### Non-text (UI components, graphics)

| Pair | Need | Dark | Light |
| --- | --- | --- | --- |
| border-strong vs ground (secondary button, input, open chip) | 3 | 3.75 pass | 4.59 pass |
| border-strong vs surface | 3 | 3.50 pass | 5.20 pass |
| border-strong vs surface-2 | 3 | 3.18 pass | 4.17 pass |
| focus ring vs ground | 3 | 17.07 pass | 16.09 pass |
| focus ring vs surface | 3 | 15.90 pass | 18.24 pass |
| success vs surface (marker, bar fill) | 3 | 7.96 pass | 5.24 pass |
| success vs data-track | 3 | 7.25 pass | 4.19 pass |
| success-border vs surface (done chip edge) | 3 | 3.57 pass | 5.24 pass |
| warning vs surface (marker, edge) | 3 | 10.10 pass | 5.71 pass |
| warning vs ground (save-bar edge) | 3 | 10.84 pass | 5.04 pass |
| danger vs surface (marker) | 3 | 6.55 pass | 6.57 pass |
| danger vs ground (save-bar edge) | 3 | 7.04 pass | 5.80 pass |
| info vs surface | 3 | 7.43 pass | 5.22 pass |
| data-2 vs data-track (second series) | 3 | 7.42 pass | 4.58 pass |
| border vs ground (decorative divider) | - | 1.31 n/a | 1.30 n/a |
| border vs surface (decorative card edge) | - | 1.22 n/a | 1.48 n/a |
| surface vs ground (card fill; not relied on) | - | 1.07 n/a | 1.13 n/a |
| surface-2 vs surface (stepper button fill; glyph carries it) | - | 1.10 n/a | 1.25 n/a |

#### Accent options

| Pair | Need | ember dark | ember light | amber dark | amber light | green dark | green light | blue dark | blue light |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| on-accent label on accent fill | 4.5 | 6.28 pass | 5.18 pass | 8.75 pass | 5.71 pass | 8.55 pass | 5.24 pass | 7.98 pass | 5.22 pass |
| accent as text on ground | 4.5 | 6.28 pass | 4.57 pass | 8.75 pass | 5.04 pass | 8.55 pass | 4.62 pass | 7.98 pass | 4.61 pass |
| accent as text on surface | 4.5 | 5.85 pass | 5.18 pass | 8.15 pass | 5.71 pass | 7.96 pass | 5.24 pass | 7.43 pass | 5.22 pass |
| accent vs ground (fill edge, ring, current chip) | 3 | 6.28 pass | 4.57 pass | 8.75 pass | 5.04 pass | 8.55 pass | 4.62 pass | 7.98 pass | 4.61 pass |
| accent vs surface | 3 | 5.85 pass | 5.18 pass | 8.15 pass | 5.71 pass | 7.96 pass | 5.24 pass | 7.43 pass | 5.22 pass |
| accent vs surface-2 / data-track (ring, bars) | 3 | 5.32 pass | 4.15 pass | 7.42 pass | 4.58 pass | 7.25 pass | 4.19 pass | 6.77 pass | 4.18 pass |

#### Current app tokens (index.html today), for comparison

| Pair | Need | Dark | Light |
| --- | --- | --- | --- |
| --muted on --bg | 4.5 | 4.49 FAIL | 3.86 FAIL |
| --muted on --surface | 4.5 | 4.10 FAIL | 4.06 FAIL |
| --muted on --surface2 | 4.5 | 3.62 FAIL | 3.49 FAIL |
| --text on --surface | 4.5 | 15.83 pass | 18.24 pass |
| #000 on --accent (.btn-primary) | 4.5 | 5.53 pass | 5.53 pass |
| --accent as text on --surface | 4.5 | 4.38 FAIL | 3.80 FAIL |
| --danger as text on --surface (.btn-danger label) | 4.5 | 3.77 FAIL | 5.99 pass |
| --warning as text on --surface (.tag-warning) | 4.5 | 5.14 pass | 3.24 FAIL |
| --border vs --surface (.form-input edge) | 3 | 1.31 FAIL | 1.27 FAIL |
| --border vs --bg | 3 | 1.43 FAIL | 1.20 FAIL |

#### Canvas literals (dark only)

| Pair | Need | Ratio |
| --- | --- | --- |
| #B5A89A muted on #0E0C0A ground (11-12px labels) | 4.5 | 8.40 pass |
| #B5A89A on #181512 surface | 4.5 | 7.82 pass |
| #F4EFE8 text on #0E0C0A | 4.5 | 17.07 pass |
| #0E0C0A on #FF5A2C (Log set label) | 4.5 | 6.28 pass |
| #8FD3AE on #1B2A22 (done chip label) | 4.5 | 8.64 pass |
| #E0A15A stat on #0E0C0A | 4.5 | 8.75 pass |
| #3A322B outline vs #0E0C0A (Quick log, Finish) | 3 | 1.55 FAIL |
| #3A322B outline vs #181512 (in card) | 3 | 1.45 FAIL |
| #3A322B open day ring vs #0E0C0A | 3 | 1.55 FAIL |
| #2C2620 progress segment / bar off vs #0E0C0A | 3 | 1.31 FAIL |
| #221E1A ring track vs #0E0C0A | 3 | 1.18 FAIL |
| #FF5A2C ring vs #221E1A track | 3 | 5.32 pass |
| #3C7A5A done chip edge vs #0E0C0A | 3 | 3.83 pass |
| #221E1A stepper button vs #181512 card | 3 | 1.10 FAIL |
| #F4EFE8 today ring vs #0E0C0A | 3 | 17.07 pass |

Reading the canvas results:
- **Muted text passes:** `#B5A89A` is 8.40:1 on the ground and 7.82:1 on cards, so the canvas fixes K11's contrast. The 11 px size is the problem, not the colour (2.3).
- **Outlined buttons fail as edges** (`#3A322B`, 1.55 and 1.45). Their labels still identify them, so this is not a WCAG 1.4.11 failure in itself, but in glare Quick log and Finish lose their shape. Use `--color-border-strong` (3.75 and 3.50).
- **Tracks and off segments** (1.18 to 1.31) are acceptable only because the value is in text beside them and the filled part passes (5.32). The system keeps that rule: a track never carries meaning alone.
- **Stepper button fill vs card** (1.10) is acceptable because the 26 px `+`/`−` glyph (14.47:1) is the visible control. The 64 px hit area is unaffected.

### 5.2 Colour is never the only signal (audit of canvas boards)

| Place | Canvas | Fix |
| --- | --- | --- |
| Set chip done vs planned | **Colour only** (green fill; both show "17 × 16") | Tick marker, plus "done" in the accessible name |
| Current set chip | 2 px accent edge plus the word "now" | Keep; uppercase "NOW" |
| Week strip (Train) | Done = fill plus tick, today = thick ring | Keep; add "Today" to the accessible name, and a planned-day dot (shape) if a plan schedules that day |
| Score bars (Progress) | Green or amber by threshold, number beside | Keep (the number carries it); the threshold is a design choice to document |
| Bottom-nav current | Accent colour only | Add the top indicator bar and `aria-current` |
| Grade ring | Colour plus "A+" plus "90/100" | Keep; add an `i` that explains the rule |

### 5.3 Text at 200% and zoom

- K28 must be fixed first: remove `maximum-scale=1, user-scalable=no` from the viewport meta. With pinch-zoom allowed, WCAG 1.4.4 is met for the capped display numerals.
- Measured fits at 200%: "LOG SET 12" 238 px and "SKIP REST" 225 px, both within the 335 px button at 375 (pass). "EXERCISE 1 OF 6" eyebrow 243 px (pass). Tab "PROGRESS" 122 px against a 90 px tab (**fails**; at 150% it is about 92 px, borderline): at 150% text and above, tab labels move to one line under the icon with a smaller icon, or switch to icon plus an accessible name with the visible label shown only for the current tab. Decide in the tab-bar board (section 7). Stepper numeral "102.5" at 2x is 264 px against a 183 px area (**fails**), hence the cap. Rest timer "10:00" at 2x is 435 px (**fails**), capped too.
- Layout rules at large text: rows wrap (never truncate). Two-button rows stack vertically when a label would wrap. Bars and cards scroll inside themselves with their buttons pinned (update-notice.md Amendment 4 pattern).
- The acceptance check for every screen: 375x667 and 430x932, 100%, 150% and 200% root size, plus landscape 812x375 at 200%. Nothing is clipped, every target is still at least 44 px, and real-touch taps land.

### 5.4 Targets, motion and screen readers

- Targets: section 2.9. The canvas complies except list rows (42 px, raise to 48) and the "See all" link (44 px, fine).
- Reduced motion: section 2.7. Every animation in index.html needs a reduced-motion rule. Two do today (`#hb-save`, `#hb-update`); the exercise-demo keyframes, toasts, sheets and the tutorial spotlight (`transition: all 0.35s`) do not.
- Live regions: workout values `polite`; the rest timer announces only at start, at 10 s left and at done (not every second); toasts `role="status"` (K21); the save-problem bar as approved.

---

## 6. Fitting this to the app

### 6.1 Token mapping (current CSS variable to system token)

| Current (index.html) | New token | Value change (dark / light) | Notes |
| --- | --- | --- | --- |
| `--bg` | `--color-ground` | `#1A1410`→`#0E0C0A` / `#FAF9F7`→`#F5F0E9` | |
| `--surface` | `--color-surface` | `#231D18`→`#181512` / same | |
| `--surface2` | `--color-surface-2` | `#2E2720`→`#221E1A` / `#F2EDE8`→`#EDE5DA` | |
| `--surface3` | `--color-surface` | retire (`#201A15` sits between bg and surface) | |
| `--border` | `--color-border` | `#3D3025`→`#2C2620` / `#E8E4DF`→`#DDD3C7` | decorative only from now on |
| (none) | `--color-border-strong` | new `#7A6A5A` | `.form-input`, `.mini-input`, `.btn-secondary`, `.bilateral-btn`, chips |
| `--text` | `--color-text` | `#FAF9F7`→`#F4EFE8` / same | |
| `--muted` | `--color-text-muted` | `#8C7B6E`→`#B5A89A` / `#8C7B6E`→`#5E5044` | **fixes K11** (4.10→7.82 dark, 4.06→7.76 light on surface) |
| `--accent`, `--action` | `--color-accent` | `#E84D2A`→`#FF5A2C` / `#E84D2A`→`#C2410C` | |
| `#000` literal in `.btn-primary` | `--color-on-accent` | `#000`→`#0E0C0A` / →`#FFFFFF` | |
| `--accent2`, `--today` | `--color-data-2` | `#C97D3A`→`#E0A15A` / →`#93590F` | today marker becomes a text-colour ring |
| `--signal`, `--green` | `--color-success` | `#5A9E6E`→`#5DBE8A` / `#3D7A52`→`#2D7A50` | |
| `--warning` | `--color-warning` | `#C97D3A`→`#F0B84A` / →`#93590F` | light fixes 3.24 FAIL |
| `--danger`, `--red` | `--color-danger` (+`-ink`) | `#D94040`→`#FF6B6B` / `#B83030`→`#B42318` | dark danger text fixes 3.77 FAIL |
| `--blue` | `--color-info` | `#7EB8D4`→`#6AA7FF` / `#4A7FA0`→`#2F6BC4` | |
| `--hero-bg`, `--hero-border` | retire | hero card = surface + border | |
| `rgba(232,77,42,…)`, `rgba(255,64,96,…)`, `rgba(255,184,0,…)`, `rgba(90,158,110,…)` in `.tag-*`, `.btn-danger`, `.rest-pill.set`, `.milestone-badge`, tutorial | `--color-*-bg` / `--color-accent` | opaque tints | `.tag-danger` and `.btn-danger` use a pink (`255,64,96`) and `.tag-warning` a yellow (`255,184,0`) that are not the theme's own colours |
| `--nav-h`, `--safe-bottom`, `--hb-bar-h` | keep | | |
| z-index literals | `--z-*` | none in stage A | section 2.8 |
| font-family literals | `--font-display`, `--font-body` | none | |

### 6.2 How to adopt incrementally (no new dependencies)
- **Alias first, then flip.** Stage A adds the new names as aliases of the old values (`--color-ground: var(--bg)`): zero visual change, goldens unchanged. Later stages flip the direction (`--bg: var(--color-ground)` with new values) one token group per change, with golden diffs reviewed by hand. Old names are deleted only when no selector uses them.
- **Plain CSS custom properties.** No preprocessor, no build step, no runtime theming library. If the architect moves CSS to a file (ADR 0001 direction), that file joins the `sw.js` precache through `npm run stamp`, and `stamp:check` must pass in the same change.
- **Size budget.** No new fonts (all weights used are in the existing variable files). Token CSS and an SVG icon set are the only additions. Measure both in the PR against the precache total (846 KB after T6, K42). Removing emoji and duplicated rules should offset some of it.
- **Every visual change re-runs** the contrast pairs above against the built CSS (computed styles), real-touch tap checks, and reduced motion on and off.

### 6.3 What the canvas gets wrong or leaves out

Wrong, to fix before building:
1. **Google Fonts `<link>` on every board.** Breaks offline (principle 5) and privacy (principle 4). Use the existing self-hosted `@font-face`.
2. **Dummy content** treated as design: "Afternoon, Test", "Plan 37 — Session", 149 sessions, "5.0k kg", "A+ 90/100", "~28.3k kcal". Real names are user-defined and real numbers come from the core. Boards should use placeholders (`<Session name>`). The time-of-day greeting is a K24 bug source: drop it, or show the name only if the user set one.
3. **Train answers "repeat last session", not "what do I do today?"** The hero card needs states: plan session due today (Start session) · no plan (Repeat last / Pick) · rest day (neutral) · workout in progress (Resume, always first) · first run (Set up equipment).
4. **11 px labels** (size, not contrast; 2.3).
5. **Outline edges `#3A322B`** vanish in glare (1.55:1).
6. **Done set chip is colour-only.**
7. **Rest and elapsed digits will jitter** (Oswald has no tabular figures).
8. **No safety line** on any workout screen.
9. **"12:41" is ambiguous** (elapsed or time of day). Label it "Elapsed", or show it as "12 min".
10. **List rows are 42 px.**
11. **No way to type a value**, no long-press, no unit or equipment-step hint on the stepper.
12. **Nav current state is colour-only.**

Missing from the canvas (needed for the real app): Plans, Exercise library, Profile and Data (backup, export, import, snapshots, theme, units, feedback settings), import preview, confirm and undo (T7), the save-problem bar and update card in the new style, toasts, sheets and confirm dialogs, onboarding with readiness screen, finish summary (PRs, "how did I do"), per-lift progress, volume per muscle, recovery, empty, loading and error states, light theme, landscape, supersets, cancel workout, RPE entry (K5; must not slow logging: optional, after the set), the FAB question (K22, K23, K24: the canvas has no FAB, which I support).

---

## 7. Next canvas boards, and staged adoption

### 7.1 Boards to add (in priority order)

1. **Live workout, complete:** stepper at limit, typed value, changed-from-last marker, set-chip row with done, skipped, PR and five or more sets (scrolling), superset pair, Finish confirm, Cancel.
2. **Rest timer** with the safety line, rest-done state, and sound and haptic toggles reachable.
3. **Light theme** for Train, Workout, Rest and Progress.
3b. **Accent picker:** Profile, then Appearance (theme and accent), and Workout plus Train in all four accents in both themes. The green board is checked with a colour-blindness simulation for current versus done.
4. **Train hero states:** plan due, no plan, rest day, resume, first run.
5. **Save-problem bar states** 1 to 8 in the new style, mid-workout and on Train, dark and light; update card; toasts.
6. **Profile and Data:** backup status, export, import, snapshots, theme, units, feedback.
7. **Import preview, confirm and undo** (T7).
8. **Plans:** list, plan detail, edit day, empty.
9. **Exercise library:** search, filter by equipment, how-to sheet with safety line.
10. **Progress, deep:** per-lift trend with estimate labelling and sparse data, volume per muscle, recovery (labelled estimate), consistency without streak guilt.
11. **Finish summary:** sets, time, PRs (real only), estimate labels.
12. **Large text (200%) and landscape** variants of Workout and Rest; the tab-bar large-text decision.
13. **Empty, loading and error** set.

### 7.2 Staged adoption

| Stage | What | Visual change | Risk | When |
| --- | --- | --- | --- | --- |
| A | Add `--color-*`, `--z-*`, `--font-*` and `--space-*` names as **aliases of current values**; no selector changes | none (goldens identical) | very low; one `<style>` block, needs `npm run stamp` | **Decided:** M1 only if the architect can fit it into an existing M1 task safely; otherwise the first M2 task |
| B | Accessibility-only value fixes: `--color-text-muted` (K11), `--color-border-strong` on inputs and secondary buttons, viewport zoom (K28), `role="status"` on toasts (K21), reduced-motion rules for existing animations, FAB layer (K22, K23) | small, targeted | low; golden diffs reviewed | start of M2 (some are already logged for T8) |
| C | Flip palette and type scale to this system (dark), add light theme values and the System theme option, add the four `[data-accent]` token blocks (ember active, so no visual difference from the accent yet), remove gradients and emoji chrome (K24) | whole app | medium; every screen's goldens | M2 |
| D | Rebuild components screen by screen: **Workout and Rest first** (stepper, chips, Log set, safety line), then Train, Progress, Plans, Profile | per screen | medium; per-screen tasks with real-touch e2e | M2 |
| E | **Accent picker (decided):** Profile, then Appearance, the stored setting, `data-accent` applied before first paint, and the per-accent rules in 2.2 (amber data-2 swap, blue info marker, current-state shape cues). Contrast is re-measured for four accents by two themes. Haptics and sound settings may ship alongside it. | small | low-medium; goldens per accent | M2, after D's Workout and Train screens (the rules depend on the new chips and segments) |

Each stage gets a task plan, product-designer and accessibility-performance-reviewer review of the built UI, and the contrast table re-measured from computed styles.

---

## 8. Open questions for James (recommendation first; numbering kept)

Questions 1 to 4 (accent, light theme, Oswald, how far before M2) were answered by James on 2026-11-03; see Decisions at the top. Still open:

5. **Calories headline.** Recommend not showing "kcal burned" as a headline stat until K9 has a source; keep it as a labelled estimate in the finish summary. Alternative: keep it as on the canvas, labelled "(est.)".
6. **The FAB.** Recommend removing the ⚡ FAB outside workouts (the rest timer starts itself on Log set). This removes K22 and K23 at the source. Alternative: keep it and move it to `--z-page-float`.
