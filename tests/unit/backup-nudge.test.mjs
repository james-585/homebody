import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../src/core/backup-nudge.js';

const { backupNudge, DAY } = globalThis.HBBackupNudge;
const NOW = Date.parse('2026-11-01T12:00:00Z');
const base = (o = {}) => ({
  now: NOW,
  lastBackupAt: NOW - 15 * DAY,
  workoutDates: [NOW - 2 * DAY],
  snoozedUntil: null,
  workoutActive: false,
  ...o,
});

test('due: 15 days since export and a workout since', () => {
  assert.deepEqual(backupNudge(base()), { due: true, reason: 'overdue' });
});
test('not due at 13 days, due at exactly 14', () => {
  assert.equal(backupNudge(base({ lastBackupAt: NOW - 13 * DAY })).due, false);
  assert.equal(backupNudge(base({ lastBackupAt: NOW - 14 * DAY })).due, true);
});
test('not due when no workout since the export', () => {
  const r = backupNudge(base({ workoutDates: [new Date(NOW - 20 * DAY).toISOString()] }));
  assert.deepEqual(r, { due: false, reason: 'nothing-new' });
});
test('never exported: counts from the oldest workout', () => {
  const old = [NOW - 20 * DAY, NOW - 1 * DAY];
  assert.deepEqual(backupNudge(base({ lastBackupAt: null, workoutDates: old })), {
    due: true,
    reason: 'never-exported',
  });
  assert.equal(backupNudge(base({ lastBackupAt: null, workoutDates: [NOW - DAY] })).due, false);
});
test('no workouts: nothing to lose, no nudge', () => {
  assert.equal(backupNudge(base({ workoutDates: [], lastBackupAt: null })).due, false);
});
test('never during a workout', () => {
  assert.deepEqual(backupNudge(base({ workoutActive: true })), {
    due: false,
    reason: 'workout-active',
  });
});
test('snooze defers until its time, then it is due again', () => {
  assert.equal(backupNudge(base({ snoozedUntil: NOW + DAY })).reason, 'snoozed');
  assert.equal(backupNudge(base({ snoozedUntil: NOW })).due, true);
});
test('junk dates are ignored', () => {
  assert.equal(backupNudge(base({ workoutDates: ['x', null, NOW - DAY] })).due, true);
});
