# T4b — Pre-M1 upgrade path and multi-tab (tests and docs only)

Milestone: M1 (docs/plans/m1.md) · Agent: storage-sync-engineer · Branch: claude/m1-t4b-upgrade-test (proposed, Q1)
Status: Approved 2026-10-31 (starts after the T4a Amendment 3 round is finished and reviewed)

Second half of the approved T4 split (docs/plans/m1/T4.md, Q1 and Q6; "Release order": T4a is not deployed until this passes). Starts only after T4a (claude/m1-t4-update-flow) is finished.

## Scope
- In: (1) a frozen copy of the pre-M1 build with a README and an integrity test; (2) AC3, the upgrade e2e from that build to the current one, through the old page's own banner and reload; (3) multi-tab e2e, including a characterisation of an old-code tab; (4) `docs/offline.md`: the known limitation of the first update after M1 and its user-facing mitigation.
- Out: any change to `sw.js`, `index.html`, `src/`, goldens or existing tests; fixing anything the upgrade reveals (stop and report instead); K20 (shared origin); T4a items.

## What the pre-M1 build does (verified with `git show d642b2b`)
d642b2b is "Merge pull request #1" (parents 7865ea6 and f4b12ae), the last commit before M1 code. Shell files there: `index.html` (672,329 B), `sw.js` (1,225 B), `manifest.json`, `icon-192.png`, `icon-512.png`; no fonts dir (Google Fonts by CDN), no precache beyond `manifest.json`.
- `sw.js`: cache `homebody-v11` holding only `manifest.json`; `install` calls `skipWaiting()`; HTML is network-first (`no-store`) with cache fallback, so this build is not offline-capable; `activate` deletes every cache not named `homebody-v11` (any name), then claims; message `'skipWaiting'` only.
- Page: registers `sw.js?v=7` on `load`; `setInterval(() => reg.update(), 60000)`; `controllerchange` reloads unconditionally (once, guarded by `refreshing`; also on first claim).
- Banner A (static, always wins): "Update Available / HomeBody has been updated", buttons "Later" (hides) and "Update Now" (posts the string `'skipWaiting'` to the waiting worker, or `location.reload()` if none is recorded). Shown when a worker reaches `installed` with a controller present. No workout check anywhere. Banner B ("Update available / Reload now") is dead code because A's element exists, so a worker already waiting at launch shows nothing.
- Workout: persisted to `hb_active_workout` on every set; `wmRestoreIfActive` restores it on load with the toast "Workout resumed".
Consequence: with the new worker installing from `sw.js` (query dropped), the old page sees `updatefound`, shows banner A, and its tap leads to an unconditional reload even mid-workout.

## Acceptance criteria
- [ ] AC3 (m1.md): e2e: upgrade from the pre-M1 `sw.js` + index.html (from git history) to the new version succeeds with no data loss and the app then works offline.
- [ ] Snapshot: the five files under `docs/reference/pre-m1-d642b2b/` match the SHA-256s in its README, and byte for byte `git show d642b2b:<file>` when that commit is reachable.
- [ ] Multi-tab: a workout in tab B holds the notice in tab A; an update applied from tab A does not reload a new-code tab B during its workout, and B reloads only after it ends. An old-code tab B's behaviour is recorded as tested fact.
- [ ] `docs/offline.md` states the first-update limitation and what survives and is lost.

## Approach
Reuse the T4a helpers (`createSite`, `deploy` with `sw.js` last, `seedOrigin`, `blockExternal`, `installProbes` in `tests/e2e/helpers/deploy.mjs`) unchanged; new code goes in new files so T4a stays frozen. v1 = a temp dir assembled from the five snapshot files under their real names; v2 = `buildCurrent()` (or the variant if a distinct VERSION is needed). One site directory, one origin, so registration, caches and localStorage persist across the deploy. The old page is driven through its own UI: `page.clock.install()` plus `runFor(60_000)` makes the old `setInterval` trigger the check (fallback: `reg.update()` from the test); then click "Update Now" and wait for the reload on observable conditions (`controller.scriptURL`, `caches.keys()`, About version), never sleeps. Seeds are the real fixture (`seedData()`) and the `hb_active_workout` synthetic variant.

**Hazard found while planning, needs your decision (Q2).** If the snapshot is committed as runnable `index.html` and `sw.js` under `docs/`, GitHub Pages (which serves the repo) would serve them at `.../docs/reference/pre-m1-d642b2b/`. Anyone opening that URL registers the old worker there, and its `activate` deletes every cache on the shared origin not named `homebody-v11`, which includes the live app's `homebody-<VERSION>` cache and other projects' caches (K20). Proposal: commit the files with a `.frozen` suffix (`index.html.frozen`, `sw.js.frozen`, `manifest.json.frozen`, `icon-192.png.frozen`, `icon-512.png.frozen`); the tests restore the real names in a temp dir. They stay byte-identical to `git show d642b2b:<file>`, are not executable, and are skipped by ESLint, the stamp and the browser. This deviates from the file names in the approved T4 plan, hence the question.

## Files
- Create: `docs/reference/pre-m1-d642b2b/{index.html,sw.js,manifest.json,icon-192.png,icon-512.png}.frozen`, `docs/reference/pre-m1-d642b2b/README.md` (commit, parents, file list with SHA-256 and sizes, how to verify with `git show d642b2b:<file> | sha256sum`, why `.frozen`, never edit); `tests/unit/pre-m1-snapshot.test.mjs`; `tests/e2e/upgrade.spec.mjs`; `tests/e2e/helpers/snapshot.mjs` (assembles the temp v1 dir)
- Change: `docs/offline.md` (the "T4b not described as done" line in the intro, a "First update after M1" section, a multi-tab section, a verification entry)
- Data: none · Storage format: unchanged (read and compared only; `vaultfit_v1` and `hb_active_workout` are never written by the test beyond the seed)
- Hashes, as recorded now (the README and the test repeat them): index.html `2018b54c…ff191`, sw.js `fef3e6a3…cc1182`, manifest.json `607908bd…ca0c`, icon-192 `4ab4b4a7…d46a`, icon-512 `b0cee395…19a7` (full values go in the README).

## Tests
- `tests/unit/pre-m1-snapshot.test.mjs` (snapshot AC): hashes each `.frozen` file against the recorded values; if `git cat-file -e d642b2b^{commit}` succeeds, also compares bytes with `git show d642b2b:<file>`. In CI (`actions/checkout` default `fetch-depth: 1`) the commit is absent, so only the hash check runs and the test says so in its output; no `fetch-depth: 0` is added, keeping `ci.yml` untouched. Catches a corrupted or hand-edited snapshot (the hash list is in the same commit, so a git comparison on a full clone is the independent check).
- `upgrade.spec.mjs` AC3, Chromium, `serviceWorkers:'allow'`, external requests aborted (the old page asks Google Fonts; they are blocked and counted, so the zero-external assertion is for the post-upgrade page only):
  1. Old page + old worker with the real history seeded in `vaultfit_v1`; deploy v2 (sw.js last); old poll fires; banner A appears; "Update Now"; old unconditional reload; assert `vaultfit_v1` is byte-identical to the seed string, `homebody-v11` is gone, exactly `homebody-<NEW>` remains, About shows the new VERSION.
  2. The `sw.js?v=7` to `sw.js` rename: no second banner after the reload (the `GET_VERSION` same-VERSION filter); asserts no waiting worker and no visible card.
  3. `setOffline(true)`, reload: Home renders with the history; log a workout through the UI; reload offline again; it is in History.
  4. Variant with `hb_active_workout` seeded: the old page restores it ("Workout resumed"); after the update the workout is still restorable and `hb_active_workout` is byte-identical until the user acts.
  5. Variant "reload first": reload the old tab (new page under the old worker), then update via the new banner; same data and cache assertions.
  `@smoke` on case 1 plus 3 only if it passes in WebKit; otherwise Chromium only and the reason recorded here.
- `upgrade.spec.mjs` multi-tab (one browser context, two pages): (a) new-code tabs A and B on v1: workout in B, deploy v2, A shows no notice; finish in B, A shows it (via the `storage` event); (b) A applies the update while B has a workout: B does not reload (marker survives), B shows "reload needed" only after its workout ends and reloads only on its own tap; (c) characterisation, old-code B: both tabs on the snapshot with a workout in B, update through A's old banner; B reloads without any tap or workout check; assert what survives (`hb_active_workout`, restored with "Workout resumed", sets already logged) and what is lost (in-memory state, for example a running rest timer, text typed but not saved into a set); these assertions are the record of the known limitation, not a request to fix it.

## Principles touched
1: the upgrade test is the guarantee that the first M1 update loses no history (byte comparison before and after, plus the active workout). 5: the app opens offline after the upgrade; a mid-workout reload by old code is characterised and documented, not hidden. 4: no new request; the test asserts zero non-origin hosts after the upgrade. 8: the snapshot is data, never executed outside the temp test site. 7, 9: none.

## Stop conditions
Stop, report, and wait for the human if any of these happen:
- The change needs a file outside **Files** above, or a new dependency.
- An existing test has to be changed or deleted to make the new code pass.
- A storage change has no migration, or a migration fails on any fixture in tests/fixtures/legacy/.
- A strength standard, MET value, volume target or other training number would have to be written without a source or documented rationale.
- A new external request, third-party script, notification, health-platform link or data source is needed, or a secret seems necessary.
- Exercise data would have to be retyped by hand rather than extracted or sourced.
- The change makes logging a set take more than two taps, or breaks offline use.
- The 'verify' command is still red after two honest attempts.
- The acceptance criteria turn out to be ambiguous or contradict the spec.
- The upgrade loses or alters any byte of user data (`vaultfit_v1`, `hb_active_workout`).
- The upgrade test passes only with a sleep or a retry.
- The snapshot does not match `git show d642b2b:<file>` or the recorded hashes.
- The upgrade needs any change to `sw.js` or `index.html` behaviour. T4b is tests and docs only: if it reveals a product bug (for example a spurious banner, a lost cache, no offline start), STOP and report; do not fix it here.

## Reviewers
test-engineer verifies the ACs and mutation-checks the upgrade test (for example corrupt one seeded byte, or leave `homebody-v11` in place, and see it fail). security-reviewer: the snapshot of old service-worker code (its repo location and the `.frozen` decision) and the upgrade path. code-reviewer. accessibility-performance-reviewer is not needed (no UI, no size change to the shipped app). devops-engineer is informed of the Pages exposure question (Q2) because no deploy workflow exists yet.

## Size and CI
About 690 KB of new tracked files, but `index.html.frozen` and the others are the same blobs already in history, so `.git` and clone size barely grow; only the checkout does. Nothing here is in `PRECACHE` or the shipped shell (the stamp walks only the top level, `src/` and `fonts/`), so VERSION and the app size are unchanged. Prettier ignores `docs`; ESLint does not match `.frozen`. CI cost: one extra e2e spec (about six short Chromium tests, a few in WebKit if tagged) and one fast unit test.

## Only a real iPhone can prove (human step)
Standalone-PWA lifecycle and true airplane mode. Steps: on the phone, install the pre-M1 build (the live site before deploying T4a, or the snapshot served from a scratch host you control), log some history and start a workout; deploy; reopen; tap the old "Update Now" while idle, then once mid-workout on a spare device or a copy; confirm history intact, "Workout resumed" appears, the new version is running (Profile -> About), then airplane mode, force-quit, reopen. Record the result in the PR.

## Questions for the human (recommended answer first)
1. Branch and PR: create `claude/m1-t4b-upgrade-test` from the T4a branch tip and open one PR containing T4a and T4b, merged only once T4b is green? Recommend yes: the Release order already forbids merging T4a alone, and one PR avoids a stacked-PR rebase after T4a review fixes. Alternative: a stacked PR (T4b based on T4a, T4a PR not merged on its own), which gives smaller reviews at the cost of retargeting; only worth it if you want T4a reviewed separately first.
2. Commit the snapshot with a `.frozen` suffix (deviation from the T4 plan's file names) so Pages never serves a runnable old service worker that would delete the live app's cache? Recommend yes. Also confirm how Pages publishes (branch root vs a future workflow) so devops can exclude `docs/reference/` if needed.
3. Deploy T4a/T4b to users before or after your iPhone check? Recommend after: merge when CI is green, but publish only after you have done the manual step against the pre-M1 build from the live site, because only the phone shows whether iOS fires `controllerchange` and keeps `hb_active_workout`. If you prefer speed, deploy first and treat the phone check as a same-day rollback trigger; the first update goes through old code either way.
4. If the old-code multi-tab characterisation shows a mid-workout reload that loses more than a rest timer, is that acceptable as documented, or should it become a gate before deploy? Recommend documented unless it loses logged sets (then stop and decide).

## Approval
Approved by James on 2026-10-31, in chat, with these answers:
- Q1: one branch for T4b, started from the T4a tip (claude/m1-t4b-upgrade-test), and ONE PR containing T4a and T4b. Nothing is merged to `main` or deployed until T4b's upgrade test passes.
- Q2: yes. The frozen pre-M1 `index.html` and `sw.js` are stored with a `.frozen` suffix (byte-identical to git); tests restore the real names in a temp directory. This deviates from the file names in T4.md deliberately, so GitHub Pages cannot serve a runnable old service worker.
- Q3: deploy only after James has run the manual iPhone check against the old build (the plan's checklist).
- Q4: a gate. If the old-code mid-workout reload loses anything beyond a running rest timer, T4b stops and reports before any deploy.
T4b is tests and docs only; if the upgrade test reveals a product bug, stop and report, do not fix it here.

## Gate ruling (James, in chat, 2026-10-31)
The Q4 gate does not trigger. The old-code mid-workout reload loses only in-memory state (a running rest timer and a typed-but-uncommitted field value, because the app saves on `change`); the workout, every ticked set and all history are kept (`vaultfit_v1` byte-identical, `hb_active_workout` restored with "Workout resumed"). James accepted this as the documented cost of the first update after M1. The manual iPhone check (docs/offline.md, "Verification") still precedes any deploy.

## Review follow-up (approved by James in chat, 2026-10-31)
After the T4b reviews (code: approve; security: pass with notes; test-engineer: ACs met), James approved one small fix commit, then the single PR for T4a + T4b. In scope: `docs/offline.md` (soften the identical-waiting-worker claim to what the test proves; "the two sections above" becomes "below"; one sentence that an old build for the iPhone check must be served from a different origin than the live app, e.g. a LAN or localhost server or another account); a "Superseded by T4b.md" note on the stale lines of `docs/plans/m1/T4.md` (separate PRs, snapshot names without `.frozen`, `reg.update()` wording, `@smoke`); `tests/e2e/upgrade.spec.mjs` comment and nit cleanups only (the real reason for Chromium-only, explain `replies >= 2`, remove the no-op `void browserName` and the pointless alias, narrow the catch on `site.close()`); no assertion weakened, no product code. L2/L3 (append-only guard, Pages publish scope) are noted for `docs/security.md` later.
