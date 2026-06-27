# Schedules are continuous across weeks (Carry-over), not independent

Each weekly solve takes prior weeks as input via **Carry-over**, rather than
treating every week as an independent problem. Carry-over carries two kinds of
state: recent facts that drive rules (who worked last weekend; who worked a Night
Shift on the last day) and rolling cumulative counts that drive Fairness (how many
Burden Shifts each employee has recently worked).

## Why

Several accepted rules are impossible without it: consecutive-weekend protection
needs last weekend's assignments; night recovery straddles the week boundary; and
fairness measured within a single week is meaningless — burden must be balanced
cumulatively across weeks.

## Consequences

The system is not stateless per week. There is coupling between consecutive
Schedules, and the accepted Schedule (including manual Overrides) must be
persisted as the source of next week's Carry-over. We accept this coupling over
the simplicity of independent weekly solves.

## The continuity seam

The HTTP service itself stays stateless (it persists nothing — see `main.py`), so
the coupling is realised as a *data seam* rather than server-side storage:

  * **In:** `RequirementsIn.employees` carry `carryover_burden`,
    `worked_last_weekend`, `prev_shift_end` and `prev_shift_was_night`, which feed
    R3/R6-carry-over, R7 and R9.
  * **Out:** `/api/solve` and `/api/validate` return `next_carryover` — a
    self-describing seed envelope derived from the accepted Schedule by
    `carryover.carryover_seed`: `{source_week_start, target_week_start,
    source_feasible, employees: {employee_id: {…}}}`. The per-employee field
    shapes match `EmployeeIn` (single-sourced as `requirements.CarryoverFields`).
  * **Back in:** the client submits that envelope verbatim as the optional
    `carryover_seed` on the next week's build/solve/validate request.
    `requirements.apply_carryover_seed` checks `target_week_start` equals the
    requested week (rejecting a wrong-week splice) and then merges it onto the
    employees, so the server — not the client — owns the merge.

The client (or a future persistence layer) owns storing the accepted Schedule and
replaying the envelope; the server only computes and re-applies the seed.
`prev_shift_end` is emitted local-naive, matching the input datetime contract.

Guards on the seam: a cross-week **overlap** (last week's shift ending after a
current shift starts) is a hard R3 violation, not a silently-ignored negative gap;
`source_feasible` warns when a seed came from a hard-infeasible schedule (e.g. a
bad Override); and `carryover_burden` is capped so an unbounded rolling count
can't overflow or swamp the soft score. Demand coverage (R4) sits on the MEDIUM
score level, above Fairness (R9) and the other soft rules, so carry-over can never
make leaving a coverable seat empty look cheaper than filling it.
