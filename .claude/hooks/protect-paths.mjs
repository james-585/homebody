#!/usr/bin/env node
// Claude Code PreToolUse hook: blocks file-tool access that would break a
// CLAUDE.md guardrail, so the rule is enforced rather than requested.
//
//   1. Secrets: no Read/Edit/Write of `.env` or `.env.*`. `.env.example` is
//      allowed — it holds placeholders only. HomeBody needs no secrets.
//   2. Frozen data: `docs/reference/` (snapshots of shipped versions) and
//      `tests/fixtures/legacy/` (real-shape user data for migration tests)
//      are append-only: existing files cannot be edited or overwritten, but
//      new files can be added. Principle 1 (never lose user data) depends on those
//      fixtures staying exactly as they were captured.
//
// Limits: this guards the file tools only. A shell command such as
// `cat .env` is not seen here; the deny rules in .claude/settings.json cover
// the common forms.
//
// Exit code 2 blocks the tool call and shows stderr to Claude. Any other
// failure exits 0 so a broken hook never wedges a session.

import { existsSync, readFileSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const input = readInput();
const filePath = input?.tool_input?.file_path;
if (typeof filePath !== 'string' || filePath === '') process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const absolute = resolve(projectDir, filePath);
const rel = relative(projectDir, absolute).split(sep).join('/');
const name = basename(absolute);

if ((name === '.env' || name.startsWith('.env.')) && name !== '.env.example') {
  block(
    `Blocked: ${rel} may hold secrets. HomeBody needs none; ` +
      'use .env.example for variable names and ask the human if a value seems necessary.',
  );
}

const isWrite = ['Edit', 'MultiEdit', 'Write'].includes(input.tool_name);
const frozen = rel.startsWith('docs/reference/') || rel.startsWith('tests/fixtures/legacy/');
if (isWrite && frozen && existsSync(absolute)) {
  block(
    `Blocked: ${rel} is frozen reference data; existing files are read-only. ` +
      'Add a new file beside it instead; record data problems in docs/known-issues.md.',
  );
}

process.exit(0);
