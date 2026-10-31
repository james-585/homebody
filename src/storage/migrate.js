// Migration runner (pure: no I/O, no clock). Contract in ADR 0002 and tests/unit/helpers/
// migration-harness.mjs: a migration is { from, to, migrate(doc) }; a document carries its version
// in `schemaVersion` (absent means 1). The runner never mutates its input and refuses, rather than
// guesses, on data it cannot read: invalid JSON -> 'corrupt', a newer schema -> 'future'.

export const CURRENT_SCHEMA = 1;

const versionOf = (doc) => doc.schemaVersion ?? 1;

/**
 * @param {Array<{from:number,to:number,migrate:Function}>} list
 * @param {string|object} input  stored text (parsed here) or an already parsed document
 * @param {{current?:number}} [opts]
 * @returns {{ok:true, doc:object, version:number} | {ok:false, reason:'corrupt'|'future'}}
 */
export function runMigrations(list, input, { current = CURRENT_SCHEMA } = {}) {
  let doc = input;
  if (typeof input === 'string') {
    try {
      doc = JSON.parse(input);
    } catch {
      return { ok: false, reason: 'corrupt' };
    }
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, reason: 'corrupt' };
  }
  const v = versionOf(doc);
  if (!Number.isInteger(v) || v < 1) return { ok: false, reason: 'corrupt' };
  if (v > current) return { ok: false, reason: 'future' };

  let cur = structuredClone(doc);
  const ordered = [...list].sort((a, b) => a.from - b.from);
  for (const m of ordered) {
    if (versionOf(cur) === m.from) {
      cur = m.migrate(structuredClone(cur));
      if (!cur || versionOf(cur) !== m.to) {
        throw new Error(`migration ${m.from}->${m.to} did not set schemaVersion to ${m.to}`);
      }
    }
  }
  return { ok: true, doc: cur, version: versionOf(cur) };
}
