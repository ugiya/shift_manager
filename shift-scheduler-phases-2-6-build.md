---
type: session-summary
project: "Shift Scheduler"
topic: "Shift Scheduler Phases 2–6 build"
session_type: "development"
created: 2026-06-28
---

# Shift Scheduler — Phases 2–6 Build

**Date:** 2026-06-28 (Sunday)
**Duration:** 00:47 - 02:51 (~124 min)
**Type:** personal

## Objective

Resume and finish a 6-phase feature build on the Timefold-backed weekly shift scheduler
(FastAPI + JPype backend, React/TS + Playwright frontend), driving each phase through a
strict workflow — implement → unit + e2e green → update `docs/DATA_MODEL.md` in the same
change → `/consult-codex` (gpt-5.5 xhigh) → relate to findings → add edge-case tests →
update `HANDOFF.md` — without changing any architectural pillar.

## Summary

Picked up from `HANDOFF.md` on branch `feat/employee-features-and-views` with Phase 1
(cross-site projects) already done and Phase 2 (inactive employees + HR metadata) code-complete
but unverified. Finished Phase 2 verification (full backend pytest **887 passed**, full e2e
**65 passed**) and then implemented Phases 3→6 in order. Each phase got its own consult-codex
adversarial review at xhigh reasoning; four of the five reviews returned CHANGES-NEEDED and I
fixed every finding with a targeted regression test before moving on. Final state: backend
**937 passed**, full e2e **74 passed**, and `docs/DATA_MODEL.md` §8 ("planned/in-flight") is now
empty because every planned feature shipped.

**Phase 2** (inactive employees): codex flagged five adjacent-contract issues — `MAX_EMPLOYEES`
counted inactive rows (status leaking into the solve-size guard), carry-over continuity across a
leave was undocumented, an "unusable" warning fired for inactive rows, an inactive override
returned a misleading "unknown employee" error, and the coverage-warning eligibility predicate
was duplicated. All fixed (the cap now counts active only; continuity documented + tested as
"freeze on the retained EmployeeIn, resume on reactivation"; warning scoped to active; a clear
"not active" error; a coverage↔eligibility parity test).

**Phase 3** (date-based unavailability): added `unavailable_dates` to the domain `Employee` and
`EmployeeIn`; an employee is removed from a Seat's eligibility (worker *and* manager) for shifts
starting on an unavailable date, the EXC flag names the date when that's the cause, and coverage
warnings became availability-aware (per-date). Codex APPROVE-WITH-NITS → tightened ISO-date
validation to strict `YYYY-MM-DD`, added a rigorous by-date manager parity test and an
override-accrues-burden regression.

**Phase 4** (preferred shift types, R11): a new soft PENALTY rule for being assigned a shift type
the employee didn't list (never a reward — a reward has no flag and breaks the constraints↔
analysis parity model). The standout was a real Timefold gotcha: its jpyinterpreter has no
`frozenset.__bool__`, so `bool(set)`/`not set` inside a constraint lambda either errors or
*silently inverts* the result — the fix is `len(set) == 0`, with the predicate moved into a
shared `Seat.is_dispreferred_type()` method so constraints and analysis can't drift. Codex
CHANGES-NEEDED → fixed a referential-integrity gap (deleting a shift type still preferred by an
employee was UI-permitted but backend-rejected).

**Phase 5** (import/export): new `portability.py` + `/api/export` and `/api/import` endpoints and
an `ImportExport` toolbar. JSON is lossless (whole document); CSV is a lossy employee roster
(references by name, internal id in column 1, `;`-multivalue, carry-over dropped), with a
pluggable `ImportMode` (replace / upsert by id / upsert by name / replace+auto-create-refs) that
reuses `validate_requirements`. Codex CHANGES-NEEDED with three HIGH findings — all fixed:
upsert no longer wipes carry-over for matched rows, ambiguous/`;`-bearing reference names fail
loud instead of silently corrupting, name-upsert keeps the existing id and rejects duplicate
keys, auto-created projects union teams across rows, an import size cap, and the frontend now
surfaces validation errors instead of reporting plain success.

**Phase 6** (read-only views): a "View by: Site | Team | Project | Employee" selector. Site stays
the editable seat grid (overrides only here); Project is a read-only seat grid aggregating a
project's seats across teams/sites (ADR-0003); Team and Employee are read-only people-as-rows
rosters. Frontend-only — the dataset payload already carried everything. Codex CHANGES-NEEDED →
three ProjectView fixes (normalized null-role lane key, each cell names its shift type so two
same-day seats are distinguishable, cross-team badge derived from `project.team_ids` rather than
this week's seats).

## Work Log

1. Read source-of-truth files in order (`CLAUDE.md` → `HANDOFF.md` → `docs/DATA_MODEL.md §8`);
   reconciled the stated tip `edad485` (pre-amend twin of the WIP commit) with HEAD `9665d3c`.
2. **Phase 2 verify:** killed stale uvicorn; ran full backend (887) + full e2e (65); ran
   consult-codex (xhigh) → CHANGES-NEEDED; fixed 5 findings in `requirements.py`/`serialize.py`/
   `main.py`; added 7 edge tests to `test_employee_status.py`; re-ran backend (894) + targeted
   e2e (19); updated DATA_MODEL §3/§5 + HANDOFF.
3. **Phase 3:** added `unavailable_dates` across domain/input/eligibility/analysis/coverage;
   wrote `test_unavailability.py`; built the `UnavailableDates` editor control; backend 903 →
   905, full e2e 66; codex APPROVE-WITH-NITS → strict `_bad_date`, manager parity + override-
   burden tests; updated DATA_MODEL §2/§3/§4 and reconciled CONTEXT.md ("Unavailability"
   per-Shift→per-date to match the locked decision).
4. **Phase 4:** added `W_PREFERRED_SHIFT_TYPE`, `Employee.preferred_shift_type_ids`, the R11
   constraint + analysis mirror + CONSTRAINTS/CANON; hit the inverted-result bug, traced it to
   `frozenset.__bool__` via `score_breakdown`, fixed with `len(...)==0` in a shared
   `Seat.is_dispreferred_type()`; wrote `test_preferred_shift_type.py`; codex CHANGES-NEEDED →
   `shiftTypeReferenced` delete-gate fix + edge tests; backend 916, e2e editor specs green.
   Saved a `timefold-no-frozenset-bool` memory.
5. **Phase 5:** wrote `portability.py` (JSON lossless, CSV lossy, ImportMode) + endpoints +
   `ImportExport` toolbar; wrote `test_portability.py` + `portability.spec.ts`; codex
   CHANGES-NEEDED (3 HIGH) → restructured CSV import (preserve carry-over on upsert, loud
   ambiguous-name/`;` errors, keep id on name-upsert, dedup keys, autocreate team-union, size
   cap) + 7 follow-up tests; frontend surfaces import errors; backend 937, e2e 72→ green.
6. **Phase 6:** added the `scheduleView` selector + `ProjectView.tsx` + `RosterView.tsx`, gated
   the sitebar to Site view; wrote `views.spec.ts`; codex CHANGES-NEEDED → 3 ProjectView fixes
   + a pre-solve empty + shift-identity test; updated DATA_MODEL §7 (view modes) and emptied §8.
7. **Final verification:** full backend **937 passed**, full e2e **74 passed**; updated HANDOFF
   to mark all 6 phases DONE.

## Deliverables

### Obsidian Note
- [Session note in Obsidian](file:///Users/uri/obsidian/work_notes/2026/06_June/week_5_28_04/28_Sunday/shift-scheduler-phases-2-6-build.md)

### Task Folder — new files
- [portability.py](file:///Users/uri/projects/adili/shift_manager/backend/app/portability.py) — import/export (JSON lossless, CSV lossy, ImportMode)
- [test_unavailability.py](file:///Users/uri/projects/adili/shift_manager/backend/tests/test_unavailability.py)
- [test_preferred_shift_type.py](file:///Users/uri/projects/adili/shift_manager/backend/tests/test_preferred_shift_type.py)
- [test_portability.py](file:///Users/uri/projects/adili/shift_manager/backend/tests/test_portability.py)
- [ImportExport.tsx](file:///Users/uri/projects/adili/shift_manager/frontend/src/components/ImportExport.tsx)
- [ProjectView.tsx](file:///Users/uri/projects/adili/shift_manager/frontend/src/components/ProjectView.tsx)
- [RosterView.tsx](file:///Users/uri/projects/adili/shift_manager/frontend/src/components/RosterView.tsx)
- [portability.spec.ts](file:///Users/uri/projects/adili/shift_manager/frontend/e2e/portability.spec.ts)
- [views.spec.ts](file:///Users/uri/projects/adili/shift_manager/frontend/e2e/views.spec.ts)

### Task Folder — key modified files
- [requirements.py](file:///Users/uri/projects/adili/shift_manager/backend/app/requirements.py) · [constraints.py](file:///Users/uri/projects/adili/shift_manager/backend/app/constraints.py) · [analysis.py](file:///Users/uri/projects/adili/shift_manager/backend/app/analysis.py) · [domain.py](file:///Users/uri/projects/adili/shift_manager/backend/app/domain.py) · [data.py](file:///Users/uri/projects/adili/shift_manager/backend/app/data.py) · [main.py](file:///Users/uri/projects/adili/shift_manager/backend/app/main.py) · [serialize.py](file:///Users/uri/projects/adili/shift_manager/backend/app/serialize.py) · [config.py](file:///Users/uri/projects/adili/shift_manager/backend/app/config.py)
- [App.tsx](file:///Users/uri/projects/adili/shift_manager/frontend/src/App.tsx) · [Editor.tsx](file:///Users/uri/projects/adili/shift_manager/frontend/src/components/Editor.tsx) · [api.ts](file:///Users/uri/projects/adili/shift_manager/frontend/src/api.ts) · [types.ts](file:///Users/uri/projects/adili/shift_manager/frontend/src/types.ts) · [lib/req.ts](file:///Users/uri/projects/adili/shift_manager/frontend/src/lib/req.ts) · [styles.css](file:///Users/uri/projects/adili/shift_manager/frontend/src/styles.css)
- [docs/DATA_MODEL.md](file:///Users/uri/projects/adili/shift_manager/docs/DATA_MODEL.md) · [CONTEXT.md](file:///Users/uri/projects/adili/shift_manager/CONTEXT.md) · [HANDOFF.md](file:///Users/uri/projects/adili/shift_manager/HANDOFF.md)

## Key Decisions

- **R11 is a penalty, not a reward.** A preferred-shift-type *reward* would have no flag and
  break the constraints↔analysis parity model, so an *unmet* preference is penalised instead.
  Weight 8 (below R10=10, above fairness=5); soft, so it can never sacrifice coverage.
- **CSV is a deliberately lossy roster.** Carry-over and `avoid_shift_ids` are week-specific and
  shift-id-specific, so they're excluded; on upsert the omitted fields are *preserved* from the
  existing record (only replace/new rows default them). Ambiguous or `;`-bearing reference names
  fail loud rather than silently corrupt.
- **Schedule views show the materialized (active) roster only.** Inactive-employee management
  lives in the Editor/export, not in a schedule lens — Employee view is "who works when".
- **Reconciled docs to locked decisions, not on a whim.** CONTEXT.md "Unavailability" changed
  per-Shift → per-date and "Preference" extended to cover R11, to match decisions already in
  HANDOFF/DATA_MODEL §8 — no pillar (entity model, 3-level scoring, ADR-0002, datetime) changed.
- **Did not commit.** Standing rule is to commit only when asked; all work remains uncommitted on
  the feature branch.

## Technical Context

- **⚠️ Timefold jpyinterpreter has no `frozenset.__bool__`.** In any constraint-stream lambda or
  domain method reachable from one, `bool(set)`/`not set`/`if set:` either raises
  `AttributeError` or *silently inverts* the filter. Use `len(set) == 0`. Membership (`in`/`not
  in`) and `len()` translate fine — matching how R10/EXC already work. Saved as a project memory.
- **constraints.py is the scoring authority; analysis.py mirrors it exactly** (pinned by
  `test_rule_parity.py` + `test_score_authority.py`). New rule R11 added to both via a shared
  `Seat.is_dispreferred_type()` predicate and the parity `CANON`.
- **Per-date eligibility** is computed in `build_schedule` (`_eligible_workers`/`_eligible_managers`
  now take `day`); the EXC enrichment and availability-aware coverage warnings mirror it.
- **Import reuses `validate_requirements`** — `portability.import_document` returns a merged doc
  dict, the endpoint builds `RequirementsIn(**merged)` and validates, so import can't bypass the
  normal guards (incl. an explicit pre-parse size cap).
- **Test counts:** backend 887 → **937** (+50 across `test_employee_status` follow-ups,
  `test_unavailability`, `test_preferred_shift_type`, `test_portability`); e2e 65 → **74**.

## Current Status & Next Steps

- **Resolved:** All 6 phases implemented, unit + e2e green, each consult-codex'd and all findings
  fixed with regression tests; DATA_MODEL/CONTEXT/HANDOFF in sync; DATA_MODEL §8 empty.
- **Pending:** Nothing functional. The branch is **uncommitted** (`feat/employee-features-and-views`).
- **Next action:** Commit when ready — either per-phase or as one squash — then open a PR.
- **Blockers:** None.

## Related Topics

- Timefold constraints / parity (HardMediumSoftScore, the `frozenset.__bool__` gotcha)
- ADR-0003 cross-site projects (eligibility + Project-view aggregation)
- ADR-0002 carry-over (continuity across a leave)
- consult-codex review workflow (per-phase gpt-5.5 xhigh adversarial review)
