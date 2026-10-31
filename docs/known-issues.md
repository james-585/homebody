# Known issues

Seeded from the product/code review of the shipped app (index.html, sw.js, manifest.json). Owners are the agents who should triage each item. Status: Open unless stated.

## Reliability and data
| # | Issue | Owner |
| --- | --- | --- |
| K1 | `sw.js` precaches only `manifest.json`, and `index.html` is network-first with an empty cache as fallback, so the app does not open offline. Fonts come from Google Fonts. | storage-sync-engineer |
| K2 | All data lives in one localStorage blob (`vaultfit_v1`). Only a manual export protects it; storage can be evicted or cleared. Writes fail silently (`persistSave` swallows errors). | storage-sync-engineer |
| K3 | Exercises are matched by name string; bilateral sides are a " (Left)" / " (Right)" suffix. Renaming breaks history, PRs and plans. | exercise-data-curator, architect |
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
| K13 | Exercises use emoji icons and text instructions only; no form media. | product-designer, exercise-data-curator |

## Engineering
| # | Issue | Owner |
| --- | --- | --- |
| K14 | One ~670 KB, ~7,800-line file with global functions, inline handlers and no automated tests. | architect, test-engineer |
| K15 | Names are interpolated into HTML via template literals and inline handlers; `escHtml` does not protect JS string contexts inside `onclick`. Needs an audit. | security-reviewer |
