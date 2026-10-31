# Update notice, offline-ready toast and Profile -> About

Status: Approved by James on 2026-10-31, in chat, with Q1-Q4 answered as recommended (bottom card above the FAB; full 12-hex version with Copy; toast screen-reader gap accepted and logged as K21; keep "Your history is kept."). (T4 step 0, docs/plans/m1/T4.md). Author: product-designer, 2026-10-31.
Scope: only the UI that T4 needs. No other screen changes. Principles: 5 (never interrupt a workout), 7 (never slow logging), 2 (plain, honest copy).

## User goal
"Get the new version when it suits me, never mid-set, and know the app works in the garage without signal."

## Shared rules (all states)
- **Never during a workout.** While `hbWorkoutActive()` is true, nothing in this spec appears: no banner, no toast, no sound, no haptic. If a workout starts while the banner is showing (the `#wm-overlay` appears), the banner hides at once and is held again.
- **No jargon.** User copy never says "service worker", "cache", "hash" or "refresh". It says update, reload, offline, version.
- **Text only via `textContent`.** All strings below are constants; `VERSION` is hex only.
- **Colour is never the only signal.** Every status has words; dots are decoration.
- **Do not use `--muted` for any new text.** Measured: `--muted` #8C7B6E is 4.10:1 on dark `--surface` and 4.06:1 on light `--surface` (fails AA for small text, K11). All new text uses `--text`.

## Measured contrast (WCAG 2.x, from the :root and [data-theme="light"] values)
| Pair | Dark | Light | Need |
| --- | --- | --- | --- |
| `--text` on `--surface` (banner copy, About rows) | 15.83 | 18.24 | 4.5 |
| `--text` on `--surface2` (`.btn-secondary` label) | 13.98 | 15.68 | 4.5 |
| `#000` on `--accent` (`.btn-primary` label) | 5.53 | 5.53 | 4.5 |
| `--accent` border vs `--bg` (banner outline vs page) | 4.80 | 3.61 | 3.0 |
| `--accent` border vs `--surface` | 4.38 | 3.80 | 3.0 |
| `--signal` dot on `--surface` (Ready) | 5.20 | 5.12 | 3.0 |
| `--warning` dot on `--surface` (Setting up) | 5.14 | 3.24 | 3.0 |
| `--muted` dot on `--surface` (Not available; non-text only) | 4.10 | 4.06 | 3.0 |
`--surface` vs `--bg` is only 1.09 (dark) and 1.16 (light), so the banner's edge is the 1.5px `--accent` border, not the fill. Accent-coloured *text* is not used (3.80 on light surface fails 4.5).

## State 1: update available (Update / Later)
**Placement.** Floating card in the bottom thumb zone, above the FAB, never over the nav or the FAB:
`position:fixed; left:14px; right:14px; max-width:520px; margin:0 auto; bottom:calc(var(--nav-h) + var(--safe-bottom) + 74px)` (74 = 14 FAB gap + 48 FAB + 12 clearance). Measured at 390x844: FAB top 718, banner bottom 706. `z-index:9590`: above pages, sheets (9000-9200) and the workout layer (unused, it is hidden then); below the FAB tray backdrop (9599), FAB (9600), timer modal (9700), confirm dialog (9800), tutorial (9850) and toasts (9950), so it never covers a dialog the user opened.
**Look.** `--surface` fill, `1.5px solid var(--accent)` border, radius 14px (`.card`), padding 14px 16px, existing toast shadow. Same at 375 px and 430 px; centred with max 520px on larger screens.
```
+------------------------------------------+   <- 1.5px --accent border
| Update ready                             |   Oswald 700, 1rem, --text
| Reloads HomeBody. Your history is kept.  |   Inter 0.85rem, --text
| +-----------------+  +-----------------+ |
| |      LATER      |  |     UPDATE      | |   48px tall, equal width, 8px gap
| +-----------------+  +-----------------+ |
+------------------------------------------+
           (FAB 48px, right)            [O]
=========== bottom nav (64px + safe area) ==========
```
**Controls.** `Later` = `.btn-secondary`, `Update` = `.btn-primary` (primary on the right, nearest the right thumb). Each `min-height:48px`, half the width (about 150 px at 375). No close X, no swipe-to-dismiss (too easy to trigger with a sweaty thumb).
**Update tap.** Re-check `hbWorkoutActive()`; if true, hide and hold. Otherwise the button reads `Updating…`, both buttons disable, and the page reloads when the new version takes over. If no reload has happened after 10 s, the buttons quietly return to `Later` / `Update` (no error text; see State 6).
**Later tap.** Banner hides for this page session. The update applies the next time HomeBody is fully closed and reopened. Profile -> About shows the quiet `Update now` line (State 5).
**Motion.** Enter: 200 ms ease-out, `translateY(16px)` + opacity 0 -> 1. Exit: 150 ms opacity. No overshoot (unlike `.m-toast`). `prefers-reduced-motion: reduce`: no translate, no transition (appears and disappears instantly).
**Accessibility.** Container `role="region" aria-label="App update"`, placed in the DOM just before `<nav class="bottom-nav">`, hidden with the `hidden` attribute (out of tab order and the accessibility tree). Inside, an always-present `role="status"` element (polite) receives the title + body text when the banner is shown, so screen readers announce "Update ready. Reloads HomeBody. Your history is kept." **Never `role="alert"`, never assertive, never `.focus()`**: focus stays where the user is. Buttons are real `<button>`s; visible focus ring `2px solid var(--text)`, offset 2px. Escape while focus is inside = Later.

## State 2: update held during a workout
**During the workout:** nothing. No banner, no badge, no toast, no sound, no About change visible (About is unreachable under the workout layer anyway).
**After Finish or Discard (Cancel Workout):** the existing save confirmation is the priority. Finish shows "✓ Workout saved — ~X–Y kcal" plus possible PR (+0.5 s) and milestone (+0.8 s) toasts, each about 3 s; Discard shows "Workout cancelled". The banner appears **only once the toast stack (`#m-toasts`) is empty, and no sooner than 4 s after the workout layer closes**, in the State 1 position, on whatever page the user landed on (normally Home). It never covers or replaces the save toast. If another workout starts first, it stays held. Copy and controls are State 1's.

## State 3: updated in another window, reload needed
Same card, position, motion, roles and hold rules as State 1. Shown at this page's next safe moment; never reloads while `hbWorkoutActive()`.
- Title: `HomeBody was updated`
- Body: `Updated in another window. Reload to use the new version.`
- Buttons: `Later` (`.btn-secondary`) / `Reload` (`.btn-primary`), 48px.
- `Reload` re-checks `hbWorkoutActive()`, then reloads. `Later` hides it for the session; About shows the reload line (State 5).

## State 4: first install, "ready to use offline" (one time)
Reuse `mToast` unchanged: `mToast('Ready to use offline', 'success')` (green ✓, `--signal` left edge, existing bottom position above the nav). Shown once per page session when this page goes from uncontrolled to controlled. Not shown if `hbWorkoutActive()` (About still says Ready). It may stack with the existing welcome toast and sit over the first-run sheet; both are existing behaviour and harmless. Known gap: `#m-toasts` has no live region, so screen readers do not hear it; About's Offline line is the accessible, persistent source (see Q3).

## State 5: Profile -> About card
New `.card` (`margin-top:10px`) directly after **Data & Backup** in `#page-profile`. Title `About` (`.card-title`). Rows are `min-height:48px`, `display:flex; justify-content:space-between; align-items:center`, separated by `1px solid var(--border)`; labels Inter 0.85rem 500 `--text`, values `--text`.
```
ABOUT
Version          3f9a1c0b7e42   [ COPY ]     <- mono value, 44px button
--------------------------------------------
Offline          (o) Ready                   <- dot + word
--------------------------------------------
Update ready                    [ UPDATE ]   <- only when waiting after Later
```
- **Version.** Full 12-hex `VERSION` from the active worker, in `ui-monospace, SFMono-Regular, Menlo, monospace` (system fonts, no download), 0.85rem, `letter-spacing:0.02em`. `Copy` is a `.btn-secondary` at `min-height:44px; min-width:64px` with `aria-label="Copy version"`; it copies `HomeBody 3f9a1c0b7e42` and its label becomes `Copied` for 2 s (in a polite `role="status"` span next to it). If copy fails, the label becomes `Copy failed`; the value stays readable. No version yet or no worker: value `Unknown`, no Copy button.
- **Offline.** Three values, words always present; the value element is `role="status"` so the one change from Setting up to Ready is announced politely while About is open:
  - `Ready` (dot `--signal`): the page is controlled by a worker.
  - `Setting up…` (dot `--warning`): service workers supported, not yet controlled.
  - `Not available in this browser` (dot `--muted`): no service worker support, or registration was rejected.
- **Quiet update line.** Hidden unless an update is waiting and the banner is not on screen (i.e. after Later). Label `Update ready`, button `Update` (`.btn-secondary`, 44px; secondary on purpose: quiet). Same tap behaviour as State 1. In the State 3 case the line reads `Updated in another window` with a `Reload` button.
No other Profile changes.

## State 6: failures and edge cases (all silent)
- Update check while offline: nothing shown, nothing logged to the user, About unchanged.
- Update download fails (install rejected): nothing shown; the current version keeps running; the next launch or return to the app checks again.
- Waiting version equals the running one (`GET_VERSION` match) or does not answer: no banner, no About line.
- Update tapped but no takeover within 10 s: buttons restore (State 1); no error copy, because nothing is lost and the update still applies on the next full close.

## Tokens and components used
`--surface --surface2 --bg --text --accent --signal --warning --muted(dot only) --border --nav-h --safe-bottom`; `.card .card-title .btn-primary .btn-secondary`; `mToast`. No new tokens. docs/design/system.md does not exist yet; these are recorded there when it is created.

## Open questions for James (recommendation first)
1. **Banner position:** bottom card above the FAB (recommended: thumb reach, clears FAB and the toast lane) vs the old top bar (out of thumb reach) vs bottom over the FAB (hides the rest-timer button).
2. **Version display:** full 12-hex value with Copy, copying `HomeBody <VERSION>` (recommended; fits at 375 px and bug reports need it whole) vs a 7-character short form.
3. **Toast not announced to screen readers:** accept for T4 and log it in docs/known-issues.md for accessibility-performance-reviewer, adding `role="status"` to `#m-toasts` in a later task (recommended, because `mToast` and its container are outside T4) vs widen T4 to include that one attribute.
4. **Reassurance line "Your history is kept.":** keep it (recommended; true by principle 1 and asserted by AC1) vs drop it for a shorter banner.
