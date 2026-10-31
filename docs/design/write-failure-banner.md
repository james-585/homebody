# Save-problem bar (write-failure banner)

Status: Approved. Approved by james585 on 2026-10-31, in chat. Answers: Q1 hold T4 update card and About Update/Reload while a save failure shows (one-condition widening of T5); Q2 accept misleading "saved" toasts, log K26 for T8; Q3 Retry only mid-workout, Export after Finish or Cancel; Q4 Export is the main button; Q5 no "free up space" advice; Q6 load-time bars stay all session. Author: product-designer, 2026-10-31.
Scope: only the UI that T5b needs: one bar, its states, its copy, its layering, and the CSS that moves other layers out of its way. No change to `mToast`, call sites, T4 update code or any `wm*` function (except the approved Q3 `wmPersist` catch line).
Principles: 1 (never lose data: the bar is the only truthful signal that something is not saved), 5 (works mid-workout), 7 (never slows logging), 2 (plain, calm, honest copy).

## User goal
"If HomeBody can't keep what I just did, tell me straight away, in words, and give me one tap to keep a copy. Don't get in the way of my set."

## Shared rules
- **Exception to "nothing during a workout".** docs/design/update-notice.md hides everything while `hbWorkoutActive()`. This bar is the one exception: it **must** show mid-workout, because closing the app at that moment loses data. It must never cover the workout header (title, set count, stopwatch, Cancel, Finish), any set row or tick, the rest-timer sheet or the FAB. It achieves this by **taking space, not overlaying** (see Placement).
- **No jargon.** Never "storage quota", "localStorage", "write", "error", "exception", "schema". Say saved, not saved, space, browser, version, copy.
- **Fixed strings only, via `textContent`.** One string set per state and error kind (below). The raw exception message is never shown.
- **Colour is never the only signal.** Each state has a title in words and a marker shape: circle with `!` (not saved), diamond (saving paused), tick (saved).
- **No new text in `--muted`** (fails AA, K11). All bar text is `--text`.
- **No sound, no haptic, never takes focus.**

## Placement and layering
**Top bar that pushes content down.** A full-width bar fixed to the top of the viewport. When it is shown, every full-screen layer starts below it, so it covers nothing. At the bottom nothing changes: the update card (z 150), the FAB tray (9600, K22) and the toast lane (9950) all stay where they are, and the bar cannot collide with them or with the FAB-over-sheet problem (K23).

```
#hb-save { position:fixed; top:0; left:0; right:0; z-index:10000;
           padding: max(10px, env(safe-area-inset-top)) 12px 10px;
           background:var(--surface); border-bottom:2px solid <state colour>;
           box-shadow:0 8px 32px rgba(0,0,0,0.8),0 2px 8px rgba(0,0,0,0.4);
           max-height:40vh; max-height:40dvh; }
inner content: max-width 520px; margin 0 auto
```
- The bar's rendered height is written to `--hb-bar-h` on `<html>` (a `ResizeObserver` on the bar; `0px` when hidden) and `html.hb-save-on` is set while shown.
- **Push rule** (part of the banner CSS block, no other file or function touched):
  ```
  html.hb-save-on :is(.app, .wm-overlay, .modal-overlay, .show-workout-overlay,
                      .show-wkt-overlay, #m-ex-sheet,
                      body > [style*="position:fixed"][style*="inset:0"]) { top: var(--hb-bar-h) !important }
  html.hb-save-on .modal-sheet { max-height: calc(92vh - var(--hb-bar-h)) }
  ```
  `!important` is needed because `#m-ex-sheet` and the script-built modals set `inset:0` inline. The last selector catches script-built full-screen modals that have no class. The acceptance check "nothing under the bar" (below) is what proves the list is complete; if it finds another layer, add it to this list.
- **Content does not jump under the thumb.** When the bar appears (or its height changes by d px), the scroll container that is on screen (`#wm-body` in a workout, otherwise `.page.active`) gets `scrollTop += d`; when it hides, `scrollTop -= d`. A set row the user is about to tap therefore stays at the same screen position (exact whenever the container is scrolled at least d px; at the very top it shifts down, never up, so a tap lands on the row above's space, not on another tick).
- **DOM position:** first child of `<body>`, before `.app`, so it is first in reading order.

### Z-order
| Layer | z-index | Relation to the bar |
| --- | --- | --- |
| Page sticky headers | 50 | below; pushed down with `.app` |
| Bottom nav | 100 | below; bottom of screen, no overlap |
| Update card (T4) | 150 | below; bottom of screen, no overlap |
| `.modal-overlay` and sheets | 200 | below; pushed down |
| Workout layer 9500, FAB tray 9599/9600, timer sheet 9700, confirm 9800, tutorial 9850, script modals 9900-9999 | 9000+ | below; full-screen ones pushed down, FAB and toasts are at the bottom |
| Toasts `#m-toasts` | 9950 | below; bottom lane, no overlap |
| **Save-problem bar** | **10000** | top of the stack |

The bar is the highest layer because it must never be hidden by whatever the user happens to have open. Because everything full-screen is pushed down, being on top never means covering. Record this scale in docs/design/system.md when that file is created.

## States
Two layouts. **Row layout** (two actions): marker, title and body, then a button row with two equal 48 px buttons. **Inline layout** (one action): marker, title and body on the left, one 48 px button on the right, at least 96 px wide.

| # | State | When | Marker / edge colour | Layout and actions | Dismiss |
| --- | --- | --- | --- | --- | --- |
| 1 | Not saved, retrying | first failure; the store's automatic retry is pending | circle `!`, `--danger` | Row: `Export` (primary), `Saving…` (busy, in Retry's place) | no |
| 2 | Not saved | the automatic retry failed | circle `!`, `--danger` | Row: `Retry` (secondary, left), `Export` (primary, right) | no |
| 3 | Retry in progress | user tapped Retry | same as 2 | Retry label becomes `Saving…` | no |
| 3b | Retry failed | Retry's save failed again | same as 2 | Retry label shows `Still not saved` for 2 s, then `Retry` | no |
| 4 | Saved | a save covering everything that failed has succeeded | tick, `--signal` | the button area holds one `Done` button (same height) | auto after 4 s, or `Done` |
| 5 | Mid-workout not saved | active-workout save failed (via the Q3 `wmPersist` catch) while the workout layer is open | circle `!`, `--danger` | Inline: `Retry` only (see Q3 for why no Export) | no |
| 6 | Saved data could not be read | load: `corrupt` | diamond, `--warning` | Inline: `Export` | no (whole session) |
| 7 | Saved by a newer version | load: `future` | diamond, `--warning` | Inline: `Export` | no (whole session) |
| 8 | Saving is not working | load: storage cannot be opened, or `hbBootFailed()` | diamond, `--warning` | Inline: `Export` | no (whole session) |

Notes for states:
- **1 and 3 look the same on purpose** (busy Retry slot, nothing else changes). Between 1, 2, 3, 3b only the button label changes, so the bar height never changes while the user is tapping it.
- **States 2 to 5 cover each other.** If the workout layer closes while state 5 shows, the bar switches to state 2 (row layout, Export appears) and the alert is not repeated. If a workout starts while state 2 shows, the bar stays in state 2 (Export stays; Export saves history, and the copy still holds).
- **Saved (4) must be true.** Show it only when every write that failed since the bar appeared has since succeeded: the main save (`persistSave`) and, if it failed, the active-workout save. A success of one does not clear a failure of the other.
- **Retry** calls `persistSave()`; if a workout is active it also calls `wmPersist()` (calling it, not editing it). It saves what is in memory now.
- **Export** calls `mExportData()` unchanged. Its own toast (`✓ Exported N workouts`) confirms it. Export does not change the bar: the data is still not saved in the app.
- **Load-time states 6, 7, 8** are on screen before the first visible frame (render them before `hb-booting` is removed), so nothing jumps after first paint. They stay for the whole session, including during workouts, because nothing new will be kept. They have no Retry (there is nothing a retry could fix).
- **Busy and disabled:** `Saving…` stays at full colour, gets `aria-disabled="true"` and `pointer-events:none` (same rule as T4's `Updating…`). Never the `disabled` attribute, never dimmed.

## Copy
Titles: Oswald 700, 1rem, sentence case, `--text`. Bodies: Inter 0.85rem, line-height 1.4, `--text`. At 375 px and 100% text every title fits one line and every body two lines in the row layout, three in the inline layout.

**States 1 to 3b** (title is the same for all, so nothing reflows):
- Title: `Not saved. Keep HomeBody open.`
- Body by kind:
  - `quota`: `HomeBody is out of space in this browser. Tap Export to keep a copy of everything.`
  - `unavailable`: `This browser is stopping HomeBody from saving. Tap Export to keep a copy of everything.`
  - `unknown`: `Something stopped HomeBody saving. Tap Retry, or Export to keep a copy.`

We do not say "free up space on your phone": the limit is the browser's allowance for HomeBody, not the phone, so that advice would usually be false (see Q5).

**State 4:** title `Saved`; body `Everything is saved on this device.`; button `Done`.

**State 5** (any kind): title `Workout not saved yet`; body `Keep HomeBody open. Your sets are on screen. Finish as normal and it saves again.`; button `Retry`.

**State 6:** title `Saved data could not be read`; body `It has not been changed. Saving is paused so nothing overwrites it. Don't delete HomeBody or clear its data.`; button `Export`.

**State 7:** title `Saved by a newer version`; body `Your history is untouched. Saving is paused so nothing is lost. Close and reopen HomeBody to get the newer version.`; button `Export`.

**State 8:** title `Saving is not working`; body `This browser is blocking HomeBody's saved data, so nothing new will be kept. Nothing has been deleted. Close and reopen HomeBody.`; button `Export`.

Button labels (Oswald, uppercase via the existing button classes): `Retry`, `Export`, `Saving…`, `Still not saved`, `Done`.

## Wireframes
**375 x 667, state 2 (row layout), on Home.** About 136 px tall at 100% text.
```
+-------------------------------------------+  <- top of viewport (safe area padding)
| (!) Not saved. Keep HomeBody open.        |  Oswald 1rem
|     HomeBody is out of space in this      |  Inter 0.85rem
|     browser. Tap Export to keep a copy... |
| +------------------+ +------------------+ |
| |      RETRY       | |      EXPORT      | |  48px, equal width, 8px gap
| +------------------+ +------------------+ |
+===========================================+  <- 2px --danger edge
| HOME header (sticky, pushed down)         |
| ...page content...                        |
|                                      [⚡] |  FAB unchanged
|  toasts lane unchanged                    |
+---------- bottom nav unchanged -----------+
```
**375 x 667, state 5 (inline), mid-workout.** About 96 px tall; the workout header moves down intact.
```
+-------------------------------------------+
| (!) Workout not saved yet    +----------+ |
|     Keep HomeBody open. Your |  RETRY   | |  48px tall, >= 96px wide
|     sets are on screen. ...  +----------+ |
+===========================================+
| PUSH DAY A        0:42      CANCEL FINISH |  .wm-header, fully visible
| 6/18 sets ======-------------------- 33%  |
| BENCH PRESS                               |
|  1  60kg  8  [✓]                          |  rows keep their screen position
|  2  60kg  8  [ ]                          |  (scroll compensation)
```
**430 x 932 and wider:** identical structure; inner content is `max-width:520px`, centred, so buttons never stretch past 260 px each. Bar about 118 px (body fits two lines).

**State 4 (row layout):**
```
| (✓) Saved                                 |
|     Everything is saved on this device.   |
| +---------------------------------------+ |
| |                 DONE                  | |
| +---------------------------------------+ |
+===========================================+  <- 2px --signal edge
```
**State 6 (inline), diamond marker in `--warning`:**
```
| <> Saved data could not be read +--------+ |
|    It has not been changed. ... | EXPORT | |
|    ... or clear its data.       +--------+ |
```

## Interaction details
- **Buttons:** `Export` = `.btn-primary` (right, nearest a right thumb); `Retry` and `Done` = `.btn-secondary`. Every button `min-height:48px`; in the row layout each is half the inner width (about 171 px at 375). No close X and no swipe (sweaty thumbs; and states 1-3 and 5-8 must not be dismissable).
- **Marker:** 20 px, vertically aligned with the title. Not-saved: 2 px `--danger` ring with a bold `!` in `--danger`. Paused: 12 px square rotated 45 degrees in `--warning` (same shape as T4 "Setup failed"). Saved: `✓` in `--signal`. Markers are `aria-hidden="true"`; the words carry the meaning.
- **Large text:** at 200% text the bar may grow up to `40dvh`. Then the title and body scroll inside the bar (`overflow-y:auto; overscroll-behavior:contain`) and the button area is pinned to the bar's bottom (`position:sticky; bottom:0; background:var(--surface)`), as in T4 Amendment 4. Buttons are never clipped.
- **Auto-dismiss (state 4 only):** 4 s, paused while focus is inside the bar. On dismiss, if focus was inside the bar it moves (with `preventScroll`) to the Finish button when the workout layer is open, otherwise to the active bottom-nav tab (`aria-current="page"`, T4). Never to `<body>`.
- **Motion:** the bar fades in over 150 ms (opacity only; no slide, because the layers below move once in a single step and scroll compensation keeps content still). Fade out 150 ms after Saved. `prefers-reduced-motion: reduce`: no transition.
- **Relation to toasts.** Call sites call `persistSave()` and then show their own toasts (`✓ Workout saved — ~X–Y kcal`, `Workout deleted`, `✓ "Plan" saved`). Those toasts describe the action in memory, not the save, and T5 does not change them. **The bar is the truthful signal and it wins:** it appears in the same frame as the failed save (the store must publish the failure, state 1, synchronously inside the `persistSave()` call when the first attempt throws), it sits at the top while toasts sit at the bottom so both are readable, and it outlives every toast (toasts last about 3 s; the bar stays until saved). Screen-reader users hear only the bar, because toasts have no live region (K21). The remaining contradiction (a "saved" toast while the bar says not saved) is Q2.
- **Relation to the update card.** Both may be on screen (top and bottom). See Q1: reloading for an update while the bar says not saved would lose the unsaved changes.

## Accessibility
- Bar container: `role="region" aria-label="Saving"`. Its visible text is not a live region.
- Two visually hidden live regions **outside the bar**, always in the DOM from page load (so they exist before any text arrives):
  - `role="alert"`: receives title + body **once per episode**, one frame after the bar first shows (an episode runs from the bar appearing to it being dismissed; load-time states are one episode for the session). Never written again in that episode, including when the workout closes (5 to 2).
  - `role="status"` (polite): receives `Saving…`, `Still not saved`, and `Saved. Everything is saved on this device.` when those happen. Emptied silently when the bar hides.
- The bar never takes focus. Buttons are real `<button type="button">`s with visible focus `outline:2px solid var(--text); outline-offset:2px`. Tab order: Retry, Export (or the single button). No Escape behaviour (not dismissable).
- Tap targets: 48 px tall minimum, at least 96 px wide.

## Measured contrast (WCAG 2.x, from `:root` and `[data-theme="light"]`)
| Pair | Dark | Light | Need |
| --- | --- | --- | --- |
| `--text` on `--surface` (title, body) | 15.83 | 18.24 | 4.5 |
| `--text` on `--surface2` (`.btn-secondary` label) | 13.98 | 15.68 | 4.5 |
| `#000` on `--accent` (`.btn-primary` Export, `Saving…` if shown in primary) | 5.53 | 5.53 | 4.5 |
| `--danger` marker on `--surface` (non-text) | 3.77 | 5.99 | 3.0 |
| `--danger` 2 px edge vs `--bg` (bar edge vs page) | 4.13 | 5.70 | 3.0 |
| `--warning` marker on `--surface` | 5.14 | 3.24 | 3.0 |
| `--warning` 2 px edge vs `--bg` | 5.63 | 3.08 | 3.0 |
| `--signal` marker on `--surface` | 5.20 | 5.12 | 3.0 |
| `--signal` 2 px edge vs `--bg` | 5.69 | 4.86 | 3.0 |
`--surface` vs `--bg` is only 1.09 / 1.16, so the coloured 2 px bottom edge (plus shadow) is what separates the bar from the page. No coloured text is used (`--danger` text on dark `--surface` is 3.77, below 4.5). Light-theme `--warning` edges pass at 3.08 with little margin; do not lighten it.

## Acceptance checks
Run at 375x667, 390x844 and 430x932, dark and light, unless stated. Taps use real touch (`page.touchscreen.tap`) at 85% across the button and its vertical centre, never `element.click()`.
1. **Not saved after Finish (AC2).** With `setItem` throwing `QuotaExceededError` for `vaultfit_v1`, Finish a workout: the bar shows state 1 in the same frame as the Finish toast, then state 2 with the `quota` copy, `Retry` and `Export`, the circle marker and a `--danger` edge. The `role="alert"` region was written exactly once.
2. **Nothing under the bar.** While the bar shows, sample `document.elementFromPoint` on a 10 px grid over the bar's rectangle: every hit is the bar or a descendant. Then, for every visible element with computed `position:fixed` other than the bar, its top is >= the bar's bottom, or it is the bottom nav, FAB tray, toast container or update card. Repeat with: Home, Progress, a `.modal-overlay` sheet open, the exercise sheet open, the workout layer open, and the rest-timer sheet open from the FAB during a workout.
3. **Workout untouched (state 5).** With the active-workout save faulted, tick a set: the bar shows state 5. `.wm-header` (title, stopwatch, Cancel, Finish) is fully visible below the bar; a real-touch tap on the next set's tick and on Finish hits them; the rest-timer sheet opens fully visible; logging a set still takes the same taps as before.
4. **No jump under the thumb.** With `#wm-body` scrolled at least the bar height, the next set's tick has the same screen `y` (within 1 px) before and after the bar appears and after it hides. Same for `.page.active` on Home.
5. **Retry.** While still faulted, tap Retry: label `Saving…` (full colour, `aria-disabled`), then `Still not saved` for 2 s, then `Retry`; bar top and height change by 0 px; the alert is not re-written; the status region announces both. Clear the fault, tap Retry: state 4 (tick, `--signal` edge, `Done`), `vaultfit_v1` holds the workout, the bar disappears after 4 s, and focus (if it was on Retry) lands on the active nav tab, never `<body>`.
6. **Export.** Real-touch tap on Export in state 2 downloads a file containing the unsaved finished workout; the bar stays in state 2.
7. **Saved is honest.** With both the main save and the active-workout save having failed, a successful main save alone does not show state 4.
8. **Load-time states.** Seed an unreadable blob (state 6), a `schemaVersion` above current (state 7), and a storage open failure / aborted `src/storage/store.js` (state 8): the bar is present in the first visible frame (frame sampler), has only `Export`, never auto-dismisses, stays during a workout, and the stored blob is byte-identical after a Finish.
9. **Large text.** At 200% text, including landscape 812x375: buttons fully visible and unclipped without scrolling the bar; bar height <= 40% of the viewport; touch taps on the buttons pass.
10. **Reduced motion.** With `prefers-reduced-motion: reduce`, the bar has no transition.
11. **Text safety.** Every string in the bar equals one of the constants in Copy; no exception message appears in the DOM; text is set with `textContent`.
12. **Contrast.** Computed colours of title, body, buttons, marker and edge match the table above in both themes.

## Tokens and components used
`--surface --surface2 --bg --text --accent --danger --warning --signal --border`; `.btn-primary .btn-secondary`; `mExportData()`, `persistSave()`, `wmPersist()` (called, not changed). New: one CSS custom property `--hb-bar-h` (set by script, `0px` when hidden) and the html class `hb-save-on`. No new colour tokens. Z-index 10000 joins the scale in update-notice.md.

## Open questions for James (recommendation first)
1. **Update while not saved.** Tapping `Update` or `Reload` on the T4 card reloads the page, which throws away exactly the changes the bar says are not saved, and that card says "Your history is kept". Recommend: while the bar is in states 1-3b or 5, hold the T4 card and About's Update/Reload button (a one-condition change in T4 code, so T5 scope widens by one line), and release them once Saved. Alternative: log it as a known issue for T6.
2. **"Saved" toasts that are not true.** `✓ Workout saved — ~X–Y kcal` and the other "saved" toasts still show when the save failed. Recommend: accept for T5 (the bar appears in the same frame, stays longer, and is the only thing screen readers hear) and log it as K26 for T8, where those toasts would wait for the store's result or say "logged" instead. Alternative: widen T5 to reword those five toast strings now.
3. **No Export mid-workout.** `mExportData()` exports saved history plus finished workouts, not the sets of the workout in progress, so an Export button during a workout would suggest it protects those sets when it does not. Recommend: state 5 offers Retry only, and Export appears as soon as the workout is finished or cancelled (state 2). Alternative: show Export mid-workout with the label `Export history`.
4. **Export as the main button.** Recommend Export is primary (orange, right): for the likely cause (out of space) Retry will not work until T6, and Export is the action that protects data. Alternative: Retry primary.
5. **Out-of-space advice.** There is nothing the user can do in the app to free space until T6 (IndexedDB). Recommend: say only "out of space in this browser" and "Export", with no "free up space" advice that would usually be false. Alternative: add "Delete old progress photos" or similar if T6 is far off.
6. **Load-time bars stay all session.** Recommend: yes, including during workouts, because nothing new will be kept and the user must know before logging. Alternative: allow collapsing to a slim 48 px "Saving paused" strip (new UI, more to build and test).

## Notes for the implementer (not decisions for James)
- The store's `subscribe` needs to publish: `retrying` (synchronously, inside the failing `persistSave()` call), `failed` with `kind`, `saving` (Retry started), `saved`, and the load-time `readonly` with `reason` (`corrupt` | `future` | `unavailable`). If it cannot publish `retrying` synchronously, the bar starts at state 2 after the automatic retry, and acceptance check 1's "same frame" becomes "within the retry delay": report this rather than changing the spec.
- State 5 needs the Q3 `wmPersist` catch to publish into the same channel, and a way to know the active-workout save later succeeded (check 7). If that needs more than the approved one-line catch edit, stop and report (T5 stop condition).
- `hbBootFailed()` has no `HB.storage`; it renders state 8 directly through the same render function.
