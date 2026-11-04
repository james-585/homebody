# Import preview, confirm, Undo and export labelling (T7b)

Status: **Approved by james585 on 2026-11-04, in chat.** Answers: Q1 the too-large backup saves the full export as `HomeBody_full_<YYYY-MM-DD>.txt`, labelled not importable today; Q2 the save bar's `Export` reads `Export this session` in states 6 to 8 (K30; amends write-failure-banner.md, see its dated amendment); Q3 Undo lasts until reload; Q4 the user taps Restart after Undo, no automatic reload; Q5 the import sheet and dialogs sit at z 9800, above the FAB; Q6 plans-only imports also get Undo; Q7 problem lists show positions only, never values. Section 12 (Addendum: refusal R5 "Not saved yet", the matching Undo refusal UF5 and the T7b handoff rules) approved by james585 on 2026-11-04, in chat: R5 as written, and Undo also refuses when changes are not saved. Kind mapping additions (R2 `stale`, R2b `restored`, UF2b, F9, their copy and check A37) and the rule that hides the save bar for the `restored`, `restoring` and `importing` read-only states (10.2, A38) approved by james585 on 2026-11-04, in chat. Author: product-designer, 2026-11-03. Branch `claude/t7-import-preview-spec`.
Plan: docs/plans/m1/T7.md (approved 2026-11-03). Related: docs/design/write-failure-banner.md (approved; bar patterns, live regions, push rule), docs/design/update-notice.md (update card), docs/design/design-system.md and tokens.json on `claude/design-system-m2` (proposal; tokens, components, z-scale), docs/security.md.
Principles: 1 (Merge default, Replace explicit, snapshot, Undo), 2 (calm, plain, no claims), 4 (exports are labelled as health data), 5 (works offline; nothing interrupts a workout), 7 (the logging path is not touched), 8 (imported text is data: text nodes only).

Scope: the UI that T7b builds on top of `HB.io` (T7a): the Profile "Data & Backup" card, one import sheet with every state, the Replace and Undo dialogs, export outcomes (including partial and raw), and their copy, layering, accessibility and checks. **Every user-visible string is in this document.** If the engineer meets a result, reason code or situation with no string here, that is the T7 stop condition "copy would have to be invented": stop and report; do not write a string.

Out of scope (T8 or later): a snapshot list and Restore UI, backup reminders, `lastBackupAt`, input `maxlength`, CSV, delete-all, the rest of Profile -> Data.

---

## 1. User goals

- "Keep a copy of my training somewhere safe, in one tap."
- "Bring my history onto this phone without losing what's already here."
- "Before anything changes, show me exactly what will happen, in words I understand."
- "If I got it wrong, let me take it back."
- "Never let any of this get in the way of a workout."

---

## 2. Shared rules

### 2.1 Copy rules
- **No jargon.** Never: JSON, schema, version number, ID, seq, mirror, IndexedDB, localStorage, engine, quota, snapshot, validation, error code, exception. Say: backup, file, saved, copy, this device, browser, tab, newer version, entries, numbers.
- **Nothing was changed is always said** on every refusal and failure, because it is the first thing a worried user needs to know.
- **Coach, not clinician.** No health claims. The health-data label says what the file holds and that it is private, nothing more.
- **Fixed strings only.** The raw exception message, the reason code and the validator's internal path are never shown.
- **Sentence case** in titles and body. Buttons use the existing button classes, which uppercase visually (Oswald); the strings below are written in sentence case and stored that way.
- **Placeholders**: `{n}` integers, `{date}`, `{time}`, `{size}`, `{list}`, `{name}`, `{path}`, `{reason}`, `{file}`. How each is formatted is in 2.3. A `{name}` is always an imported or user string and follows the text rule (2.2).
- **Plurals**: every count string has a singular (n = 1) and a plural form, both listed. Zero is never shown as a count in a sentence; that item is left out (see `{list}`).

### 2.2 The text-node rule for imported and user strings (security, principle 8)
This is load-bearing and is checked by acceptance checks A20 to A23.
1. **Every string that came from a file or from the user** (profile name, plan names; nothing else is displayed from the file in this UI) reaches the DOM **only** through `node.textContent = value` or `document.createTextNode(value)`. Never `innerHTML`, `outerHTML`, `insertAdjacentHTML`, template literals assigned to any of those, `setAttribute` (including `title`, `aria-label`, `data-*`), inline handlers or `style`. New T7b code does not use `escHtml` for these strings either: text nodes only.
2. **Copy with a placeholder is built as nodes**: fixed text node + a `<span class="hb-io-name" dir="auto">` whose `textContent` is the clipped value + fixed text node. Never by string concatenation into markup.
3. **Clipping**: display at most 40 user-perceived characters (graphemes via `Intl.Segmenter` with `granularity:'grapheme'`; fallback `Array.from(value)`, which never splits a surrogate pair), then append `…` (U+2026). The full value is never placed in an attribute. A clipped plan or profile name may be read by screen readers in its clipped form; that is accepted.
4. **Isolation**: `.hb-io-name { unicode-bidi: isolate; overflow-wrap: anywhere; }` plus `dir="auto"`, so a right-to-left name cannot reorder the copy around it and a 40-character string with no spaces wraps instead of widening the sheet.
5. **Numbers** are rendered only from values with `typeof === 'number'` (from `summarize`), through `Intl.NumberFormat`. A string from the file is never shown as a number.
6. **Dates** are rendered only from validated ISO strings or timestamps returned by `summarize`, through `Intl.DateTimeFormat`. Never the raw file text.
7. **Record paths** (`{path}`) are built from the fixed labels in 6.4 and integers. They never include a value, a dictionary key (a personal-record or progression-log key is a user string) or the validator's raw `where` text.
8. **Toasts**: `mToast` writes `innerHTML` (index.html ~1138). Only the fixed toast strings in this spec, with integers inserted, ever reach it. No imported or user string is ever passed to `mToast`.
9. **No imported content in logs**: no `console.*` of file text, names or `where`.

### 2.3 Formatting
- `{n}`: `new Intl.NumberFormat(undefined).format(n)` (en-GB gives `1,234`).
- `{date}`: `Intl.DateTimeFormat(undefined, {day:'numeric', month:'short', year:'numeric'})` (en-GB: `1 Nov 2026`). An absent or unusable `_exported` gives the string `an unknown date`.
- `{time}`: `Intl.DateTimeFormat(undefined, {hour:'numeric', minute:'2-digit'})`.
- `{size}`: megabytes to one decimal place, using **the same divisor as the 20 MB cap** in `validate.js` (if the cap is `20 * 1024 * 1024`, divide by `1024 * 1024`). The cap itself is always written `20 MB`.
- `{list}`: the non-zero items joined with `Intl.ListFormat(undefined, {type:'conjunction'})` (en-GB: `a, b and c`). Items use the count strings in 6.2.
- `{file}`: the exact filename that the download will use (5.1); a test checks the displayed text equals `a.download`.

### 2.4 Visual rules
- **No new text in a muted colour.** Today's `--muted` fails AA (K11): 4.10:1 on `--surface`. All text in this UI is `--text` (system: `--color-text`). Muted may be used only as a non-text edge colour (it passes 3:1 as an edge, see 7.6).
- **No coloured text** in M1 tokens: `--danger` text on dark `--surface` is 3.77:1 and `--accent` text 4.38:1, both fail. State is shown by a marker shape plus words. (When stage C of the design system lands, `--color-danger-ink` text passes and may be used; not needed here.)
- **Markers** (aria-hidden, 20 px, from system 2.10): circle with `!` in danger = refused, failed, removes data. Diamond in warning = check this, nothing blocked. Tick in success = done. `i` in a circle = information (health label, filename).
- **No emoji** in the new UI (K13, K24). The shipped `⬇`, `⬆`, `📅`, `⚠`, `🏋️`, `🏆`, `⭐` are removed from these screens.
- **Busy** buttons: label changes, full colour, `aria-disabled="true"`, `pointer-events:none`; never dimmed, never the `disabled` attribute (system 3, update-notice.md).
- **Unavailable** options (Replace for a partial file): 40% opacity **plus** a reason in words directly under it, and `aria-disabled="true"` with the reason linked by `aria-describedby`.

---

## 3. Entry points

| # | Entry | Where | What it does |
| --- | --- | --- | --- |
| E1 | `Export backup` | Profile, Data & Backup card | Downloads a `.vaultfit` at once (5.1). One tap, no sheet unless there is a warning or refusal |
| E2 | `Import backup` | same card | Opens the system file picker, then the import sheet (section 4) with the Merge or Replace choice |
| E3 | `Import plans only` | same card | File picker, then the plans-only sheet (4.10); only plans are added |
| E4 | `Undo import` | the import success state, and a row in the card for the rest of the session (4.8) | Undo flow (4.9) |
| E5 | `Export` in the save-problem bar | bar states 2, 4 (row), 6, 7, 8 | As E1; in states 6 to 8 it is a **partial** export (5.3) |
| E6 | `Export saved file` | bar states 6 to 8; and the card in those states (3.2) | Raw "as found" `.txt` (5.5) |
| E7 | `Save as text file` | the export-too-large sheet (5.4) | Full export as `HomeBody_full_<YYYY-MM-DD>.txt`, not importable today |

### 3.1 Profile, Data & Backup card (normal state)

Replaces the card at index.html ~691-706. Same position in Profile. The `Replay app tutorial` button stays in this card, below a 16 px gap and a 1 px `--border` divider, with its label and handler unchanged except for the emoji.

375 x 667, dark:
```
+---------------------------------------------+
| DATA & BACKUP                               |  card-title (existing)
| Keep a copy of your workouts, records,      |  Inter 0.875rem, --text
| plans and profile in a file. You can bring  |
| it back on this phone or another one.       |
|                                             |
| (i) Backups hold your health data, such as  |  info row: --surface2 fill,
|     body measurements. Keep them private.   |  1px --border, i marker,
|     They stay on your device unless you     |  Inter 0.875rem, --text
|     share them.                             |
|                                             |
| +-----------------------------------------+ |
| |            EXPORT BACKUP                | |  .btn-primary, 48px, full width
| +-----------------------------------------+ |
| File name: HomeBody_2026-11-03.vaultfit     |  Inter 0.8125rem, --text
|                                             |
| +-----------------------------------------+ |
| |            IMPORT BACKUP                | |  .btn-secondary, 48px
| +-----------------------------------------+ |
| +-----------------------------------------+ |
| |          IMPORT PLANS ONLY              | |  .btn-secondary, 48px
| +-----------------------------------------+ |
| Before anything changes you'll see what     |  Inter 0.8125rem, --text
| will happen, and you can undo an import.    |
| ------------------------------------------- |
| [ REPLAY APP TUTORIAL ]                     |  unchanged
+---------------------------------------------+
```
- Gaps: 8 px between the two import buttons, 16 px between groups.
- Conditional lines (each its own row, `--text`, Inter 0.8125rem):
  - When `hbWorkoutActive()` is true: under the file name, `io.card.workoutNote`.
  - After a successful import this session: the Undo row (4.8) directly under the intro text, above the health label, so it is found first.
  - After an export this session that had a warning (5.2) and the warning sheet was not shown (workout layer open): an inline notice row, warning diamond, `io.card.lastExportWarn` with a 48 px secondary button `io.btn.seeDetails` that opens the 5.2 sheet.
- At 430 x 932 the card is identical; content max-width 520 px.

### 3.2 The card in save-bar states 6, 7, 8 (data could not be read, newer version, saving not working)
- `Export backup` label becomes `io.btn.exportSession` (`Export this session`) and the file-name line shows the partial name (5.3).
- A second button, `.btn-secondary`, **above** `Import backup`: `Export saved file` (the approved bar label), with the line `io.card.rawNote` under it.
- `Import backup` and `Import plans only` stay visible and tappable; tapping them shows the read-only refusal (R2) without opening the picker. (Hiding them would make the user think the feature has gone.)
- The health-data label stays.

---

## 4. Import flow

One bottom sheet, `#hb-io-sheet`, hosts every import state; only its content changes. It is a `.modal-overlay` (so the save-bar push rule already moves it) at **z-index 9800** (`--z-dialog`), not 200. Reason: the FAB is at 9600 and covers the right end of sheet buttons at 200 (K23: a real tap on "Confirm Import" opened the FAB tray). At 9800 the sheet and its scrim sit above the FAB, below toasts (9950) and the save bar (10000). (Decision 5.)

Sheet frame (all states):
- `--surface` fill, top corners 20 px (system `--radius-2xl` 28 px in M2), grab handle 36 x 4 px (decorative only; **no swipe-down close**), max-height `calc(92dvh - var(--hb-bar-h, 0px))`, content max-width 520 px centred.
- Header: title (Oswald 700, 1.25rem, `--text`), and a 48 x 48 px `Close` button top right labelled with the word `Close` (`io.btn.close`), not a bare ✕.
- Body scrolls (`overflow-y:auto; overscroll-behavior:contain`).
- **Footer pinned to the sheet bottom** (`position:sticky; bottom:0; background:var(--surface)`; padding-bottom `max(12px, env(safe-area-inset-bottom))`). Two buttons side by side, 48 px, equal width, 8 px gap: secondary on the left, primary on the right (nearest a right thumb). When either label would wrap (large text) they stack: **primary at the bottom**, secondary above it.
- **Destructive actions are never in the footer next to the primary.** Replace is chosen in the body (4.4) and confirmed in a separate dialog (4.5); Undo sits in the body of the success state (4.7).
- Scrim: `#000` at 0.6 (light theme `--text` at 0.4). Tapping the scrim, `Close`, or Escape closes the sheet **only in states where nothing is in progress** (I1-to-I4 previews and every refusal). In I2 (checking), I6 (importing), U3 (undoing) and U4 (restart) they do nothing; those states say why.
- While open: `.app` gets `inert`, `#m-fab-tray` is under the scrim, the update card (z 150) is under the scrim.

### State map
```
tap Import backup
  -> pre-checks (sync, before the picker): workout active? read-only? fallback? not loaded? unsaved?
       any fails -> sheet opens at R1..R5 (no picker)
  -> file picker (cancel -> nothing happens, no sheet)
  -> I2 Checking file  (module load, size, read, parse, validate)
       fails -> F1..F8 / M1, M2
  -> I3 Preview, Merge selected
       <-> I4 Preview, Replace selected
  -> Import (Merge)        -> I6 Importing -> I7 Done (Undo)
  -> Replace my data...    -> I5 Replace dialog -> I6 -> I7
       I6 fails -> R1..R5 (re-checked at apply), C1 changed in another tab, W1 not saved
I7 / card Undo row -> U1 confirm or U2 warning -> U3 Undoing -> U4 Restart
                                                       fails -> UF1..UF5
```
Pre-checks must be **synchronous** inside the tap handler, and the picker opened in the same handler, so the browser keeps the user's tap as permission to open it. The modules are loaded with `import()` in parallel, after `input.click()`; I2 waits for them. The same refusals are checked again by `importDoc` at apply and show the same copy.

### 4.1 I1 Pick a file
System file picker (`accept=".vaultfit,.json,application/json,text/plain"`, unchanged). Cancelling the picker shows nothing. HomeBody adds no UI here.

### 4.2 I2 Checking file
Opens as soon as a file is chosen.
```
+---------------------------------------------+
| Checking file                     [ CLOSE ] |  Close: aria-disabled while parsing
|                                             |
| Reading 8.4 of 18.2 MB                      |  only for files over 1 MB
| [=================------------------]  46%  |  6px bar, role=progressbar
|                                             |
| Checking a large file can take a few        |
| seconds. Nothing has been changed.          |
+---------------------------------------------+
|  [        CANCEL        ]                   |  secondary, left; no primary
+---------------------------------------------+
```
- Title `io.check.title`. Body `io.check.body`.
- **Files up to 1 MB**: the body line appears only if checking is still running after 300 ms (no flash for small files). **Over 1 MB**: the reading line and bar show at once with `io.check.reading`, updated from `FileReader` progress events (bar `role="progressbar"`, `aria-valuemin=0`, `aria-valuemax=100`, `aria-valuenow`; the status region announces only 50% and done, not every event). After reading, the line becomes `io.check.parsing`.
- **Parsing blocks the page** (up to 2 s for 20 MB, T7 timing limit). So: no spinner or animated element at all in this state (a frozen spinner reads as a crash); before calling `JSON.parse` the code waits two animation frames so the `io.check.parsing` text is painted first.
- `Cancel` (`io.btn.cancel`) aborts the read if still reading; during parsing a tap is honoured as soon as parsing ends (the result is discarded, the sheet closes). Escape and scrim do the same as Cancel here (nothing is lost).

### 4.3 I3 Preview, Merge selected (default)
Rendered only from `summarize` output. 375 x 667, dark:
```
+---------------------------------------------+
| Check before importing            [ CLOSE ] |
|                                             |
| Backup made 1 Nov 2026.                     |  io.prev.made
| Adds 290 workouts, 4 plans and 12 personal  |  summary sentence (aria-live polite,
| records. Nothing of yours is changed or     |  changes with the choice)
| removed.                                    |
|                                             |
| <> Partial backup ...                       |  warnings, if any (4.3.2),
| <> Large history ...                        |  most serious first
|                                             |
| WHAT'S IN THE FILE                          |  eyebrow, --text
| Workouts                                    |  list rows, 48px min
|   312 in file · 290 new · 22 already here   |
|   4 Jan 2025 to 28 Oct 2026                 |
| Personal records                            |
|   44 in file · 12 new · 32 already here     |
|   (yours are kept)                          |
| Body measurements  ...                      |
| Plans  ...                                  |
| Favourite exercises  ...                    |
| Profile                                     |
|   Yours is kept.                            |
|                                             |
| HOW TO IMPORT                               |  eyebrow
| +-----------------------------------------+ |
| | (o) Add to my data                      | |  radio card, 2px --accent edge
| |     Keeps everything you have and adds  | |  when selected
| |     what's new from the file.           | |
| +-----------------------------------------+ |
| +-----------------------------------------+ |
| | ( ) Replace my data                     | |  radio card, 1.5px edge
| |     Removes your current data and uses  | |  (--muted as edge colour)
| |     only what's in the file.            | |
| +-----------------------------------------+ |
+---------------------------------------------+
| [   CANCEL   ]          [    IMPORT     ]   |  footer pinned
+---------------------------------------------+
```

#### 4.3.1 Order (this is also the screen-reader reading order; DOM order equals visual order)
1. Title `io.prev.title`.
2. `io.prev.made` (backup date).
3. **Summary sentence** (`id="hb-io-summary"`, `aria-live="polite"`, the dialog's `aria-describedby`): `io.sum.merge` or `io.sum.mergeNothing` (Merge), or `io.sum.replace` (Replace). It is rewritten when the choice changes, so the change is announced.
4. Warnings (4.3.2), each a row with a diamond (or circle where stated) and its text.
5. `What's in the file` (`io.prev.inFile`) and the category rows (4.3.3).
6. `How to import` (`io.prev.how`) and the two options.
7. Footer.

#### 4.3.2 Warnings (show only those that apply; this order)
| Key | When (`summarize`) | Marker | Text |
| --- | --- | --- | --- |
| `io.warn.partial` | file is `_partial` | diamond | see copy table |
| `io.warn.mirror` | the result would be over the 512K mirror ceiling | diamond | see copy table |
| `io.warn.future` | `futureDates > 0` | diamond | singular / plural |
| `io.warn.renumbered` | re-id'd count `> 0` | diamond | singular / plural |
| `io.warn.inFileDupes` | duplicates inside the file `> 0` | diamond | singular / plural |
| `io.warn.dropped` | dropped unknown details `> 0` | `i` | singular / plural |

Refused records never reach this screen: one refused record refuses the whole file (F6).

#### 4.3.3 Category rows
One row per category, in this order: Workouts, Personal records, Body measurements, Plans, Favourite exercises, Profile. A category with 0 in the file **and** (under Replace) 0 of yours is left out. Row: name (Inter 500, 0.9375rem) then a detail line (Inter 0.875rem), both `--text`. Numbers use `tabular-nums`.
- Merge detail: `io.row.merge` (`{n} in file · {new} new · {present} already here`), parts with 0 left out except `in file`. Personal records and body measurements add `io.row.yoursKept` when `present > 0`.
- Workouts add the date range line `io.row.range` when the file has at least one workout.
- Replace detail: `io.row.replace` (`Yours: {mine} removed · From file: {n}`).
- Profile row: one of `io.prof.mergeKept`, `io.prof.mergeAdopt` (with `{name}` if the file's profile has a name, else `io.prof.mergeAdoptNoName`), `io.prof.replace` / `io.prof.replaceNoName` / `io.prof.replaceClear`, `io.prof.none`.

#### 4.3.4 Choice
- A native radio group (`<fieldset>` with `<legend>` = `io.prev.how`; two `<input type="radio" name="hb-io-mode">` each inside its label card). Each card is at least 64 px tall, full width, 8 px apart. Selected: 2 px `--accent` edge **and** the filled radio dot (shape, not only colour; holds for the green accent too). Unselected: 1.5 px edge in `--muted` (non-text use, 4.10:1 on `--surface`, passes 3:1).
- Labels `io.opt.merge` + `io.opt.mergeHint`; `io.opt.replace` + `io.opt.replaceHint`. The Replace card has the circle-`!` danger marker beside its title (aria-hidden; the hint words carry the meaning).
- Merge is selected on open, every time.

#### 4.3.5 Nothing new under Merge
When Merge would add nothing, the summary is `io.sum.mergeNothing` and the primary button reads `io.btn.done` and closes the sheet. Selecting Replace still works.

### 4.4 I4 Preview, Replace selected
Same sheet; the differences:
- Summary sentence `io.sum.replace`: `Removes your {mineList} and uses the backup from {date} instead.` If you have nothing, `io.sum.replaceEmpty`.
- A danger row directly under the summary (circle `!`, `--danger` 2 px left edge, `--surface2` fill, text `--text`): `io.warn.replaceRemoves` with the list of what is removed, and, if the profile changes, the profile sentence.
- Category rows switch to the Replace detail.
- Footer primary label becomes `io.btn.replaceNext` (`Replace my data…`). It opens the dialog (4.5); it never applies directly.
- **Partial file**: the Replace card is shown at 40% opacity with `aria-disabled="true"` and the reason `io.opt.replacePartial` under it at full opacity; it cannot be selected (the radio input has `aria-disabled`, and a tap on it announces the reason through the status region and does nothing).

375 x 667, Replace selected (top of body):
```
| Check before importing            [ CLOSE ] |
| Backup made 1 Nov 2026.                     |
| Removes your 140 workouts, 3 plans and 32   |
| personal records and uses the backup from   |
| 1 Nov 2026 instead.                         |
| +-----------------------------------------+ |
| |(!) This removes your current data:      | |  danger row
| |    140 workouts, 32 personal records,   | |
| |    18 body measurements, 3 plans and 6  | |
| |    favourite exercises.                 | |
| |    Your profile (Sam) is replaced by    | |  names as text nodes, clipped
| |    the one in the file (Alex).          | |
| +-----------------------------------------+ |
|  ...rows, choice (Replace selected)...      |
| [   CANCEL   ]       [ REPLACE MY DATA… ]   |
```

### 4.5 I5 Replace confirmation dialog
A centred confirm dialog above the sheet (same layer, 9800, its own scrim at 0.6 over the sheet). Title `io.rep.title`, body `io.rep.body`, then a 1-line note `io.rep.undoNote`. Buttons: left `io.btn.keepMine` (secondary), right `io.btn.replaceConfirm` (filled danger with `#000`/on-accent label, the only place a filled danger button is allowed), **16 px gap** (wider than the usual 8 px, sweaty thumbs). **Initial focus on `Keep my data`.** Escape and scrim = Keep my data. At large text the buttons stack with `Keep my data` at the **bottom** (the safe action where the thumb lands) and the danger confirm above it.
```
+-------------------------------------------+
|  Replace all your data?                   |
|  This removes your 140 workouts, 32       |
|  personal records, 18 body measurements,  |
|  3 plans and 6 favourite exercises, and   |
|  uses the backup from 1 Nov 2026 instead. |
|  A copy of your data from before is kept  |
|  on this device, and you can undo this    |
|  until you close HomeBody.                |
|  +----------------+  +-----------------+  |
|  |  KEEP MY DATA  |  | REPLACE MY DATA |  |
|  +----------------+  +-----------------+  |
+-------------------------------------------+
```

### 4.6 I6 Importing
- The footer primary becomes busy: `io.btn.importing` (`Importing…`). Cancel and Close get `aria-disabled` and a line appears above the footer: `io.apply.keepOpen`. Scrim and Escape do nothing.
- The status region announces `io.apply.keepOpen` once.
- No progress bar (the write is one transaction; there is nothing honest to measure).

### 4.7 I7 Import done
```
+---------------------------------------------+
| (✓) Import done                   [ CLOSE ] |
|                                             |
| Added 290 workouts, 4 plans and 12 personal |
| records. Nothing of yours was changed or    |
| removed.                                    |
|                                             |
| A copy of your data from before the import  |
| is kept on this device.                     |
| +-----------------------------------------+ |
| |             UNDO IMPORT                 | |  secondary, 48px, in the BODY
| +-----------------------------------------+ |
| You can undo until you close HomeBody.      |
|                                             |
| <> Large history ... (if the mirror warning |
|    applied, repeated here)                  |
+---------------------------------------------+
|              [        DONE        ]         |  primary, full width, footer
+---------------------------------------------+
```
- Title `io.done.title` with the tick marker. Body: Merge `io.done.merge` (or `io.done.mergeNothing` is never reached: Done closed the sheet), Replace `io.done.replace`. Then `io.done.copyKept`, the Undo button `io.btn.undo`, then `io.done.undoUntil`.
- `Done` (`io.btn.done`) is the only footer button; it closes the sheet and focus returns to `Import backup`. Undo is in the body, at least 24 px above the footer, so it is never adjacent to Done.
- After a full import the app stays on Profile (the shipped code also showed Profile) and every page is re-rendered from the new `state.*` before this state is shown.
- No success toast (the sheet is the confirmation; a toast would be a second, inaccessible copy of it).

### 4.8 Undo row in the card (rest of the session)
After the sheet closes, until the page is reloaded or Undo has run, the Data & Backup card shows:
```
| (i) Imported today at 14:02.  [ UNDO IMPORT ]|   row, 48px button, secondary
```
Text `io.card.undoRow`. If the import was on an earlier calendar day than now (a session left open overnight), `io.card.undoRowDate`. The row disappears after a successful Undo (the app restarts anyway) and on reload. Undo lasts until reload (Decision 3).

### 4.9 Undo
Availability: the button is shown only if this session completed an import, the store is writable, and that import's `pre-import` snapshot id is known. At tap:
1. If `hbWorkoutActive()`: UF1.
2. If the store is read-only: UF2.
2b. If the store's status is `unsaved` (a save failed or is retrying, or the plain copy is ahead of the last committed save): UF5. This is checked at the tap, **before** U1 or U2 opens, and again by `restore`, which refuses with the same kind; a refusal at that point (after U1 or U2 was confirmed) also shows UF5 and nothing is undone.
3. Read `meta.seq` from IndexedDB (T7 plan). **Equal** to the import's commit seq: **U1**. **Not equal** (something was saved since, here or in another tab): **U2**.

**U1 Undo confirm** (centred dialog, layer 9800): title `io.undo.title`, body `io.undo.body`. Buttons: left `io.btn.keepImport` (secondary), right `io.btn.undoConfirm` (filled danger). 16 px gap; initial focus on `Keep import`; Escape and scrim = Keep import; at large text `Keep import` is at the bottom.

**U2 Undo with later changes** (same dialog shape, diamond marker before the title):
```
+-------------------------------------------+
| <> Undo will also remove later changes    |
| Something was saved after the import, for |
| example a workout or a plan change. Undo  |
| goes back to how things were before the   |
| import at 14:02, so those changes are     |
| removed too.                              |
| HomeBody keeps a copy of how things are   |
| now on this device. To keep a copy you    |
| can open yourself, export a backup first. |
| +---------------------------------------+ |
| |            EXPORT BACKUP              | |  secondary, full width
| +---------------------------------------+ |
|                                           |  24px gap
| +----------------+ +--------------------+ |
| |  KEEP IMPORT   | |   UNDO ANYWAY      | |  secondary | filled danger
| +----------------+ +--------------------+ |
+-------------------------------------------+
```
`Export backup` runs E1 and leaves the dialog open (its toast confirms). Initial focus on `Keep import`.

**U3 Undoing**: the dialog closes; the import sheet (reopened if it was closed) shows title `io.undoing.title`, body `io.apply.keepOpen`, no buttons enabled. Scrim and Escape do nothing.

**U4 Restart needed** (after `restore` succeeds; the store is now read-only until reload):
```
+---------------------------------------------+
| (✓) Import undone                           |  no Close button in this state
|                                             |
| Your data is back to how it was before the  |
| import. Restart HomeBody to finish.         |
+---------------------------------------------+
|              [      RESTART       ]         |  primary, full width
+---------------------------------------------+
```
`Restart` (`io.btn.restart`) calls `location.reload()`. This is the one state with no way out except Restart, because the app cannot save until it restarts; the body says so, and Escape, scrim and Close are absent rather than silently ignored (no Close button is rendered). Focus moves to the title, then Tab reaches only `Restart`. No automatic reload (Decision 4).

Undo failures:
| State | When | Title | Body | Buttons |
| --- | --- | --- | --- | --- |
| UF1 | workout active | `io.r.workout.title` | `io.uf.workout` | Close |
| UF2 | read-only: `corrupt`, `future`, `unavailable`, `stale` | `io.uf.readonly.title` | `io.uf.readonly` | Close |
| UF2b | read-only: `restoring`, `importing`, `restored` (restart pending) | `io.r.restart.title` | `io.uf.restart` | Close |
| UF3 | restore failed (write) | `io.uf.failed.title` | `io.uf.failed` | Close, Try again |
| UF4 | snapshot gone | `io.uf.gone.title` | `io.uf.gone` | Close |
| UF5 | changes not saved (kind `unsaved`), at tap or from `restore` | `io.r.unsaved.title` | `io.uf.unsaved` (bar showing) or `io.uf.unsavedNoBar` | Close, Export backup (primary) |
After UF3, UF4 and UF5 the import is still in place and the Undo row stays (UF4 removes it). UF5 follows R5 exactly (12.1): it points to the save bar's Retry, has no Retry of its own, no `role="alert"`, and when the bar reaches Saved it adds the line `io.uf.unsaved.nowSaved`, announced once through `#hb-io-status`.

### 4.10 Plans-only sheet
Same sheet and states as the full import, with these differences:
- No mode choice: plans are always added (Merge restricted to plans). No Replace dialog.
- The whole file is still checked; any problem anywhere in the file refuses it (F6 copy is the same).
- Preview I3p:
```
+---------------------------------------------+
| Add plans                         [ CLOSE ] |
| Adds 2 plans to My plans. Your workouts,    |  io.plan.sum
| records, measurements and profile are not   |
| changed.                                    |
|                                             |
| PLANS IN THE FILE                           |
| Upper / Lower 4-day                         |  plan name: text node, clipped 40
|   4 days · New                              |
| Kettlebell basics                           |
|   3 days · Already in your plans            |  io.plan.present (words, no colour)
| Full body A/B                               |
|   2 days · New                              |
|   ...                                       |
| and 7 more                                  |  only if over 20 plans
+---------------------------------------------+
| [   CANCEL   ]         [  ADD 2 PLANS  ]    |
+---------------------------------------------+
```
- Up to 20 plans are listed (first 20 in file order), then `io.plan.more`. Each row: name (text node, clipped), then `io.plan.days` and `io.plan.new` or `io.plan.present`.
- All plans already present: summary `io.plan.allPresent`; the primary is `Done`.
- No plans in the file: refusal P0 (`io.plan.none.title` / `io.plan.none`).
- Warnings shown here: only `io.warn.future`, `io.warn.dropped` (plans only), and `io.warn.mirror`.
- Primary `io.btn.addPlans` (singular / plural); busy `io.btn.adding`.
- Done state: `io.plandone.title`, `io.plandone.body` (+ `io.plandone.present` when some were already there), `io.done.copyKept`, Undo button and `io.done.undoUntil` as in 4.7. Footer primary `io.btn.showPlans` (closes the sheet and opens Plans, My plans tab); `Close` in the header just closes. Plans-only has Undo (Decision 6).

### 4.11 Refusals and failures (every one in the plan)
Each is a state of the same sheet: a marker + title + body, then the footer. Unless stated: footer is a single full-width secondary `Close`, the marker is circle `!` in `--danger`, and the body ends by saying nothing was changed.

| ID | Cause (plan / reason) | Shown | Title key | Body key | Footer |
| --- | --- | --- | --- | --- | --- |
| R1 | active workout (`hbWorkoutActive()`; also at apply) | at tap, or at apply | `io.r.workout.title` | `io.r.workout` | Close |
| R2 | store read-only: `corrupt`, `future`, `unavailable`, and `stale` (a quick start showed older data, so saving is paused; the bar shows state 8) | at tap, or at apply | `io.r.readonly.title` | `io.r.readonly` | Close |
| R2b | store read-only: `restoring` or `importing` (restart pending, or another import in this tab), and `restored` (an Undo or restore has finished and the app has not restarted yet) | at tap, or at apply | `io.r.restart.title` | `io.r.restart` | Close |
| R3 | localStorage fallback engine | at tap, or at apply | `io.r.fallback.title` | `io.r.fallback` | Close |
| R4 | not loaded yet (`hbLoadedOk` false) | at tap, or at apply | `io.r.loading.title` | `io.r.loading` | Close |
| R5 *(section 12)* | kind `unsaved`: a save has failed or is retrying, or the plain copy is ahead of the last committed save | at tap (both import buttons), or at apply | `io.r.unsaved.title` | `io.r.unsaved` or `io.r.unsavedNoBar` | Close, Export backup (primary) |
| M1 | module failed to load (offline and not cached, or network) | in I2 | `io.m.load.title` | `io.m.load` | Close, Reload |
| M2 | version skew (`IO_API_VERSION` or `LATEST_SCHEMA` mismatch) | in I2 | `io.m.skew.title` | `io.m.skew` | Close, Reload |
| F1 | file over 20 MB (size or text length) | in I2, before reading if `file.size` | `io.f.big.title` | `io.f.big` | Close |
| F2 | empty file, or `JSON.parse` failed | in I2 | `io.f.corrupt.title` | `io.f.corrupt` | Close |
| F3 | not a HomeBody file (top level not an object, or `_vaultfit !== true`, or `workouts` missing or not a list) | in I2 | `io.f.notHb.title` | `io.f.notHb` | Close |
| F4 | `_version` above `LATEST_SCHEMA` | in I2 | `io.f.newer.title` | `io.f.newer` | Close |
| F5 | `_version` not a usable whole number | in I2 | `io.f.corrupt.title` | `io.f.corrupt` | Close |
| F6 | invalid records (any record refused) | in I2 | `io.f.invalid.title` | `io.f.invalid` + list (6.4) | Close |
| F7 | numbers exhausted when renumbering (2^53 case) | in I2 or at apply | `io.f.invalid.title` | `io.f.ids` | Close |
| F8 | the browser could not read the file (`FileReader` error) | in I2 | `io.f.read.title` | `io.f.read` | Close |
| C1 | changed in another tab (`skipOnMismatch` skip) | at apply | `io.chg.title` | `io.chg.body` | Close, Check again (primary) |
| W1 | write failed: out of space | at apply | `io.w.title` | `io.w.quota` | Close, Try again (primary) |
| W2 | write failed: other | at apply | `io.w.title` | `io.w.other` | Close, Try again (primary) |
| P0 | plans-only: no plans in the file | in I2 | `io.plan.none.title` | `io.plan.none` | Close |
| F9 | kind `consumed`: the held file text is gone (the sheet was closed, or the file was already applied) when Check again, Try again or Import runs | at recheck or apply | `io.f.again.title` | `io.f.again` | Close |

Notes:
- **Diamond, not circle,** for R2b, R4, M2 (nothing is wrong with the user's data or file; a restart or wait fixes it).
- **Reload** (`io.btn.reload`, primary) in M1 and M2 calls `location.reload()`. While the save-problem bar is in a not-saved state (1 to 3b, 5) the Reload button is busy-styled with label `io.btn.reloadWait` and `aria-disabled`, for the same reason the update card is held (write-failure-banner.md Q1): a reload would lose the unsaved changes. It becomes `Reload` again when the bar reaches Saved.
- **Check again** (C1) re-runs `summarize` against the current store with the file text already in memory (held until the sheet closes) and returns to I3 with Merge selected. It does not reopen the picker.
- **Try again** (W1, W2) re-runs the apply with the same file and the same choice; for Replace it goes through the dialog again.
- The shipped toasts `Invalid file — not a HomeBody backup`, `Could not read file — make sure it is a .vaultfit backup`, `No plans found in this file` and the overwrite warning box are removed; these sheet states replace them.

---

## 5. Export

### 5.1 E1 Export backup (normal)
- One tap: `buildExport` runs, the file downloads, nothing else opens. Filename `HomeBody_<YYYY-MM-DD>.vaultfit` (no profile name). The card shows the name in advance (`io.card.fileName`).
- Toast (fixed string, integer only): `io.x.toast` / `io.x.toastOne`. The same text is written to the card's polite status region `#hb-io-status` (visually hidden, in the DOM from page load), because toasts have no live region (K21).
- Busy: if `buildExport` takes over 300 ms (large history; module loading), the button label becomes `io.btn.exporting` until the download starts.
- If a workout is in progress (`hbWorkoutActive()`), the export proceeds; the card line `io.card.workoutNote` already says the workout is not included.

### 5.2 Export with a warning (records that would not import)
`buildExport` checks its own output; if any record would be refused it **still downloads**, then opens the sheet:
```
+---------------------------------------------+
| <> Backup saved, with a problem   [ CLOSE ] |
| Your backup was saved, but 2 entries in it  |
| wouldn't import into HomeBody as they are,  |
| so it can't fully restore your data yet.    |
| Your data in the app is unchanged.          |
| Edit these entries, then export again:      |
|                                             |
| - Workout 13 · exercise 4 · name: has       |
|   characters HomeBody doesn't accept, such  |
|   as < or >                                 |
| - Plan 2 · day 1 · notes: is too long       |
+---------------------------------------------+
|              [        DONE        ]         |
+---------------------------------------------+
```
Title `io.xw.title`, body `io.xw.body`, list (6.4), footer `Done`. The toast is not shown in this case (the sheet replaces it).
**During an open workout layer** (Export from the save bar in state 2 while a workout is open) the sheet is **not** shown: only the toast `io.xw.toastWorkout`, and the card row from 3.1 offers the details afterwards.

### 5.3 Partial export (K30; save-bar states 6, 7, 8)
- Filename `HomeBody_partial_<YYYY-MM-DD>.vaultfit`; the file carries `_partial`.
- Card label `Export this session` (3.2), and the save bar's `Export` button also reads `Export this session` (`io.btn.exportSession`) in bar states 6, 7 and 8 (Decision 2; write-failure-banner.md amendment 2026-11-04). In bar states 2 and 4 it stays `Export`.
- Toast `io.xp.toast`, also written to `#hb-io-status` and, when the export came from the bar, to the bar's own polite status region.
- When imported later, the preview shows `io.warn.partial` and Replace is unavailable (4.4).

### 5.4 Export refused: too large to import again
`buildExport` refuses when its output would exceed the 20 MB import cap. Nothing downloads. The sheet:
```
+---------------------------------------------+
| (!) Backup too large              [ CLOSE ] |
| Your history is bigger than HomeBody can    |
| import (20 MB), so it hasn't made a backup  |
| file that couldn't be restored. Nothing has |
| changed.                                    |
| To keep a full copy anyway, save it as a    |
| text file. It holds everything, but         |
| HomeBody can't import it today.             |
| (i) It holds your health data. Keep it      |
|     private.                                |
+---------------------------------------------+
| [   CLOSE   ]      [ SAVE AS TEXT FILE ]    |
+---------------------------------------------+
```
Title `io.xc.title`, body `io.xc.body`, health line `io.health.short`, primary `io.btn.saveText`. Mid-workout layer open: toast `io.xc.toastWorkout` only.

**What `Save as text file` saves (Decision 1):** the full export, the same content `buildExport` would have produced, without the 20 MB cap, as a `text/plain` file named `HomeBody_full_<YYYY-MM-DD>.txt` (same date rule as 5.1; no profile name). It is **not** the `vaultfit_v1` as-found copy, which has stopped updating at this size. After the download: toast `io.xc.toastSaved`, also written to `#hb-io-status`, and the sheet closes. If that download fails: toast `io.x.failed`.

### 5.5 Raw "as found" export (`Export saved file`)
- Label `Export saved file` (approved, unchanged), filename `homebody-saved-data-as-found.txt` (unchanged), read-only.
- After the download: toast `io.raw.toast`, written also to the bar's polite status region (from the bar) or `#hb-io-status` (from the card). This is the health-data label for the raw file required by T7 AC.
- In the card (3.2) the line under the button: `io.card.rawNote`.
- If `HB.storage.status().mirror === 'stale'`, the card line becomes `io.card.rawNoteStale` (the as-found file may be older than what the app shows; honest labelling). The bar does not change (approved copy).

### 5.6 Export failures
| ID | When | Shown | Copy |
| --- | --- | --- | --- |
| XM1 | module failed to load | sheet, as M1 | `io.m.load.title` / `io.m.loadExport`; footer: Close, Reload (primary); body also offers `Export saved file` as a secondary full-width button in the body when `vaultfit_v1` is readable |
| XM2 | version skew | sheet, as M2 | `io.m.skew.title` / `io.m.skew`; Close, Reload |
| XF | anything else (download could not start) | toast + status | `io.x.failed` |
During an open workout layer XM1 and XM2 are toasts only: `io.x.failedWorkout`.

---

## 6. Copy (every string)

### 6.1 Card, buttons, generic
| Key | String |
| --- | --- |
| `io.card.title` | `Data & Backup` (existing title, kept) |
| `io.card.intro` | `Keep a copy of your workouts, records, plans and profile in a file. You can bring it back on this phone or another one.` |
| `io.health.label` | `Backups hold your health data, such as body measurements. Keep them private. They stay on your device unless you share them.` |
| `io.health.short` | `It holds your health data. Keep it private.` |
| `io.card.fileName` | `File name: {file}` |
| `io.card.importNote` | `Before anything changes you'll see what will happen, and you can undo an import.` |
| `io.card.workoutNote` | `Your workout in progress isn't in the backup until you finish it.` |
| `io.card.undoRow` | `Imported today at {time}.` |
| `io.card.undoRowDate` | `Imported on {date} at {time}.` |
| `io.card.lastExportWarn` | `Your last backup has entries that won't import.` |
| `io.card.rawNote` | `Downloads HomeBody's saved data exactly as it was found, as a text file. It holds your health data. Keep it private.` |
| `io.card.rawNoteStale` | `Downloads HomeBody's saved data exactly as it was found, as a text file. It may be older than what you see in the app. It holds your health data. Keep it private.` |
| `io.btn.export` | `Export backup` |
| `io.btn.exportSession` | `Export this session` |
| `io.btn.exporting` | `Exporting…` |
| `io.btn.import` | `Import backup` |
| `io.btn.importPlans` | `Import plans only` |
| `io.btn.close` | `Close` |
| `io.btn.cancel` | `Cancel` |
| `io.btn.done` | `Done` |
| `io.btn.import2` | `Import` |
| `io.btn.importing` | `Importing…` |
| `io.btn.replaceNext` | `Replace my data…` |
| `io.btn.keepMine` | `Keep my data` |
| `io.btn.replaceConfirm` | `Replace my data` |
| `io.btn.undo` | `Undo import` |
| `io.btn.keepImport` | `Keep import` |
| `io.btn.undoConfirm` | `Undo import` |
| `io.btn.undoAnyway` | `Undo anyway` |
| `io.btn.restart` | `Restart` |
| `io.btn.reload` | `Reload` |
| `io.btn.reloadWait` | `Waiting to save…` |
| `io.btn.checkAgain` | `Check again` |
| `io.btn.tryAgain` | `Try again` |
| `io.btn.seeDetails` | `See details` |
| `io.btn.saveText` | `Save as text file` |
| `io.btn.addPlans` | `Add {n} plans` / `Add 1 plan` |
| `io.btn.adding` | `Adding…` |
| `io.btn.showPlans` | `Show my plans` |

### 6.2 Count items (for `{list}`, sentences and rows)
| Key | n = 1 | n > 1 |
| --- | --- | --- |
| `io.c.workouts` | `1 workout` | `{n} workouts` |
| `io.c.prs` | `1 personal record` | `{n} personal records` |
| `io.c.bodyMetrics` | `1 body measurement` | `{n} body measurements` |
| `io.c.plans` | `1 plan` | `{n} plans` |
| `io.c.favs` | `1 favourite exercise` | `{n} favourite exercises` |
Row names: `Workouts`, `Personal records`, `Body measurements`, `Plans`, `Favourite exercises`, `Profile`.

### 6.3 Checking, preview, choice, apply, done
| Key | String |
| --- | --- |
| `io.check.title` | `Checking file` |
| `io.check.reading` | `Reading {read} of {size} MB` (both one decimal, same divisor) |
| `io.check.parsing` | `Checking a large file can take a few seconds.` |
| `io.check.body` | `Nothing has been changed.` |
| `io.prev.title` | `Check before importing` |
| `io.prev.made` | `Backup made {date}.` |
| `io.prev.inFile` | `What's in the file` |
| `io.prev.how` | `How to import` |
| `io.sum.merge` | `Adds {list}. Nothing of yours is changed or removed.` |
| `io.sum.mergeNothing` | `Nothing new to add. Everything in this file is already in HomeBody.` |
| `io.sum.replace` | `Removes your {mineList} and uses the backup from {date} instead.` |
| `io.sum.replaceEmpty` | `You have no data in HomeBody yet, so this adds everything in the backup from {date}.` |
| `io.row.merge` | `{n} in file · {new} new · {present} already here` |
| `io.row.yoursKept` | `Where both have one, yours is kept.` |
| `io.row.range` | `{first} to {last}` (or `{first}` alone when equal) |
| `io.row.replace` | `Yours: {mine} removed · From file: {n}` |
| `io.prof.mergeKept` | `Yours is kept.` |
| `io.prof.mergeAdopt` | `You have no profile yet, so the one in the file is used ({name}).` |
| `io.prof.mergeAdoptNoName` | `You have no profile yet, so the one in the file is used.` |
| `io.prof.replace` | `Your profile ({mine}) is replaced by the one in the file ({name}).` |
| `io.prof.replaceNoName` | `Your profile is replaced by the one in the file.` |
| `io.prof.replaceClear` | `The file has no profile, so yours is cleared.` |
| `io.prof.none` | `No profile in the file.` |
| `io.opt.merge` | `Add to my data` |
| `io.opt.mergeHint` | `Keeps everything you have and adds what's new from the file.` |
| `io.opt.replace` | `Replace my data` |
| `io.opt.replaceHint` | `Removes your current data and uses only what's in the file.` |
| `io.opt.replacePartial` | `Not available: this is a partial backup, so it could remove history that isn't in it.` |
| `io.warn.replaceRemoves` | `This removes your current data: {mineList}.` |
| `io.rep.title` | `Replace all your data?` |
| `io.rep.body` | `This removes your {mineList}, and uses the backup from {date} instead.` |
| `io.rep.undoNote` | `A copy of your data from before is kept on this device, and you can undo this until you close HomeBody.` |
| `io.apply.keepOpen` | `Keep HomeBody open. This takes a moment.` |
| `io.done.title` | `Import done` |
| `io.done.merge` | `Added {list}. Nothing of yours was changed or removed.` |
| `io.done.replace` | `Your data now comes from the backup made {date}.` |
| `io.done.copyKept` | `A copy of your data from before the import is kept on this device.` |
| `io.done.undoUntil` | `You can undo until you close HomeBody.` |

`{mineList}` is the `{list}` of the user's current counts that Replace removes. `{mine}` in the profile string is the user's own profile name (text node, clipped). `{first}`/`{last}` are `{date}`s.

### 6.4 Warnings and record paths
| Key | n = 1 | n > 1 / single string |
| --- | --- | --- |
| `io.warn.partial` | | `Partial backup. It was made when HomeBody couldn't read its saved data, so it may hold only part of a history. You can add it to your data, but not use it to replace your data.` |
| `io.warn.mirror` | | `Large history. Everything will be saved, but one of HomeBody's safety copies stops updating at this size. Keep your own backup files as well.` |
| `io.warn.future` | `1 workout or measurement is dated after today. It's imported as it is.` | `{n} workouts or measurements are dated after today. They're imported as they are.` |
| `io.warn.renumbered` | `1 workout will be renumbered so it doesn't clash with yours. Its content doesn't change.` | `{n} workouts will be renumbered so they don't clash with yours. Their content doesn't change.` |
| `io.warn.inFileDupes` | `1 workout appears twice in the file. Both copies are imported.` | `{n} workouts appear more than once in the file. Every copy is imported.` |
| `io.warn.dropped` | `1 extra detail in the file isn't used by HomeBody and is left out.` | `{n} extra details in the file aren't used by HomeBody and are left out.` |

**Record path** `{path}`: segments joined with ` · `, numbers 1-based in file order. Built only from these labels and integers:
| Validator segment | Label |
| --- | --- |
| top-level header fields (`_vaultfit`, `_version`, `_exported`, other `_*`) | `File details` |
| `workouts[i]` | `Workout {i}` |
| `exercises[j]` | `exercise {j}` |
| `sets[k]` | `set {k}` |
| `personalRecords` entry (by position, never by key) | `Personal record {i}` |
| `bodyMetrics[i]` | `Body measurement {i}` |
| `userPlans[i]` | `Plan {i}` |
| plan day (`days[d]`, `planDays[d]`, any day list) | `day {d}` |
| `favourites[i]` | `Favourite {i}` |
| `profile` | `Profile` |
| `profile.equipment` and its lists | `equipment` |
| `_progressionLog` entry (by position) | `Progress history {i}` |
| field `name` | `name` |
| field `notes`, `desc` | `notes` |
| field `date` | `date` |
| weight, reps, time, rpe, duration, calories, totals, value | `weight`, `reps`, `time`, `effort (RPE)`, `duration`, `calories`, `totals`, `value` |
| level, goal, sex, activity, trackType, unit | `a setting` |
| `id`, `planId`, day index fields | `number` |
| any other field | `a detail` |
| the whole list is too long (bounds) | the list's label in plural: `Workouts`, `Body measurements`, `Personal records`, `Plans`, `Favourites`, `Exercises in workout {i}` |

**Reasons** `{reason}` (one per T7a reason code; T7a's code list is mapped to exactly one of these; an unmapped code is a stop condition):
| Reason | String |
| --- | --- |
| characters refused (`<`, `>`, controls, bidi, line separators, lone surrogates) | `has characters HomeBody doesn't accept, such as < or >` |
| over the length cap | `is too long` |
| wrong type, not finite, `-0`, number as text | `isn't the right kind of value` |
| out of range | `is outside the allowed range` |
| not a valid date | `isn't a valid date` |
| date outside the window | `has a date before 2000 or more than a year ahead` |
| not an allowed choice (enum) | `isn't one of the allowed choices` |
| required and missing | `is missing` |
| reserved key (`__proto__`, `constructor`, `prototype`) | `uses a name HomeBody can't accept` |
| too many entries (bounds) | `has too many entries` |
| nested too deeply | `is nested too deeply` |

List item: `{path}: {reason}` (a `<li>` built from text nodes). The `<` and `>` in the first reason are fixed copy, set with `textContent`.
The validator returns at most 20 problems. If 20 are shown, add `io.list.first20` after the list.

| Key | String |
| --- | --- |
| `io.list.first20` | `Showing the first 20.` |

### 6.5 Refusals and failures
| Key | String |
| --- | --- |
| `io.r.workout.title` | `Finish your workout first` |
| `io.r.workout` | `A workout is in progress, here or in another HomeBody tab or window. Finish or cancel it, then try again. Nothing was changed.` |
| `io.r.readonly.title` | `Importing is paused` |
| `io.r.readonly` | `HomeBody isn't saving right now (see the message at the top), so it can't import. Nothing was changed.` |
| `io.r.restart.title` | `Restart HomeBody first` |
| `io.r.restart` | `HomeBody needs to restart before it can import. Close and reopen it, then try again. Nothing was changed.` |
| `io.r.fallback.title` | `Can't import right now` |
| `io.r.fallback` | `HomeBody's main storage didn't open this time, so it's running in a limited mode that can't import safely. Nothing was changed. Close and reopen HomeBody, then try again.` |
| `io.r.loading.title` | `Still starting up` |
| `io.r.loading` | `HomeBody is still loading your data. Wait a moment, then try again. Nothing was changed.` |
| `io.r.unsaved.title` *(12)* | `Not saved yet` |
| `io.r.unsaved` *(12)* | `Your latest changes aren't saved yet, and importing now could lose them. Tap Retry on the message at the top, or export a backup to keep a copy. When it says Saved, try again. Nothing was changed.` |
| `io.r.unsavedNoBar` *(12)* | `Your latest changes aren't saved yet, and importing now could lose them. Export a backup to keep a copy, then close and reopen HomeBody so it can finish saving, and try again. Nothing was changed.` |
| `io.r.unsaved.nowSaved` *(12)* | `Saved. Close this and choose your file again.` |
| `io.enum.unknown` *(12)* | `a setting HomeBody doesn't recognise` |
| `io.m.load.title` | `Import isn't available right now` |
| `io.m.load` | `Part of HomeBody didn't load. Reload HomeBody, then try again. Nothing was changed.` |
| `io.m.loadExport` | `Part of HomeBody didn't load, so it can't make a backup. Reload HomeBody, then try again. Nothing was changed.` |
| `io.m.skew.title` | `HomeBody needs to reload` |
| `io.m.skew` | `An update arrived while HomeBody was open. Reload to finish it, then try again. Nothing was changed.` |
| `io.f.big.title` | `This file is too big` |
| `io.f.big` | `HomeBody can import backups up to 20 MB. This file is {size} MB. Nothing was changed.` |
| `io.f.corrupt.title` | `This file can't be read` |
| `io.f.corrupt` | `It may be damaged or incomplete, for example if the download didn't finish. Nothing was changed. Try exporting the backup again.` |
| `io.f.notHb.title` | `Not a HomeBody backup` |
| `io.f.notHb` | `Choose a file made with Export backup in HomeBody. It usually ends in .vaultfit. Nothing was changed.` |
| `io.f.newer.title` | `Made by a newer HomeBody` |
| `io.f.newer` | `This backup comes from a newer version of HomeBody. Close and reopen HomeBody to get the newer version, then try again. Nothing was changed.` |
| `io.f.invalid.title` | `This file can't be imported` |
| `io.f.invalid` | `HomeBody checked it and found entries it can't accept, so nothing was imported. Your data is unchanged. If you made this file with HomeBody, export a fresh backup and try again.` |
| `io.f.ids` | `Some workouts in this file can't be renumbered to fit with yours, so nothing was imported. Your data is unchanged.` |
| `io.f.again.title` | `Choose the file again` |
| `io.f.again` | `HomeBody no longer has this file open. Close this and choose it again. Nothing was changed.` |
| `io.f.read.title` | `Couldn't open the file` |
| `io.f.read` | `Your browser couldn't read this file. Try choosing it again. Nothing was changed.` |
| `io.chg.title` | `HomeBody changed in another tab` |
| `io.chg.body` | `Your data changed in another HomeBody tab or window while this was open, so nothing was imported. Check the preview again before importing.` |
| `io.w.title` | `Import didn't finish` |
| `io.w.quota` | `HomeBody is out of space in this browser, so it couldn't save the import. Nothing was changed.` |
| `io.w.other` | `Something stopped HomeBody saving the import. Nothing was changed.` |
| `io.plan.none.title` | `No plans in this file` |
| `io.plan.none` | `This file has no plans to add. Nothing was changed.` |

### 6.6 Plans only
| Key | n = 1 | n > 1 / single |
| --- | --- | --- |
| `io.plan.title` | | `Add plans` |
| `io.plan.sum` | `Adds 1 plan to My plans. Your workouts, records, measurements and profile are not changed.` | `Adds {n} plans to My plans. Your workouts, records, measurements and profile are not changed.` |
| `io.plan.allPresent` | `This plan is already in your plans. Nothing to add.` | `All {n} plans are already in your plans. Nothing to add.` |
| `io.plan.inFile` | | `Plans in the file` |
| `io.plan.days` | `1 day` | `{n} days` |
| `io.plan.new` | | `New` |
| `io.plan.present` | | `Already in your plans` |
| `io.plan.more` | | `and {n} more` |
| `io.plandone.title` | | `Plans added` |
| `io.plandone.body` | `Added 1 plan to My plans. Nothing else was changed.` | `Added {n} plans to My plans. Nothing else was changed.` |
| `io.plandone.present` | `1 was already in your plans.` | `{n} were already in your plans.` |

### 6.7 Undo
| Key | String |
| --- | --- |
| `io.undo.title` | `Undo the import?` |
| `io.undo.body` | `HomeBody goes back to exactly how it was before the import at {time}, then restarts.` |
| `io.undo2.title` | `Undo will also remove later changes` |
| `io.undo2.body` | `Something was saved after the import, for example a workout or a plan change. Undo goes back to how things were before the import at {time}, so those changes are removed too.` |
| `io.undo2.copy` | `HomeBody keeps a copy of how things are now on this device. To keep a copy you can open yourself, export a backup first.` |
| `io.undoing.title` | `Undoing the import` |
| `io.undone.title` | `Import undone` |
| `io.undone.body` | `Your data is back to how it was before the import. Restart HomeBody to finish.` |
| `io.uf.workout` | `You can't undo an import while a workout is in progress. Finish or cancel it, then try again. Nothing was changed.` |
| `io.uf.readonly.title` | `Can't undo right now` |
| `io.uf.restart` | `HomeBody needs to restart before it can undo. Close and reopen it, then try again. Nothing was changed.` |
| `io.uf.readonly` | `HomeBody isn't saving right now (see the message at the top), so it can't undo. Nothing was changed.` |
| `io.uf.failed.title` | `Undo didn't finish` |
| `io.uf.failed` | `Something stopped HomeBody undoing the import. Nothing was changed: the import is still in place.` |
| `io.uf.gone.title` | `Can't undo this import` |
| `io.uf.gone` | `The copy from before this import is no longer on this device. Nothing was changed.` |
| `io.uf.unsaved` | `Your latest changes aren't saved yet, and undoing now could lose them. Tap Retry on the message at the top, or export a backup to keep a copy. When it says Saved, try again. Nothing was changed.` |
| `io.uf.unsavedNoBar` | `Your latest changes aren't saved yet, and undoing now could lose them. Export a backup to keep a copy, then close and reopen HomeBody so it can finish saving. Nothing was changed.` |
| `io.uf.unsaved.nowSaved` | `Saved. Close this and tap Undo import again.` |
`{time}` (and `{date}` if not today, as `{date} at {time}`) is the import's commit time.

### 6.8 Export
| Key | String |
| --- | --- |
| `io.x.toast` | `Backup saved: {n} workouts. Keep the file private.` |
| `io.x.toastOne` | `Backup saved: 1 workout. Keep the file private.` |
| `io.xw.title` | `Backup saved, with a problem` |
| `io.xw.body` | `Your backup was saved, but {n} entries in it wouldn't import into HomeBody as they are, so it can't fully restore your data yet. Your data in the app is unchanged. Edit these entries, then export again:` (n = 1: `…but 1 entry in it wouldn't import into HomeBody as it is, …Edit this entry, then export again:`) |
| `io.xw.toastWorkout` | `Backup saved. Some entries won't import: see Profile after your workout.` |
| `io.xp.toast` | `Partial backup saved: only what HomeBody has this session. Keep the file private.` |
| `io.xc.title` | `Backup too large` |
| `io.xc.body` | `Your history is bigger than HomeBody can import (20 MB), so it hasn't made a backup file that couldn't be restored. Nothing has changed. To keep a full copy anyway, save it as a text file. It holds everything, but HomeBody can't import it today.` |
| `io.xc.toastSaved` | `Full copy saved as a text file. HomeBody can't import it today. Keep it private.` |
| `io.xc.toastWorkout` | `Backup not made: too large. See Profile after your workout.` |
| `io.raw.toast` | `Saved file downloaded. It holds your health data. Keep it private.` |
| `io.x.failed` | `Couldn't make the backup. Nothing was changed. Try again.` |
| `io.x.failedWorkout` | `Couldn't make the backup. Try again after your workout.` |
The exact `io.xw.body` singular is: `Your backup was saved, but 1 entry in it wouldn't import into HomeBody as it is, so it can't fully restore your data yet. Your data in the app is unchanged. Edit this entry, then export again:`.

---

## 7. Accessibility

### 7.1 Sheet and dialogs
- `#hb-io-sheet`: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` = the state title, `aria-describedby` = `#hb-io-summary` in preview states, the body paragraph in other states. `.app` gets `inert` while it is open (removed on close).
- **Focus**: on open and on every state change, focus moves to the state title (`tabindex="-1"`, `preventScroll`), so the screen reader reads the title and then the description. Tab order then follows DOM order: body links and buttons (Undo in I7), radio group, footer secondary, footer primary, Close. Close is last in DOM order but first visually top-right; that is accepted because Escape is available, and it keeps the reading order "content then actions".
- **On close**, focus returns to the button that opened the flow (Import backup, Import plans only, Export backup, Undo import, or the bar's Export). If that element no longer exists, to the Data & Backup card title (`tabindex="-1"`). Never to `<body>`.
- **Dialogs** (I5, U1, U2): `role="alertdialog"`, labelled and described; initial focus on the safe button; Escape = safe button; focus returns to the sheet's primary button (I5) or the Undo button (U1, U2) on cancel.
- **No surprise traps**: Escape and Close work in every state except I2-parsing (ignored for at most about 2 s, then honoured), I6, U3 (in progress; the visible line says to keep the app open) and U4 (Restart only; the body says why). In those states Close is `aria-disabled` (I2, I6, U3) or absent (U4).

### 7.2 Announcements
- **No `role="alert"` inside the import or export UI.** Every outcome that matters happens inside the modal sheet, and moving focus to the new title announces it once; an alert as well would read it twice. This mirrors the save bar's "once per episode" rule.
- **One polite status region per surface**, present from page load and outside any hidden element: `#hb-io-status` (visually hidden) for toasts, export outcomes, reading progress (50% and done only), the busy line `io.apply.keepOpen`, and the "Replace not available" reason when a disabled option is tapped. The summary sentence `#hb-io-summary` is itself `aria-live="polite"`.
- The save-problem bar keeps its own alert and status (approved). If an import write fails with a quota error the bar may also appear; that is accepted (the bar is about saving in general, the sheet about this import).

### 7.3 Screen-reader summary of the preview (expected reading, Merge, example)
"Check before importing, dialog. Backup made 1 Nov 2026. Adds 290 workouts, 4 plans and 12 personal records. Nothing of yours is changed or removed." Then on swipe: warnings, "What's in the file", rows, "How to import, group, Add to my data, radio button, selected, 1 of 2 ...". Markers are `aria-hidden`; the category rows are a `<ul>`; the problem list is a `<ul>`.

### 7.4 Targets and reach
- Every button 48 px tall; radio cards 64 px; Close 48 x 48; the Undo row button 48 px and at least 96 px wide. 8 px minimum between targets, 16 px between a safe and a destructive button.
- **Thumb zone**: the primary action is always the pinned footer's right (or bottom when stacked) button. Destructive choices are in the body (Replace option, Undo button) or in a dialog where the safe button takes the thumb position at large text.
- Real-touch taps at 85% across each footer button must hit it (the FAB is under the scrim; K23).

### 7.5 Large text, zoom, motion
- At 200% text (and landscape 812 x 375 at 200%): the sheet body scrolls; the footer stays pinned and fully visible; footer buttons stack (primary bottom); dialogs scroll inside themselves with buttons pinned (update-notice.md Amendment 4 pattern); nothing is clipped; names wrap (`overflow-wrap:anywhere`).
- Pinch-zoom: nothing in this UI depends on K28 being fixed, but nothing prevents it.
- **Reduced motion**: the sheet's 280 ms slide (and the shipped bounce curve, which must not be used here) becomes an instant show; dialogs have no scale; the reading bar changes width without a transition. Normal motion: sheet slide 280 ms `cubic-bezier(0.2,0,0,1)`, no overshoot; dialogs fade 150 ms. No sound, no haptics.

### 7.6 Contrast (M1 tokens; measured values from write-failure-banner.md and the design system)
| Pair | Dark | Light | Need |
| --- | --- | --- | --- |
| `--text` on `--surface` (all sheet text) | 15.83 | 18.24 | 4.5 |
| `--text` on `--surface2` (secondary buttons, info and danger rows) | 13.98 | 15.68 | 4.5 |
| `#000` on `--accent` (primary buttons) | 5.53 | 5.53 | 4.5 |
| `#000` on `--danger` (filled danger confirm, dark) / `#fff` on `--danger` (light) | 4.75 | 6.00 | 4.5 |
| `--muted` as radio-card edge vs `--surface` | 4.10 | 4.06 | 3.0 |
| `--accent` selected edge vs `--surface` | 4.38 | 3.80 | 3.0 |
| `--danger` marker vs `--surface` | 3.77 | 5.99 | 3.0 |
| `--warning` marker vs `--surface` | 5.14 | 3.24 | 3.0 |
| `--signal` tick vs `--surface` | 5.20 | 5.12 | 3.0 |
The filled danger confirm label is `#000` in dark (`#D94040`, 4.75:1, a thin margin) and `#fff` in light (`#B83030`, 6.00:1), computed with the WCAG 2.x formula; the engineer re-measures from computed styles; if either fails, use the destructive outline variant: `--surface2` fill, `--text` label, 2 px `--danger` edge, plus the circle marker). After design-system stage C, the system's own tokens and section 5.1 figures apply.

### 7.7 Light and dark, accent picker
Tokens only, no literals (system 2). Mapping for the implementer (M1 name, then system name): `--surface`/`--color-surface`, `--surface2`/`--color-surface-2`, `--text`/`--color-text`, `--muted` (edges only)/`--color-border-strong`, `--accent`/`--color-accent`, `#000` on accent/`--color-on-accent`, `--danger`/`--color-danger`, `--warning`/`--color-warning`, `--signal`/`--color-success`, `--border`/`--color-border`. The selected radio card uses the accent edge **and** the dot, so it works under all four accents; danger states use the circle marker and words, so ember accent and danger red are never confused.

---

## 8. Layers and what never interrupts a workout

| Layer | z-index | Relation |
| --- | --- | --- |
| Update card | 150 | under the import scrim; untouched |
| `.modal-overlay` sheets (others) | 200 | not open at the same time |
| Workout layer | 9500 | **the import UI never opens over it** (below) |
| FAB tray | 9600 | under the import sheet and its scrim (fixes K23 for this flow) |
| Timer sheet | 9700 | not reachable while the import sheet is open (FAB under scrim) |
| **Import sheet, Replace and Undo dialogs** | **9800** | `--z-dialog`; dialogs stack above the sheet in DOM order at the same z |
| Toasts | 9950 | above the sheet: export toasts stay readable |
| Save-problem bar | 10000 | above everything; pushes the sheet down (the sheet is a `.modal-overlay`, already in the push list) |

Must not interrupt a workout (principle 5, update-notice.md, write-failure-banner.md):
- No import or export sheet, dialog or toast ever opens over the workout layer. Import and Undo are refused with R1 / UF1 when a workout is active; the pre-check happens before the picker, so the user never chooses a file only to be refused.
- A workout started in another tab during a preview is caught at apply (R1); nothing is shown in the other tab.
- Export from the save bar while the workout layer is open (bar state 2 kept from before the workout) downloads and shows only a toast; sheets are deferred to the card row (5.2, 5.4, 5.6).
- Nothing in T7b touches the logging path: the set-logging tap count is unchanged (checked).
- U4's restart is user-triggered and impossible during a workout (Undo is refused then).

---

## 9. Acceptance checks (automatable)

Run in Chromium at 375x667, 390x844 and 430x932, dark and light, unless stated; `@smoke` ones also in WebKit. Taps use `page.touchscreen.tap` at 85% across the target and its vertical centre, never `element.click()`. Strings are compared with the constants in section 6 (a test imports one shared copy table, or the e2e holds a copy of the table and asserts equality).

Entry and card
- A1 The card shows exactly `io.card.intro`, `io.health.label`, `io.card.fileName` (with today's date under the frozen clock), the three buttons and `io.card.importNote`; no emoji in these buttons; computed text colour of every line is `--text`.
- A2 `io.card.fileName` text equals the `download` attribute of the exported link, which matches `^HomeBody_\d{4}-\d{2}-\d{2}\.vaultfit$` and contains no profile name.
- A3 In seeded save-bar states 6, 7, 8: the save bar's export button reads `Export this session` (and `Export` in states 2 and 4); the card shows `Export this session`, `Export saved file` and `io.card.rawNote`; the export filename matches `^HomeBody_partial_\d{4}-\d{2}-\d{2}\.vaultfit$` and the file has `_partial: true`.

Pre-checks and refusals
- A4 With `hb_active_workout` seeded: tapping Import backup opens R1 and **no file chooser event fires** (`page.on('filechooser')` not called). Same for Import plans only. Same with seeded read-only (R2), fallback engine (R3), `hbLoadedOk` false (R4).
- A5 Each of F1 (generated 20 MB + 1 byte), F2 (empty; truncated JSON), F3 (`{}`; `_vaultfit:false`; array), F4 (`_version: 99`), F5 (`_version: "2"`, 1.5), F6 (a name containing `<b>`), F8 (simulated read error) shows its exact title and body; `vaultfit_v1` and IndexedDB are byte/deep-equal before and after.
- A6 F6 list: each item matches `^(File details|Workout \d+|Personal record \d+|Body measurement \d+|Plan \d+|Favourite \d+|Profile|Progress history \d+|Workouts|Body measurements|Personal records|Plans|Favourites|Exercises in workout \d+)( · [a-z][a-z ()0-9A-Z]*)*: ` followed by one reason string from 6.4; for a crafted file whose bad value is the marker string `ZZVALUEZZ` and whose bad dictionary key is `ZZKEYZZ`, neither marker appears anywhere in the DOM or in any attribute.
- A7 Module failure: block the module URL (route abort) and tap Import backup, choose the fixture: M1 shows; the shipped `mConfirmImport` is never called (spy) and state is unchanged. Version skew (stubbed constant): M2. With the save bar seeded in state 2, the Reload button reads `Waiting to save…`, is `aria-disabled`, and a tap does not reload.
- A8 C1: commit a save from a second page between preview and Import: C1 shows; `Check again` returns to I3 with fresh counts; nothing was imported.
- A9 W1: with the IndexedDB write faulted as quota, Import shows W1; state unchanged; the store is writable afterwards (a normal save succeeds).

Preview
- A10 Fixture over different seeded data: summary sentence, every category row and the date range equal `summarize` output formatted per 2.3; Merge is selected; the radio group is a native group with two radios.
- A11 Selecting Replace rewrites `#hb-io-summary` (polite live region) to `io.sum.replace`, shows the danger row with every non-zero current count, and the primary reads `Replace my data…`; tapping it opens I5 with initial focus on `Keep my data`; Escape returns to I4 with nothing changed.
- A12 Partial file: `io.warn.partial` shows; the Replace radio is `aria-disabled`, cannot be checked by touch or keyboard, and its reason is visible and linked by `aria-describedby`.
- A13 Each warning in 4.3.2 appears for its crafted file (future date, colliding ids, in-file duplicate, unknown key, a document over 512K characters) and not otherwise.
- A14 Profile strings: each of the six profile cases renders its exact string; names appear only inside `.hb-io-name` spans with `dir="auto"`.

Apply, done, Undo
- A15 Merge import: I6 shows `Importing…` (`aria-disabled`, full opacity); then I7; current workouts are all still present; Undo is inside the body, not in the footer, and its bounding box is at least 24 px above the footer.
- A16 Undo with nothing saved since: U1, then U4; after Restart, state deep-equals the pre-import state (T7 AC "Undo restores exactly").
- A17 Undo after logging and finishing a workout: U2 shows with `Export backup`, `Keep import`, `Undo anyway`; `Keep import` changes nothing.
- A18 Undo with a workout active: UF1; nothing changed. Undo row appears in the card after closing I7, and is gone after reload.
- A19 Plans-only: fixture with one plan already present shows `New` and `Already in your plans` rows; re-importing the same file shows `io.plan.allPresent` and Done; workouts, PRs, body and profile unchanged.

Text safety
- A20 Every text node in `#hb-io-sheet`, the dialogs, the card and the toasts equals a section 6 string, a formatted number or date, or the clipped value of a known imported/user name.
- A21 A file whose profile and plan names are `"><img src=x onerror=window.__x=1>`, `&#39;);window.__x=1;//`, a 600-character string, a right-to-left name and an emoji-with-skin-tone name (all valid under the string rule except the first, which must be refused by F6): `window.__x` stays undefined; no `<img>` is created; displayed names are at most 40 graphemes plus `…`, never split an emoji or surrogate pair; no attribute anywhere contains any of these strings.
- A22 `mToast` is never called with a string containing a profile or plan name (spy over the whole flow).
- A23 No `console.*` call during the flow contains file content (spy).

Layout, a11y, motion, workout
- A24 With the sheet open, the FAB is under the scrim: a real tap at 92% across each footer button activates that button (K23 regression).
- A25 With the save bar shown (state 2), opening the sheet: the sheet's top is at or below the bar's bottom; nothing of the sheet is under the bar (elementFromPoint grid over the bar).
- A26 Focus: on each state change `document.activeElement` is the state title; after Close it is the opener; never `<body>`. Escape closes in preview and refusal states and does nothing in I6 and U3; U4 has no Close button.
- A27 No element in the import and export UI has `role="alert"` or `aria-live="assertive"`.
- A28 200% root font size at 375x667 and 812x375: footer buttons fully visible without scrolling, stacked with the primary lowest; every button at least 48 px tall; real-touch taps pass.
- A29 `prefers-reduced-motion: reduce`: the sheet and dialogs have `transition-duration` 0 and no transform animation; the I2 state contains no animated element in either mode.
- A30 Contrast: computed colours of title, body, buttons, markers, radio edges and the danger confirm meet 7.6 in both themes.
- A31 Logging a set in the workout layer still takes the same taps as before (existing tap-count check passes unchanged); the goldens, `offline`, `update` and `idb` specs pass unchanged.
- A33 Too-large export (stub `buildExport`'s size check to refuse): the 5.4 sheet shows `io.xc.title` and `io.xc.body`, nothing downloads until `Save as text file` is tapped; then exactly one `text/plain` download named `^HomeBody_full_\d{4}-\d{2}-\d{2}\.txt$` whose content parses to the full in-memory export (not the `vaultfit_v1` text), and the toast reads `io.xc.toastSaved`.
- A34 *(section 12)* R5: with the IndexedDB save faulted so the save bar shows state 2, tap Import backup and Import plans only: R5 opens with `io.r.unsaved.title` and `io.r.unsaved`, no `filechooser` event fires, and the store is unchanged. With the same fault injected between preview and Import: R5 shows at apply, nothing is imported, and the in-memory edit is still present (deep-equal) and is saved by a later successful Retry. While R5 is open, a real-touch tap on the bar's Retry hits it (the bar is neither under the scrim nor `inert`); after bar state 4 (Saved) the sheet shows `io.r.unsaved.nowSaved` and `#hb-io-status` announced it once. `Export backup` in R5 downloads a file that contains the unsaved edit. With the mirror counter seeded ahead of the committed one and no bar showing, R5 uses `io.r.unsavedNoBar`. The sheet contains no Retry button and no `role="alert"`.
- A35 *(section 12)* Handoff rules: (a) a Merge that adds nothing (`nothing: true`) leaves `state.*` identical (same object identity) and shows `io.sum.mergeNothing`; (b) in I6 no Check again control exists and Escape, scrim and Close do nothing; (c) a profile with `goal: "constructor"`, `sex: "hidden"` or `activity: "__proto__"` and a plan with `level: "active"` import with warnings, render `io.enum.unknown` where a label would show, and add no class, id or attribute containing the raw token anywhere in the DOM.
- A36 *(section 12)* UF5: after a successful import, fault the IndexedDB save so the bar shows state 2, then tap Undo import (in I7 and in the card row): UF5 opens with `io.r.unsaved.title` and `io.uf.unsaved`, **U1 and U2 never open**, and the store and in-memory state are unchanged. With `restore` stubbed to refuse with kind `unsaved` after U1 is confirmed: UF5 shows, nothing is undone, the Undo row stays. With no bar showing and the mirror counter ahead: `io.uf.unsavedNoBar`. After bar state 4 the sheet shows `io.uf.unsaved.nowSaved`. No Retry button and no `role="alert"` in the sheet.
- A37 Kind mapping is complete: a unit test iterates `HBStorage.IMPORT_KINDS`, the store's read-only kinds (`corrupt`, `future`, `unavailable`, `stale`, `restoring`, `importing`, `restored`) and `validate.js` `REASONS`, and asserts each has exactly one row in the 10.1 table and that every copy key in that row exists in the copy table; an unknown kind fails the test. e2e: (a) with the store locked as `restored` (Undo finished, before Restart; U4 cannot be closed, so drive the pre-check function directly) the import pre-check maps to R2b; (b) seeded `stale` boot shows R2 for Import and UF2 for Undo; (c) Check again after `dispose()` shows F9; (d) `restore` stubbed to throw `restored` shows UF2b.
- A38 Save bar hidden for deliberate locks (10.2): (a) after Undo reaches U4 (store kind `restored`), `#hb-save` is not displayed, `html.hb-save-on` is absent, `--hb-bar-h` is `0px`, the bar's alert and status regions were never written, and focus is on the U4 title; (b) with `writeDoc` held open during I6 (kind `importing`) and during U3 (kind `restoring`), the same holds and the sheet's top does not move (bounding box unchanged within 1 px); (c) control: seeded `corrupt`, `future`, `unavailable` and `stale` still show bar states 6, 7, 8, 8 with the alert written once; (d) an import whose write finds newer data (store locks `future`) shows bar state 7 and the sheet R2.
- A32 Offline (context offline after first load, modules precached): the full import, Undo and export flows work.

---

## 10. Notes for the implementer (not decisions for James)
- Reason codes: T7a defines the codes; T7b maps each to exactly one row of 4.11 / 6.4. Add a unit test that every code exported by `validate.js` and `importDoc` has a mapping. An unmapped code is a stop condition, not a reason to write copy.
- `summarize` must provide, as numbers or validated dates: per-category in-file, new, present and (Replace) removed counts; first and last workout date; `_exported`; re-id'd count; in-file duplicate count; dropped count; future-date count; `partial`; mirror-ceiling flag; profile case (one of the six in 4.3.3) and the incoming profile name; plan list (name, day count, present flag) for plans-only. If any of these is missing, stop and report rather than computing it in the UI from `state.*`.
- Dictionary entries (personal records, progression log) must come back from the validator with a position, not the key, in `where`. If `where` contains a key or value, that is a security finding: stop and report.
- The file text is held only while the sheet is open (for Check again and Try again) and is dropped on close.
- *(Section 12; from the T7a security review)* **Apply stays modal; state is replaced in the same `.then`.** From the Import (or Add plans) tap until `state.*` has been replaced, the sheet stays in I6 (no Close, Escape or scrim; `.app` inert), and `state.*` is replaced in the same `.then` as the `importDoc` result, before any other tap is handled. Saves refused by the `importing` lock in that window are silent (no bar, no toast); that is expected and is only safe because nothing else can be tapped.
- *(Section 12)* **`nothing: true`.** Check `r.nothing` first. When it is true, do **not** replace `state.*` from `r.doc` (it is the IndexedDB read, not an import result); show the "nothing to add" outcome.
- *(Section 12)* **`Check again` is unavailable while applying.** In I6 it is not rendered; in C1 it is busy (`aria-disabled`, label unchanged) from its tap until the new preview shows, so a double tap cannot start two previews or an apply.
- *(Section 12)* **"Nothing to add" comes from `summarize`.** `summarize` exposes a boolean for "Merge adds nothing"; `io.sum.mergeNothing` and `io.plan.allPresent` are chosen from that boolean only, never by adding up counts in the UI.
- *(Section 12)* **Unrecognised setting values.** Unrecognised enum tokens (profile `goal`, `sex`, `activity`; plan `goal` and `level`) arrive as warnings, not refusals. They are never displayed raw: a label comes from a fixed lookup table checked with `Object.hasOwn(table, token)` (so `constructor`, `__proto__`, `toString` never match inherited properties), and an unknown token shows `io.enum.unknown` through `textContent`. A token is never used as a class name, id or attribute; where a class is derived from a known token it is namespaced and taken from the table's own value (`hb-goal-<value>`), never from the raw token, so tokens such as `hidden` or `active` cannot hit existing classes. No new preview warning line is added for these.
- *(Section 12)* **R5 kind `unsaved`.** The synchronous pre-check reads the store status: `failed` or `retrying`, or the mirror counter ahead of the committed counter, maps to R5. The same kind from `previewImport` or `importDoc` maps to R5 too. Choose `io.r.unsaved` when the save bar is showing, otherwise `io.r.unsavedNoBar`.
- **Kind to state (10.1).** T7b asserts this table is complete (A37).

#### 10.1 Kind to state
Sources: `HBStorage.IMPORT_KINDS` and the store's read-only kinds in `src/hb-storage.js` (~114-138 on `claude/m1-t7-import`), and `REASONS` in `src/storage/validate.js`. "Import" means `importBlocked`, `previewImport`, `importDoc` or `HB.io`; "Undo" means `checkUndo` or `undoImport`.

| Kind (and reason) | Import state | Undo state | Notes |
| --- | --- | --- | --- |
| `workout-active` | R1 | UF1 | |
| `corrupt`, `future`, `unavailable` (read-only) | R2 | UF2 | the save bar shows states 6, 7, 8 |
| `stale` (read-only) | R2 | UF2 | the bar shows state 8 |
| `restoring`, `importing` (read-only) | R2b | UF2b | |
| `restored` (read-only) | R2b | UF2b | after a finished Undo the Undo row is gone; this covers another path reaching the store before Restart |
| `unsupported` (localStorage fallback engine) | R3 | UF2 | |
| `not-loaded` | R4 | UF2 | |
| `unsaved` | R5 | UF5 | |
| `io-unavailable` | M1 (export: XM1) | M1 | |
| `io-skew` | M2 (export: XM2) | M2 | |
| `read-failed` | F8 | n/a | |
| `consumed` | F9 | n/a | |
| `invalid` + `too-large` | F1 | n/a | `{size}` from `file.size` |
| `invalid` + `empty`, `not-json`, `not-text`, `bad-version`, `migration-failed` | F2 (F5 for `bad-version`, same copy) | n/a | |
| `invalid` + `not-homebody`, `missing-workouts` | F3 | n/a | |
| `invalid` + `newer-version` | F4 | n/a | |
| `invalid` + `missing-field`, `bad-type`, `out-of-range`, `too-long`, `too-many`, `bad-chars`, `bad-key`, `bad-enum`, `bad-date` | F6 (list, reasons per 6.4) | n/a | |
| `invalid` + `id-space` | F7 | n/a | |
| `no-plans` | P0 | n/a | |
| `partial-replace` | stays in I4: Replace shown unavailable with `io.opt.replacePartial`, announced through `#hb-io-status` | n/a | the UI prevents it; this is the backstop |
| `changed-elsewhere` | C1 | n/a | |
| `changed-since` | n/a | U2 (shown again, then the user decides) | race between `checkUndo` and `undoImport` |
| `not-found` | n/a | UF4 | |
| `bad-mode` | W2 | n/a | a programming error; never expected; test that the UI only passes `merge`, `replace`, `plans` |
| no kind, quota error (write) | W1 | UF3 | |
| no kind, any other error | W2 | UF3 | |
| `restore` migration reason (from `runMigrations`) | n/a | UF3 | |

Engineering notes (not copy):
- **Pre-picker check reads `HB.storage.status()` synchronously.** `importBlocked()` is asynchronous (it awaits `usable()` and `settled()`). The file picker must open inside the tap handler, so the **pre-picker gate is a synchronous read of `HB.storage.status()`** (read-only kind, fallback, loaded, unsaved) and `hbWorkoutActive()`; `importBlocked()` then runs after the file is chosen, and `importDoc` checks again at apply. Do not `await importBlocked()` before `input.click()`.
- After a successful Undo the store locks with `restored`; without 10.2 the bar would show state 8 "Saving is not working" above U4 "Import undone". 10.2 prevents that.

#### 10.2 Save bar hidden for the deliberate locks (James, 2026-11-04)
- **Condition, exactly:** the save-problem bar does not render a read-only state (6, 7 or 8) when the store's read-only kind is `restored`, `restoring` or `importing`. These locks are deliberate and the import sheet explains them (I6, U3, U4, R2b, UF2b). Test the kind itself, not the published bar state (the store maps every unknown kind to `unavailable`), for example `status().readOnlyKind` or a `deliberate: true` flag published with it.
- **Every other read-only kind still shows the bar:** `corrupt` (state 6), `future` (state 7), `unavailable` and `stale` (state 8), including when an import or restore ends by locking with one of them (the store locks with `future` or `corrupt` if it finds such data in the write); the sheet then shows R2 or UF2, whose copy points to "the message at the top".
- **Not-saved states 1 to 3b and 5 are unaffected.** They cannot start inside these locks (saves refused by the lock are silent, section 10 above), and an import or Undo cannot start while one shows (R5, UF5). If one is already on screen when a lock begins (a failure that publishes in the same frame), it stays; the hide rule never removes a showing bar.
- **Nothing is announced and nothing moves:** while hidden for these kinds the bar's `role="alert"` and `role="status"` regions are not written, `html.hb-save-on` is not set and `--hb-bar-h` stays `0px`, so the sheet does not jump. The bar never takes focus in any case; focus stays on the sheet title (I6, U3, U4) as specified in 7.1.
- **After the lock:** `importing` is released when `state.*` has been replaced (success) or on failure; nothing is shown for it. `restored` lasts until Restart; the reload starts a normal session. `restoring` either becomes `restored` or is released on failure (UF3).
- Scope: a one-condition change in the bar code; recorded as an amendment in write-failure-banner.md (2026-11-04).

- The shipped overwrite box text ("This will overwrite all current data ... This cannot be undone.") is wrong after T7 (Merge is default; Undo exists) and must not survive anywhere.

---

## 11. Decisions (James, 2026-11-04, in chat)

1. **Too-large backup:** `Save as text file` saves the full export as `HomeBody_full_<YYYY-MM-DD>.txt`, labelled not importable today (5.4). Not the as-found copy, which is stale at that size.
2. **Partial label (K30):** the save bar's `Export` reads `Export this session` in states 6 to 8 (5.3); recorded as a dated amendment in write-failure-banner.md.
3. **Undo lifetime:** until reload, from the success state and the card row (4.8). After that, T8's restore list.
4. **After Undo:** the user taps Restart (U4); no automatic reload.
5. **Layer:** the import sheet and its dialogs are at z 9800 (`--z-dialog`), above the FAB (section 8).
6. **Plans-only:** gets the same Undo (4.10).
7. **Problem lists:** positions only, never values, for import and export (6.4).

## 12. Addendum 2026-11-04: refusal R5 "Not saved yet" and T7b handoff rules

Status: **Approved by james585 on 2026-11-04, in chat** (R5 as written; Undo also refuses on `unsaved`, 12.6). Source: the T7a security review (approach approved by James on 2026-11-04): `importDoc` and `previewImport` refuse with kind `unsaved` when the store has a failed save (status `failed` or `retrying`, or the mirror counter is ahead of the committed one), because a Merge import builds on the last committed data and would wipe an edit that so far exists only in memory and in the plain copy (principle 1).

### 12.1 R5 Not saved yet
- **When:** at the Import backup or Import plans only tap, before the file picker opens (with R1 to R4; the picker never opens), and at apply if it appears then (I6 to R5; nothing imported; the file text is dropped).
- **No second save-problem UI.** R5 does not offer Retry itself. It points to the approved save-problem bar (write-failure-banner.md) and uses its words: not saved, Retry, Export, Saved. The bar is at z 10000, outside `.app`, and pushes the sheet down, so it stays visible and tappable above R5's scrim. `inert` goes on `.app` only, never on `#hb-save`.
- **Copy:** title `io.r.unsaved.title`. Body `io.r.unsaved` when the save bar is showing (states 1 to 3b; state 5 cannot occur because import is refused during a workout), or `io.r.unsavedNoBar` when the kind is `unsaved` but no bar is showing (the plain copy is ahead with no failed save this session). Marker: circle `!` in `--danger`, as in the bar, because data is at risk.
- **Actions:** footer left `Close` (secondary), right `Export backup` (primary, `io.btn.export`). Export runs E1 unchanged; the backup includes the unsaved in-memory edit, which is what protects it. R5 stays open and E1's toast confirms; an export warning or refusal replaces R5 with 5.2 or 5.4 as usual. No Retry button in the sheet.
- **When the bar reaches Saved** while R5 is open, the body gains the line `io.r.unsaved.nowSaved` (`--text`, no marker), announced once through `#hb-io-status`; focus does not move. The user closes and taps Import again (a fresh tap gives the picker its permission).
- **Accessibility:** as every refusal: focus to the title on open, `aria-describedby` = the body, Escape and scrim = Close, focus returns to the opener. No `role="alert"`: the bar has already alerted once for this episode and R5 must not alert again. Tab order follows 7.1: body, footer Close, Export backup, then the header Close. While `aria-modal` is set a screen-reader user cannot move to the bar, so the body names it ("the message at the top") and `Export backup` is the way to protect the data from inside the dialog; after closing R5, the bar's Retry is the next region in reading order. 48 px buttons; at 200% text the footer stacks with Export backup at the bottom.
- **Light and dark, accent:** tokens as in 7.6 and 7.7; nothing new.

375 x 667, dark, save bar in state 2 above the sheet:
```
+---------------------------------------------+  save bar (z 10000), unchanged
| (!) Not saved. Keep HomeBody open.          |
|     Something stopped HomeBody saving...    |
| [      RETRY      ]  [      EXPORT      ]   |
+=============================================+
| ...scrim...                                 |
+---------------------------------------------+  import sheet, pushed below the bar
| (!) Not saved yet                 [ CLOSE ] |
|                                             |
| Your latest changes aren't saved yet, and   |
| importing now could lose them. Tap Retry on |
| the message at the top, or export a backup  |
| to keep a copy. When it says Saved, try     |
| again. Nothing was changed.                 |
|                                             |
| (after Saved:) Saved. Close this and choose |
| your file again.                            |
+---------------------------------------------+
| [   CLOSE   ]        [  EXPORT BACKUP  ]    |
+---------------------------------------------+
```

### 12.2 Copy added
`io.r.unsaved.title`, `io.r.unsaved`, `io.r.unsavedNoBar`, `io.r.unsaved.nowSaved` and `io.enum.unknown`, all in section 6.5.

### 12.3 Handoff rules (engineering contract)
In section 10: apply stays modal and `state.*` is replaced in the same `.then` (refused saves during import are silent); check `r.nothing` and never replace state from `r.doc` when it is true; `Check again` unavailable while applying; `summarize` exposes the "Merge adds nothing" boolean used for `io.sum.mergeNothing` and `io.plan.allPresent`; unrecognised enum tokens render only through own-property lookup tables and text nodes, never as un-namespaced class names.

### 12.4 Checks
A34, A35 and A36 (section 9).

### 12.5 Decisions (James, 2026-11-04, in chat)
1. **R5 approved as written:** it points to the save bar's Retry, `Export backup` is the primary action, and there is no Retry in the sheet.
2. **Undo also refuses when changes are not saved:** same pattern (12.6).

### 12.6 UF5 Undo refused: not saved yet
- **When:** at the Undo import tap (in I7 or the card row), before U1 or U2 opens; and if `restore` refuses with kind `unsaved` after U1 or U2 was confirmed. Nothing is undone; the import stays; the Undo row stays.
- **Copy:** title `io.r.unsaved.title` (`Not saved yet`); body `io.uf.unsaved` when the save bar is showing, otherwise `io.uf.unsavedNoBar`; after the bar reaches Saved, the added line `io.uf.unsaved.nowSaved` (section 6.7).
- **Actions, a11y, layering, light and dark:** exactly as R5 (12.1): footer `Close` (left) and `Export backup` (primary, right); circle `!` in `--danger`; focus to the title; Escape and scrim = Close; focus returns to the Undo button; no `role="alert"`; the bar stays above and tappable. The wireframe is R5's with the UF5 body.
- **Engineering:** storage-sync-engineer adds the `unsaved` check to `restore` (refuse with kind `unsaved`, nothing written), alongside the existing workout and read-only checks. Check: A36.

### 12.7 Kind mapping additions (2026-11-04; approved by james585 on 2026-11-04, in chat)
From the T7a security re-check (L3): the store can return kinds this spec did not name. Mapped in 10.1, keeping to existing states and copy where possible: `stale` joins R2 / UF2, `restored` joins R2b; new are UF2b (Undo while a restart is pending; copy `io.uf.restart`) and F9 (`consumed`: copy `io.f.again.title`, `io.f.again`). Check: A37.

Decisions (James, 2026-11-04, in chat):
1. **UF2b and F9 approved** with their copy, and the 10.1 table with A37.
2. **The save bar is hidden for the read-only kinds `restored`, `restoring` and `importing`**; every other read-only kind still shows it. Contract in 10.2, check A38, amendment in write-failure-banner.md.

## Approval
Approved by james585 on 2026-11-04, in chat (answers in section 11).
