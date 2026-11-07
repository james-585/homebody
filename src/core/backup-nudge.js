// Backup nudge rule (T8, assumption A1). Pure: time is passed in, nothing is read or written here.
// Product numbers, not training claims: remind 14 days after the last export (or after the oldest
// workout if never exported), only if a workout was logged since, snooze 7 days, never mid-workout.
(function (root) {
  const DAY = 86400000;
  const NUDGE_AFTER_DAYS = 14;
  const SNOOZE_DAYS = 7;

  const ts = (v) => {
    const n = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(n) ? n : null;
  };

  /**
   * @param {{now:number, lastBackupAt:?number, workoutDates:Array<string|number>,
   *          snoozedUntil:?number, workoutActive:boolean}} i
   * @returns {{due:boolean, reason:string}}
   */
  function backupNudge(i) {
    if (i.workoutActive) return { due: false, reason: 'workout-active' };
    if (ts(i.snoozedUntil) !== null && i.now < ts(i.snoozedUntil))
      return { due: false, reason: 'snoozed' };
    const dates = (i.workoutDates || []).map(ts).filter((n) => n !== null);
    if (!dates.length) return { due: false, reason: 'no-workouts' };
    const last = ts(i.lastBackupAt);
    const since = dates.filter((d) => last === null || d > last);
    if (!since.length) return { due: false, reason: 'nothing-new' };
    const ref = last !== null ? last : Math.min(...dates);
    if (i.now - ref < NUDGE_AFTER_DAYS * DAY) return { due: false, reason: 'too-soon' };
    return { due: true, reason: last === null ? 'never-exported' : 'overdue' };
  }

  const api = { backupNudge, NUDGE_AFTER_DAYS, SNOOZE_DAYS, DAY };
  root.HBBackupNudge = Object.freeze(api);
})(globalThis);
