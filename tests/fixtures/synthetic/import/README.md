# Synthetic import fixtures (T7)

Derived by script from `tests/fixtures/legacy/vaultfit_v1_export.sanitized.json` and `tests/fixtures/synthetic/homebody_v1.json`; nothing in `legacy/` was edited. They sit in a sub-folder so the migration harness (which loads every top-level file as a stored document) does not pick them up.

- `v1_export_no_rpe.json`: what an older v1 export may look like: no `_version`, no `rpe` or `notes` on workouts; three workouts, three PRs, two body rows, one plan, a profile.
- `hostile_strings_allowed.json`: apostrophe, double quote, backslash, backtick, `&#39;` and HTML-looking text in a name and a note. Valid data: kept as text, never rendered as markup.
- `hostile_name_refused.json`: `<script>` in a workout name; refused (`bad-chars`), whole file rejected.
- `proto_key_refused.json`: a `__proto__` key in `personalRecords` (raw text); refused (`bad-key`).
- `k39_mirror_15_digit_hbseq.json`: a `vaultfit_v1` mirror text whose `hbSeq` has 15 digits (the K39 case); the boot rule must ignore it.
