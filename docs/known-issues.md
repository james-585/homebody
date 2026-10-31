# Known issues

Seeded from the product/code review of the shipped app (index.html, sw.js, manifest.json). Owners are the agents who should triage each item. Status: Open unless stated.

## Reliability and data
| # | Issue | Owner |
| --- | --- | --- |
| K1 | `sw.js` precaches only `manifest.json`, and `index.html` is network-first with an empty cache as fallback, so the app does not open offline. Fonts come from Google Fonts. | storage-sync-engineer |
| K2 | All data lives in one localStorage blob (`vaultfit_v1`). Only a manual export protects it; storage can be evicted or cleared. Writes fail silently (`persistSave` swallows errors). | storage-sync-engineer |
| K3 | Exercises are matched by name string; bilateral sides are a " (Left)" / " (Right)" suffix. Renaming breaks history, PRs and plans. | exercise-data-curator, architect |
| K16 | **Confirmed on a real export:** 12 exercise names in 149 workouts of history are missing from the current library (for example "DB Curl", "KB Front Raise", "Farmer's Walk", a typo "DB Sumo Squat with Capf Raise"). Volume, recovery, PR and strength-level code skips unmatched names, so stats are silently undercounted. Fixture: tests/fixtures/legacy/vaultfit_v1_export.sanitized.json. | exercise-data-curator, storage-sync-engineer |
| K17 | Stored records come in mixed shapes: workouts with and without `notes` / `rpe` (47 of 149 have no RPE), and two side encodings (474 entries use the " (Left)" / " (Right)" name suffix, only 248 also carry `bilateral` / `side`). Migrations and readers must handle all of them. | storage-sync-engineer |
| K4 | Cache version is bumped by hand; `sw.js?v=7` is registered while the cache is v11 and comments say v8. | devops-engineer |

## Training logic
| # | Issue | Owner |
| --- | --- | --- |
| K5 | RPE is captured in workout mode but never used by `mAutoProgress` or `mGetSuggestion`. | training-scientist |
| K6 | `mGetSuggestion` shows "✓ — try +weight" after any previous session, regardless of whether reps were hit or effort was maximal. | training-scientist |
| K7 | No deload, stall detection or warm-up ramp. Fixed fortnight cooldown for plan progression. | training-scientist |
| K8 | Recovery uses fixed 24/48/72 h bands and fixed per-muscle set targets for everyone. | training-scientist |
| K9 | Calorie estimate multiplies MET x bodyweight x modelled time by an arbitrary 0.8 factor. Strength standards and MET values have no cited source. | training-scientist, exercise-data-curator |

## Product and UX
| # | Issue | Owner |
| --- | --- | --- |
| K10 | Streak counts consecutive calendar days, so a planned rest day resets it to zero. | product-designer, strategist |
| K11 | Viewport sets `user-scalable=no` (blocks pinch-zoom); muted text colour on the dark background is likely below WCAG AA for small text. | accessibility-performance-reviewer |
| K12 | Profile weight is kg only; no unit setting. | product-designer, frontend-engineer |
| K18 | With a sparse real equipment ladder (dumbbells 5 and 10 kg, kettlebells 10 and 16 kg) the fixed "+1.25 / +2.5 kg" hint in `mGetSuggestion` is unusable. Progression needs non-load levers (reps, sets, tempo, pauses, density, unilateral variants) when the next weight does not exist. | training-scientist, strength-coach |
| K19 | No support for training around an injury or constraint. A real user runs spine-aware programming (spinal-loading days spaced 72 h or more apart, supersets only on non-spine days) and rehab phases, encoded only in free-text plan day names and notes. Needs a decision on constraint tags per exercise ("spinal loading"), spacing rules, and plan versioning (the same user has v3, v4 and v5 of one programme as separate workout-name prefixes). Must stay coach-not-clinician: the app applies the user's own constraints and does not diagnose or prescribe rehab. | product-strategist, strength-coach, architect |
| K13 | Exercises use emoji icons and text instructions only; no form media. | product-designer, exercise-data-curator |

## Engineering
| # | Issue | Owner |
| --- | --- | --- |
| K14 | One ~670 KB, ~7,800-line file with global functions, inline handlers and no automated tests. | architect, test-engineer |
| K15 | Names are interpolated into HTML via template literals and inline handlers; `escHtml` does not protect JS string contexts inside `onclick`. Needs an audit. | security-reviewer |
