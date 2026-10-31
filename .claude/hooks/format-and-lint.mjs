#!/usr/bin/env node
// Claude Code PostToolUse hook: after every Edit/Write, run Prettier on the
// file, then ESLint on JS/TS files, so problems surface at the edit that
// caused them rather than at PR time.
//
// Prettier fixes in place silently. ESLint errors exit 2, which feeds the
// output back to Claude so it fixes the problem rather than suppressing it.
//
// Skipped on purpose:
//   - `index.html` and `sw.js`: the shipped app is one ~670 KB hand-formatted
//     file. Reformatting it on every edit would bury the real diff. Remove
//     this exclusion when the architect adopts a formatter for it (ADR).
//   - **/__fixtures__/** and tests/fixtures/**: they may break rules on purpose.
//
// If node_modules is missing (no toolchain yet, or a fresh clone before
// `npm install`) the hook does nothing.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

const input = readInput();
const filePath = input?.tool_input?.file_path;
if (typeof filePath !== 'string' || filePath === '') process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const absolute = resolve(projectDir, filePath);
const rel = relative(projectDir, absolute).split(sep).join('/');
if (rel.startsWith('..') || !existsSync(absolute)) process.exit(0);

const skipExact = new Set(['index.html', 'sw.js']);
if (skipExact.has(rel) || rel.includes('/__fixtures__/') || rel.startsWith('tests/fixtures/')) {
  process.exit(0);
}

const prettierBin = join(projectDir, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
const eslintBin = join(projectDir, 'node_modules', 'eslint', 'bin', 'eslint.js');

function run(bin, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

if (existsSync(prettierBin)) {
  run(prettierBin, ['--write', '--ignore-unknown', '--log-level', 'warn', rel]);
}

const lintable = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
if (existsSync(eslintBin) && lintable.has(extname(rel))) {
  const result = run(eslintBin, ['--max-warnings=0', '--no-warn-ignored', rel]);
  if (result.status !== 0) {
    process.stderr.write(
      `ESLint failed on ${rel}. Fix the code; do not disable the rule.\n${result.stdout}${result.stderr}`,
    );
    process.exit(2);
  }
}

process.exit(0);
