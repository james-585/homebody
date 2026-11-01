# Security and privacy notes: on-device data (storage)

Status: first version written by storage-sync-engineer during T5; **to be reviewed by security-reviewer** (the reviewer agent is read-only). Scope today: what HomeBody keeps in the browser, how it is protected from loss and overwrite, and what a "delete all my data" feature must remove. Principles: CLAUDE.md 1, 4, 8.

## Storage inventory (everything the app keeps on the device)
| Where | Name | Holds | Notes |
| --- | --- | --- | --- |
| localStorage | `vaultfit_v1` | Main document: workouts, personal records, body metrics (health data), plans, profile, favourites | Schema 1; the only key the app saves history to |
| localStorage | `homebody_v1`, `homebody_v0`, `vaultfit_v0` | Legacy copies of the main document | Read and copied once when `vaultfit_v1` is absent; never modified or removed by the app |
| localStorage | `hb_storage_meta` | `persistAskedAt` (timestamp) and `persistGranted` (true, false, `unsupported`, `error`) | Sidecar added in T5b; read with a 1 KB cap, fields copied by name |
| localStorage | `hb_active_workout` | The workout in progress | Written on every set by `wmPersist` |
| localStorage | `hb_milestones` | Milestones already shown | |
| localStorage | `hb_theme`, `hb_seen_guide`, `hb_seen_tutorial` | UI preferences and first-run flags | |
| Cache Storage | `homebody-<VERSION>` | The app shell (HTML, manifest, icons, fonts, `src/*.js`) | Names start with `homebody-`; the github.io origin is shared (K20) |
| Service worker | registration for this scope | Offline shell | |
| localStorage | `hb_probe_missing_key` | Never written | Read once to prove storage works |

Not used yet: sessionStorage, IndexedDB (T6 will add a database), cookies. No network storage, no accounts, no analytics.

## "Delete all my data" rules (for T8 or whoever builds it)
- Remove the listed localStorage keys **one by one**. Never `localStorage.clear()`: the github.io origin is shared with other projects (K20).
- Delete only caches whose name starts with `homebody-`. Unregister only the service worker whose scope is this app.
- Before deleting: stop the `wmPersist` tick (it re-creates `hb_active_workout`), and stop any pending store retry or queued write (it would re-create `vaultfit_v1`). Delete, then reload.
- Keep the key list in one place in the code, and add the T6 IndexedDB database to it when it exists.
- Tell the user what stays: exported `.vaultfit` files and the raw `.txt` file are in their Downloads and the app cannot remove them; and a persistent-storage grant from the browser (`persist()`) cannot be withdrawn by the app.

## Raw "as found" export
`Export saved file` (shown when saved data cannot be read, is from a newer version, or storage failed to open) downloads the stored text of `vaultfit_v1` unchanged. It is read-only (never parses or writes), uses a `text/plain` Blob and the fixed filename `homebody-saved-data-as-found.txt`. It contains health data, so the user should treat the file as private. The plain `Export` beside it exports in-memory state (see K30).

## Protections against overwriting or losing data
- Corrupt or newer-than-known stored data: the store loads empty in memory, goes read-only and never writes `vaultfit_v1`.
- `hbLoadedOk`: `persistSave` refuses to write until `persistLoad` has copied the stored document into state this session, so a storage script that loads late cannot overwrite saved data with the empty startup state. If the storage script fails to load or throws before the store exists, `hbBootFailed()` starts the app on empty state and nothing is written. `wmPersist`, the `WM_KEY` removal and `hb_milestones` writes are not covered (K29).
- Legacy keys are copied, never removed. A quota failure while adopting leaves everything intact.
- The sidecar `hb_storage_meta` is ignored if 1 KB or larger, or if it is not a plain object; unknown fields are dropped; no prototype pollution (tested).
- Failure messages shown to the user are fixed strings chosen by error kind; raw exception text is never rendered.

## `navigator.storage.persist()`
Requested once, after the first successful save whose payload contains at least one workout, and not before. The result and a timestamp go in `hb_storage_meta`; `HB.storage.status()` returns `persisted`, `persistAsked` and `persistGranted`. Some browsers (Firefox) may show a permission prompt at that moment. The request sends nothing off the device.

## Exports leave app control
`.vaultfit`/JSON exports and the raw `.txt` file are ordinary files in the user's Downloads. Once exported they are outside the app's protection and may be synced or shared by the OS.

## Content-Security-Policy (not adopted)
There is no CSP. Adopting one would need hashes or nonces for the inline boot script in `<head>` and the inline `onerror` attribute on the storage script tag (replace with `addEventListener`), plus the many inline handlers in `index.html` (K15, K20).

## Open items
K20 (shared origin), K29 (pre-load window and `hbLoadedOk` coverage), K30 (plain Export in unreadable-data states looks normal; only `vaultfit_v1` is raw-readable when HB failed to boot).
