# Security and privacy notes: on-device data (storage)

Status: first version written by storage-sync-engineer during T5; **to be reviewed by security-reviewer** (the reviewer agent is read-only). Scope today: what HomeBody keeps in the browser, how it is protected from loss and overwrite, and what a "delete all my data" feature must remove. Principles: CLAUDE.md 1, 4, 8.

## Storage inventory (everything the app keeps on the device)
| Where | Name | Holds | Notes |
| --- | --- | --- | --- |
| IndexedDB | database `homebody`, stores `workouts`, `records`, `meta` | The live data (schema 2): workouts, personal records, body metrics (health data), plans, profile, favourites; `meta` holds `schemaVersion`, `seq`, `migratedFrom`, `migratedAt`, `mirrorSig` and `mirrorSigSeq` (fingerprint of the migrated mirror text and the seq it was current at), `persistAskedAt`, `persistGranted`, `lastBackupAt` (reserved) | T6. Each save is one transaction. Records are copied out by name (a whitelist), never merged by key |
| IndexedDB | database `homebody`, store `snapshots` | Verbatim copies of the whole document: `pre-migration` (the first one is kept until the user deletes it), `pre-reconcile`, `pre-restore`, and later `pre-import` (T7); the last 5 plus the kept one | **Extra on-device copies of health data**: they count as user data and must go with delete-all. Never rendered; a restore payload goes through the migration runner |
| localStorage | `vaultfit_v1` | The v1 **mirror** of the live data: exactly the six-key blob `persistSave` has always written, plus one ignorable key `hbSeq` (the commit counter) | Written synchronously on every save so a pre-M1 build (rollback) reads current history. Migration does not rewrite it: it stays byte for byte as found until the first save. IndexedDB `meta.mirrorSig` (length + FNV-1a) with `mirrorSigSeq` recognises it, but only while `meta.seq` still equals `mirrorSigSeq`: once IndexedDB has committed since, an unmarked mirror is older and IndexedDB wins. **A failed mirror write can leave an older mirror**; the boot rule never lets it overwrite newer IndexedDB data. Kept for all of M1; removing it needs its own ADR. About the size of the whole history (about 5% of a typical 5 MB budget at the fixture size) |
| localStorage | `homebody_v1`, `homebody_v0`, `vaultfit_v0` | Legacy copies of the main document | Read and copied once when `vaultfit_v1` is absent; never modified or removed by the app |
| localStorage | `hb_storage_meta` | `persistAskedAt` (timestamp), `persistGranted` (true, false, `unsupported`, `error`) and, since T6, `idbSeq` (the commit counter of the last IndexedDB commit, an integer) | Sidecar added in T5b; read with a 1 KB cap, fields copied by name. `idbSeq` lets the next boot prove the mirror equals IndexedDB (fast boot) |
| localStorage | `hb_active_workout` | The workout in progress | Written on every set by `wmPersist` |
| localStorage | `hb_milestones` | Milestones already shown | |
| localStorage | `hb_theme`, `hb_seen_guide`, `hb_seen_tutorial` | UI preferences and first-run flags | |
| Cache Storage | `homebody-<VERSION>` | The app shell (HTML, manifest, icons, fonts, `src/*.js`) | Names start with `homebody-`; the github.io origin is shared (K20) |
| Service worker | registration for this scope | Offline shell | |
| localStorage | `hb_probe_missing_key` | Never written | Read once to prove storage works |

Not used: sessionStorage (the tests only), cookies. IndexedDB holds the data since T6 (rows above). No network storage, no accounts, no analytics.

## "Delete all my data" rules (for T8 or whoever builds it)
- Remove the listed localStorage keys **one by one**. Never `localStorage.clear()`: the github.io origin is shared with other projects (K20).
- Delete only caches whose name starts with `homebody-`. Unregister only the service worker whose scope is this app.
- Before deleting: stop the `wmPersist` tick (it re-creates `hb_active_workout`), and stop any pending store retry or queued write (it would re-create `vaultfit_v1`). Delete, then reload.
- The key list is in one place in the code: `HBStorage.KEYS` (`localStorage`: every key above; `indexedDB`: `['homebody']`), covered by a test that records every key written in a full fake session.
- IndexedDB: close the store's connection, stop queued writes (as above), then `indexedDB.deleteDatabase('homebody')` and wait for it to finish (a connection left open makes it `blocked`). Deleting the database removes the live stores **and** every snapshot. `hb_storage_meta` is read once into IndexedDB `meta` and left in place, so delete it too. Delete the `vaultfit_v1` mirror: it is a full copy.
- Stop other tabs first: a second open tab can recreate the database after it is deleted (K32). Until T8 adds a stop-other-tabs step, delete-all must say to close other HomeBody tabs.
- Tell the user what stays: exported `.vaultfit` files and the raw `.txt` file are in their Downloads and the app cannot remove them; and a persistent-storage grant from the browser (`persist()`) cannot be withdrawn by the app.

## Raw "as found" export
`Export saved file` (shown when saved data cannot be read, is from a newer version, or storage failed to open) downloads the stored text of `vaultfit_v1` unchanged. It is read-only (never parses or writes), uses a `text/plain` Blob and the fixed filename `homebody-saved-data-as-found.txt`. It contains health data, so the user should treat the file as private. The plain `Export` beside it exports in-memory state (see K30).

## Protections against overwriting or losing data
- Corrupt or newer-than-known stored data: the store loads empty in memory, goes read-only and never writes `vaultfit_v1`.
- `hbLoadedOk`: `persistSave` refuses to write until `persistLoad` has copied the stored document into state this session, so a storage script that loads late cannot overwrite saved data with the empty startup state. If the storage script fails to load or throws before the store exists, `hbBootFailed()` starts the app on empty state and nothing is written. `wmPersist`, the `WM_KEY` removal and `hb_milestones` writes are not covered (K29).
- IndexedDB (T6): migration and every save are single transactions (all or nothing; tested with an abort part-way). The first migration commits a verbatim snapshot of the source text in the same transaction as the data and the schema marker, so nothing is marked migrated without its way back. The source and the legacy keys are never modified by the migration. `restore(id)` refuses during a workout, snapshots the present state first, and then the store is read-only until reload.
- Which copy wins at boot: a mirror with no `hbSeq` (a pre-M1 build or a localStorage fallback session wrote it) whose fingerprint is not `meta.mirrorSig`, or with `hbSeq` above `meta.seq`, is newer: IndexedDB is snapshotted (`pre-reconcile`), then the mirror is imported and the mirror is restamped. A mirror below `meta.seq` is stale: IndexedDB wins and the mirror is rewritten from it. The decision is one pure function, `decideBoot`, tested as a table. A corrupt or newer-than-known mirror is ignored and left as found. Corrupt IndexedDB (data without valid meta) or `schemaVersion` above the app's: read-only, never written, including by a save queued before IndexedDB attached (every engine write goes through one `canWrite()` gate, and nothing clears a read-only state); the load-time bar shows (also after a fast boot, which renders from the mirror first); `Export saved file` still reads the mirror text.
- IndexedDB unavailable, blocked, erroring or silent for 1.2 s: the localStorage engine runs the session (`status().fallback`), and its unmarked blob is imported (with a snapshot) on the next IndexedDB boot. A connection that opens late is closed. `onversionchange` closes the connection; the next save reopens it.
- Fast boot assumption: the page may render from the mirror before IndexedDB opens only when the mirror is provably not older (`canFastBoot`: marked and equal to the sidecar's `idbSeq`, or unmarked with no commit ever noted). If IndexedDB then turns out newer, the store goes read-only (bar: "Saving is not working", reopen) and nothing is saved over it. Every write also checks `meta.seq` inside its transaction (`expectSeq`): if another tab committed meanwhile, the state being replaced is first kept as a `pre-overwrite` snapshot.
- Retention is per snapshot reason (newest 5 of each, plus the `keep:true` one); a restore never prunes the snapshot it restores from. Snapshots keep deleted records (K33).
- A failed mirror write is logged and shown as `status().mirror: 'stale'`, never as a save error; the IndexedDB commit is the save.
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
K20 (shared origin), K29 (pre-load window and `hbLoadedOk` coverage, reduced), K31 (two tabs both saving is last write wins), K30 (plain Export in unreadable-data states looks normal; only `vaultfit_v1` is raw-readable when HB failed to boot).
