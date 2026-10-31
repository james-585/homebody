# Task plan template

The milestone plan (`docs/plans/<milestone>.md`) says *what* the milestone delivers and lists its tasks. Before any task is implemented, the assigned agent writes a short task plan from this template at `docs/plans/<milestone>/<task-id>.md` (e.g. `docs/plans/m1/T3.md`). The human approves it; then implementation starts.

Why: a milestone plan is too big to review line by line, and a solo builder has no second reviewer watching the agent mid-task. A one-page plan with explicit stop conditions is the checkpoint. Keep it under a page — if it doesn't fit, split the task.

Copy everything below the line.

---

```markdown
# <task-id> — <title>

Milestone: <M#> (docs/plans/<milestone>.md) · Agent: <agent-name> · Branch: <branch>
Status: Draft | Approved <date> | Done <date>

## Scope
- In: <what this task changes, in 1–3 bullets>
- Out: <what it deliberately does not touch, so the agent doesn't drift>

## Acceptance criteria
Copied from the milestone plan, one per line, each checkable by a test or a command.
- [ ] AC1 …
- [ ] AC2 …

## Approach
<3–6 sentences. Name the existing modules, ADRs and interfaces it builds on.
If it needs a decision with real trade-offs, stop and ask the architect for an ADR first.>

## Files
- Create: <paths>
- Change: <paths>
- Data: <exercise library, plans, standards, or storage-format changes, or "none">
- Storage format: <unchanged | changed — name the migration and its fixtures>

## Tests
- <test file> — <which AC it proves, and the failure it would catch>

## Principles touched
<Which CLAUDE.md principles (1–9) this task can break, and how the plan keeps them.
"None" is a valid answer; say why.>

## Stop conditions
Stop, report, and wait for the human if any of these happen:
- The change needs a file outside **Files** above, or a new dependency.
- An existing test has to be changed or deleted to make the new code pass.
- A storage change has no migration, or a migration fails on any fixture in tests/fixtures/legacy/.
- A strength standard, MET value, volume target or other training number would have to be written without a source or documented rationale.
- A new external request, third-party script, notification, health-platform link or data source is needed, or a secret seems necessary.
- Exercise data would have to be retyped by hand rather than extracted or sourced.
- The change makes logging a set take more than two taps, or breaks offline use.
- The 'verify' command (once it exists) is still red after two honest attempts.
- The acceptance criteria turn out to be ambiguous or contradict the spec.
- <task-specific condition, if any>

## Approval
Approved by: <human> on <date> — or the change requested.
```
