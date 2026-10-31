# Update notice, offline-ready toast and Profile -> About

Status: Approved by James on 2026-10-31, in chat, with Q1-Q4 answered as recommended (bottom card above the FAB; full 12-hex version with Copy; toast screen-reader gap accepted and logged as K21; keep "Your history is kept."). (T4 step 0, docs/plans/m1/T4.md). Author: product-designer, 2026-10-31.
Revised 2026-10-31 after the built-UI review (approved by James in chat)
Revised again 2026-10-31 (Amendment 3, approved by James in chat): Updating state keeps the visible card content; hidden live region; failed offline setup shown in About; focus fallback to the current page; card max-height and scroll; About shows the version the page booted with.
Scope: only the UI that T4 needs. No other screen changes except the two clearance fixes in State 1 (FAB tray hit area, Profile bottom padding), which Amendment 2 to T4a brings into scope. Principles: 5 (never interrupt a workout), 7 (never slow logging), 2 (plain, honest copy).

## User goal
"Get the new version when it suits me, never mid-set, and know the app works in the garage without signal."

## Shared rules (all states)
- **Never during a workout.** While `hbWorkoutActive()` is true, nothing in this spec appears: no banner, no toast, no sound, no haptic. If a workout starts while the banner is showing (the `#wm-overlay` appears), the banner hides at once and is held again.
- **No jargon.** User copy never says "service worker", "cache", "hash" or "refresh". It says update, reload, offline, version.
- **Text only via `textContent`.** All strings below are constants; `VERSION` is hex only.
- **Colour is never the only signal.** Every status has words; dots are decoration.
- **Do not use `--muted` for any new text.** Measured: `--muted` #8C7B6E is 4.10:1 on dark `--surface` and 4.06:1 on light `--surface` (fails AA for small text, K11). All new text uses `--text`. Exception, not fixed here: the `ABOUT` card title uses the shared `.card-title` style, which is `--muted` like every neighbouring card title (Data & Backup and others). Changing it only here would make About inconsistent; the fix belongs to the token-wide K11 work and is tracked there.

## Measured contrast (WCAG 2.x, from the :root and [data-theme="light"] values)
| Pair | Dark | Light | Need |
| --- | --- | --- | --- |
| `--text` on `--surface` (banner copy, About rows) | 15.83 | 18.24 | 4.5 |
| `--text` on `--surface2` (`.btn-secondary` label) | 13.98 | 15.68 | 4.5 |
| `#000` on `--accent` (`.btn-primary` label, including `Updating…`) | 5.53 | 5.53 | 4.5 |
| `--accent` 2px border vs `--bg` (banner outline vs page) | 4.80 | 3.61 | 3.0 |
| `--accent` 2px border vs `--surface` | 4.38 | 3.80 | 3.0 |
| `--signal` dot on `--surface` (Ready) | 5.20 | 5.12 | 3.0 |
| `--warning` dot on `--surface` (Setting up) and `--warning` diamond (Offline setup failed) | 5.14 | 3.24 | 3.0 |
| `--muted` dot on `--surface` (Not available; non-text only) | 4.10 | 4.06 | 3.0 |
| `--muted` `.card-title` "ABOUT" on `--surface` (existing style, K11) | 4.10 | 4.06 | 4.5 (fails; tracked under K11) |
`--surface` vs `--bg` is only 1.09 (dark) and 1.16 (light), so the banner's edge is the 2px `--accent` border, not the fill. The border-vs-background ratios above are colour ratios and do not change with width; 2px (up from 1.5px) makes the edge a solid, unambiguous line in glare and avoids sub-pixel blurring at 1.5px on 2x/3x screens. Accent-coloured *text* is not used (3.80 on light surface fails 4.5).

## State 1: update available (Update / Later)
**Placement.** Floating card in the bottom thumb zone, above the FAB, never over the nav or the FAB:
`position:fixed; left:14px; right:14px; max-width:520px; margin:0 auto; bottom:calc(var(--nav-h) + var(--safe-bottom) + 74px)` (74 = 14 FAB gap + 48 FAB + 12 clearance). Measured at 390x844: FAB top 718, banner bottom 706.

**Z-order.** `z-index:150`. The card is part of the page layer, not a dialog:

| Layer | z-index | Relation to the card |
| --- | --- | --- |
| Page sticky headers | 50 | below the card |
| Bottom nav | 100 | below the card (the card never overlaps it by position anyway) |
| **Update card** | **150** | |
| `.modal-overlay` and sheets | 200 | above: any sheet or modal the user opens covers the card |
| Workout layer, FAB tray backdrop (9599), FAB (9600), timer modal (9700), confirm dialog (9800), tutorial (9850) | 9000+ | above |
| Toasts (`#m-toasts`) | 9950 | above |

So the card never covers a sheet, dialog, the FAB or a toast the user is looking at. When a sheet closes, the card is visible again where it was (it is not re-announced).

**FAB hit area (clearance fix).** The FAB tray container `#m-fab-tray` is a large invisible box that, as built, swallowed taps on the card's `Update` button and on About rows behind it. Rule: `#m-fab-tray { pointer-events:none }`; `#m-fab-main` and each *visible* tray child (the menu items when the tray is open) get `pointer-events:auto`. Hidden tray items stay non-interactive. The FAB's own 48px target and behaviour are unchanged.

**Look.** `--surface` fill, `2px solid var(--accent)` border, radius 14px (`.card`), padding 14px 16px, existing toast shadow. Same at 375 px and 430 px; centred with max 520px on larger screens.

**Height limit (Amendment 3).** `box-sizing:border-box; max-height:50vh; max-height:50dvh; overflow-y:auto; overscroll-behavior:contain`. The card never covers more than half the screen; if large text makes it taller, the card scrolls inside itself (touch, wheel, and focusing a button scrolls it into view) and the page behind does not scroll. Measured: at 375x667 the card is 136 px (20%) at 100% text, 190 px (28%) at 150% and 227 px (34%) at 200%, all without scrolling; at 390x844 200% text, 227 px (27%). It only reaches the limit in landscape phones with very large text (812x375 at 200%: 188 px, 50%, scrolls, both buttons partly visible and tappable). Rule for a future revision: keep the button row reachable without scrolling (see the review note on a sticky button row).
```
+------------------------------------------+   <- 2px --accent border
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

**Update tap.** Re-check `hbWorkoutActive()`; if true, hide and hold. Otherwise enter the **Updating** state:
- The primary button's label becomes `Updating…` and it stays at **full opacity** (black on `--accent`, 5.53:1; a dimmed busy button reads as broken in glare). Further taps are blocked with `pointer-events:none` and `aria-disabled="true"` (not the `disabled` attribute, so it keeps its colours and is still read by screen readers).
- Only `Later` is dimmed (disabled styling) and cannot be tapped.
- **The visible title and body do not change** (`Update ready` / `Reloads HomeBody. Your history is kept.` stay on screen), so the card's height and position do not move under the thumb. Measured at 375, 390 and 430 px, dark and light: 0 px change in top and height.
- The text `Updating…` is written once into the card's hidden live region (see Accessibility), so screen-reader users hear it. It is not repeated.
- The page reloads when the new version takes over. If no reload has happened after 10 s, the buttons quietly return to `Later` / `Update`, `aria-disabled` is removed and the live region is cleared silently (no error text, nothing re-announced; see State 6). The tap no longer counts as a request after that, so a later takeover from elsewhere shows State 3 rather than reloading.

```
| +-----------------+  +-----------------+ |
| |  LATER (dimmed) |  |   UPDATING…     | |   primary at full opacity
| +-----------------+  +-----------------+ |
```

**Later tap.** Banner hides for this page session. The update applies the next time HomeBody is fully closed and reopened. Profile -> About shows the quiet `Update` line (State 5).
**Motion.** Enter: 200 ms ease-out, `translateY(16px)` + opacity 0 -> 1. Exit: 150 ms opacity. No overshoot (unlike `.m-toast`). `prefers-reduced-motion: reduce`: no translate, no transition (appears and disappears instantly).
**Accessibility.** Container `role="region" aria-label="App update"`, placed in the DOM just before `<nav class="bottom-nav">`. When off screen it is `visibility:hidden` plus `inert` (out of tab order and the accessibility tree) but stays in the DOM, so its live region exists before any text arrives. Inside, a **visually hidden** `role="status"` element (polite; 1x1 px, clipped) is the card's only live region; the visible title and body are plain text, not live. One frame after the card is shown it receives "Update ready. Reloads HomeBody. Your history is kept." (or the State 3 text); in the Updating state it is replaced once by `Updating…`; it is emptied when the card hides or the buttons restore (emptying is not announced). **Never `role="alert"`, never assertive, and the card never takes focus when it appears**: focus stays where the user is. Buttons are real `<button>`s; visible focus ring `2px solid var(--text)`, offset 2px. Escape while focus is inside = Later.
**Focus on dismiss.** After `Later` or Escape, focus must not fall to `<body>`. It returns to the element that had focus immediately before focus moved into the card, if it is still in the document and visible. If there was none (for example the user simply tapped `Later`), or that element is gone or hidden, focus goes to the current page container, `.page.active`, which is given `tabindex="-1"`, `role="region"` and an `aria-label` from its nav tab label (`Train`, `Progress`, `Plans`, `Profile`). Focus is moved with `preventScroll`, so the page does not jump. After a touch tap nothing is visible (`:focus-visible` does not match). After Escape from the keyboard the browser's default ring can match on the container, but it is drawn on the viewport edges under the sticky header and nav and was not visible at 390x844; the next Tab goes to the first control on that page (Train: `Browse Plans`; Profile: the first body-metric field).

## State 2: update held during a workout
**During the workout:** nothing. No banner, no badge, no toast, no sound, no About change visible (About is unreachable under the workout layer anyway).
**After Finish or Discard (Cancel Workout):** the existing save confirmation is the priority. Finish shows "✓ Workout saved — ~X–Y kcal" plus possible PR (+0.5 s) and milestone (+0.8 s) toasts, each about 3 s; Discard shows "Workout cancelled". The banner appears **only once the toast stack (`#m-toasts`) is empty, and no sooner than 4 s after the workout layer closes**, in the State 1 position, on whatever page the user landed on (normally Home). It never covers or replaces the save toast. If another workout starts first, it stays held. Copy and controls are State 1's.

## State 3: updated, reload needed
Same card, position, z-order, motion, roles, focus and hold rules as State 1. Shown at this page's next safe moment; never reloads while `hbWorkoutActive()`. The copy is neutral on purpose: this state covers both an update applied from another window or tab, and the case where the user tapped `Update` but a workout started before the new version took over.
- Title: `HomeBody updated`
- Body: `Reload to use the new version.`
- Buttons: `Later` (`.btn-secondary`) / `Reload` (`.btn-primary`), 48px.
- `Reload` re-checks `hbWorkoutActive()`, then reloads (same Updating-state rules as State 1, with the label `Updating…`). `Later` hides it for the session; About shows the reload line (State 5).

## State 4: first install, "ready to use offline" (one time)
Reuse `mToast` unchanged: `mToast('Ready to use offline', 'success')` (green ✓, `--signal` left edge, existing bottom position above the nav). Shown once per page session when this page goes from uncontrolled to controlled. Not shown if `hbWorkoutActive()` (About still says Ready). It may stack with the existing welcome toast and sit over the first-run sheet; both are existing behaviour and harmless. Known gap: `#m-toasts` has no live region, so screen readers do not hear it; About's Offline line is the accessible, persistent source (see Q3).

## State 5: Profile -> About card
New `.card` (`margin-top:10px`) directly after **Data & Backup** in `#page-profile`. Title `About` (`.card-title`; `--muted`, see the K11 note in Shared rules). Rows are `min-height:48px`, `display:flex; justify-content:space-between; align-items:center`, separated by `1px solid var(--border)`; labels Inter 0.85rem 500 `--text`, values `--text`.

**Profile bottom clearance.** Profile's scroll content gets `padding-bottom` of at least `calc(var(--nav-h) + var(--safe-bottom) + 74px)`, so the last About row (and its button) can scroll fully clear of the FAB and is never underneath it.

```
ABOUT
Version          3f9a1c0b7e42   [ COPY ]     <- mono value, nowrap; 44px button, min-width 84px
--------------------------------------------
Offline          (o) Ready                   <- dot + word
--------------------------------------------
Update ready                    [ UPDATE ]   <- only when waiting after Later
```
At large text sizes (or narrow widths) the Version row wraps; the value and Copy move together under the label, and the hash is never broken:
```
Version
3f9a1c0b7e42                    [ COPY ]
```
- **Version.** Full 12-hex `VERSION` of **the version this page booted with** (read from the worker that controlled the page at launch, or from the first worker that takes control of an uncontrolled page). When a newer version takes over from another tab (State 3), About keeps showing, and `Copy` keeps copying, the version this page is actually running until it reloads; the `Updated, reload to use it` line underneath says a newer one is waiting. No "(after reload)" label is needed. The value is in `ui-monospace, SFMono-Regular, Menlo, monospace` (system fonts, no download), 0.85rem, `letter-spacing:0.02em`, `white-space:nowrap` (never break mid-hash). The row uses `flex-wrap:wrap`, with the value and Copy kept in one group, so when there is not enough room the group drops onto its own line under the `Version` label. `Copy` is a `.btn-secondary` at `min-height:44px; min-width:84px` (wide enough that `Copied` does not change its width) with `aria-label="Copy version"`; it copies `HomeBody 3f9a1c0b7e42` and its label becomes `Copied` for 2 s (in a polite `role="status"` span next to it). If copy fails, the label becomes `Copy failed`; the value stays readable. No version yet or no worker: value `Unknown`, set in Inter (the normal value style, **not** monospace, because it is a word, not a code), no Copy button.
- **Offline.** Four values, words always present; the value element is `role="status"` so each change (for example Setting up to Ready) is announced politely while About is open:
  - `Ready` (round dot `--signal`): the page is controlled by a worker.
  - `Setting up…` (round dot `--warning`): service workers supported, not yet controlled, nothing has failed.
  - `Offline setup failed, reconnect and reopen` (**diamond** `--warning`: the 10 px marker with `border-radius:1px` rotated 45 degrees, about 14 px across): not controlled, and either registration was rejected or the first install failed (the installing worker became redundant, for example a shell file that 404s). The shape, not only the colour, separates it from `Setting up…`; amber, not red, because the app still works online and no data is at risk. The value may wrap to two lines at 375-390 px; the marker stays vertically centred. Once a later launch succeeds it becomes `Ready`.
  - `Not available in this browser` (round dot `--muted`): **only** when the browser has no service worker support at all. It no longer covers a rejected registration.
```
Offline   <> Offline setup failed, reconnect and     <- diamond marker, --text words
             reopen
```
- **Quiet update line.** Hidden unless an update is waiting and the banner is not on screen (i.e. after Later). Button is `.btn-secondary`, 44px (secondary on purpose: quiet). Same tap behaviour as the matching banner state.
  - State 1 case: label `Update ready`, button `Update`.
  - State 3 case: label `Updated, reload to use it`, button `Reload`.
No other Profile changes.

## State 6: failures and edge cases (all silent)
- Update check while offline: nothing shown, nothing logged to the user, About unchanged.
- Update download fails (install rejected): nothing shown; the current version keeps running; the next launch or return to the app checks again. (This applies only when a version is already installed. A failed *first* install is not silent: About says `Offline setup failed, reconnect and reopen`, State 5.)
- Waiting version equals the running one (`GET_VERSION` match) or does not answer: no banner, no About line.
- Update tapped but no takeover within 10 s: buttons restore (State 1); no error copy, because nothing is lost and the update still applies on the next full close.

## Verification
Hit-testing must use real touch input, not `element.click()` (which bypasses overlapping boxes and hid the FAB tray bug). At viewports 375x667, 390x844 and 430x932, for each of:
1. the card's `Update` button (State 1) and `Reload` (State 3),
2. About `Copy`,
3. About's quiet `Update` / `Reload` button (after Later, scrolled to the bottom of Profile),

tap with `page.touchscreen.tap(x, y)` (or assert `document.elementFromPoint(x, y)`) at a point 85% across the button's width and at its vertical centre. The hit element must be the intended button or a descendant of it, never `#m-fab-tray`, the nav or another overlay. Also check: with the FAB tray closed, a tap in the tray's bounding box but outside `#m-fab-main` reaches whatever is underneath. Run in light and dark themes; reduced motion on and off.

## Tokens and components used
`--surface --surface2 --bg --text --accent --signal --warning --muted(dot only; existing .card-title) --border --nav-h --safe-bottom`; `.card .card-title .btn-primary .btn-secondary`; `mToast`. No new tokens. Z-index values used: 50 (page headers), 100 (nav), 150 (update card), 200 (modal overlays and sheets), 9599-9950 (FAB layer to toasts); these are recorded as a z-index scale in docs/design/system.md when it is created.

## Open questions for James (recommendation first)
1. **Banner position:** bottom card above the FAB (recommended: thumb reach, clears FAB and the toast lane) vs the old top bar (out of thumb reach) vs bottom over the FAB (hides the rest-timer button).
2. **Version display:** full 12-hex value with Copy, copying `HomeBody <VERSION>` (recommended; fits at 375 px and bug reports need it whole) vs a 7-character short form.
3. **Toast not announced to screen readers:** accept for T4 and log it in docs/known-issues.md for accessibility-performance-reviewer, adding `role="status"` to `#m-toasts` in a later task (recommended, because `mToast` and its container are outside T4) vs widen T4 to include that one attribute.
4. **Reassurance line "Your history is kept.":** keep it (recommended; true by principle 1 and asserted by AC1) vs drop it for a shorter banner.
