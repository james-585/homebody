// T4b: the frozen pre-M1 build still matches the recorded hashes, and git when git can tell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SNAPSHOT_DIR, SNAPSHOT_FILES, SNAPSHOT_SHA256 } from '../e2e/helpers/snapshot.mjs';

const COMMIT = 'd642b2b';
const reachable = (() => {
  try {
    execFileSync('git', ['cat-file', '-e', `${COMMIT}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

for (const f of SNAPSHOT_FILES) {
  test(`${f}.frozen matches the recorded SHA-256`, () => {
    const bytes = readFileSync(join(SNAPSHOT_DIR, f + '.frozen'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), SNAPSHOT_SHA256[f]);
  });

  test(`${f}.frozen is byte-identical to git show ${COMMIT}:${f}`, (t) => {
    if (!reachable) {
      t.skip(`${COMMIT} is not in this clone (shallow); only the hash check ran`);
      return;
    }
    const fromGit = execFileSync('git', ['show', `${COMMIT}:${f}`], { maxBuffer: 16 << 20 });
    assert.ok(fromGit.equals(readFileSync(join(SNAPSHOT_DIR, f + '.frozen'))));
  });
}

test('the README lists every recorded hash', () => {
  const readme = readFileSync(join(SNAPSHOT_DIR, 'README.md'), 'utf8');
  for (const f of SNAPSHOT_FILES) assert.ok(readme.includes(SNAPSHOT_SHA256[f]), f);
});
