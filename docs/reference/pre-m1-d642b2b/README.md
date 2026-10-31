# Frozen snapshot: the pre-M1 build (commit d642b2b)

Read-only. Never edit, rename or "fix" these files (CLAUDE.md: `docs/reference/` is append-only).

- Commit: `d642b2bcc3ea7eb5cbf70febbda176bc4dc58086`, "Merge pull request #1 from james-585/claude/agent-team-setup" (parents `7865ea6`, `f4b12ae`). The last commit before any M1 code.
- Purpose: the T4b upgrade test (`tests/e2e/upgrade.spec.mjs`) serves this build, then deploys the current one over it, to prove the first update after M1 loses no data. CI clones shallowly, so the files are committed rather than read from git.

## Why the `.frozen` suffix
The files are byte-identical to git but not runnable. If they were `index.html` and `sw.js` under `docs/`, GitHub Pages would serve them. Anyone opening that URL would register the old worker, whose `activate` deletes every cache on the shared `github.io` origin not named `homebody-v11`. That includes the live app's cache and other projects' caches (K20). The tests restore the real names in a temp directory (`tests/e2e/helpers/snapshot.mjs`).

## Files (SHA-256, bytes)
| File | SHA-256 | Bytes |
| --- | --- | --- |
| `index.html.frozen` | `2018b54cfcd50beb9e293b721a7b1150a42c13c514fb252e224be13f711ff191` | 672329 |
| `sw.js.frozen` | `fef3e6a3052d59621eb6e1f05791957231a1bfe1ff77fade2aea100db6cc1182` | 1225 |
| `manifest.json.frozen` | `607908bd6b998d8cd198827258266b90cad73ba6ddcba5eb83bd0a5e77f5ca0c` | 664 |
| `icon-192.png.frozen` | `4ab4b4a7c631d1e3ec007c30bf1c740fa6a880a09a20856babd2432b8568d46a` | 1728 |
| `icon-512.png.frozen` | `b0cee395124c019438800d0e6165e5bddf0bf97a9cc39829a54046a9da2819a7` | 7004 |

## Verify
On a full clone: `git show d642b2b:sw.js | sha256sum` (and the same for each file) must equal the table. `tests/unit/pre-m1-snapshot.test.mjs` checks the hashes always, and the bytes against git when the commit is reachable.

## What this build does (facts the upgrade test relies on)
- `sw.js`: cache `homebody-v11` with only `manifest.json`; `install` calls `skipWaiting()`; `activate` deletes every cache not named `homebody-v11`, then claims; HTML is network-first, so this build is not offline-capable.
- Page: registers `sw.js?v=7`; polls `reg.update()` every 60 s; reloads on any `controllerchange`; banner "Update Available" with "Later" / "Update Now" (posts the string `'skipWaiting'`), no workout check; the active workout is saved to `hb_active_workout` on every set and restored on load ("Workout resumed").
- It requests Google Fonts by CDN (blocked in tests).
