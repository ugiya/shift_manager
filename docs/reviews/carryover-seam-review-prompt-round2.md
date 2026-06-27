# Holistic adversarial review — shift-scheduler carry-over change (round 2)

You are a principal engineer doing a **deep, independent** review of a completed
change to a Python/FastAPI + React/TypeScript shift-scheduler that uses **Timefold**
(a Java constraint solver via a JPype bridge). **Everything you need is inline
below** — domain spec, ADRs, all relevant source at its current state, and the new
tests. No repo access needed. Cite `file:line`. Assume the author is competent;
find the *subtle* problems.

## Where this came from

An earlier review of yours (against commit `c446a65`) returned REQUEST CHANGES on
a carry-over change with **6 must-fix + 5 nice-to-have** items. The author then
implemented **all** of them (the user chose "everything", and chose
`HardMediumSoftScore` for the fairness-vs-coverage fix), and additionally **wired a
"carry to next week" UI feature** on top of the resulting validated seam. A
separate model (Codex gpt-5.5) reviewed each step and ultimately approved. Your job
is a fresh, independent verdict on the whole thing — do not assume the prior
approvals are correct.

## What changed (summary; verify against the source)

**Backend**
1. **Cross-boundary overlap (was must-fix #1).** R3/R6 carry-over filters dropped
   the `0 <=` lower bound, so a negative gap (last week's shift ending after a
   current shift starts — an overlap R1 can't see) is now a hard R3. Applied
   identically in `constraints.py` and `analysis.py`.
2. **Fairness vs coverage (must-fix #2).** Migrated `HardSoftScore` →
   `HardMediumSoftScore`. R4 understaffing is penalized on the **MEDIUM** level
   (`of_medium`), every other soft rule stays soft. So demand coverage strictly
   outranks R9 fairness regardless of `carryover_burden`. `kind` (Infeasibility |
   Compromise) and `level` (hard|medium|soft) are now distinct in `CONSTRAINTS`.
3. **Burden cap (must-fix #3).** `MAX_CARRYOVER_BURDEN=1000` enforced in validation
   and clamped in the seed output (overflow / soft-domination guard; coverage no
   longer depends on it).
4. **Seed identity (must-fix #4).** `next_carryover` is now a self-describing
   envelope `{source_week_start, target_week_start, source_feasible, employees}`
   (`carryover.carryover_seed`). Requests accept an optional `carryover_seed`;
   `requirements.apply_carryover_seed` **rejects a non-empty seed whose
   target_week_start is missing or != the requested week**, then merges it.
5. **Parity (must-fix #5).** `constraints.py` and `analysis.py` carry-over R3/R6 are
   both **per-seat** now (consistent with the existing pairwise within-week R3); a
   parity test asserts the analysis hard-flag count equals Timefold's hard score.
6. **Infeasible-source seed (must-fix #6).** `source_feasible` in the envelope;
   `apply_carryover_seed` warns when replaying a seed from an infeasible schedule.
7. **Nice-to-haves:** single-source `CarryoverFields` model + drift test (N1);
   documented snapshot (not patch) assignment semantics (N2); `dt.utcoffset() is
   not None` aware-check (N3); conservative night flag on `end_dt` ties (N4);
   frontend comment (N5).

**Frontend — new "carry to next week" feature**
- Captures `next_carryover` from solve/validate into state; a "Carry to {date}"
  button advances `week_start` to the seed's target and replays the envelope as
  `carryover_seed`; a "seeded" indicator shows when a week runs off a seed.
- `ScoreBadge` now surfaces the MEDIUM (coverage) penalty distinctly.
- Concurrency handling (this is the part to scrutinize hardest): a single
  `reqToken` op-generation guard makes solve/validate refuse to write a stale
  response (score/flags/`nextCarryover`) after a newer override or requirements
  change; `buildToken` cancels in-flight/debounced builds; requirements changes and
  carry-forward bump **both** tokens synchronously and clear both spinners; spinner
  resets in `finally` are token-gated (only the latest op clears its own), and the
  op that bumps the shared token clears the *other* type's spinner on start.

## Verification already run

Backend `pytest`: **879 passed**. Playwright e2e (Brave): **65 passed** (incl. 3 new
carry-over specs). `npm run build` + `typecheck:e2e` pass. Both original blockers
reproduced-then-confirmed-fixed.

## Questions to attack (be concrete; cite file:line)

1. **Completeness & correctness of each of the 6 must-fix + 5 nice-to-have** — is
   any item only superficially addressed, or addressed in a way that breaks
   something else?
2. **Score model.** Is the `HardMediumSoftScore` migration complete and correct?
   Does coverage dominate fairness in *all* cases (multi-seat, multi-employee — not
   just the single-seat example)? Any constraint on the wrong level? Does the
   `kind`=soft / `level`=medium split for R4 cause any reporting/semantic bug
   (e.g. flags taxonomy vs score breakdown)?
3. **Carry-over rest semantics.** Is per-seat (vs the reviewer's earlier
   "earliest-only" suggestion) actually correct, and does `analysis.py` truly
   mirror `constraints.py` now? Walk a multi-week example end-to-end through the
   envelope → replay → `apply_carryover_seed` path. Any naive/aware or overlap edge
   left?
4. **Seed envelope.** Is `apply_carryover_seed` airtight (week identity, the
   cap/clamp interaction producing always-valid seeds, source_feasible)? Can a
   crafted seed still corrupt a week?
5. **Frontend concurrency (audit independently, do not trust the prior approval).**
   Model the React state machine (`reqToken`, `buildToken`, the debounced build
   effect, solve, validate, carry-forward, requirements-change). Is there ANY
   remaining interleaving that writes stale `nextCarryover`/score, leaves a stuck
   or early-hidden spinner, or shows a stale clickable Carry button? Consider
   React 18 batching, passive-effect timing vs promise microtasks, and rapid
   user actions.
6. **Tests.** Do the new backend + e2e tests actually pin these behaviors, or do
   they pass for the wrong reasons? What's the highest-value missing test?
7. **Anything that should block.**

End with `VERDICT: APPROVE` or `VERDICT: REQUEST CHANGES`, then a prioritized
must-fix vs nice-to-have list.

---

# MATERIAL (all inline below)

## Domain spec — CONTEXT.md

```markdown
# Shift Scheduling

The language of a product that helps a scheduler build a weekly work schedule
across multiple sites and teams, then explains every place it had to bend or
break a rule.

## Language

### Organization

**Site**:
A geographic location where employees physically sit and work. Homes multiple
Teams, which may run different shift schedules. A Team usually belongs to one
Site.
_Avoid_: location, factory, branch.

**Team**:
A group of employees led by exactly one Shift Manager, working across several
Projects. The Team carries its own weekly shift schedule (which Shift Types it
runs). Usually sits at one Site; on rare occasions a Team is split across two
Sites while still sharing a single Shift Manager.
_Avoid_: crew, squad, unit, group.

**Project**:
A unit of continuous work owned by a Team. Each shift a Project runs is staffed
by a fixed crew composition expressed as Role counts (e.g. 1 developer + 1
product manager) so the work advances as many hours per day as possible. An
employee may belong to several Projects and is eligible to fill any of their
(Project, Role) slots.
_Avoid_: task, assignment, workstream.

**Employee**:
A person who may be assigned to shifts. Belongs to one Team and holds one or more
Roles. Workers also belong to one or more Projects within their Team; a Shift
Manager is classified at the Team level rather than per Project. Managers are
Employees.
_Avoid_: worker (when the umbrella is meant), staff, resource.

**Role**:
A skill an employee is qualified to perform (e.g. developer, QA, product
manager). A word like "manager" may appear in a Role name as description only and
implies no hierarchy. Worker demand is matched on the pair (Project, Role): the
eligible pool is employees who belong to that Project and hold that Role. Every
deployment defines its own Roles — none are built in.
_Avoid_: capability, skill, qualification, position.

**Shift Manager**:
The supervisory position in charge of an entire shift for a Team — a genuine
hierarchical role, distinct from any Role whose name merely contains "manager"
(e.g. product manager). Staffed one per Team per shift, never per Project. A Shift
Manager is also an Employee.
_Avoid_: supervisor, team lead, manager (unqualified).

**Scheduler**:
The user who runs schedule generation, reviews results, makes Overrides, and
accepts the Schedule. Holds authority over a set of Teams — covering both a
central planner managing many Teams and a Shift Manager scheduling only their
own. A role, not necessarily a distinct person.
_Avoid_: planner, admin, operator.

**Unavailability**:
A hard fact that an employee cannot be assigned to a Shift (approved time off,
sick leave, an external commitment). Granular per Shift; employees are available
by default. In v1 it is entered by the Scheduler and is simply true once
entered — there is no pending/approval state.
_Avoid_: absence, leave, block.

**Preference**:
A soft statement that an employee would rather (or rather not) work certain
Shifts. Violating a Preference is a Compromise the optimizer may accept
automatically and report — never a hard block.
_Avoid_: wish, request, constraint.

### Shifts

**Shift Type**:
A reusable, date-independent template for a shift: a name plus an explicit
classification (e.g. whether it is a night shift). Its concrete start/end clock
hours are bound per Site, so the same Shift Type can run different hours at
different Sites. Examples: Morning, Evening, Night, Cross.
_Avoid_: shift name, shift category.

**Shift**:
A Shift Type occurring on a specific calendar date, for a specific Team, at a
specific Site — the concrete thing that carries staffing demand and that
employees are assigned to. For counting (demand, one-per-day), a Shift belongs to
the date on which it *starts*; rest rules instead use the actual end→next-start
gap in clock time.
_Avoid_: shift slot, occurrence.

**Cross (shift)**:
A Shift Type for a long shift that spans/crosses two normal shift windows
(Hebrew: משמרת חוצה) — e.g. a mid-day shift overlapping parts of both Morning
and Evening.

**Night Shift**:
A Shift whose Shift Type is explicitly classified as night. The classification is
set by the scheduler, never inferred from the shift's name or hours, because the
rest/recovery rules key off the classification.
_Avoid_: late shift, graveyard.

**Weekend**:
A configurable set of days treated as the weekly rest block, defaulting to Friday
+ Saturday, global across Sites. The days are independently assignable — an
employee may work only Friday or only Saturday.
_Avoid_: rest days, off days.

**Weekend Shift**:
A Shift that *starts* on a Weekend day. An employee "worked the weekend" if they
worked *any* Weekend Shift that week (not necessarily the whole weekend).
_Avoid_: weekend duty.

**Rest Gap**:
The elapsed clock time between an employee's shift end and their next shift start
(spanning the week boundary via Carry-over). Two configurable minimums govern it:
a legal turnaround minimum between any two shifts, and a longer night-recovery
minimum after a Night Shift (default ~24h / a full day off).
_Avoid_: break, downtime, cooldown.

**Burden Shift**:
A Shift considered unpopular and therefore subject to Fairness — by default any
Night Shift or Weekend Shift, with the set configurable per deployment.
_Avoid_: unpopular shift, bad shift.

**Fairness**:
A soft optimization objective that spreads Burden Shifts evenly, measured
cumulatively across weeks (via Carry-over), among employees within the same Team
who are eligible for that shift. Never a hard constraint — Fairness influences
*who* gets a burden, never *whether* it is covered.
_Avoid_: equity, balance, rotation.

### Demand & Scheduling

**Demand**:
The staffing required for the Shifts in a week, in two parts: exactly one Shift
Manager per Team per shift the Team runs, and — per Project running that shift — a
count per Role (the crew composition, e.g. 1 developer + 1 product manager).
Demand is **exact**: both understaffing and overstaffing are Compromises, weighted
equally. Crew composition can vary by day and by shift, reflecting how advanced a
Project is, so Demand is defined per concrete Shift rather than as a fixed weekly
template.
_Avoid_: requirement, headcount, quota.

**Assignment**:
A single employee placed in a single seat — one (Shift, Project, Role) for a
worker, or (Shift, Team) for a Shift Manager. An employee fills at most one seat
at any one time, and that seat counts toward exactly one demand. Multi-Project
membership only widens the pool eligible for a seat; it never lets one person
satisfy two seats in the same time slot (a hard impossibility — neither seat
counts as filled).
_Avoid_: placement, booking.

**Carry-over**:
State from prior weeks that feeds the current week's solve. Two kinds: recent
facts that drive rules (who worked last weekend, who worked a Night Shift on the
last day) and rolling cumulative counts that drive Fairness (how many Burden
Shifts each employee has recently worked). The system is not stateless per week;
each solve takes prior weeks as input.
_Avoid_: history, state, continuity.

**Schedule**:
A complete set of employee-to-shift assignments for one week. Always fully
produced — the system never refuses to return one, even when rules are broken.
The system is the system of record: the accepted Schedule (including any
Overrides) is what feeds the next week's Carry-over.
_Avoid_: roster, plan, timetable.

**Override**:
A manual change the scheduler makes to a generated Schedule. Overrides are
first-class and recorded, never silent. Any Override re-validates the *whole*
Schedule and re-raises all Compromises and Infeasibilities it affects anywhere —
so a single swap may surface several flags at once (e.g. a replacement landing on
both a 2nd consecutive weekend and a 6-day week). The scheduler can outrank the
optimizer, but never silently.
_Avoid_: manual edit, adjustment, tweak.

**Compromise**:
A soft-rule violation the system knowingly accepted in a produced Schedule and
surfaced to the scheduler, instead of failing to produce a Schedule. The system
optimizes to minimize Compromises; it never hides them.
_Avoid_: error, warning, conflict.

**Infeasibility**:
A hard-core violation — something illegal or physically impossible (one person in
two places at once; the legal minimum of one day off per calendar week). Unlike a
Compromise, a hard constraint is never knowingly broken; the affected slice is
left unfilled instead.
_Avoid_: failure, exception.

**Exceptional Assignment**:
An assignment reaching outside an employee's normal eligibility — covering a Role
they don't hold (substitution by Role), a Project they don't belong to, a Team
they don't belong to (cross-team fill-in), or a Site their Team isn't at (a split
Team). All are rare. The optimizer never places these automatically; it surfaces
them as suggestions for the scheduler to approve when demand cannot otherwise be
met. Contrast with multi-Project membership within one's own Team (common,
automatic) and Preference violations (automatic, reported as Compromises).
_Avoid_: override, manual assignment, substitution.
```

## ADR-0002 — continuous across weeks (current)

```markdown
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
```

## backend/app/config.py (current)

```python
"""Tunable scheduling parameters and soft-constraint weights.

These are the "configurable with sane defaults" knobs from CONTEXT.md. The soft
weights encode a *rough* severity ordering only — the authoritative ordering is
still an open product decision (see docs/adr/0001). They are deliberately spread
far apart so the solver's trade-offs are legible.
"""

# --- Time / rest model -------------------------------------------------------
# A Shift is counted on the calendar day it STARTS; rest is measured in real
# clock minutes between one shift's end and the next shift's start.
LEGAL_REST_MINUTES = 8 * 60      # hard: legal turnaround between any two shifts
NIGHT_REST_MINUTES = 24 * 60     # soft-strong: recovery after a Night Shift

# Weekend = the weekly rest block. Python weekday(): Mon=0 .. Sun=6.
WEEKEND_WEEKDAYS = frozenset({4, 5})   # Friday, Saturday

DAYS_IN_WEEK = 7

# --- Soft-constraint weights (severity ordering, provisional) ----------------
W_UNDERSTAFF = 100        # R4  exact demand: an unfilled seat
W_OVERSTAFF = 100         # R4  exact demand: a surplus assignment (equal weight)
W_ONE_SHIFT_PER_DAY = 80  # R5  at most one shift per calendar day
W_NIGHT_RECOVERY = 70     # R6  rest after a night shift
W_CONSECUTIVE_WEEKEND = 60  # R7  two weekends in a row
W_EXCEPTIONAL = 50        # Exceptional Assignment (eligibility-exceeding override)
W_SIXTH_DAY = 20          # R8  working a 6th day (only one day off)
W_PREFERENCE = 10         # R10 working an avoided shift
W_FAIRNESS = 5            # R9  burden-shift imbalance (per squared unit)

# --- Resource limits (DoS / accidental blow-up guards) -----------------------
# Generous bounds for a real org; they only reject pathological inputs. The
# client controls solve time and problem size, so these cap both.
MAX_SOLVE_SECONDS = 60        # per /api/solve call
MAX_SEATS = 20_000            # materialised planning entities per problem
MAX_EMPLOYEES = 5_000         # problem facts per problem
MAX_REQUEST_BYTES = 5_000_000  # request body ceiling (~5 MB)
# Cap on client-supplied rolling burden. R9 squares (carryover_burden + this week),
# so an unbounded client value could overflow the (32-bit) soft score or swamp the
# other soft rules. Coverage (R4) is on a higher score level, so this is purely an
# overflow / soft-domination guard, not what protects coverage. A real deployment
# should decay/window the rolling count rather than sum forever.
MAX_CARRYOVER_BURDEN = 1_000

# Browser origins allowed to call the API. Dev and prod are both effectively
# same-origin (Vite proxies /api in dev; FastAPI serves the SPA in prod), so
# only the local dev server's direct origins need listing.
ALLOWED_ORIGINS = [
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:8000", "http://127.0.0.1:8000",
]
```

## backend/app/domain.py (current)

```python
"""Timefold planning domain for weekly shift scheduling.

Maps directly onto CONTEXT.md:

  * Problem facts (immutable): Site, Role, Team, Project, Employee, ShiftType, Shift
  * Planning entity:            Seat  -- one required position in one Shift
  * Planning variable:          Seat.employee (nullable -> best-effort under-staffing)
  * Per-seat value range:       Seat.eligible -- only employees eligible for the seat,
                                so the solver NEVER auto-creates an Exceptional Assignment.
  * Planning solution:          Schedule
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Optional

from timefold.solver.domain import (PlanningEntityCollectionProperty, PlanningId,
                                     PlanningScore, PlanningVariable,
                                     ProblemFactCollectionProperty, ValueRangeProvider,
                                     planning_entity, planning_solution)
from timefold.solver.score import HardMediumSoftScore

from .config import WEEKEND_WEEKDAYS


# --- Problem facts -----------------------------------------------------------

@dataclass(frozen=True)
class Site:
    id: str
    name: str


@dataclass(frozen=True)
class Role:
    id: str
    name: str


@dataclass(frozen=True)
class Team:
    id: str
    name: str
    site_id: str


@dataclass(frozen=True)
class Project:
    id: str
    name: str
    team_id: str


@dataclass(frozen=True)
class ShiftType:
    id: str
    name: str
    is_night: bool
    start_hour: int   # 0..23
    end_hour: int     # 0..23 ; if <= start_hour the shift crosses midnight


@dataclass(frozen=True)
class Employee:
    """A person who may be assigned to shifts.

    The trailing fields are Carry-over (see ADR-0002): facts and cumulative
    counts from prior weeks that feed this week's solve.
    """
    id: str
    name: str
    team_id: str
    role_ids: frozenset[str]
    project_ids: frozenset[str]
    can_manage: bool = False                     # eligible to be this team's Shift Manager
    avoid_shift_ids: frozenset[str] = frozenset()  # negative Preferences (R10)
    # --- Carry-over ---
    carryover_burden: int = 0                    # burden shifts in recent weeks (R9 fairness)
    worked_last_weekend: bool = False            # R7 consecutive-weekend protection
    prev_shift_end: Optional[datetime] = None    # last shift end in prior week (R3/R6 across boundary)
    prev_shift_was_night: bool = False           # whether that last shift was a Night Shift


@dataclass(frozen=True)
class Shift:
    """A Shift Type occurring on a concrete date for one Team at one Site.

    Computed time fields are stored so constraints stay free of config lookups.
    """
    id: str
    shift_type: ShiftType
    team_id: str
    site_id: str
    start_dt: datetime
    end_dt: datetime

    @property
    def is_night(self) -> bool:
        return self.shift_type.is_night

    @property
    def start_date(self):
        return self.start_dt.date()

    @property
    def is_weekend(self) -> bool:
        # "worked the weekend" keys off the day the shift STARTS.
        return self.start_dt.weekday() in WEEKEND_WEEKDAYS


# --- Planning entity ---------------------------------------------------------

@planning_entity
@dataclass
class Seat:
    """One required position to fill: a worker seat (Shift x Project x Role) or a
    manager seat (Shift x Team). `eligible` is this seat's value range."""
    id: Annotated[str, PlanningId]
    kind: str                       # 'worker' | 'manager'
    shift: Shift
    team_id: str
    project_id: Optional[str]       # worker seats only
    role_id: Optional[str]          # worker seats only
    eligible: Annotated[list[Employee], ValueRangeProvider] = field(default_factory=list)
    employee: Annotated[Optional[Employee],
                        PlanningVariable(allows_unassigned=True)] = field(default=None)

    @property
    def is_burden(self) -> bool:
        # By default any Night Shift or Weekend Shift is a Burden Shift (R9).
        return self.shift.is_night or self.shift.is_weekend

    def is_eligible(self, emp: Employee) -> bool:
        return emp in self.eligible


# --- Planning solution -------------------------------------------------------

@planning_solution
@dataclass
class Schedule:
    employees: Annotated[list[Employee], ProblemFactCollectionProperty]
    shifts: Annotated[list[Shift], ProblemFactCollectionProperty]
    seats: Annotated[list[Seat], PlanningEntityCollectionProperty]
    score: Annotated[Optional[HardMediumSoftScore], PlanningScore] = field(default=None)
```

## backend/app/constraints.py (current)

```python
"""Constraint provider: the hard core + soft rules from CONTEXT.md.

`for_each(Seat)` yields only ASSIGNED seats (the planning variable is nullable),
so `s.employee` is never None inside these streams. Unassigned seats are reached
only via `for_each_including_unassigned` (used for under-staffing).
"""
from __future__ import annotations

from datetime import datetime

from timefold.solver.score import (ConstraintCollectors, ConstraintFactory, Constraint,
                                    HardMediumSoftScore, Joiners, constraint_provider)

from .config import (DAYS_IN_WEEK, LEGAL_REST_MINUTES, NIGHT_REST_MINUTES,
                     W_CONSECUTIVE_WEEKEND, W_EXCEPTIONAL, W_FAIRNESS,
                     W_NIGHT_RECOVERY, W_ONE_SHIFT_PER_DAY, W_PREFERENCE,
                     W_SIXTH_DAY, W_UNDERSTAFF)
from .domain import Seat, Shift


# --- Constraint names + metadata (used by the solver service for reporting) ---
# Two orthogonal axes:
#   kind  -- domain taxonomy: 'hard' -> Infeasibility, 'soft' -> Compromise.
#   level -- score level the penalty lands on: 'hard' | 'medium' | 'soft'.
# They usually coincide, but R4 (understaffing) is a *Compromise* (kind 'soft')
# scored on the MEDIUM level so demand coverage strictly outranks every soft rule
# (CONTEXT.md: fairness influences who fills a burden, never whether it is filled).
CONSTRAINTS: dict[str, dict] = {
    "R1 one assignment per moment": {"kind": "hard", "level": "hard", "rule": "R1"},
    "R2 at least one day off per week": {"kind": "hard", "level": "hard", "rule": "R2"},
    "R3 legal turnaround rest": {"kind": "hard", "level": "hard", "rule": "R3"},
    "R3 legal turnaround rest (carry-over)": {"kind": "hard", "level": "hard", "rule": "R3"},
    "R4 exact demand (understaffing)": {"kind": "soft", "level": "medium", "rule": "R4"},
    "R5 at most one shift per day": {"kind": "soft", "level": "soft", "rule": "R5"},
    "R6 night recovery": {"kind": "soft", "level": "soft", "rule": "R6"},
    "R6 night recovery (carry-over)": {"kind": "soft", "level": "soft", "rule": "R6"},
    "R7 no consecutive weekends": {"kind": "soft", "level": "soft", "rule": "R7"},
    "R8 preferred second day off": {"kind": "soft", "level": "soft", "rule": "R8"},
    "R9 fairness (burden balance)": {"kind": "soft", "level": "soft", "rule": "R9"},
    "R10 respect preferences": {"kind": "soft", "level": "soft", "rule": "R10"},
    "Exceptional Assignment (needs sign-off)": {"kind": "soft", "level": "soft", "rule": "EXC"},
}


# --- helpers -----------------------------------------------------------------

def _overlap(a: Shift, b: Shift) -> bool:
    return a.start_dt < b.end_dt and b.start_dt < a.end_dt


def _gap_minutes(end: datetime, start: datetime) -> float:
    return (start - end).total_seconds() / 60.0


def _ordered(a: Seat, b: Seat) -> tuple[Seat, Seat]:
    return (a, b) if a.shift.start_dt <= b.shift.start_dt else (b, a)


def _pair_gap_minutes(a: Seat, b: Seat) -> float:
    first, second = _ordered(a, b)
    return _gap_minutes(first.shift.end_dt, second.shift.start_dt)


# --- constraints -------------------------------------------------------------

def one_assignment_per_moment(cf: ConstraintFactory) -> Constraint:
    # R1 (hard): an employee fills at most one seat at any one time. Two seats
    # with the same employee whose shifts overlap is physically impossible.
    return (cf.for_each_unique_pair(Seat, Joiners.equal(lambda s: s.employee))
            .filter(lambda a, b: _overlap(a.shift, b.shift))
            .penalize(HardMediumSoftScore.ONE_HARD)
            .as_constraint("R1 one assignment per moment"))


def at_least_one_day_off(cf: ConstraintFactory) -> Constraint:
    # R2 (hard): legal floor of >= 1 day off per calendar week.
    return (cf.for_each(Seat)
            .group_by(lambda s: s.employee,
                      ConstraintCollectors.count_distinct(lambda s: s.shift.start_date))
            .filter(lambda emp, days: days >= DAYS_IN_WEEK)
            .penalize(HardMediumSoftScore.ONE_HARD)
            .as_constraint("R2 at least one day off per week"))


def legal_turnaround_rest(cf: ConstraintFactory) -> Constraint:
    # R3 (hard): minimum legal rest between any two shifts.
    return (cf.for_each_unique_pair(Seat, Joiners.equal(lambda s: s.employee))
            .filter(lambda a, b: not _overlap(a.shift, b.shift)
                    and 0 <= _pair_gap_minutes(a, b) < LEGAL_REST_MINUTES)
            .penalize(HardMediumSoftScore.ONE_HARD)
            .as_constraint("R3 legal turnaround rest"))


def legal_turnaround_rest_carryover(cf: ConstraintFactory) -> Constraint:
    # R3 (hard) across the week boundary, via Carry-over (ADR-0002). A negative gap
    # means last week's shift overlaps this one -- a cross-boundary double-booking
    # that R1 cannot catch (last week's shift isn't a Seat in this Schedule). It is
    # still a hard violation, so there is no lower bound on the gap. Paired per
    # current-week Seat, matching the within-week pairwise R3.
    return (cf.for_each(Seat)
            .filter(lambda s: s.employee.prev_shift_end is not None
                    and _gap_minutes(s.employee.prev_shift_end, s.shift.start_dt)
                    < LEGAL_REST_MINUTES)
            .penalize(HardMediumSoftScore.ONE_HARD)
            .as_constraint("R3 legal turnaround rest (carry-over)"))


def understaffing(cf: ConstraintFactory) -> Constraint:
    # R4 (MEDIUM): exact demand. A seat left unfilled is an under-staffing Compromise.
    # Coverage sits on the MEDIUM score level — above every soft rule — so Fairness
    # (R9) and the other softs can decide *who* fills a burden but never make leaving
    # a coverable seat empty look cheaper than filling it (CONTEXT.md: fairness
    # influences who, never whether). (Over-staffing cannot occur: demand is exactly
    # one seat each.)
    return (cf.for_each_including_unassigned(Seat)
            .filter(lambda s: s.employee is None)
            .penalize(HardMediumSoftScore.of_medium(W_UNDERSTAFF))
            .as_constraint("R4 exact demand (understaffing)"))


def at_most_one_shift_per_day(cf: ConstraintFactory) -> Constraint:
    # R5 (soft-strong): at most one shift per calendar (start) day.
    return (cf.for_each(Seat)
            .group_by(lambda s: (s.employee, s.shift.start_date), ConstraintCollectors.count())
            .filter(lambda key, c: c > 1)
            .penalize(HardMediumSoftScore.ONE_SOFT, lambda key, c: W_ONE_SHIFT_PER_DAY * (c - 1))
            .as_constraint("R5 at most one shift per day"))


def night_recovery(cf: ConstraintFactory) -> Constraint:
    # R6 (soft-strong): a long recovery gap after a Night Shift.
    def violation(a: Seat, b: Seat) -> bool:
        if _overlap(a.shift, b.shift):
            return False
        first, second = _ordered(a, b)
        return first.shift.is_night and _pair_gap_minutes(a, b) < NIGHT_REST_MINUTES
    return (cf.for_each_unique_pair(Seat, Joiners.equal(lambda s: s.employee))
            .filter(violation)
            .penalize(HardMediumSoftScore.of_soft(W_NIGHT_RECOVERY))
            .as_constraint("R6 night recovery"))


def night_recovery_carryover(cf: ConstraintFactory) -> Constraint:
    # R6 (soft-strong) across the week boundary, via Carry-over. As with R3, a
    # negative gap (overlap with last week's night) is still a violation, so there
    # is no lower bound.
    return (cf.for_each(Seat)
            .filter(lambda s: s.employee.prev_shift_was_night
                    and s.employee.prev_shift_end is not None
                    and _gap_minutes(s.employee.prev_shift_end, s.shift.start_dt)
                    < NIGHT_REST_MINUTES)
            .penalize(HardMediumSoftScore.of_soft(W_NIGHT_RECOVERY))
            .as_constraint("R6 night recovery (carry-over)"))


def no_consecutive_weekends(cf: ConstraintFactory) -> Constraint:
    # R7 (soft-strong): don't work two weekends in a row (uses Carry-over).
    return (cf.for_each(Seat)
            .filter(lambda s: s.shift.is_weekend and s.employee.worked_last_weekend)
            .group_by(lambda s: s.employee)
            .penalize(HardMediumSoftScore.of_soft(W_CONSECUTIVE_WEEKEND))
            .as_constraint("R7 no consecutive weekends"))


def preferred_second_day_off(cf: ConstraintFactory) -> Constraint:
    # R8 (soft-mild): people prefer a 2nd day off; working 6 days violates it.
    return (cf.for_each(Seat)
            .group_by(lambda s: s.employee,
                      ConstraintCollectors.count_distinct(lambda s: s.shift.start_date))
            .filter(lambda emp, days: days == DAYS_IN_WEEK - 1)
            .penalize(HardMediumSoftScore.of_soft(W_SIXTH_DAY))
            .as_constraint("R8 preferred second day off"))


def fairness_burden(cf: ConstraintFactory) -> Constraint:
    # R9 (soft objective): spread Burden Shifts (night/weekend) evenly, measured
    # cumulatively across weeks via carry-over. Penalising the marginal squared
    # load makes piling burdens on an already-loaded person progressively costly.
    return (cf.for_each(Seat)
            .filter(lambda s: s.is_burden)
            .group_by(lambda s: s.employee, ConstraintCollectors.count())
            .penalize(HardMediumSoftScore.ONE_SOFT,
                      lambda emp, c: W_FAIRNESS
                      * ((c + emp.carryover_burden) ** 2 - emp.carryover_burden ** 2))
            .as_constraint("R9 fairness (burden balance)"))


def respect_preferences(cf: ConstraintFactory) -> Constraint:
    # R10 (soft-mild): avoid shifts the employee asked not to work.
    return (cf.for_each(Seat)
            .filter(lambda s: s.shift.id in s.employee.avoid_shift_ids)
            .penalize(HardMediumSoftScore.of_soft(W_PREFERENCE))
            .as_constraint("R10 respect preferences"))


def exceptional_assignment(cf: ConstraintFactory) -> Constraint:
    # Eligibility-exceeding assignment. The solver can never create one (value
    # range = eligible only); it appears only via a manual Override and is
    # surfaced as a Compromise that needs sign-off.
    return (cf.for_each(Seat)
            .filter(lambda s: not s.is_eligible(s.employee))
            .penalize(HardMediumSoftScore.of_soft(W_EXCEPTIONAL))
            .as_constraint("Exceptional Assignment (needs sign-off)"))


@constraint_provider
def define_constraints(cf: ConstraintFactory) -> list[Constraint]:
    return [
        one_assignment_per_moment(cf),
        at_least_one_day_off(cf),
        legal_turnaround_rest(cf),
        legal_turnaround_rest_carryover(cf),
        understaffing(cf),
        at_most_one_shift_per_day(cf),
        night_recovery(cf),
        night_recovery_carryover(cf),
        no_consecutive_weekends(cf),
        preferred_second_day_off(cf),
        fairness_burden(cf),
        respect_preferences(cf),
        exceptional_assignment(cf),
    ]
```

## backend/app/analysis.py (current)

```python
"""Human-readable flag derivation (Compromises + Infeasibilities).

Mirrors `constraints.py` exactly, but produces rich messages naming the
employees and shifts involved -- this is the list shown in the UI's flags panel
and asserted by tests. Tests also cross-check the count of HARD flags here
against Timefold's authoritative hard score, so the two cannot silently drift.
"""
from __future__ import annotations

from datetime import datetime
from itertools import combinations

from .config import (DAYS_IN_WEEK, LEGAL_REST_MINUTES, NIGHT_REST_MINUTES,
                     W_CONSECUTIVE_WEEKEND, W_EXCEPTIONAL, W_FAIRNESS,
                     W_NIGHT_RECOVERY, W_ONE_SHIFT_PER_DAY, W_PREFERENCE,
                     W_SIXTH_DAY, W_UNDERSTAFF)
from .domain import Schedule, Seat, Shift

HARD_WEIGHT = 10_000  # for sorting only; hard always sorts above soft


def _overlap(a: Shift, b: Shift) -> bool:
    return a.start_dt < b.end_dt and b.start_dt < a.end_dt


def _gap_minutes(end: datetime, start: datetime) -> float:
    return (start - end).total_seconds() / 60.0


def _ordered(a: Seat, b: Seat) -> tuple[Seat, Seat]:
    return (a, b) if a.shift.start_dt <= b.shift.start_dt else (b, a)


def _hours(minutes: float) -> str:
    return f"{minutes / 60:.1f}h"


def shift_label(shift: Shift) -> str:
    d = shift.start_dt
    return f"{shift.shift_type.name} · {d:%a %d %b}"


def seat_label(seat: Seat, schedule_lookup: dict) -> str:
    if seat.kind == "manager":
        team = schedule_lookup["teams"].get(seat.team_id, seat.team_id)
        return f"Shift Manager · {team}"
    project = schedule_lookup["projects"].get(seat.project_id, seat.project_id)
    role = schedule_lookup["roles"].get(seat.role_id, seat.role_id)
    return f"{role} · {project}"


def _flag(rule, kind, weight, title, detail, *, employee=None, shift=None, seats=()):
    key = "|".join([rule, str(employee), str(shift), *sorted(s.id for s in seats)])
    return {
        "id": key,
        "rule": rule,
        "kind": kind,                       # 'hard' (Infeasibility) | 'soft' (Compromise)
        "weight": HARD_WEIGHT if kind == "hard" else weight,
        "title": title,
        "detail": detail,
        "employee_id": employee,
        "shift_id": shift,
        "seat_ids": [s.id for s in seats],
    }


def derive_flags(schedule: Schedule, lookup: dict | None = None) -> list[dict]:
    lookup = lookup or _build_lookup(schedule)
    emp_name = lambda e: lookup["employees"].get(e.id, e.id) if e else "?"
    flags: list[dict] = []
    assigned = [s for s in schedule.seats if s.employee is not None]

    # group seats by employee
    by_emp: dict[str, list[Seat]] = {}
    for s in assigned:
        by_emp.setdefault(s.employee.id, []).append(s)

    # R1 one assignment per moment (hard)
    for a, b in combinations(assigned, 2):
        if a.employee.id == b.employee.id and _overlap(a.shift, b.shift):
            flags.append(_flag(
                "R1", "hard", 0,
                f"{emp_name(a.employee)} double-booked",
                f"Assigned to two overlapping shifts: "
                f"{shift_label(a.shift)} and {shift_label(b.shift)}. Neither seat counts as filled.",
                employee=a.employee.id, seats=(a, b)))

    # per-employee day stats
    for emp_id, seats in by_emp.items():
        emp = seats[0].employee
        days = {s.shift.start_date for s in seats}
        # R2 >= 1 day off per week (hard)
        if len(days) >= DAYS_IN_WEEK:
            flags.append(_flag(
                "R2", "hard", 0,
                f"{emp_name(emp)} has no day off",
                f"Working all {len(days)} days this week — the legal floor of one day off is broken.",
                employee=emp_id))
        # R8 preferred second day off (soft-mild)
        elif len(days) == DAYS_IN_WEEK - 1:
            flags.append(_flag(
                "R8", "soft", W_SIXTH_DAY,
                f"{emp_name(emp)} works 6 days",
                f"Only one day off this week; the preferred second day off is not met.",
                employee=emp_id))
        # R5 at most one shift per day (soft-strong)
        per_day: dict = {}
        for s in seats:
            per_day.setdefault(s.shift.start_date, []).append(s)
        for d, day_seats in per_day.items():
            if len(day_seats) > 1:
                flags.append(_flag(
                    "R5", "soft", W_ONE_SHIFT_PER_DAY,
                    f"{emp_name(emp)} has {len(day_seats)} shifts on {d:%a %d %b}",
                    "More than one shift on the same calendar day.",
                    employee=emp_id, seats=tuple(day_seats)))

    # R3 / R6 pairwise rest (within week)
    for emp_id, seats in by_emp.items():
        emp = seats[0].employee
        for a, b in combinations(seats, 2):
            if _overlap(a.shift, b.shift):
                continue
            first, second = _ordered(a, b)
            gap = _gap_minutes(first.shift.end_dt, second.shift.start_dt)
            if gap < 0:
                continue
            if gap < LEGAL_REST_MINUTES:
                flags.append(_flag(
                    "R3", "hard", 0,
                    f"{emp_name(emp)} has too little rest",
                    f"Only {_hours(gap)} between {shift_label(first.shift)} and "
                    f"{shift_label(second.shift)} (legal minimum {_hours(LEGAL_REST_MINUTES)}).",
                    employee=emp_id, seats=(first, second)))
            if first.shift.is_night and gap < NIGHT_REST_MINUTES:
                flags.append(_flag(
                    "R6", "soft", W_NIGHT_RECOVERY,
                    f"{emp_name(emp)} short night recovery",
                    f"Only {_hours(gap)} after night shift {shift_label(first.shift)} "
                    f"(recommended {_hours(NIGHT_REST_MINUTES)}).",
                    employee=emp_id, seats=(first, second)))

    # R3 / R6 carry-over across the week boundary. Mirrors constraints.py exactly:
    # last week's shift is paired with EACH current-week seat (per-seat, like the
    # within-week pairwise R3), and a negative gap is a hard cross-boundary overlap
    # that R1 cannot see — so there is no lower bound on the gap.
    for emp_id, seats in by_emp.items():
        emp = seats[0].employee
        if emp.prev_shift_end is None:
            continue
        for s in seats:
            gap = _gap_minutes(emp.prev_shift_end, s.shift.start_dt)
            if gap < LEGAL_REST_MINUTES:
                detail = (f"Overlaps last week's shift — no rest before "
                          f"{shift_label(s.shift)}." if gap < 0 else
                          f"Only {_hours(gap)} between last week's shift and "
                          f"{shift_label(s.shift)} (legal minimum {_hours(LEGAL_REST_MINUTES)}).")
                flags.append(_flag(
                    "R3", "hard", 0,
                    f"{emp_name(emp)} too little rest from last week",
                    detail, employee=emp_id, seats=(s,)))
            if emp.prev_shift_was_night and gap < NIGHT_REST_MINUTES:
                detail = (f"Overlaps last week's night shift — no recovery before "
                          f"{shift_label(s.shift)}." if gap < 0 else
                          f"Only {_hours(gap)} after last week's night shift before "
                          f"{shift_label(s.shift)} (recommended {_hours(NIGHT_REST_MINUTES)}).")
                flags.append(_flag(
                    "R6", "soft", W_NIGHT_RECOVERY,
                    f"{emp_name(emp)} short night recovery from last week",
                    detail, employee=emp_id, seats=(s,)))

    # R7 no consecutive weekends (soft-strong)
    for emp_id, seats in by_emp.items():
        emp = seats[0].employee
        wk = [s for s in seats if s.shift.is_weekend]
        if wk and emp.worked_last_weekend:
            flags.append(_flag(
                "R7", "soft", W_CONSECUTIVE_WEEKEND,
                f"{emp_name(emp)} works a 2nd weekend in a row",
                f"Assigned a weekend shift ({shift_label(wk[0].shift)}) after working last weekend.",
                employee=emp_id, seats=tuple(wk)))

    # R10 respect preferences (soft-mild)
    for s in assigned:
        if s.shift.id in s.employee.avoid_shift_ids:
            flags.append(_flag(
                "R10", "soft", W_PREFERENCE,
                f"{emp_name(s.employee)} works an avoided shift",
                f"{emp_name(s.employee)} preferred not to work {shift_label(s.shift)}.",
                employee=s.employee.id, shift=s.shift.id, seats=(s,)))

    # Exceptional Assignment (soft, override-only)
    for s in assigned:
        if not s.is_eligible(s.employee):
            flags.append(_flag(
                "EXC", "soft", W_EXCEPTIONAL,
                f"{emp_name(s.employee)} — exceptional assignment",
                f"{emp_name(s.employee)} is outside the normal eligibility for "
                f"{seat_label(s, lookup)} and needs sign-off.",
                employee=s.employee.id, shift=s.shift.id, seats=(s,)))

    # R4 exact demand — understaffing (soft)
    for s in schedule.seats:
        if s.employee is None:
            flags.append(_flag(
                "R4", "soft", W_UNDERSTAFF,
                f"Unfilled: {seat_label(s, lookup)}",
                f"No eligible employee available for {seat_label(s, lookup)} on "
                f"{shift_label(s.shift)}.",
                shift=s.shift.id, seats=(s,)))

    # R9 fairness — surface only when the burden spread is notable (soft objective)
    flags.extend(_fairness_flags(schedule, by_emp, lookup))

    flags.sort(key=lambda f: (-f["weight"], f["rule"]))
    return flags


def _fairness_flags(schedule: Schedule, by_emp: dict, lookup: dict) -> list[dict]:
    out: list[dict] = []
    # total burden = carry-over + this week's burden seats, grouped by team
    by_team: dict[str, dict[str, tuple]] = {}
    for emp in schedule.employees:
        this_week = sum(1 for s in by_emp.get(emp.id, []) if s.is_burden)
        total = emp.carryover_burden + this_week
        by_team.setdefault(emp.team_id, {})[emp.id] = (emp, total, this_week)
    for team_id, members in by_team.items():
        totals = [t for (_e, t, _w) in members.values()]
        this_week_total = sum(w for (_e, _t, w) in members.values())
        if not totals or this_week_total == 0:
            # Fairness is only actionable when burdens are actually handed out this
            # week; pure carry-over imbalance with nothing to assign is not a flag.
            continue
        spread = max(totals) - min(totals)
        if spread >= 2:
            team = lookup["teams"].get(team_id, team_id)
            top = max(members.values(), key=lambda v: v[1])
            out.append(_flag(
                "R9", "soft", W_FAIRNESS,
                f"Burden imbalance in {team}",
                f"Burden shifts (night/weekend) are uneven across {team}: "
                f"spread of {spread} between the most- and least-loaded member "
                f"(most loaded: {lookup['employees'].get(top[0].id, top[0].id)}).",
                employee=None))
    return out


def _build_lookup(schedule: Schedule) -> dict:
    return {
        "employees": {e.id: e.name for e in schedule.employees},
        "teams": {},
        "projects": {},
        "roles": {},
    }
```

## backend/app/solver.py (current)

```python
"""Solver factory, solve, and Timefold-authoritative scoring.

The SolverFactory is built once (JVM class generation is expensive). `solve`
runs local search; `analyze` returns Timefold's authoritative score breakdown
without re-solving -- this is what backs Override re-validation (ADR: an Override
re-validates the *whole* Schedule).
"""
from __future__ import annotations

from functools import lru_cache

from timefold.solver import SolutionManager, SolverFactory
from timefold.solver.config import (Duration, ScoreDirectorFactoryConfig, SolverConfig,
                                     TerminationConfig)

from .constraints import CONSTRAINTS, define_constraints
from .domain import Schedule, Seat

DEFAULT_SPENT_SECONDS = 8
DEFAULT_UNIMPROVED_SECONDS = 2


@lru_cache(maxsize=1)
def _solver_factory(spent: int = DEFAULT_SPENT_SECONDS,
                    unimproved: int = DEFAULT_UNIMPROVED_SECONDS) -> SolverFactory:
    config = SolverConfig(
        solution_class=Schedule,
        entity_class_list=[Seat],
        score_director_factory_config=ScoreDirectorFactoryConfig(
            constraint_provider_function=define_constraints),
        termination_config=TerminationConfig(
            spent_limit=Duration(seconds=spent),
            unimproved_spent_limit=Duration(seconds=unimproved)),
    )
    return SolverFactory.create(config)


@lru_cache(maxsize=1)
def _solution_manager() -> SolutionManager:
    return SolutionManager.create(_solver_factory())


def solve(problem: Schedule, spent: int = DEFAULT_SPENT_SECONDS,
          unimproved: int = DEFAULT_UNIMPROVED_SECONDS) -> Schedule:
    """Generate a complete Schedule (best-effort: always returns one)."""
    return _solver_factory(spent, unimproved).build_solver().solve(problem)


def analyze(problem: Schedule):
    """Timefold's authoritative ScoreAnalysis for an (already-assigned) solution.

    Also writes the score back onto `problem.score`, so a hand-edited Schedule
    coming from an Override gets re-scored without a re-solve.
    """
    sm = _solution_manager()
    sm.update(problem)            # recompute and set problem.score
    return sm.analyze(problem)


def score_breakdown(problem: Schedule) -> dict:
    """Per-constraint totals from Timefold, classified hard/soft via CONSTRAINTS."""
    analysis = analyze(problem)
    score = problem.score
    constraints = []
    for ca in analysis.constraint_analyses:
        name = str(ca.constraint_name)
        meta = CONSTRAINTS.get(name, {"kind": "soft", "level": "soft", "rule": "?"})
        constraints.append({
            "name": name,
            "rule": meta["rule"],
            "kind": meta["kind"],
            "level": meta.get("level", meta["kind"]),
            "match_count": int(ca.match_count),
            "score": str(ca.score),
        })
    return {
        "score": str(score),
        "hard_score": score.hard_score,
        "medium_score": score.medium_score,
        "soft_score": score.soft_score,
        "feasible": score.hard_score >= 0,
        "constraints": constraints,
    }
```

## backend/app/requirements.py (current)

```python
"""User-supplied scheduling requirements.

The interactive editor builds one of these documents and posts it to /api/build,
/api/solve and /api/validate. This module parses it (pydantic), validates it
(referential integrity + coverage warnings) and turns it into a domain `Dataset`.

Rule constants (legal/night rest, weekend days) stay global defaults — the editor
configures the org, people, skills, projects, shift types (incl. hours + night
flag) and demand.

Datetime contract: all schedule times are local-naive (data.py builds them with
`datetime.combine`, no tzinfo). `prev_shift_end` is the only datetime the client
sends, so it must be local-naive too — validation rejects timezone-aware values
rather than letting a naive/aware mismatch crash the solve/score path.
"""
from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, Field

from .config import (LEGAL_REST_MINUTES, MAX_CARRYOVER_BURDEN, MAX_EMPLOYEES,
                     MAX_SEATS, NIGHT_REST_MINUTES, WEEKEND_WEEKDAYS)
from .data import Dataset
from .domain import Employee, Project, Role, ShiftType, Site, Team

# Day name <-> Python weekday() (Mon=0 .. Sun=6)
DAY_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
DAY_TO_WEEKDAY = {"Sun": 6, "Mon": 0, "Tue": 1, "Wed": 2, "Thu": 3, "Fri": 4, "Sat": 5}
WEEKDAY_TO_DAY = {v: k for k, v in DAY_TO_WEEKDAY.items()}


# --- input models ------------------------------------------------------------

class SiteIn(BaseModel):
    id: str
    name: str


class RoleIn(BaseModel):
    id: str
    name: str


class ShiftTypeIn(BaseModel):
    id: str
    name: str
    start: int            # 0..23
    end: int              # 0..23 ; end<=start crosses midnight
    is_night: bool = False


class TeamIn(BaseModel):
    id: str
    name: str
    site: str


class ProjectIn(BaseModel):
    id: str
    name: str
    team: str


class EmployeeIn(BaseModel):
    id: str
    name: str
    team: str
    roles: list[str] = Field(default_factory=list)
    projects: list[str] = Field(default_factory=list)
    can_manage: bool = False
    # --- Carry-over (ADR-0002): prior-week state that feeds this week's solve ---
    carryover_burden: int = 0
    worked_last_weekend: bool = False
    prev_shift_end: str | None = None        # local-naive ISO datetime; R3/R6 across the week boundary
    prev_shift_was_night: bool = False       # whether that last shift was a Night Shift
    avoid_shift_ids: list[str] = Field(default_factory=list)  # negative Preferences (R10)


class DemandIn(BaseModel):
    team: str
    shift_type: str
    days: list[str] = Field(default_factory=list)
    crew: dict[str, dict[str, int]] = Field(default_factory=dict)  # project -> role -> count


class CarryoverFields(BaseModel):
    """The four carry-over fields, in one place (ADR-0002). This is the single
    source for the carry-over shape shared by EmployeeIn (input), the seed envelope
    (CarryoverSeedIn / next_week_carryover output) and the frontend types — a
    contract test pins EmployeeIn against it so the four cannot drift apart."""
    carryover_burden: int = 0
    worked_last_weekend: bool = False
    prev_shift_end: str | None = None        # local-naive ISO datetime; R3/R6 across boundary
    prev_shift_was_night: bool = False


CARRYOVER_FIELDS = tuple(CarryoverFields.model_fields)


class CarryoverSeedIn(BaseModel):
    """A prior week's carry-over seed, replayed as this week's input (ADR-0002).
    Self-describing so a client cannot silently splice a wrong-week seed: the server
    checks `target_week_start` matches the requested week before applying it."""
    source_week_start: str | None = None
    target_week_start: str | None = None
    source_feasible: bool = True             # was the source schedule hard-feasible?
    employees: dict[str, CarryoverFields] = Field(default_factory=dict)


class RequirementsIn(BaseModel):
    sites: list[SiteIn] = Field(default_factory=list)
    roles: list[RoleIn] = Field(default_factory=list)
    shift_types: list[ShiftTypeIn] = Field(default_factory=list)
    teams: list[TeamIn] = Field(default_factory=list)
    projects: list[ProjectIn] = Field(default_factory=list)
    employees: list[EmployeeIn] = Field(default_factory=list)
    demand: list[DemandIn] = Field(default_factory=list)
    week_start: str | None = None   # ISO date; defaults to the seed week


# --- validation --------------------------------------------------------------

def _dupes(ids: list[str]) -> list[str]:
    seen, dup = set(), set()
    for i in ids:
        (dup if i in seen else seen).add(i)
    return sorted(dup)


def _parse_datetime(s: str) -> datetime | None:
    """Parse an ISO datetime, or None if it isn't one."""
    try:
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def _naive_datetime(s: str | None) -> datetime | None:
    """Parse a carry-over datetime for the domain, enforcing the local-naive
    contract (see module docstring). Raises on a timezone-aware value so a
    direct `to_dataset` caller fails loudly here instead of crashing deep in the
    solve/score path. HTTP callers get a friendly error from
    `validate_requirements` first; this is the defence for any other ingress."""
    if s is None:
        return None
    dt = datetime.fromisoformat(s)
    if dt.utcoffset() is not None:
        raise ValueError(f"prev_shift_end must be a local (timezone-naive) ISO "
                         f"datetime, got {s!r}")
    return dt


def _bad_date(s: str) -> bool:
    try:
        date.fromisoformat(s)
        return False
    except (ValueError, TypeError):
        return True


def _estimated_seats(req: RequirementsIn) -> int:
    """Upper bound on materialised seats: per demand row, one manager seat plus
    the crew total, for each selected day. Over-counts shifts shared across rows,
    which is fine for a guard."""
    total = 0
    for d in req.demand:
        crew_total = sum(c for roles in d.crew.values() for c in roles.values() if c > 0)
        total += len(d.days) * (1 + crew_total)
    return total


def validate_requirements(req: RequirementsIn) -> tuple[list[str], list[str]]:
    """Return (errors, warnings). Errors block solving; warnings don't."""
    errors: list[str] = []
    warnings: list[str] = []

    site_ids = {s.id for s in req.sites}
    role_ids = {r.id for r in req.roles}
    st_ids = {s.id for s in req.shift_types}
    team_ids = {t.id for t in req.teams}
    project_by_id = {p.id: p for p in req.projects}

    # duplicates
    for label, ids in [
        ("site", [s.id for s in req.sites]), ("role", [r.id for r in req.roles]),
        ("shift type", [s.id for s in req.shift_types]), ("team", [t.id for t in req.teams]),
        ("project", [p.id for p in req.projects]), ("employee", [e.id for e in req.employees]),
    ]:
        for d in _dupes(ids):
            errors.append(f"Duplicate {label} id: {d!r}")

    # emptiness
    if not req.sites:
        errors.append("At least one site is required.")
    if not req.teams:
        errors.append("At least one team is required.")
    if not req.employees:
        warnings.append("No employees defined — every seat will be unfilled.")
    if not req.demand:
        warnings.append("No demand defined — there is nothing to schedule.")

    # shift types
    for st in req.shift_types:
        if not (0 <= st.start <= 23 and 0 <= st.end <= 23):
            errors.append(f"Shift type {st.id!r}: hours must be 0–23.")
        if st.start == st.end:
            errors.append(f"Shift type {st.id!r}: start and end hours must differ.")

    # teams -> sites
    for t in req.teams:
        if t.site not in site_ids:
            errors.append(f"Team {t.id!r} references unknown site {t.site!r}.")

    # projects -> teams
    for p in req.projects:
        if p.team not in team_ids:
            errors.append(f"Project {p.id!r} references unknown team {p.team!r}.")

    # employees
    for e in req.employees:
        if e.team not in team_ids:
            errors.append(f"Employee {e.id!r} references unknown team {e.team!r}.")
        for r in e.roles:
            if r not in role_ids:
                errors.append(f"Employee {e.id!r} has unknown role {r!r}.")
        for pid in e.projects:
            proj = project_by_id.get(pid)
            if proj is None:
                errors.append(f"Employee {e.id!r} on unknown project {pid!r}.")
            elif proj.team != e.team:
                errors.append(f"Employee {e.id!r} is on project {pid!r} which is not in their team.")
        if e.carryover_burden < 0:
            errors.append(f"Employee {e.id!r}: carry-over burden cannot be negative.")
        elif e.carryover_burden > MAX_CARRYOVER_BURDEN:
            errors.append(f"Employee {e.id!r}: carry-over burden {e.carryover_burden} "
                          f"exceeds the limit of {MAX_CARRYOVER_BURDEN}.")
        if e.prev_shift_end is not None:
            dt = _parse_datetime(e.prev_shift_end)
            if dt is None:
                errors.append(f"Employee {e.id!r}: prev_shift_end {e.prev_shift_end!r} "
                              f"is not a valid ISO datetime.")
            elif dt.utcoffset() is not None:
                # Schedule times are local-naive (data.py builds them with
                # datetime.combine, no tz). A timezone-aware carry-over time would
                # later be subtracted from naive shift times and crash the
                # solve/score path, so reject it at the edge.
                errors.append(f"Employee {e.id!r}: prev_shift_end {e.prev_shift_end!r} "
                              f"must be a local (timezone-naive) ISO datetime.")
        if not e.roles and not e.can_manage:
            warnings.append(f"Employee {e.id!r} has no role and cannot manage — unusable.")

    # demand
    for i, d in enumerate(req.demand):
        where = f"Demand #{i + 1}"
        if d.team not in team_ids:
            errors.append(f"{where} references unknown team {d.team!r}.")
        if d.shift_type not in st_ids:
            errors.append(f"{where} references unknown shift type {d.shift_type!r}.")
        if not d.days:
            errors.append(f"{where} has no days selected.")
        for day in d.days:
            if day not in DAY_TO_WEEKDAY:
                errors.append(f"{where} has invalid day {day!r}.")
        for pid, roles in d.crew.items():
            proj = project_by_id.get(pid)
            if proj is None:
                errors.append(f"{where} crew references unknown project {pid!r}.")
            elif proj.team != d.team:
                errors.append(f"{where} crew project {pid!r} is not in team {d.team!r}.")
            for rid, count in roles.items():
                if rid not in role_ids:
                    errors.append(f"{where} crew references unknown role {rid!r}.")
                if count < 1:
                    errors.append(f"{where} crew count for {pid}/{rid} must be ≥ 1.")

    # week start
    if req.week_start is not None and _bad_date(req.week_start):
        errors.append(f"week_start {req.week_start!r} is not a valid ISO date.")

    # problem-size guards (resource exhaustion)
    if len(req.employees) > MAX_EMPLOYEES:
        errors.append(f"Too many employees: {len(req.employees)} exceeds the "
                      f"limit of {MAX_EMPLOYEES}.")
    est_seats = _estimated_seats(req)
    if est_seats > MAX_SEATS:
        errors.append(f"Problem too large: ~{est_seats} seats exceeds the "
                      f"limit of {MAX_SEATS}.")

    # coverage warnings (only if no blocking errors so far for the entity)
    if not errors:
        _coverage_warnings(req, warnings)

    return errors, warnings


def apply_carryover_seed(req: RequirementsIn,
                         seed: CarryoverSeedIn) -> tuple[list[str], list[str]]:
    """Replay a prior week's carry-over seed onto this week's employees (ADR-0002).

    Mutates `req.employees` in place, then normal `validate_requirements` covers the
    merged values (naive-datetime + burden-cap checks). Returns (errors, warnings):
    a blocking error if the seed targets a different week than requested; warnings
    for an infeasible source or unknown employees. Must run BEFORE validation.
    """
    errors: list[str] = []
    warnings: list[str] = []
    effective_week = req.week_start or Dataset.week_start.isoformat()
    # A seed that actually carries data MUST declare a target week that matches the
    # requested one — otherwise a seed with a missing/empty target_week_start could
    # silently splice carry-over into the wrong week. (An empty seed is a no-op and
    # needs no check.)
    if seed.employees:
        if not seed.target_week_start:
            errors.append("Carry-over seed must declare target_week_start "
                          f"(expected {effective_week!r}).")
            return errors, warnings
        if seed.target_week_start != effective_week:
            errors.append(f"Carry-over seed targets week {seed.target_week_start!r}, but the "
                          f"requested week is {effective_week!r}.")
            return errors, warnings
    if not seed.source_feasible:
        warnings.append("Carry-over seed came from an infeasible schedule; its rest / "
                        "fairness carry-over may be unreliable.")
    by_id = {e.id: e for e in req.employees}
    for emp_id, co in seed.employees.items():
        e = by_id.get(emp_id)
        if e is None:
            warnings.append(f"Carry-over seed references unknown employee {emp_id!r}; ignored.")
            continue
        e.carryover_burden = co.carryover_burden
        e.worked_last_weekend = co.worked_last_weekend
        e.prev_shift_end = co.prev_shift_end
        e.prev_shift_was_night = co.prev_shift_was_night
    return errors, warnings


def _coverage_warnings(req: RequirementsIn, warnings: list[str]) -> None:
    teams_with_demand = {d.team for d in req.demand}
    for team in req.teams:
        if team.id not in teams_with_demand:
            continue
        if not any(e.team == team.id and e.can_manage for e in req.employees):
            warnings.append(f"Team {team.id!r} has demand but no shift-manager-eligible "
                            f"employee — manager seats will be unfilled.")
    for d in req.demand:
        for pid, roles in d.crew.items():
            for rid in roles:
                eligible = [e for e in req.employees
                            if pid in e.projects and rid in e.roles]
                if not eligible:
                    warnings.append(f"No employee can fill {rid} on {pid} — those seats "
                                    f"will be unfilled.")


# --- conversion --------------------------------------------------------------

def to_dataset(req: RequirementsIn) -> Dataset:
    sites = [Site(s.id, s.name) for s in req.sites]
    roles = [Role(r.id, r.name) for r in req.roles]
    shift_types = [ShiftType(s.id, s.name, s.is_night, s.start, s.end) for s in req.shift_types]
    teams = [Team(t.id, t.name, t.site) for t in req.teams]
    projects = [Project(p.id, p.name, p.team) for p in req.projects]
    employees = [
        Employee(e.id, e.name, e.team, frozenset(e.roles), frozenset(e.projects),
                 can_manage=e.can_manage,
                 avoid_shift_ids=frozenset(e.avoid_shift_ids),
                 carryover_burden=e.carryover_burden,
                 worked_last_weekend=e.worked_last_weekend,
                 prev_shift_end=_naive_datetime(e.prev_shift_end),
                 prev_shift_was_night=e.prev_shift_was_night)
        for e in req.employees
    ]
    demand = [
        (d.team, d.shift_type, [DAY_TO_WEEKDAY[day] for day in d.days], d.crew)
        for d in req.demand
    ]
    week_start = date.fromisoformat(req.week_start) if req.week_start else Dataset.week_start
    return Dataset(sites, roles, teams, projects, employees, shift_types, demand, week_start)


def dataset_to_requirements(ds: Dataset) -> dict:
    """The seed dataset as an editable requirements doc (GET /api/requirements)."""
    return {
        "sites": [{"id": s.id, "name": s.name} for s in ds.sites],
        "roles": [{"id": r.id, "name": r.name} for r in ds.roles],
        "shift_types": [{"id": s.id, "name": s.name, "start": s.start_hour,
                         "end": s.end_hour, "is_night": s.is_night} for s in ds.shift_types],
        "teams": [{"id": t.id, "name": t.name, "site": t.site_id} for t in ds.teams],
        "projects": [{"id": p.id, "name": p.name, "team": p.team_id} for p in ds.projects],
        "employees": [{
            "id": e.id, "name": e.name, "team": e.team_id,
            "roles": sorted(e.role_ids), "projects": sorted(e.project_ids),
            "can_manage": e.can_manage,
            "avoid_shift_ids": sorted(e.avoid_shift_ids),
            "carryover_burden": e.carryover_burden,
            "worked_last_weekend": e.worked_last_weekend,
            "prev_shift_end": e.prev_shift_end.isoformat() if e.prev_shift_end else None,
            "prev_shift_was_night": e.prev_shift_was_night,
        } for e in ds.employees],
        "demand": [{
            "team": team_id, "shift_type": st_id,
            "days": [WEEKDAY_TO_DAY[w] for w in sorted(weekdays, key=lambda x: DAY_ORDER.index(WEEKDAY_TO_DAY[x]))],
            "crew": crew,
        } for (team_id, st_id, weekdays, crew) in ds.demand],
        "week_start": ds.week_start.isoformat(),
        "config": {
            "legal_rest_hours": LEGAL_REST_MINUTES / 60,
            "night_rest_hours": NIGHT_REST_MINUTES / 60,
            "weekend_days": [WEEKDAY_TO_DAY[w] for w in sorted(WEEKEND_WEEKDAYS)],
        },
    }
```

## backend/app/carryover.py (NEW, current)

```python
"""Next-week Carry-over derivation (ADR-0002).

ADR-0002: schedules are continuous across weeks. The *accepted* Schedule for one
week — including any manual Overrides — is the source of the next week's
Carry-over. The service stays stateless (main.py): it persists nothing and
instead derives the seed here and hands it back, so the client can replay it as
next week's requirements input.

`next_week_carryover(schedule)` turns an assigned Schedule into a
``{employee_id: {carry-over fields}}`` map whose keys and value shapes match
`EmployeeIn`, so each entry can be pasted straight onto next week's employee.
The four fields mirror the carry-over inputs they will feed:

  * carryover_burden     — cumulative burden shifts (R9 fairness), rolled forward
  * worked_last_weekend  — did they work a weekend shift this week? (R7)
  * prev_shift_end        — end of their last shift this week (R3/R6 across boundary)
  * prev_shift_was_night  — was that last shift a Night Shift? (R6)
"""
from __future__ import annotations

from datetime import date, timedelta

from .config import MAX_CARRYOVER_BURDEN
from .domain import Schedule


def next_week_carryover(schedule: Schedule) -> dict[str, dict]:
    """Derive each employee's carry-over for the week *after* this Schedule.

    Overrides are already baked into ``seat.employee`` (re-validation applies them
    before scoring), so this reads the schedule as accepted.
    """
    worked_by_emp: dict[str, list] = {}
    for seat in schedule.seats:
        if seat.employee is not None:
            worked_by_emp.setdefault(seat.employee.id, []).append(seat)

    out: dict[str, dict] = {}
    for emp in schedule.employees:
        worked = worked_by_emp.get(emp.id, [])
        # The latest shift end drives turnaround / night recovery across the boundary.
        # If several shifts tie on that end time (only reachable via an R1-infeasible
        # overlap, which also marks the seed source_feasible=False), report a night
        # conservatively — assume the longer recovery applies — so the seed never
        # under-states the rest the next week owes.
        last_end = max((s.shift.end_dt for s in worked), default=None)
        tied = [s for s in worked if s.shift.end_dt == last_end]
        burden_this_week = sum(1 for s in worked if s.is_burden)
        out[emp.id] = {
            # Rolling cumulative burden: prior weeks + this week (R9). Employees
            # who didn't work still carry their accumulated burden forward. Clamp to
            # the input cap so the seed always re-validates as next week's input.
            "carryover_burden": min(MAX_CARRYOVER_BURDEN,
                                    emp.carryover_burden + burden_this_week),
            # Next week's "last weekend" is this week's weekend (R7).
            "worked_last_weekend": any(s.shift.is_weekend for s in worked),
            # Local-naive ISO, matching the input contract (requirements.py).
            "prev_shift_end": last_end.isoformat() if last_end else None,
            "prev_shift_was_night": any(s.shift.is_night for s in tied),
        }
    return out


def carryover_seed(schedule: Schedule, week_start: date, *, feasible: bool) -> dict:
    """A self-describing seed envelope for the week *after* this Schedule (ADR-0002).

    Carries week identity (`source`/`target_week_start`) so the client cannot
    silently replay a wrong-week seed, and `source_feasible` so a seed derived from
    a hard-infeasible schedule (e.g. a bad Override) is not trusted blindly. The
    server replays it via `requirements.apply_carryover_seed`.
    """
    return {
        "source_week_start": week_start.isoformat(),
        "target_week_start": (week_start + timedelta(days=7)).isoformat(),
        "source_feasible": feasible,
        "employees": next_week_carryover(schedule),
    }


def empty_carryover_seed() -> dict:
    """Shape-stable empty envelope for error responses (no schedule to derive from)."""
    return {"source_week_start": None, "target_week_start": None,
            "source_feasible": False, "employees": {}}
```

## backend/app/serialize.py (current)

```python
"""JSON (de)serialization between the API and the Timefold domain."""
from __future__ import annotations

from .analysis import seat_label, shift_label
from .data import Dataset, build_lookup, build_schedule
from .domain import Schedule, Seat


def dataset_payload(dataset: Dataset, schedule: Schedule) -> dict:
    """Static structure the frontend needs to render the grid (pre-solve)."""
    lookup = build_lookup(dataset)
    return {
        "sites": [{"id": s.id, "name": s.name} for s in dataset.sites],
        "week_start": dataset.week_start.isoformat(),
        "days": [d for d in _week_days(dataset)],
        "roles": [{"id": r.id, "name": r.name} for r in dataset.roles],
        "teams": [{"id": t.id, "name": t.name, "site_id": t.site_id} for t in dataset.teams],
        "projects": [{"id": p.id, "name": p.name, "team_id": p.team_id} for p in dataset.projects],
        "shift_types": [{"id": st.id, "name": st.name, "is_night": st.is_night,
                         "start_hour": st.start_hour, "end_hour": st.end_hour}
                        for st in dataset.shift_types],
        "employees": [{
            "id": e.id, "name": e.name, "team_id": e.team_id,
            "role_ids": sorted(e.role_ids), "project_ids": sorted(e.project_ids),
            "can_manage": e.can_manage,
            "avoid_shift_ids": sorted(e.avoid_shift_ids),
            "carryover_burden": e.carryover_burden,
            "worked_last_weekend": e.worked_last_weekend,
            "prev_shift_end": e.prev_shift_end.isoformat() if e.prev_shift_end else None,
            "prev_shift_was_night": e.prev_shift_was_night,
        } for e in dataset.employees],
        "shifts": [_shift_payload(s) for s in _sorted_shifts(schedule)],
        "seats": [_seat_payload(s, lookup) for s in schedule.seats],
    }


def _week_days(dataset: Dataset) -> list[str]:
    from datetime import timedelta
    return [(dataset.week_start + timedelta(days=i)).isoformat() for i in range(7)]


def _sorted_shifts(schedule: Schedule):
    return sorted(schedule.shifts, key=lambda s: (s.start_dt, s.team_id))


def _shift_payload(s) -> dict:
    return {
        "id": s.id,
        "shift_type_id": s.shift_type.id,
        "shift_type_name": s.shift_type.name,
        "team_id": s.team_id,
        "site_id": s.site_id,
        "date": s.start_date.isoformat(),
        "weekday": s.start_dt.weekday(),
        "start": s.start_dt.isoformat(),
        "end": s.end_dt.isoformat(),
        "is_night": s.is_night,
        "is_weekend": s.is_weekend,
        "label": shift_label(s),
    }


def _seat_payload(seat: Seat, lookup: dict) -> dict:
    return {
        "id": seat.id,
        "kind": seat.kind,
        "shift_id": seat.shift.id,
        "team_id": seat.team_id,
        "project_id": seat.project_id,
        "role_id": seat.role_id,
        "label": seat_label(seat, lookup),
        "eligible_employee_ids": [e.id for e in seat.eligible],
    }


def assignments_of(schedule: Schedule) -> dict[str, str | None]:
    return {s.id: (s.employee.id if s.employee else None) for s in schedule.seats}


def validate_assignments(schedule: Schedule, assignments: dict[str, str | None],
                         employees_by_id: dict) -> list[str]:
    """Errors for an assignments map: every key must be a real seat id and every
    non-null value a real employee id. Catches stale client state instead of
    silently masking an unknown employee as 'unfilled'.

    Snapshot semantics (not patch): the map is the *complete* desired state. The
    service is stateless — each call rebuilds the Schedule with every seat empty and
    then applies the map — so a seat that is absent (or null) is intentionally
    unassigned. There is no prior server state to "leave unchanged", which is why a
    missing seat id is not an error: best-effort scheduling allows unfilled seats."""
    errors: list[str] = []
    seat_ids = {s.id for s in schedule.seats}
    for seat_id, emp_id in assignments.items():
        if seat_id not in seat_ids:
            errors.append(f"Assignment references unknown seat id {seat_id!r}.")
        if emp_id is not None and emp_id not in employees_by_id:
            errors.append(f"Assignment for seat {seat_id!r} references unknown "
                          f"employee id {emp_id!r}.")
    return errors


def apply_assignments(schedule: Schedule, assignments: dict[str, str | None],
                      employees_by_id: dict) -> Schedule:
    """Set each seat's employee from a {seat_id: employee_id|null} map.

    Snapshot, not patch: a seat absent from the map is left unassigned (see
    `validate_assignments`). Send the full desired state every call.

    Employees that are not in a seat's eligible list are still applied (that is an
    Exceptional Assignment from an Override) -- re-validation will flag them.
    """
    for seat in schedule.seats:
        emp_id = assignments.get(seat.id)
        seat.employee = employees_by_id.get(emp_id) if emp_id else None
    return schedule


def fresh_schedule_and_index(dataset: Dataset):
    schedule = build_schedule(dataset)
    employees_by_id = {e.id: e for e in dataset.employees}
    return schedule, employees_by_id
```

## backend/app/main.py (current)

```python
"""FastAPI app — requirements-driven scheduling.

The client (the interactive editor) holds a *requirements* document and posts it
with every call. The server validates it, materialises it into a domain Dataset,
and builds / solves / re-validates — staying stateless so it's deterministic and
"any Override re-validates the whole Schedule" stays literally true.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .analysis import derive_flags
from .carryover import carryover_seed, empty_carryover_seed
from .config import ALLOWED_ORIGINS, MAX_REQUEST_BYTES, MAX_SOLVE_SECONDS
from .data import build_lookup, build_schedule, default_dataset
from .requirements import (CarryoverSeedIn, RequirementsIn, apply_carryover_seed,
                           dataset_to_requirements, to_dataset, validate_requirements)
from .serialize import (apply_assignments, assignments_of, dataset_payload,
                        validate_assignments)
from .solver import score_breakdown, solve


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm up the JVM / Timefold class generation so the first request is fast.
    score_breakdown(build_schedule(default_dataset()))
    yield


app = FastAPI(title="Shift Scheduler", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["*"], allow_headers=["*"],
)


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    """Reject oversized bodies before they are read/parsed."""
    cl = request.headers.get("content-length")
    if cl is not None and cl.isdigit() and int(cl) > MAX_REQUEST_BYTES:
        return JSONResponse(status_code=413, content={"detail": "Request body too large."})
    return await call_next(request)


class BuildRequest(BaseModel):
    requirements: RequirementsIn
    carryover_seed: CarryoverSeedIn | None = None


class SolveRequest(BaseModel):
    requirements: RequirementsIn
    seconds: int | None = None
    carryover_seed: CarryoverSeedIn | None = None


class ValidateRequest(BaseModel):
    requirements: RequirementsIn
    assignments: dict[str, str | None]
    carryover_seed: CarryoverSeedIn | None = None


def _materialize(req: RequirementsIn, seed: CarryoverSeedIn | None = None):
    """(dataset, schedule, lookup) or None if there are blocking errors.

    An optional carry-over seed (ADR-0002) is replayed onto the employees first,
    after a week-identity check, so the merged values pass normal validation.
    """
    seed_warnings: list[str] = []
    if seed is not None:
        seed_errors, seed_warnings = apply_carryover_seed(req, seed)
        if seed_errors:
            return None, seed_errors, seed_warnings
    errors, warnings = validate_requirements(req)
    warnings = seed_warnings + warnings
    if errors:
        return None, errors, warnings
    ds = to_dataset(req)
    return (ds, build_schedule(ds), build_lookup(ds)), errors, warnings


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/requirements")
def get_requirements() -> dict:
    """The seed org as an editable requirements doc — the editor's starting point."""
    return dataset_to_requirements(default_dataset())


@app.post("/api/build")
def post_build(req: BuildRequest) -> dict:
    mat, errors, warnings = _materialize(req.requirements, req.carryover_seed)
    if mat is None:
        return {"errors": errors, "warnings": warnings, "dataset": None}
    ds, schedule, _lookup = mat
    return {"errors": [], "warnings": warnings, "dataset": dataset_payload(ds, schedule)}


@app.post("/api/solve")
def post_solve(req: SolveRequest) -> dict:
    if req.seconds is not None and not (1 <= req.seconds <= MAX_SOLVE_SECONDS):
        return {"errors": [f"seconds must be between 1 and {MAX_SOLVE_SECONDS}."],
                "warnings": [], "dataset": None, "assignments": {}, "score": None,
                "flags": [], "next_carryover": empty_carryover_seed()}
    mat, errors, warnings = _materialize(req.requirements, req.carryover_seed)
    if mat is None:
        return {"errors": errors, "warnings": warnings, "dataset": None, "assignments": {},
                "score": None, "flags": [], "next_carryover": empty_carryover_seed()}
    ds, schedule, lookup = mat
    solved = solve(schedule, spent=(req.seconds or 8), unimproved=2)
    score = score_breakdown(solved)
    return {
        "errors": [], "warnings": warnings,
        "dataset": dataset_payload(ds, solved),
        "assignments": assignments_of(solved),
        "score": score,
        "flags": derive_flags(solved, lookup),
        "next_carryover": carryover_seed(solved, ds.week_start, feasible=score["feasible"]),
    }


@app.post("/api/validate")
def post_validate(req: ValidateRequest) -> dict:
    mat, errors, warnings = _materialize(req.requirements, req.carryover_seed)
    if mat is None:
        return {"errors": errors, "warnings": warnings, "dataset": None, "assignments": {},
                "score": None, "flags": [], "next_carryover": empty_carryover_seed()}
    ds, schedule, lookup = mat
    employees_by_id = {e.id: e for e in ds.employees}
    assignment_errors = validate_assignments(schedule, req.assignments, employees_by_id)
    if assignment_errors:
        return {"errors": assignment_errors, "warnings": warnings, "dataset": None,
                "assignments": {}, "score": None, "flags": [],
                "next_carryover": empty_carryover_seed()}
    apply_assignments(schedule, req.assignments, employees_by_id)
    score = score_breakdown(schedule)
    return {
        "errors": [], "warnings": warnings,
        "dataset": dataset_payload(ds, schedule),
        "assignments": assignments_of(schedule),
        "score": score,
        "flags": derive_flags(schedule, lookup),
        "next_carryover": carryover_seed(schedule, ds.week_start, feasible=score["feasible"]),
    }


# --- Serve the built frontend (single-origin for e2e / Claude-in-Chrome) -----
_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="frontend")
```

## frontend/src/types.ts (current)

```typescript
export interface NamedRef { id: string; name: string }

export interface Team { id: string; name: string; site_id: string }
export interface Project { id: string; name: string; team_id: string }
export interface ShiftType {
  id: string; name: string; is_night: boolean; start_hour: number; end_hour: number;
}

export interface Employee {
  id: string;
  name: string;
  team_id: string;
  role_ids: string[];
  project_ids: string[];
  can_manage: boolean;
  avoid_shift_ids: string[];
  carryover_burden: number;
  worked_last_weekend: boolean;
  prev_shift_end: string | null; // local-naive ISO datetime; R3/R6 across the week boundary
  prev_shift_was_night: boolean;
}

export interface Shift {
  id: string;
  shift_type_id: string;
  shift_type_name: string;
  team_id: string;
  site_id: string;
  date: string;
  weekday: number;
  start: string;
  end: string;
  is_night: boolean;
  is_weekend: boolean;
  label: string;
}

export interface Seat {
  id: string;
  kind: "worker" | "manager";
  shift_id: string;
  team_id: string;
  project_id: string | null;
  role_id: string | null;
  label: string;
  eligible_employee_ids: string[];
}

export interface Dataset {
  sites: NamedRef[];
  week_start: string;
  days: string[];
  roles: NamedRef[];
  teams: Team[];
  projects: Project[];
  shift_types: ShiftType[];
  employees: Employee[];
  shifts: Shift[];
  seats: Seat[];
}

export interface ConstraintTotal {
  name: string;
  rule: string;
  kind: "hard" | "soft";            // domain taxonomy: Infeasibility | Compromise
  level: "hard" | "medium" | "soft"; // score level the penalty lands on
  match_count: number;
  score: string;
}
export interface ScoreInfo {
  score: string;
  hard_score: number;
  medium_score: number;             // demand coverage (R4) — above all soft rules
  soft_score: number;
  feasible: boolean;
  constraints: ConstraintTotal[];
}

export interface Flag {
  id: string;
  rule: string;
  kind: "hard" | "soft";
  weight: number;
  title: string;
  detail: string;
  employee_id: string | null;
  shift_id: string | null;
  seat_ids: string[];
}

export type Assignments = Record<string, string | null>;

export interface SolveResult {
  assignments: Assignments;
  score: ScoreInfo;
  flags: Flag[];
}

// --- editable requirements document ----------------------------------------
export interface ReqSite { id: string; name: string }
export interface ReqRole { id: string; name: string }
export interface ReqShiftType { id: string; name: string; start: number; end: number; is_night: boolean }
export interface ReqTeam { id: string; name: string; site: string }
export interface ReqProject { id: string; name: string; team: string }
export interface ReqEmployee {
  id: string;
  name: string;
  team: string;
  roles: string[];
  projects: string[];
  can_manage: boolean;
  // Carry-over (ADR-0002): prior-week state that feeds this week's solve.
  carryover_burden: number;
  worked_last_weekend: boolean;
  prev_shift_end: string | null; // local-naive ISO datetime; R3/R6 across the week boundary
  prev_shift_was_night: boolean;
  avoid_shift_ids: string[]; // negative preferences (R10); round-tripped, not yet edited here
}
export interface ReqDemand {
  team: string;
  shift_type: string;
  days: string[];
  crew: Record<string, Record<string, number>>; // project -> role -> count
}
export interface RequirementsDoc {
  sites: ReqSite[];
  roles: ReqRole[];
  shift_types: ReqShiftType[];
  teams: ReqTeam[];
  projects: ReqProject[];
  employees: ReqEmployee[];
  demand: ReqDemand[];
  week_start?: string;
  config?: { legal_rest_hours: number; night_rest_hours: number; weekend_days: string[] };
}

// Per-employee carry-over fields (ADR-0002). Shapes match ReqEmployee's carry-over
// fields so each entry can be pasted onto / replayed for next week's employee.
export interface Carryover {
  carryover_burden: number;
  worked_last_weekend: boolean;
  prev_shift_end: string | null;
  prev_shift_was_night: boolean;
}

// Self-describing seed envelope for the *next* week, derived from an accepted
// Schedule. Carries week identity (so a wrong-week replay is rejected) and whether
// the source schedule was feasible. Submit it back verbatim as a request's
// `carryover_seed` to seed the following week.
export interface CarryoverSeed {
  source_week_start: string | null;
  target_week_start: string | null;
  source_feasible: boolean;
  employees: Record<string, Carryover>;
}

export interface BuildResult {
  errors: string[];
  warnings: string[];
  dataset: Dataset | null;
}
export interface SolveResponse extends BuildResult {
  assignments: Assignments;
  score: ScoreInfo | null;
  flags: Flag[];
  next_carryover: CarryoverSeed;
}
export interface ValidateResponse extends BuildResult {
  assignments: Assignments;
  score: ScoreInfo | null;
  flags: Flag[];
  next_carryover: CarryoverSeed;
}

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
```

## frontend/src/api.ts (current)

```typescript
import type {
  Assignments,
  BuildResult,
  CarryoverSeed,
  RequirementsDoc,
  SolveResponse,
  ValidateResponse,
} from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => json<T>(r));
}

export function getRequirements(): Promise<RequirementsDoc> {
  return fetch("/api/requirements").then((r) => json<RequirementsDoc>(r));
}

// `carryoverSeed` (optional): a prior week's next_carryover envelope, replayed to
// seed this week's carry-over. The server checks it targets this week (ADR-0002).
export function build(
  requirements: RequirementsDoc,
  carryoverSeed?: CarryoverSeed,
): Promise<BuildResult> {
  return post<BuildResult>("/api/build", { requirements, carryover_seed: carryoverSeed });
}

export function solve(
  requirements: RequirementsDoc,
  seconds?: number,
  carryoverSeed?: CarryoverSeed,
): Promise<SolveResponse> {
  return post<SolveResponse>("/api/solve", { requirements, seconds, carryover_seed: carryoverSeed });
}

export function validate(
  requirements: RequirementsDoc,
  assignments: Assignments,
  carryoverSeed?: CarryoverSeed,
): Promise<ValidateResponse> {
  return post<ValidateResponse>("/api/validate", {
    requirements,
    assignments,
    carryover_seed: carryoverSeed,
  });
}
```

## frontend/src/App.tsx (current)

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { build as apiBuild, getRequirements, solve as apiSolve, validate as apiValidate } from "./api";
import type {
  Assignments, CarryoverSeed, Dataset, Flag, RequirementsDoc, ScoreInfo,
} from "./types";
import { countFilled, siteIssues } from "./lib/lookups";
import ScheduleGrid from "./components/ScheduleGrid";
import FlagsPanel from "./components/FlagsPanel";
import Editor from "./components/Editor";

type View = "schedule" | "editor";

function emptyAssignments(ds: Dataset | null): Assignments {
  const a: Assignments = {};
  if (ds) for (const s of ds.seats) a[s.id] = null;
  return a;
}

export default function App() {
  const [req, setReq] = useState<RequirementsDoc | null>(null);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [assignments, setAssignments] = useState<Assignments>({});
  const [score, setScore] = useState<ScoreInfo | null>(null);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [view, setView] = useState<View>("schedule");
  const [solving, setSolving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [siteId, setSiteId] = useState<string>("");
  const [fatal, setFatal] = useState<string | null>(null);
  // Carry-over (ADR-0002): `carryover` is the seed currently applied to this week;
  // `nextCarryover` is the seed the latest solve/validate produced for the NEXT week.
  const [carryover, setCarryover] = useState<CarryoverSeed | null>(null);
  const [nextCarryover, setNextCarryover] = useState<CarryoverSeed | null>(null);
  const reqToken = useRef(0);
  const buildToken = useRef(0);

  // load the seed requirements once
  useEffect(() => {
    getRequirements().then(setReq).catch((e) => setFatal(String(e)));
  }, []);

  // rebuild (materialise) whenever the requirements change — debounced.
  // Editing the org invalidates any existing solution, so the schedule resets.
  useEffect(() => {
    if (!req) return;
    // Invalidate the stale next-week seed IMMEDIATELY (not after the debounce), so
    // the "Carry to next week" button can't be clicked during the rebuild window.
    setNextCarryover(null);
    const token = ++buildToken.current;
    const h = setTimeout(async () => {
      try {
        const r = await apiBuild(req, carryover ?? undefined);
        if (token !== buildToken.current) return;
        setErrors(r.errors);
        setWarnings(r.warnings);
        setDataset(r.dataset);
        setAssignments(emptyAssignments(r.dataset));
        setScore(null);
        setFlags([]);
        if (r.dataset && !r.dataset.sites.some((s) => s.id === siteId)) {
          setSiteId(r.dataset.sites[0]?.id ?? "");
        }
      } catch (e) {
        setFatal(String(e));
      }
    }, 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, carryover]);

  // `reqToken` is the op-generation guard: every solve/validate captures it and
  // refuses to write its (possibly stale) response — score, flags, next-week seed —
  // if a newer override or requirements change has since bumped it. This is what
  // stops an in-flight response from repopulating a stale nextCarryover after the
  // org changed. Spinners reset unconditionally so a superseded op never leaves one stuck.
  const handleSolve = useCallback(async () => {
    if (!req) return;
    ++buildToken.current;              // cancel any pending debounced build
    const token = ++reqToken.current;  // this op is the latest; older responses bail
    setValidating(false);              // supersede any in-flight validate (shared token)
    setSolving(true);
    try {
      const r = await apiSolve(req, undefined, carryover ?? undefined);
      if (token !== reqToken.current) return;   // a newer edit/override superseded us
      setErrors(r.errors);
      setWarnings(r.warnings);
      if (r.errors.length > 0 || !r.dataset) {
        setView("editor");
        return;
      }
      setDataset(r.dataset);
      setAssignments(r.assignments);
      setScore(r.score);
      setFlags(r.flags);
      setNextCarryover(r.next_carryover);
      setView("schedule");
      if (!r.dataset.sites.some((s) => s.id === siteId)) setSiteId(r.dataset.sites[0]?.id ?? "");
    } catch (e) {
      setFatal(String(e));
    } finally {
      // Only the latest op clears its spinner (avoids an early hide while a newer
      // op is still in flight); a superseding edit clears it synchronously instead.
      if (token === reqToken.current) setSolving(false);
    }
  }, [req, siteId, carryover]);

  const handleChange = useCallback(
    async (seatId: string, employeeId: string | null) => {
      if (!req) return;
      const next = { ...assignments, [seatId]: employeeId };
      setAssignments(next);
      const token = ++reqToken.current;
      setSolving(false);     // supersede any in-flight solve (shared token)
      setValidating(true);
      try {
        const r = await apiValidate(req, next, carryover ?? undefined);
        if (token === reqToken.current && r.score) {
          setScore(r.score);
          setFlags(r.flags);
          setNextCarryover(r.next_carryover);   // seed reflects the latest overrides
        }
      } catch (e) {
        setFatal(String(e));
      } finally {
        if (token === reqToken.current) setValidating(false);
      }
    },
    [req, assignments, carryover],
  );

  // Edits to the org invalidate any seed derived from the now-stale schedule, AND
  // any in-flight solve/validate (via the reqToken bump). Clearing nextCarryover in
  // the SAME update as setReq guarantees no committed render shows a stale,
  // clickable Carry button (the build-effect clear is only a backstop).
  const handleRequirementsChange = useCallback((next: RequirementsDoc) => {
    ++reqToken.current;       // bail any in-flight solve/validate write
    ++buildToken.current;     // bail any in-flight build before its microtask resolves
    setNextCarryover(null);
    setSolving(false);        // a superseded op won't clear its own spinner (token-gated)
    setValidating(false);
    setReq(next);
  }, []);

  // Advance to the next week, seeded by the accepted schedule's carry-over
  // (ADR-0002). Bumps week_start to the seed's target week and applies the seed;
  // the build effect then re-materialises the (empty) next week.
  const handleCarryForward = useCallback(() => {
    if (!req || !nextCarryover?.target_week_start) return;
    ++reqToken.current;    // invalidate any in-flight solve/validate for the old week
    ++buildToken.current;  // and any in-flight build
    // Reset the displayed schedule synchronously so the new (unsolved) week never
    // shows the prior week's solved grid during the debounced rebuild.
    setScore(null);
    setFlags([]);
    setSolving(false);
    setValidating(false);
    setAssignments(emptyAssignments(dataset));
    setReq({ ...req, week_start: nextCarryover.target_week_start });
    setCarryover(nextCarryover);
    setNextCarryover(null);
    setView("schedule");
  }, [req, nextCarryover, dataset]);

  const issues = useMemo(() => (dataset ? siteIssues(dataset, assignments) : {}), [dataset, assignments]);

  if (fatal && !req) return <div className="fatal" role="alert">Failed to load: {fatal}</div>;
  if (!req) return <div className="loading">Loading scheduler…</div>;

  const { filled, total } = dataset ? countFilled(dataset, assignments) : { filled: 0, total: 0 };
  const weekRange = dataset ? `${fmt(dataset.days[0])} – ${fmt(dataset.days[6])}` : "";
  const teams = dataset ? dataset.teams.filter((t) => t.site_id === siteId) : [];
  const blocked = errors.length > 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <h1>Shift Scheduler</h1>
          <span className="topbar__site">
            {req.sites.length} sites · {req.employees.length} people{weekRange ? ` · ${weekRange}` : ""}
            {carryover && <span className="topbar__seeded" data-testid="seeded-tag"> · seeded from prior week</span>}
          </span>
        </div>
        <div className="topbar__actions">
          <div className="viewtabs" role="tablist">
            <button className={`viewtab${view === "schedule" ? " is-active" : ""}`} data-testid="nav-schedule"
              data-active={view === "schedule"} onClick={() => setView("schedule")}>Schedule</button>
            <button className={`viewtab${view === "editor" ? " is-active" : ""}`} data-testid="nav-editor"
              data-active={view === "editor"} onClick={() => setView("editor")}>
              Requirements{blocked ? ` (${errors.length}⚠)` : ""}
            </button>
          </div>
          <ScoreBadge score={score} filled={filled} total={total} />
          <button className="btn btn--primary" data-testid="solve-button" onClick={handleSolve}
            disabled={solving || blocked} title={blocked ? "Fix requirement errors first" : ""}>
            {solving ? "Solving…" : score ? "Re-solve" : "Generate schedule"}
          </button>
          {nextCarryover?.target_week_start && (
            <button className="btn" data-testid="carry-button" onClick={handleCarryForward}
              disabled={solving || validating || blocked}
              title={`Seed the week of ${fmt(nextCarryover.target_week_start)} from this schedule`}>
              Carry to {fmt(nextCarryover.target_week_start)} →
            </button>
          )}
        </div>
      </header>

      {view === "editor" ? (
        <main className="editorwrap">
          <Editor req={req} onChange={handleRequirementsChange} errors={errors} warnings={warnings} />
        </main>
      ) : (
        <>
          {dataset && (
            <nav className="sitebar" data-testid="sitebar" aria-label="Sites">
              {dataset.sites.map((s) => {
                const iss = issues[s.id];
                const count = score ? (iss?.unfilled ?? 0) + (iss?.exceptional ?? 0) : 0;
                return (
                  <button key={s.id} className={`sitetab${s.id === siteId ? " is-active" : ""}`}
                    data-testid="site-tab" data-site-id={s.id} data-active={s.id === siteId}
                    onClick={() => setSiteId(s.id)}>
                    <span className="sitetab__name">{s.name}</span>
                    {count > 0 && <span className="sitetab__count" data-testid="site-issue-count">{count}</span>}
                  </button>
                );
              })}
            </nav>
          )}

          <main className="layout">
            <div className="layout__main">
              {blocked ? (
                <div className="banner banner--error" data-testid="blocked-banner" role="alert">
                  {errors.length} requirement error(s) — open <strong>Requirements</strong> to fix them.
                </div>
              ) : !score && !solving ? (
                <div className="hint" data-testid="presolve-hint">
                  Press <strong>Generate schedule</strong> to staff your org, then adjust any seat —
                  every change re-checks the whole schedule. Edit the org under <strong>Requirements</strong>.
                </div>
              ) : null}
              {dataset && <ScheduleGrid ds={dataset} teams={teams} assignments={assignments} onChange={handleChange} />}
            </div>
            <FlagsPanel flags={flags} score={score} validating={validating} />
          </main>
        </>
      )}
    </div>
  );
}

function ScoreBadge({ score, filled, total }: { score: ScoreInfo | null; filled: number; total: number }) {
  if (!score) {
    return <span className="badge badge--idle" data-testid="score-badge" data-feasible="unknown">Not solved</span>;
  }
  return (
    <span className={`badge ${score.feasible ? "badge--ok" : "badge--bad"}`}
      data-testid="score-badge" data-feasible={score.feasible} data-filled={filled} data-total={total}
      data-medium={score.medium_score} data-soft={score.soft_score}>
      <span className="badge__dot" aria-hidden />
      {score.feasible ? "Feasible" : "Infeasible"}
      <span className="badge__sep">·</span>{filled}/{total} filled
      {score.medium_score < 0 && (
        <><span className="badge__sep">·</span>coverage −{Math.abs(score.medium_score)}</>
      )}
      <span className="badge__sep">·</span>penalty {Math.abs(score.soft_score)}
    </span>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
```

## backend/tests/test_next_carryover.py (NEW)

```python
"""next_week_carryover (ADR-0002 continuity seam): the accepted Schedule for one
week derives the next week's carry-over seed. These pin the derivation edges;
test_api_carryover proves the seed actually round-trips through the public API."""
from __future__ import annotations

from app.carryover import next_week_carryover
from app.domain import Schedule
from app.requirements import CARRYOVER_FIELDS, CarryoverFields, EmployeeIn
from conftest import day_shift, emp, seat


def _schedule(seats, employees):
    shifts = list({s.shift.id: s.shift for s in seats}.values())
    return Schedule(list(employees), shifts, list(seats))


def test_last_shift_drives_prev_shift_end_and_night_flag():
    a = emp("a", carryover_burden=2)
    fri_night = day_shift(5, start=22, dur=8, night=True, id="fri")  # Fri 22:00 -> Sat 06:00
    tue_day = day_shift(2, start=8, dur=8, id="tue")                 # Tue 08:00 -> 16:00
    sched = _schedule([seat(fri_night, [a], a), seat(tue_day, [a], a)], [a])
    co = next_week_carryover(sched)["a"]
    assert co["prev_shift_end"] == fri_night.end_dt.isoformat()
    assert co["prev_shift_end"].endswith("T06:00:00")   # local-naive, no offset
    assert co["prev_shift_was_night"] is True
    assert co["worked_last_weekend"] is True
    assert co["carryover_burden"] == 3                  # 2 prior + 1 burden (the Fri night)


def test_last_shift_is_chosen_by_end_time_not_night_priority():
    a = emp("a")
    sun_night = day_shift(0, start=0, dur=6, night=True, id="sun")   # Sun 00:00 -> 06:00 (night)
    thu_day = day_shift(4, start=8, dur=8, id="thu")                 # Thu 08:00 -> 16:00 (later)
    sched = _schedule([seat(sun_night, [a], a), seat(thu_day, [a], a)], [a])
    co = next_week_carryover(sched)["a"]
    assert co["prev_shift_end"] == thu_day.end_dt.isoformat()
    assert co["prev_shift_was_night"] is False          # the latest-ending shift wins
    assert co["carryover_burden"] == 1                  # the Sun night is still a burden


def test_unworked_employee_carries_burden_forward_only():
    a = emp("a", carryover_burden=4)
    sched = _schedule([], [a])
    assert next_week_carryover(sched)["a"] == {
        "carryover_burden": 4,
        "worked_last_weekend": False,
        "prev_shift_end": None,
        "prev_shift_was_night": False,
    }


def test_weekday_only_week_clears_weekend_and_night():
    a = emp("a")
    mon = day_shift(1, start=8, dur=8, id="mon")
    sched = _schedule([seat(mon, [a], a)], [a])
    co = next_week_carryover(sched)["a"]
    assert co["worked_last_weekend"] is False
    assert co["prev_shift_was_night"] is False
    assert co["prev_shift_end"] == mon.end_dt.isoformat()
    assert co["carryover_burden"] == 0


def test_every_employee_is_present_in_the_seed():
    a = emp("a")
    b = emp("b")
    sh = day_shift(1, id="mon")
    sched = _schedule([seat(sh, [a], a)], [a, b])
    co = next_week_carryover(sched)
    assert set(co) == {"a", "b"}            # b worked nothing but is still seeded
    assert co["b"]["prev_shift_end"] is None


def test_carryover_shape_is_single_sourced():
    """N1 drift guard: the four carry-over fields are identical across the seed
    output, the shared CarryoverFields model, and CARRYOVER_FIELDS, and each is a
    real EmployeeIn field — so input, output and the seed envelope cannot drift."""
    a = emp("a")
    seed_keys = set(next_week_carryover(_schedule([], [a]))["a"])
    model_keys = set(CarryoverFields.model_fields)
    assert seed_keys == model_keys == set(CARRYOVER_FIELDS)
    assert model_keys <= set(EmployeeIn.model_fields)   # each entry pastes onto an employee


def test_mixed_night_tie_reports_night_conservatively():
    """When two shifts tie on the latest end time and only one is a night, report a
    night (conservative): the next week owes the longer recovery (N4)."""
    a = emp("a")
    day = day_shift(1, start=8, dur=8, id="d-day")                  # Mon 08:00-16:00
    night = day_shift(1, start=8, dur=8, night=True, id="d-night")  # same window, night
    co = next_week_carryover(_schedule([seat(day, [a], a), seat(night, [a], a)], [a]))["a"]
    assert co["prev_shift_was_night"] is True


def test_same_end_time_resolves_deterministically():
    """Two shifts sharing an end time (the (end_dt, start_dt, id) tie-break is part
    of the contract): the seed is stable across calls."""
    a = emp("a")
    s1 = day_shift(1, start=8, dur=8, id="mon-a")
    s2 = day_shift(1, start=8, dur=8, id="mon-b")   # identical window, different id
    sched = _schedule([seat(s1, [a], a), seat(s2, [a], a)], [a])
    co1 = next_week_carryover(sched)["a"]
    co2 = next_week_carryover(sched)["a"]
    assert co1 == co2
    assert co1["prev_shift_end"] == s1.end_dt.isoformat()
```

## backend/tests/test_carryover.py (current)

```python
"""Carry-over (ADR-0002): the solve is not stateless. Prior-week facts and
cumulative counts feed this week's rules. These pin the carry-over edges."""
from __future__ import annotations

from datetime import timedelta

from conftest import BASE, emp, evaluate, hard_rules, seat, shift_h, soft_rules


def test_worked_last_weekend_without_a_weekend_shift_is_quiet():
    """Carry-over alone raises nothing; it needs a matching assignment this week."""
    a = emp("a", worked_last_weekend=True)
    midweek = shift_h(2 * 24 + 8, 8, id="tue")   # Tuesday, not a weekend
    _score, flags = evaluate([seat(midweek, [a], a)], employees=[a])
    assert "R7" not in soft_rules(flags)


def test_prev_shift_end_far_enough_is_fine():
    a = emp("a", prev_shift_end=BASE + timedelta(hours=0))   # ended Sun 00:00
    sh = shift_h(12, 8, id="s")                              # starts Sun 12:00 (12h later)
    score, flags = evaluate([seat(sh, [a], a)], employees=[a])
    assert score.hard_score == 0
    assert "R3" not in hard_rules(flags)


def test_prev_night_recovery_within_24h_is_soft():
    a = emp("a", prev_shift_was_night=True, prev_shift_end=BASE + timedelta(hours=2))
    sh = shift_h(12, 6, id="s")        # Sun 12:00, 10h after prev night ended (>=8h legal)
    score, flags = evaluate([seat(sh, [a], a)], employees=[a])
    assert score.hard_score == 0
    assert "R6" in soft_rules(flags)


def test_prev_night_recovery_after_24h_is_clear():
    a = emp("a", prev_shift_was_night=True, prev_shift_end=BASE + timedelta(hours=0))
    sh = shift_h(25, 6, id="s")        # 25h after the prev night ended
    _score, flags = evaluate([seat(sh, [a], a)], employees=[a])
    assert "R6" not in soft_rules(flags)


def test_no_carryover_means_no_boundary_flags():
    a = emp("a")  # prev_shift_end None, not worked last weekend
    sh = shift_h(2, 6, id="s")         # very early Sunday shift
    score, flags = evaluate([seat(sh, [a], a)], employees=[a])
    assert score.hard_score == 0
    assert "R3" not in hard_rules(flags) and "R6" not in soft_rules(flags)


def test_carryover_burden_alone_raises_nothing():
    a = emp("a", carryover_burden=5)
    b = emp("b")
    sh = shift_h(2 * 24 + 8, 8, id="tue")   # one ordinary midweek shift
    _score, flags = evaluate([seat(sh, [a], a)], employees=[a, b])
    # high carry-over with no fresh burden imbalance shouldn't, by itself, flag
    assert "R9" not in soft_rules(flags)


def test_prev_shift_overlapping_current_is_a_hard_cross_boundary_overlap():
    """A prior-week shift ending AFTER a current shift starts (negative gap) is a
    cross-boundary overlap: hard R3. R1 can't catch it — last week's shift isn't a
    Seat in this Schedule. (Reproduced blocker #1.)"""
    a = emp("a", prev_shift_end=BASE + timedelta(hours=6))   # last week ended Sun 06:00
    sh = shift_h(2, 6, id="s")                               # current starts Sun 02:00
    score, flags = evaluate([seat(sh, [a], a)], [a])
    assert score.hard_score < 0
    assert "R3" in hard_rules(flags)
    assert "Overlaps" in next(f["detail"] for f in flags if f["rule"] == "R3")


def test_prev_night_overlap_also_flags_soft_recovery():
    a = emp("a", prev_shift_was_night=True, prev_shift_end=BASE + timedelta(hours=6))
    sh = shift_h(2, 6, id="s")
    score, flags = evaluate([seat(sh, [a], a)], [a])
    assert "R3" in hard_rules(flags)     # the overlap is hard
    assert "R6" in soft_rules(flags)     # and a night-recovery compromise


def test_carryover_rest_is_per_seat_and_matches_the_authoritative_score():
    """Parity (#5): constraints (Timefold) and analysis both pair last week's shift
    with EACH current-week seat. Two current shifts within legal rest of the prior
    end => 2 carry-over R3 + 1 within-week R3, and the hard score counts the same 3."""
    a = emp("a", prev_shift_end=BASE)        # last week ended Sun 00:00
    s1 = shift_h(2, 3, id="s1")              # Sun 02:00-05:00 (gap 2h from prev)
    s2 = shift_h(6, 3, id="s2")              # Sun 06:00-09:00 (gap 6h from prev)
    score, flags = evaluate([seat(s1, [a], a), seat(s2, [a], a)], [a])
    r3_hard = [f for f in flags if f["rule"] == "R3" and f["kind"] == "hard"]
    assert len(r3_hard) == 3
    assert score.hard_score == -3           # analysis flag count == Timefold hard matches
```

## backend/tests/test_api_carryover.py (current)

```python
"""Carry-over / preferences must be reachable through the *public API*, not just
the domain. These pin HIGH #1: prev_shift_end, prev_shift_was_night and
avoid_shift_ids round-trip through requirements, so R3/R6-carry-over and R10 can
actually fire from a posted requirements document (ADR-0002)."""
from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from app.main import app

# Sunday 2026-06-21; a single Sunday morning shift 08:00–16:00.
ORG = {
    "sites": [{"id": "hq", "name": "HQ"}],
    "roles": [{"id": "dev", "name": "Dev"}],
    "shift_types": [{"id": "m", "name": "Morning", "start": 8, "end": 16, "is_night": False}],
    "teams": [{"id": "a", "name": "Alpha", "site": "hq"}],
    "projects": [{"id": "p", "name": "Apollo", "team": "a"}],
    "employees": [
        {"id": "dana", "name": "Dana", "team": "a", "roles": ["dev"],
         "projects": ["p"], "can_manage": True},
    ],
    "demand": [{"team": "a", "shift_type": "m", "days": ["Sun"], "crew": {"p": {"dev": 1}}}],
    "week_start": "2026-06-21",
}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _worker_seat_id(client, doc):
    built = client.post("/api/build", json={"requirements": doc}).json()
    assert built["errors"] == [], built["errors"]
    return next(s["id"] for s in built["dataset"]["seats"] if s["kind"] == "worker"), built


def test_get_requirements_round_trips_carryover_fields(client):
    """The editable seed doc now carries the previously-dropped fields."""
    emp = client.get("/api/requirements").json()["employees"][0]
    assert "prev_shift_end" in emp
    assert "prev_shift_was_night" in emp
    assert "avoid_shift_ids" in emp


def test_prev_shift_end_triggers_R3_carryover_via_api(client):
    """A prior-week shift ending 6h before Sunday 08:00 breaks the 8h legal rest."""
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["prev_shift_end"] = "2026-06-21T02:00"  # 6h before the shift
    seat_id, _ = _worker_seat_id(client, doc)
    r = client.post("/api/validate",
                    json={"requirements": doc, "assignments": {seat_id: "dana"}}).json()
    assert r["errors"] == [], r["errors"]
    assert r["score"]["hard_score"] < 0
    assert any(f["rule"] == "R3" and f["kind"] == "hard" for f in r["flags"])


def test_prev_night_triggers_R6_carryover_via_api(client):
    """A prior-week *night* ending 9h before the shift: legal rest is fine (no R3)
    but night recovery (<24h) is not (R6 soft)."""
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["prev_shift_end"] = "2026-06-20T23:00"  # 9h before the shift
    doc["employees"][0]["prev_shift_was_night"] = True
    seat_id, _ = _worker_seat_id(client, doc)
    r = client.post("/api/validate",
                    json={"requirements": doc, "assignments": {seat_id: "dana"}}).json()
    assert r["score"]["hard_score"] == 0
    assert not any(f["rule"] == "R3" for f in r["flags"])
    assert any(f["rule"] == "R6" and f["kind"] == "soft" for f in r["flags"])


def test_avoid_shift_ids_triggers_R10_via_api(client):
    """A concrete shift id placed in avoid_shift_ids surfaces R10 when worked."""
    seat_id, built = _worker_seat_id(client, ORG)
    shift_id = next(s["shift_id"] for s in built["dataset"]["seats"] if s["id"] == seat_id)
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["avoid_shift_ids"] = [shift_id]
    r = client.post("/api/validate",
                    json={"requirements": doc, "assignments": {seat_id: "dana"}}).json()
    assert r["score"]["hard_score"] == 0
    assert any(f["rule"] == "R10" and f["kind"] == "soft" for f in r["flags"])


def test_no_carryover_means_clean_first_shift_via_api(client):
    """Without carry-over the same early assignment raises no boundary flag."""
    seat_id, _ = _worker_seat_id(client, ORG)
    r = client.post("/api/validate",
                    json={"requirements": ORG, "assignments": {seat_id: "dana"}}).json()
    assert r["score"]["hard_score"] == 0
    assert not any(f["rule"] in ("R3", "R6") for f in r["flags"])


def test_tz_aware_prev_shift_end_is_rejected_not_crashed(client):
    """HIGH #1: a timezone-aware prev_shift_end is a clean validation error, not a
    500. Schedule times are local-naive; mixing in an aware value used to crash
    the score/flag path with a naive/aware datetime mismatch."""
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["prev_shift_end"] = "2026-06-20T23:00:00+03:00"
    built = client.post("/api/build", json={"requirements": doc}).json()
    assert built["dataset"] is None
    assert any("prev_shift_end" in e and "naive" in e for e in built["errors"]), built["errors"]
    # the previously-crashing scoring path now returns a clean 200 + error
    seat_id, _ = _worker_seat_id(client, ORG)   # a real seat id from the valid doc
    r = client.post("/api/validate",
                    json={"requirements": doc, "assignments": {seat_id: "dana"}})
    assert r.status_code == 200
    body = r.json()
    assert body["errors"] and body["score"] is None


# A single Friday Night Shift (Fri 22:00 -> Sat 06:00): a weekend + night burden.
WEEKEND_ORG = {
    "sites": [{"id": "hq", "name": "HQ"}],
    "roles": [{"id": "dev", "name": "Dev"}],
    "shift_types": [{"id": "n", "name": "Night", "start": 22, "end": 6, "is_night": True}],
    "teams": [{"id": "a", "name": "Alpha", "site": "hq"}],
    "projects": [{"id": "p", "name": "Apollo", "team": "a"}],
    "employees": [{"id": "dana", "name": "Dana", "team": "a", "roles": ["dev"],
                   "projects": ["p"], "can_manage": True}],
    "demand": [{"team": "a", "shift_type": "n", "days": ["Fri"], "crew": {"p": {"dev": 1}}}],
    "week_start": "2026-06-21",
}


def _week1_seed(client):
    """Run week 1 (Dana works the Friday night) and return its next_carryover seed."""
    seat_id, _ = _worker_seat_id(client, WEEKEND_ORG)
    wk1 = client.post("/api/validate",
                      json={"requirements": WEEKEND_ORG,
                            "assignments": {seat_id: "dana"}}).json()
    return wk1["next_carryover"]


def test_next_carryover_envelope_is_self_describing(client):
    """The seed carries week identity + feasibility, and one entry per employee."""
    seed = _week1_seed(client)
    assert seed["source_week_start"] == "2026-06-21"
    assert seed["target_week_start"] == "2026-06-28"
    assert seed["source_feasible"] is True
    dana = seed["employees"]["dana"]
    assert dana["worked_last_weekend"] is True
    assert dana["prev_shift_was_night"] is True
    assert dana["prev_shift_end"] == "2026-06-27T06:00:00"   # local-naive, no offset
    assert dana["carryover_burden"] == 1


def test_seed_replayed_as_request_drives_next_week(client):
    """ADR-0002 round-trip via the validated seam: submit week 1's whole seed as
    week 2's carryover_seed; the server applies it and R7 (consecutive weekends)
    fires — no hand-merging of fields by the client."""
    seed = _week1_seed(client)
    wk2_doc = copy.deepcopy(WEEKEND_ORG)
    wk2_doc["week_start"] = "2026-06-28"
    seat_id2, _ = _worker_seat_id(client, wk2_doc)
    wk2 = client.post("/api/validate",
                      json={"requirements": wk2_doc, "carryover_seed": seed,
                            "assignments": {seat_id2: "dana"}}).json()
    assert wk2["errors"] == [], wk2["errors"]
    assert any(f["rule"] == "R7" and f["kind"] == "soft" for f in wk2["flags"])

    # Control: same week-2 assignment without the seed raises no R7.
    plain = client.post("/api/validate",
                        json={"requirements": wk2_doc,
                              "assignments": {seat_id2: "dana"}}).json()
    assert not any(f["rule"] == "R7" for f in plain["flags"])


def test_wrong_week_seed_is_rejected(client):
    """A seed whose target_week_start != the requested week is a clean error (#4),
    not a silent splice of carry-over from the wrong week."""
    seed = _week1_seed(client)                 # target_week_start == 2026-06-28
    doc = copy.deepcopy(WEEKEND_ORG)
    doc["week_start"] = "2026-07-05"           # asking for a different week
    r = client.post("/api/build", json={"requirements": doc, "carryover_seed": seed}).json()
    assert r["dataset"] is None
    assert any("seed targets week" in e for e in r["errors"]), r["errors"]


def test_seed_without_target_week_is_rejected(client):
    """A non-empty seed must declare a matching target_week_start; a missing/empty
    one is rejected rather than silently splicing carry-over into some week (#4)."""
    seed = copy.deepcopy(_week1_seed(client))
    seed["target_week_start"] = None
    doc = copy.deepcopy(WEEKEND_ORG)
    doc["week_start"] = "2026-06-28"
    r = client.post("/api/build", json={"requirements": doc, "carryover_seed": seed}).json()
    assert r["dataset"] is None
    assert any("target_week_start" in e for e in r["errors"]), r["errors"]


def test_infeasible_source_seed_warns(client):
    """A seed flagged source_feasible=False is applied but warns (#6)."""
    seed = _week1_seed(client)
    seed = copy.deepcopy(seed)
    seed["source_feasible"] = False
    seed["target_week_start"] = "2026-06-28"
    doc = copy.deepcopy(WEEKEND_ORG)
    doc["week_start"] = "2026-06-28"
    r = client.post("/api/build", json={"requirements": doc, "carryover_seed": seed}).json()
    assert r["dataset"] is not None
    assert any("infeasible schedule" in w for w in r["warnings"]), r["warnings"]


def test_solve_response_includes_next_carryover(client):
    """The seam is exposed on /api/solve too, with one entry per employee."""
    r = client.post("/api/solve", json={"requirements": ORG, "seconds": 1}).json()
    assert r["errors"] == [], r["errors"]
    assert set(r["next_carryover"]["employees"]) == {"dana"}
    assert set(r["next_carryover"]["employees"]["dana"]) == {
        "carryover_burden", "worked_last_weekend", "prev_shift_end", "prev_shift_was_night"}


def test_error_responses_keep_the_full_response_shape(client):
    """next_carryover (empty envelope) and assignments are present even on error
    responses, so the declared SolveResponse/ValidateResponse types hold everywhere."""
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["prev_shift_end"] = "2026-06-20T23:00:00+03:00"  # tz-aware -> error
    for path in ("/api/validate", "/api/solve"):
        body = client.post(path, json={"requirements": doc, "assignments": {}}).json()
        assert body["errors"]
        assert body["assignments"] == {}
        assert body["next_carryover"]["employees"] == {}
        assert body["next_carryover"]["source_week_start"] is None
```

## backend/tests/test_score_authority.py (current)

```python
"""Timefold is the scoring authority; the derived flags are the explanation.

These assert the two never disagree on feasibility, and that constraint metadata
and the score breakdown are well-formed.
"""
from __future__ import annotations

import pytest

from conftest import day_shift, emp, evaluate, hard_rules, seat, shift_h


def s_legal_single():
    a = emp("a")
    return [seat(day_shift(1, id="x"), [a], a)], [a]


def s_double_book():
    a = emp("a")
    sh = shift_h(8, 8)
    return [seat(sh, [a], a), seat(sh, [a], a)], [a]


def s_no_day_off():
    a = emp("a")
    return [seat(day_shift(d, id=f"d{d}"), [a], a) for d in range(7)], [a]


def s_short_rest():
    a = emp("a")
    return [seat(shift_h(20, 4, id="s1"), [a], a), seat(shift_h(26, 4, id="s2"), [a], a)], [a]


def s_exceptional_soft():
    a, b = emp("a"), emp("b")
    return [seat(day_shift(1, id="x"), [a], b)], [a, b]


def s_night_recovery_soft():
    a = emp("a")
    return [seat(shift_h(22, 8, night=True, id="n"), [a], a),
            seat(shift_h(40, 4, id="f"), [a], a)], [a]


def s_consecutive_weekend_soft():
    a = emp("a", worked_last_weekend=True)
    return [seat(day_shift(6, id="s"), [a], a)], [a]


def s_understaffed_soft():
    a = emp("a")
    return [seat(day_shift(1, id="x"), [a], None)], [a]


FEASIBLE = [s_legal_single, s_exceptional_soft, s_night_recovery_soft,
            s_consecutive_weekend_soft, s_understaffed_soft]
INFEASIBLE = [s_double_book, s_no_day_off, s_short_rest]


@pytest.mark.parametrize("builder", FEASIBLE, ids=lambda f: f.__name__)
def test_feasible_scenarios_agree(builder):
    seats, employees = builder()
    score, flags = evaluate(seats, employees)
    assert score.hard_score == 0
    assert hard_rules(flags) == []


@pytest.mark.parametrize("builder", INFEASIBLE, ids=lambda f: f.__name__)
def test_infeasible_scenarios_agree(builder):
    seats, employees = builder()
    score, flags = evaluate(seats, employees)
    assert score.hard_score < 0
    assert hard_rules(flags) != []


@pytest.mark.parametrize("builder", [s_exceptional_soft, s_night_recovery_soft,
                                     s_consecutive_weekend_soft, s_understaffed_soft],
                         ids=lambda f: f.__name__)
def test_soft_only_scenarios_are_feasible_but_report_a_compromise(builder):
    seats, employees = builder()
    score, flags = evaluate(seats, employees)
    assert score.hard_score == 0
    if builder is s_understaffed_soft:
        # Coverage (R4) is a Compromise scored on the MEDIUM level, not soft.
        assert score.medium_score < 0 and score.soft_score == 0
    else:
        assert score.soft_score < 0 and score.medium_score == 0
    assert [f for f in flags if f["kind"] == "soft"] != []


def test_coverage_outranks_fairness_regardless_of_carryover():
    """R4 coverage sits on MEDIUM, above R9 fairness (soft), so filling a burden
    seat always beats leaving it empty — even at a huge carry-over burden that
    under the old single-soft-level model made R9 outweigh R4 (the reproduced bug)."""
    a = emp("a", carryover_burden=1000)
    burden = shift_h(5 * 24 + 22, 8, night=True, id="fn")   # Friday night = weekend+night
    assigned, _ = evaluate([seat(burden, [a], a)], [a])
    unfilled, _ = evaluate([seat(burden, [a], None)], [a])
    assert assigned.medium_score == 0 and unfilled.medium_score < 0
    # higher (hard, medium) is better; coverage must win on the medium level
    assert (assigned.hard_score, assigned.medium_score) > (unfilled.hard_score, unfilled.medium_score)


def test_constraint_metadata_is_well_formed():
    from app.constraints import CONSTRAINTS
    assert CONSTRAINTS, "registry must not be empty"
    for name, meta in CONSTRAINTS.items():
        assert meta["kind"] in ("hard", "soft"), name
        assert meta["level"] in ("hard", "medium", "soft"), name
        assert meta["rule"]
    # exactly one Compromise scored on the medium level: demand coverage (R4)
    assert [m["rule"] for m in CONSTRAINTS.values() if m["level"] == "medium"] == ["R4"]


def test_score_breakdown_shape_and_known_constraints(default_solution):
    _ds, solved, _lk = default_solution
    from app.constraints import CONSTRAINTS
    from app.solver import score_breakdown
    bd = score_breakdown(solved)
    assert set(bd) >= {"score", "hard_score", "medium_score", "soft_score",
                       "feasible", "constraints"}
    assert isinstance(bd["constraints"], list)
    for c in bd["constraints"]:
        assert c["name"] in CONSTRAINTS, f"unmapped constraint surfaced: {c['name']}"
        assert c["kind"] in ("hard", "soft")
        assert c["level"] in ("hard", "medium", "soft")
```

## frontend/e2e/carryover.spec.ts (NEW)

```typescript
import { test, expect, Page } from "@playwright/test";

// "Carry to next week" (ADR-0002): solving exposes a next-week carry-over seed;
// clicking Carry advances the week, replays the seed, and the next week still
// solves feasibly and fully — proving the validated seam works end-to-end.

async function solve(page: Page) {
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("presolve-hint")).toBeVisible();
});

test("carry-over button is hidden until a schedule is generated", async ({ page }) => {
  await expect(page.getByTestId("carry-button")).toHaveCount(0);
  await expect(page.getByTestId("seeded-tag")).toHaveCount(0);
});

test("editing requirements after solving immediately hides the stale carry button", async ({ page }) => {
  await solve(page);
  await expect(page.getByTestId("carry-button")).toBeVisible();
  // Change the org: the next-week seed is derived from a schedule that no longer
  // matches, so the Carry button must disappear at once (not after a debounce).
  await page.getByTestId("nav-editor").click();
  await page.getByTestId("add-site").click();
  await expect(page.getByTestId("carry-button")).toHaveCount(0);
});

test("carrying to next week seeds it and the week still solves feasibly", async ({ page }) => {
  await solve(page);
  // the seed for next week is available
  const carry = page.getByTestId("carry-button");
  await expect(carry).toBeVisible();

  await carry.click();

  // the week advanced (schedule reset) and is now marked seeded
  await expect(page.getByTestId("seeded-tag")).toBeVisible();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "unknown");

  // re-solving the seeded week succeeds, fully staffed — the seed was accepted
  // (a wrong-week seed would have been rejected and surfaced as a blocking error)
  await solve(page);
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-filled", "135");
  await expect(page.getByTestId("blocked-banner")).toHaveCount(0);
  // and the seeded tag persists across the re-solve
  await expect(page.getByTestId("seeded-tag")).toBeVisible();
});
```

## git diff vs baseline c446a65 (tracked files; NEW files shown in full above)

```diff
diff --git a/backend/app/analysis.py b/backend/app/analysis.py
index 75089b5..fd8e5e4 100644
--- a/backend/app/analysis.py
+++ b/backend/app/analysis.py
@@ -140,25 +140,34 @@ def derive_flags(schedule: Schedule, lookup: dict | None = None) -> list[dict]:
                     f"(recommended {_hours(NIGHT_REST_MINUTES)}).",
                     employee=emp_id, seats=(first, second)))
 
-    # R3 / R6 carry-over across the week boundary
+    # R3 / R6 carry-over across the week boundary. Mirrors constraints.py exactly:
+    # last week's shift is paired with EACH current-week seat (per-seat, like the
+    # within-week pairwise R3), and a negative gap is a hard cross-boundary overlap
+    # that R1 cannot see — so there is no lower bound on the gap.
     for emp_id, seats in by_emp.items():
         emp = seats[0].employee
         if emp.prev_shift_end is None:
             continue
-        earliest = min(seats, key=lambda s: s.shift.start_dt)
-        gap = _gap_minutes(emp.prev_shift_end, earliest.shift.start_dt)
-        if 0 <= gap < LEGAL_REST_MINUTES:
-            flags.append(_flag(
-                "R3", "hard", 0,
-                f"{emp_name(emp)} too little rest from last week",
-                f"Only {_hours(gap)} between last week's shift and {shift_label(earliest.shift)}.",
-                employee=emp_id, seats=(earliest,)))
-        if emp.prev_shift_was_night and 0 <= gap < NIGHT_REST_MINUTES:
-            flags.append(_flag(
-                "R6", "soft", W_NIGHT_RECOVERY,
-                f"{emp_name(emp)} short night recovery from last week",
-                f"Only {_hours(gap)} after last week's night shift before {shift_label(earliest.shift)}.",
-                employee=emp_id, seats=(earliest,)))
+        for s in seats:
+            gap = _gap_minutes(emp.prev_shift_end, s.shift.start_dt)
+            if gap < LEGAL_REST_MINUTES:
+                detail = (f"Overlaps last week's shift — no rest before "
+                          f"{shift_label(s.shift)}." if gap < 0 else
+                          f"Only {_hours(gap)} between last week's shift and "
+                          f"{shift_label(s.shift)} (legal minimum {_hours(LEGAL_REST_MINUTES)}).")
+                flags.append(_flag(
+                    "R3", "hard", 0,
+                    f"{emp_name(emp)} too little rest from last week",
+                    detail, employee=emp_id, seats=(s,)))
+            if emp.prev_shift_was_night and gap < NIGHT_REST_MINUTES:
+                detail = (f"Overlaps last week's night shift — no recovery before "
+                          f"{shift_label(s.shift)}." if gap < 0 else
+                          f"Only {_hours(gap)} after last week's night shift before "
+                          f"{shift_label(s.shift)} (recommended {_hours(NIGHT_REST_MINUTES)}).")
+                flags.append(_flag(
+                    "R6", "soft", W_NIGHT_RECOVERY,
+                    f"{emp_name(emp)} short night recovery from last week",
+                    detail, employee=emp_id, seats=(s,)))
 
     # R7 no consecutive weekends (soft-strong)
     for emp_id, seats in by_emp.items():
diff --git a/backend/app/config.py b/backend/app/config.py
index 758bbb3..a00c45e 100644
--- a/backend/app/config.py
+++ b/backend/app/config.py
@@ -35,6 +35,12 @@ MAX_SOLVE_SECONDS = 60        # per /api/solve call
 MAX_SEATS = 20_000            # materialised planning entities per problem
 MAX_EMPLOYEES = 5_000         # problem facts per problem
 MAX_REQUEST_BYTES = 5_000_000  # request body ceiling (~5 MB)
+# Cap on client-supplied rolling burden. R9 squares (carryover_burden + this week),
+# so an unbounded client value could overflow the (32-bit) soft score or swamp the
+# other soft rules. Coverage (R4) is on a higher score level, so this is purely an
+# overflow / soft-domination guard, not what protects coverage. A real deployment
+# should decay/window the rolling count rather than sum forever.
+MAX_CARRYOVER_BURDEN = 1_000
 
 # Browser origins allowed to call the API. Dev and prod are both effectively
 # same-origin (Vite proxies /api in dev; FastAPI serves the SPA in prod), so
diff --git a/backend/app/constraints.py b/backend/app/constraints.py
index 4db3ad1..06ff5f4 100644
--- a/backend/app/constraints.py
+++ b/backend/app/constraints.py
@@ -9,7 +9,7 @@ from __future__ import annotations
 from datetime import datetime
 
 from timefold.solver.score import (ConstraintCollectors, ConstraintFactory, Constraint,
-                                    HardSoftScore, Joiners, constraint_provider)
+                                    HardMediumSoftScore, Joiners, constraint_provider)
 
 from .config import (DAYS_IN_WEEK, LEGAL_REST_MINUTES, NIGHT_REST_MINUTES,
                      W_CONSECUTIVE_WEEKEND, W_EXCEPTIONAL, W_FAIRNESS,
@@ -19,21 +19,26 @@ from .domain import Seat, Shift
 
 
 # --- Constraint names + metadata (used by the solver service for reporting) ---
-# kind: 'hard' -> Infeasibility, 'soft' -> Compromise
+# Two orthogonal axes:
+#   kind  -- domain taxonomy: 'hard' -> Infeasibility, 'soft' -> Compromise.
+#   level -- score level the penalty lands on: 'hard' | 'medium' | 'soft'.
+# They usually coincide, but R4 (understaffing) is a *Compromise* (kind 'soft')
+# scored on the MEDIUM level so demand coverage strictly outranks every soft rule
+# (CONTEXT.md: fairness influences who fills a burden, never whether it is filled).
 CONSTRAINTS: dict[str, dict] = {
-    "R1 one assignment per moment": {"kind": "hard", "rule": "R1"},
-    "R2 at least one day off per week": {"kind": "hard", "rule": "R2"},
-    "R3 legal turnaround rest": {"kind": "hard", "rule": "R3"},
-    "R3 legal turnaround rest (carry-over)": {"kind": "hard", "rule": "R3"},
-    "R4 exact demand (understaffing)": {"kind": "soft", "rule": "R4"},
-    "R5 at most one shift per day": {"kind": "soft", "rule": "R5"},
-    "R6 night recovery": {"kind": "soft", "rule": "R6"},
-    "R6 night recovery (carry-over)": {"kind": "soft", "rule": "R6"},
-    "R7 no consecutive weekends": {"kind": "soft", "rule": "R7"},
-    "R8 preferred second day off": {"kind": "soft", "rule": "R8"},
-    "R9 fairness (burden balance)": {"kind": "soft", "rule": "R9"},
-    "R10 respect preferences": {"kind": "soft", "rule": "R10"},
-    "Exceptional Assignment (needs sign-off)": {"kind": "soft", "rule": "EXC"},
+    "R1 one assignment per moment": {"kind": "hard", "level": "hard", "rule": "R1"},
+    "R2 at least one day off per week": {"kind": "hard", "level": "hard", "rule": "R2"},
+    "R3 legal turnaround rest": {"kind": "hard", "level": "hard", "rule": "R3"},
+    "R3 legal turnaround rest (carry-over)": {"kind": "hard", "level": "hard", "rule": "R3"},
+    "R4 exact demand (understaffing)": {"kind": "soft", "level": "medium", "rule": "R4"},
+    "R5 at most one shift per day": {"kind": "soft", "level": "soft", "rule": "R5"},
+    "R6 night recovery": {"kind": "soft", "level": "soft", "rule": "R6"},
+    "R6 night recovery (carry-over)": {"kind": "soft", "level": "soft", "rule": "R6"},
+    "R7 no consecutive weekends": {"kind": "soft", "level": "soft", "rule": "R7"},
+    "R8 preferred second day off": {"kind": "soft", "level": "soft", "rule": "R8"},
+    "R9 fairness (burden balance)": {"kind": "soft", "level": "soft", "rule": "R9"},
+    "R10 respect preferences": {"kind": "soft", "level": "soft", "rule": "R10"},
+    "Exceptional Assignment (needs sign-off)": {"kind": "soft", "level": "soft", "rule": "EXC"},
 }
 
 
@@ -63,7 +68,7 @@ def one_assignment_per_moment(cf: ConstraintFactory) -> Constraint:
     # with the same employee whose shifts overlap is physically impossible.
     return (cf.for_each_unique_pair(Seat, Joiners.equal(lambda s: s.employee))
             .filter(lambda a, b: _overlap(a.shift, b.shift))
-            .penalize(HardSoftScore.ONE_HARD)
+            .penalize(HardMediumSoftScore.ONE_HARD)
             .as_constraint("R1 one assignment per moment"))
 
 
@@ -73,7 +78,7 @@ def at_least_one_day_off(cf: ConstraintFactory) -> Constraint:
             .group_by(lambda s: s.employee,
                       ConstraintCollectors.count_distinct(lambda s: s.shift.start_date))
             .filter(lambda emp, days: days >= DAYS_IN_WEEK)
-            .penalize(HardSoftScore.ONE_HARD)
+            .penalize(HardMediumSoftScore.ONE_HARD)
             .as_constraint("R2 at least one day off per week"))
 
 
@@ -82,26 +87,34 @@ def legal_turnaround_rest(cf: ConstraintFactory) -> Constraint:
     return (cf.for_each_unique_pair(Seat, Joiners.equal(lambda s: s.employee))
             .filter(lambda a, b: not _overlap(a.shift, b.shift)
                     and 0 <= _pair_gap_minutes(a, b) < LEGAL_REST_MINUTES)
-            .penalize(HardSoftScore.ONE_HARD)
+            .penalize(HardMediumSoftScore.ONE_HARD)
             .as_constraint("R3 legal turnaround rest"))
 
 
 def legal_turnaround_rest_carryover(cf: ConstraintFactory) -> Constraint:
-    # R3 (hard) across the week boundary, via Carry-over (ADR-0002).
+    # R3 (hard) across the week boundary, via Carry-over (ADR-0002). A negative gap
+    # means last week's shift overlaps this one -- a cross-boundary double-booking
+    # that R1 cannot catch (last week's shift isn't a Seat in this Schedule). It is
+    # still a hard violation, so there is no lower bound on the gap. Paired per
+    # current-week Seat, matching the within-week pairwise R3.
     return (cf.for_each(Seat)
             .filter(lambda s: s.employee.prev_shift_end is not None
-                    and 0 <= _gap_minutes(s.employee.prev_shift_end, s.shift.start_dt)
+                    and _gap_minutes(s.employee.prev_shift_end, s.shift.start_dt)
                     < LEGAL_REST_MINUTES)
-            .penalize(HardSoftScore.ONE_HARD)
+            .penalize(HardMediumSoftScore.ONE_HARD)
             .as_constraint("R3 legal turnaround rest (carry-over)"))
 
 
 def understaffing(cf: ConstraintFactory) -> Constraint:
-    # R4 (soft): exact demand. A seat left unfilled is an under-staffing Compromise.
-    # (Over-staffing cannot occur: demand is modelled as exactly one seat each.)
+    # R4 (MEDIUM): exact demand. A seat left unfilled is an under-staffing Compromise.
+    # Coverage sits on the MEDIUM score level — above every soft rule — so Fairness
+    # (R9) and the other softs can decide *who* fills a burden but never make leaving
+    # a coverable seat empty look cheaper than filling it (CONTEXT.md: fairness
+    # influences who, never whether). (Over-staffing cannot occur: demand is exactly
+    # one seat each.)
     return (cf.for_each_including_unassigned(Seat)
             .filter(lambda s: s.employee is None)
-            .penalize(HardSoftScore.of_soft(W_UNDERSTAFF))
+            .penalize(HardMediumSoftScore.of_medium(W_UNDERSTAFF))
             .as_constraint("R4 exact demand (understaffing)"))
 
 
@@ -110,7 +123,7 @@ def at_most_one_shift_per_day(cf: ConstraintFactory) -> Constraint:
     return (cf.for_each(Seat)
             .group_by(lambda s: (s.employee, s.shift.start_date), ConstraintCollectors.count())
             .filter(lambda key, c: c > 1)
-            .penalize(HardSoftScore.ONE_SOFT, lambda key, c: W_ONE_SHIFT_PER_DAY * (c - 1))
+            .penalize(HardMediumSoftScore.ONE_SOFT, lambda key, c: W_ONE_SHIFT_PER_DAY * (c - 1))
             .as_constraint("R5 at most one shift per day"))
 
 
@@ -123,18 +136,20 @@ def night_recovery(cf: ConstraintFactory) -> Constraint:
         return first.shift.is_night and _pair_gap_minutes(a, b) < NIGHT_REST_MINUTES
     return (cf.for_each_unique_pair(Seat, Joiners.equal(lambda s: s.employee))
             .filter(violation)
-            .penalize(HardSoftScore.of_soft(W_NIGHT_RECOVERY))
+            .penalize(HardMediumSoftScore.of_soft(W_NIGHT_RECOVERY))
             .as_constraint("R6 night recovery"))
 
 
 def night_recovery_carryover(cf: ConstraintFactory) -> Constraint:
-    # R6 (soft-strong) across the week boundary, via Carry-over.
+    # R6 (soft-strong) across the week boundary, via Carry-over. As with R3, a
+    # negative gap (overlap with last week's night) is still a violation, so there
+    # is no lower bound.
     return (cf.for_each(Seat)
             .filter(lambda s: s.employee.prev_shift_was_night
                     and s.employee.prev_shift_end is not None
-                    and 0 <= _gap_minutes(s.employee.prev_shift_end, s.shift.start_dt)
+                    and _gap_minutes(s.employee.prev_shift_end, s.shift.start_dt)
                     < NIGHT_REST_MINUTES)
-            .penalize(HardSoftScore.of_soft(W_NIGHT_RECOVERY))
+            .penalize(HardMediumSoftScore.of_soft(W_NIGHT_RECOVERY))
             .as_constraint("R6 night recovery (carry-over)"))
 
 
@@ -143,7 +158,7 @@ def no_consecutive_weekends(cf: ConstraintFactory) -> Constraint:
     return (cf.for_each(Seat)
             .filter(lambda s: s.shift.is_weekend and s.employee.worked_last_weekend)
             .group_by(lambda s: s.employee)
-            .penalize(HardSoftScore.of_soft(W_CONSECUTIVE_WEEKEND))
+            .penalize(HardMediumSoftScore.of_soft(W_CONSECUTIVE_WEEKEND))
             .as_constraint("R7 no consecutive weekends"))
 
 
@@ -153,7 +168,7 @@ def preferred_second_day_off(cf: ConstraintFactory) -> Constraint:
             .group_by(lambda s: s.employee,
                       ConstraintCollectors.count_distinct(lambda s: s.shift.start_date))
             .filter(lambda emp, days: days == DAYS_IN_WEEK - 1)
-            .penalize(HardSoftScore.of_soft(W_SIXTH_DAY))
+            .penalize(HardMediumSoftScore.of_soft(W_SIXTH_DAY))
             .as_constraint("R8 preferred second day off"))
 
 
@@ -164,7 +179,7 @@ def fairness_burden(cf: ConstraintFactory) -> Constraint:
     return (cf.for_each(Seat)
             .filter(lambda s: s.is_burden)
             .group_by(lambda s: s.employee, ConstraintCollectors.count())
-            .penalize(HardSoftScore.ONE_SOFT,
+            .penalize(HardMediumSoftScore.ONE_SOFT,
                       lambda emp, c: W_FAIRNESS
                       * ((c + emp.carryover_burden) ** 2 - emp.carryover_burden ** 2))
             .as_constraint("R9 fairness (burden balance)"))
@@ -174,7 +189,7 @@ def respect_preferences(cf: ConstraintFactory) -> Constraint:
     # R10 (soft-mild): avoid shifts the employee asked not to work.
     return (cf.for_each(Seat)
             .filter(lambda s: s.shift.id in s.employee.avoid_shift_ids)
-            .penalize(HardSoftScore.of_soft(W_PREFERENCE))
+            .penalize(HardMediumSoftScore.of_soft(W_PREFERENCE))
             .as_constraint("R10 respect preferences"))
 
 
@@ -184,7 +199,7 @@ def exceptional_assignment(cf: ConstraintFactory) -> Constraint:
     # surfaced as a Compromise that needs sign-off.
     return (cf.for_each(Seat)
             .filter(lambda s: not s.is_eligible(s.employee))
-            .penalize(HardSoftScore.of_soft(W_EXCEPTIONAL))
+            .penalize(HardMediumSoftScore.of_soft(W_EXCEPTIONAL))
             .as_constraint("Exceptional Assignment (needs sign-off)"))
 
 
diff --git a/backend/app/domain.py b/backend/app/domain.py
index 88d8fb4..d54d2f8 100644
--- a/backend/app/domain.py
+++ b/backend/app/domain.py
@@ -19,7 +19,7 @@ from timefold.solver.domain import (PlanningEntityCollectionProperty, PlanningId
                                      PlanningScore, PlanningVariable,
                                      ProblemFactCollectionProperty, ValueRangeProvider,
                                      planning_entity, planning_solution)
-from timefold.solver.score import HardSoftScore
+from timefold.solver.score import HardMediumSoftScore
 
 from .config import WEEKEND_WEEKDAYS
 
@@ -143,4 +143,4 @@ class Schedule:
     employees: Annotated[list[Employee], ProblemFactCollectionProperty]
     shifts: Annotated[list[Shift], ProblemFactCollectionProperty]
     seats: Annotated[list[Seat], PlanningEntityCollectionProperty]
-    score: Annotated[Optional[HardSoftScore], PlanningScore] = field(default=None)
+    score: Annotated[Optional[HardMediumSoftScore], PlanningScore] = field(default=None)
diff --git a/backend/app/main.py b/backend/app/main.py
index 94d7205..c045033 100644
--- a/backend/app/main.py
+++ b/backend/app/main.py
@@ -17,10 +17,11 @@ from fastapi.staticfiles import StaticFiles
 from pydantic import BaseModel
 
 from .analysis import derive_flags
+from .carryover import carryover_seed, empty_carryover_seed
 from .config import ALLOWED_ORIGINS, MAX_REQUEST_BYTES, MAX_SOLVE_SECONDS
 from .data import build_lookup, build_schedule, default_dataset
-from .requirements import (RequirementsIn, dataset_to_requirements, to_dataset,
-                           validate_requirements)
+from .requirements import (CarryoverSeedIn, RequirementsIn, apply_carryover_seed,
+                           dataset_to_requirements, to_dataset, validate_requirements)
 from .serialize import (apply_assignments, assignments_of, dataset_payload,
                         validate_assignments)
 from .solver import score_breakdown, solve
@@ -50,21 +51,34 @@ async def limit_body_size(request: Request, call_next):
 
 class BuildRequest(BaseModel):
     requirements: RequirementsIn
+    carryover_seed: CarryoverSeedIn | None = None
 
 
 class SolveRequest(BaseModel):
     requirements: RequirementsIn
     seconds: int | None = None
+    carryover_seed: CarryoverSeedIn | None = None
 
 
 class ValidateRequest(BaseModel):
     requirements: RequirementsIn
     assignments: dict[str, str | None]
+    carryover_seed: CarryoverSeedIn | None = None
 
 
-def _materialize(req: RequirementsIn):
-    """(dataset, schedule, lookup) or None if there are blocking errors."""
+def _materialize(req: RequirementsIn, seed: CarryoverSeedIn | None = None):
+    """(dataset, schedule, lookup) or None if there are blocking errors.
+
+    An optional carry-over seed (ADR-0002) is replayed onto the employees first,
+    after a week-identity check, so the merged values pass normal validation.
+    """
+    seed_warnings: list[str] = []
+    if seed is not None:
+        seed_errors, seed_warnings = apply_carryover_seed(req, seed)
+        if seed_errors:
+            return None, seed_errors, seed_warnings
     errors, warnings = validate_requirements(req)
+    warnings = seed_warnings + warnings
     if errors:
         return None, errors, warnings
     ds = to_dataset(req)
@@ -84,7 +98,7 @@ def get_requirements() -> dict:
 
 @app.post("/api/build")
 def post_build(req: BuildRequest) -> dict:
-    mat, errors, warnings = _materialize(req.requirements)
+    mat, errors, warnings = _materialize(req.requirements, req.carryover_seed)
     if mat is None:
         return {"errors": errors, "warnings": warnings, "dataset": None}
     ds, schedule, _lookup = mat
@@ -95,41 +109,47 @@ def post_build(req: BuildRequest) -> dict:
 def post_solve(req: SolveRequest) -> dict:
     if req.seconds is not None and not (1 <= req.seconds <= MAX_SOLVE_SECONDS):
         return {"errors": [f"seconds must be between 1 and {MAX_SOLVE_SECONDS}."],
-                "warnings": [], "dataset": None, "assignments": {}, "score": None, "flags": []}
-    mat, errors, warnings = _materialize(req.requirements)
+                "warnings": [], "dataset": None, "assignments": {}, "score": None,
+                "flags": [], "next_carryover": empty_carryover_seed()}
+    mat, errors, warnings = _materialize(req.requirements, req.carryover_seed)
     if mat is None:
-        return {"errors": errors, "warnings": warnings, "dataset": None,
-                "assignments": {}, "score": None, "flags": []}
+        return {"errors": errors, "warnings": warnings, "dataset": None, "assignments": {},
+                "score": None, "flags": [], "next_carryover": empty_carryover_seed()}
     ds, schedule, lookup = mat
     solved = solve(schedule, spent=(req.seconds or 8), unimproved=2)
+    score = score_breakdown(solved)
     return {
         "errors": [], "warnings": warnings,
         "dataset": dataset_payload(ds, solved),
         "assignments": assignments_of(solved),
-        "score": score_breakdown(solved),
+        "score": score,
         "flags": derive_flags(solved, lookup),
+        "next_carryover": carryover_seed(solved, ds.week_start, feasible=score["feasible"]),
     }
 
 
 @app.post("/api/validate")
 def post_validate(req: ValidateRequest) -> dict:
-    mat, errors, warnings = _materialize(req.requirements)
+    mat, errors, warnings = _materialize(req.requirements, req.carryover_seed)
     if mat is None:
-        return {"errors": errors, "warnings": warnings, "dataset": None,
-                "score": None, "flags": []}
+        return {"errors": errors, "warnings": warnings, "dataset": None, "assignments": {},
+                "score": None, "flags": [], "next_carryover": empty_carryover_seed()}
     ds, schedule, lookup = mat
     employees_by_id = {e.id: e for e in ds.employees}
     assignment_errors = validate_assignments(schedule, req.assignments, employees_by_id)
     if assignment_errors:
         return {"errors": assignment_errors, "warnings": warnings, "dataset": None,
-                "score": None, "flags": []}
+                "assignments": {}, "score": None, "flags": [],
+                "next_carryover": empty_carryover_seed()}
     apply_assignments(schedule, req.assignments, employees_by_id)
+    score = score_breakdown(schedule)
     return {
         "errors": [], "warnings": warnings,
         "dataset": dataset_payload(ds, schedule),
         "assignments": assignments_of(schedule),
-        "score": score_breakdown(schedule),
+        "score": score,
         "flags": derive_flags(schedule, lookup),
+        "next_carryover": carryover_seed(schedule, ds.week_start, feasible=score["feasible"]),
     }
 
 
diff --git a/backend/app/requirements.py b/backend/app/requirements.py
index cc692c7..1ff18c3 100644
--- a/backend/app/requirements.py
+++ b/backend/app/requirements.py
@@ -7,6 +7,11 @@ The interactive editor builds one of these documents and posts it to /api/build,
 Rule constants (legal/night rest, weekend days) stay global defaults — the editor
 configures the org, people, skills, projects, shift types (incl. hours + night
 flag) and demand.
+
+Datetime contract: all schedule times are local-naive (data.py builds them with
+`datetime.combine`, no tzinfo). `prev_shift_end` is the only datetime the client
+sends, so it must be local-naive too — validation rejects timezone-aware values
+rather than letting a naive/aware mismatch crash the solve/score path.
 """
 from __future__ import annotations
 
@@ -14,8 +19,8 @@ from datetime import date, datetime
 
 from pydantic import BaseModel, Field
 
-from .config import (LEGAL_REST_MINUTES, MAX_EMPLOYEES, MAX_SEATS,
-                     NIGHT_REST_MINUTES, WEEKEND_WEEKDAYS)
+from .config import (LEGAL_REST_MINUTES, MAX_CARRYOVER_BURDEN, MAX_EMPLOYEES,
+                     MAX_SEATS, NIGHT_REST_MINUTES, WEEKEND_WEEKDAYS)
 from .data import Dataset
 from .domain import Employee, Project, Role, ShiftType, Site, Team
 
@@ -67,7 +72,7 @@ class EmployeeIn(BaseModel):
     # --- Carry-over (ADR-0002): prior-week state that feeds this week's solve ---
     carryover_burden: int = 0
     worked_last_weekend: bool = False
-    prev_shift_end: str | None = None        # ISO datetime; R3/R6 across the week boundary
+    prev_shift_end: str | None = None        # local-naive ISO datetime; R3/R6 across the week boundary
     prev_shift_was_night: bool = False       # whether that last shift was a Night Shift
     avoid_shift_ids: list[str] = Field(default_factory=list)  # negative Preferences (R10)
 
@@ -79,6 +84,30 @@ class DemandIn(BaseModel):
     crew: dict[str, dict[str, int]] = Field(default_factory=dict)  # project -> role -> count
 
 
+class CarryoverFields(BaseModel):
+    """The four carry-over fields, in one place (ADR-0002). This is the single
+    source for the carry-over shape shared by EmployeeIn (input), the seed envelope
+    (CarryoverSeedIn / next_week_carryover output) and the frontend types — a
+    contract test pins EmployeeIn against it so the four cannot drift apart."""
+    carryover_burden: int = 0
+    worked_last_weekend: bool = False
+    prev_shift_end: str | None = None        # local-naive ISO datetime; R3/R6 across boundary
+    prev_shift_was_night: bool = False
+
+
+CARRYOVER_FIELDS = tuple(CarryoverFields.model_fields)
+
+
+class CarryoverSeedIn(BaseModel):
+    """A prior week's carry-over seed, replayed as this week's input (ADR-0002).
+    Self-describing so a client cannot silently splice a wrong-week seed: the server
+    checks `target_week_start` matches the requested week before applying it."""
+    source_week_start: str | None = None
+    target_week_start: str | None = None
+    source_feasible: bool = True             # was the source schedule hard-feasible?
+    employees: dict[str, CarryoverFields] = Field(default_factory=dict)
+
+
 class RequirementsIn(BaseModel):
     sites: list[SiteIn] = Field(default_factory=list)
     roles: list[RoleIn] = Field(default_factory=list)
@@ -99,12 +128,27 @@ def _dupes(ids: list[str]) -> list[str]:
     return sorted(dup)
 
 
-def _bad_datetime(s: str) -> bool:
+def _parse_datetime(s: str) -> datetime | None:
+    """Parse an ISO datetime, or None if it isn't one."""
     try:
-        datetime.fromisoformat(s)
-        return False
+        return datetime.fromisoformat(s)
     except (ValueError, TypeError):
-        return True
+        return None
+
+
+def _naive_datetime(s: str | None) -> datetime | None:
+    """Parse a carry-over datetime for the domain, enforcing the local-naive
+    contract (see module docstring). Raises on a timezone-aware value so a
+    direct `to_dataset` caller fails loudly here instead of crashing deep in the
+    solve/score path. HTTP callers get a friendly error from
+    `validate_requirements` first; this is the defence for any other ingress."""
+    if s is None:
+        return None
+    dt = datetime.fromisoformat(s)
+    if dt.utcoffset() is not None:
+        raise ValueError(f"prev_shift_end must be a local (timezone-naive) ISO "
+                         f"datetime, got {s!r}")
+    return dt
 
 
 def _bad_date(s: str) -> bool:
@@ -188,9 +232,21 @@ def validate_requirements(req: RequirementsIn) -> tuple[list[str], list[str]]:
                 errors.append(f"Employee {e.id!r} is on project {pid!r} which is not in their team.")
         if e.carryover_burden < 0:
             errors.append(f"Employee {e.id!r}: carry-over burden cannot be negative.")
-        if e.prev_shift_end is not None and _bad_datetime(e.prev_shift_end):
-            errors.append(f"Employee {e.id!r}: prev_shift_end {e.prev_shift_end!r} "
-                          f"is not a valid ISO datetime.")
+        elif e.carryover_burden > MAX_CARRYOVER_BURDEN:
+            errors.append(f"Employee {e.id!r}: carry-over burden {e.carryover_burden} "
+                          f"exceeds the limit of {MAX_CARRYOVER_BURDEN}.")
+        if e.prev_shift_end is not None:
+            dt = _parse_datetime(e.prev_shift_end)
+            if dt is None:
+                errors.append(f"Employee {e.id!r}: prev_shift_end {e.prev_shift_end!r} "
+                              f"is not a valid ISO datetime.")
+            elif dt.utcoffset() is not None:
+                # Schedule times are local-naive (data.py builds them with
+                # datetime.combine, no tz). A timezone-aware carry-over time would
+                # later be subtracted from naive shift times and crash the
+                # solve/score path, so reject it at the edge.
+                errors.append(f"Employee {e.id!r}: prev_shift_end {e.prev_shift_end!r} "
+                              f"must be a local (timezone-naive) ISO datetime.")
         if not e.roles and not e.can_manage:
             warnings.append(f"Employee {e.id!r} has no role and cannot manage — unusable.")
 
@@ -238,6 +294,47 @@ def validate_requirements(req: RequirementsIn) -> tuple[list[str], list[str]]:
     return errors, warnings
 
 
+def apply_carryover_seed(req: RequirementsIn,
+                         seed: CarryoverSeedIn) -> tuple[list[str], list[str]]:
+    """Replay a prior week's carry-over seed onto this week's employees (ADR-0002).
+
+    Mutates `req.employees` in place, then normal `validate_requirements` covers the
+    merged values (naive-datetime + burden-cap checks). Returns (errors, warnings):
+    a blocking error if the seed targets a different week than requested; warnings
+    for an infeasible source or unknown employees. Must run BEFORE validation.
+    """
+    errors: list[str] = []
+    warnings: list[str] = []
+    effective_week = req.week_start or Dataset.week_start.isoformat()
+    # A seed that actually carries data MUST declare a target week that matches the
+    # requested one — otherwise a seed with a missing/empty target_week_start could
+    # silently splice carry-over into the wrong week. (An empty seed is a no-op and
+    # needs no check.)
+    if seed.employees:
+        if not seed.target_week_start:
+            errors.append("Carry-over seed must declare target_week_start "
+                          f"(expected {effective_week!r}).")
+            return errors, warnings
+        if seed.target_week_start != effective_week:
+            errors.append(f"Carry-over seed targets week {seed.target_week_start!r}, but the "
+                          f"requested week is {effective_week!r}.")
+            return errors, warnings
+    if not seed.source_feasible:
+        warnings.append("Carry-over seed came from an infeasible schedule; its rest / "
+                        "fairness carry-over may be unreliable.")
+    by_id = {e.id: e for e in req.employees}
+    for emp_id, co in seed.employees.items():
+        e = by_id.get(emp_id)
+        if e is None:
+            warnings.append(f"Carry-over seed references unknown employee {emp_id!r}; ignored.")
+            continue
+        e.carryover_burden = co.carryover_burden
+        e.worked_last_weekend = co.worked_last_weekend
+        e.prev_shift_end = co.prev_shift_end
+        e.prev_shift_was_night = co.prev_shift_was_night
+    return errors, warnings
+
+
 def _coverage_warnings(req: RequirementsIn, warnings: list[str]) -> None:
     teams_with_demand = {d.team for d in req.demand}
     for team in req.teams:
@@ -270,7 +367,7 @@ def to_dataset(req: RequirementsIn) -> Dataset:
                  avoid_shift_ids=frozenset(e.avoid_shift_ids),
                  carryover_burden=e.carryover_burden,
                  worked_last_weekend=e.worked_last_weekend,
-                 prev_shift_end=datetime.fromisoformat(e.prev_shift_end) if e.prev_shift_end else None,
+                 prev_shift_end=_naive_datetime(e.prev_shift_end),
                  prev_shift_was_night=e.prev_shift_was_night)
         for e in req.employees
     ]
diff --git a/backend/app/serialize.py b/backend/app/serialize.py
index 883229c..2a749b3 100644
--- a/backend/app/serialize.py
+++ b/backend/app/serialize.py
@@ -26,6 +26,8 @@ def dataset_payload(dataset: Dataset, schedule: Schedule) -> dict:
             "avoid_shift_ids": sorted(e.avoid_shift_ids),
             "carryover_burden": e.carryover_burden,
             "worked_last_weekend": e.worked_last_weekend,
+            "prev_shift_end": e.prev_shift_end.isoformat() if e.prev_shift_end else None,
+            "prev_shift_was_night": e.prev_shift_was_night,
         } for e in dataset.employees],
         "shifts": [_shift_payload(s) for s in _sorted_shifts(schedule)],
         "seats": [_seat_payload(s, lookup) for s in schedule.seats],
@@ -79,7 +81,13 @@ def validate_assignments(schedule: Schedule, assignments: dict[str, str | None],
                          employees_by_id: dict) -> list[str]:
     """Errors for an assignments map: every key must be a real seat id and every
     non-null value a real employee id. Catches stale client state instead of
-    silently masking an unknown employee as 'unfilled'."""
+    silently masking an unknown employee as 'unfilled'.
+
+    Snapshot semantics (not patch): the map is the *complete* desired state. The
+    service is stateless — each call rebuilds the Schedule with every seat empty and
+    then applies the map — so a seat that is absent (or null) is intentionally
+    unassigned. There is no prior server state to "leave unchanged", which is why a
+    missing seat id is not an error: best-effort scheduling allows unfilled seats."""
     errors: list[str] = []
     seat_ids = {s.id for s in schedule.seats}
     for seat_id, emp_id in assignments.items():
@@ -95,6 +103,9 @@ def apply_assignments(schedule: Schedule, assignments: dict[str, str | None],
                       employees_by_id: dict) -> Schedule:
     """Set each seat's employee from a {seat_id: employee_id|null} map.
 
+    Snapshot, not patch: a seat absent from the map is left unassigned (see
+    `validate_assignments`). Send the full desired state every call.
+
     Employees that are not in a seat's eligible list are still applied (that is an
     Exceptional Assignment from an Override) -- re-validation will flag them.
     """
diff --git a/backend/app/solver.py b/backend/app/solver.py
index 124f903..fb7699e 100644
--- a/backend/app/solver.py
+++ b/backend/app/solver.py
@@ -64,17 +64,19 @@ def score_breakdown(problem: Schedule) -> dict:
     constraints = []
     for ca in analysis.constraint_analyses:
         name = str(ca.constraint_name)
-        meta = CONSTRAINTS.get(name, {"kind": "soft", "rule": "?"})
+        meta = CONSTRAINTS.get(name, {"kind": "soft", "level": "soft", "rule": "?"})
         constraints.append({
             "name": name,
             "rule": meta["rule"],
             "kind": meta["kind"],
+            "level": meta.get("level", meta["kind"]),
             "match_count": int(ca.match_count),
             "score": str(ca.score),
         })
     return {
         "score": str(score),
         "hard_score": score.hard_score,
+        "medium_score": score.medium_score,
         "soft_score": score.soft_score,
         "feasible": score.hard_score >= 0,
         "constraints": constraints,
diff --git a/backend/tests/test_api_carryover.py b/backend/tests/test_api_carryover.py
index 64f49bb..8c2a156 100644
--- a/backend/tests/test_api_carryover.py
+++ b/backend/tests/test_api_carryover.py
@@ -92,3 +92,136 @@ def test_no_carryover_means_clean_first_shift_via_api(client):
                     json={"requirements": ORG, "assignments": {seat_id: "dana"}}).json()
     assert r["score"]["hard_score"] == 0
     assert not any(f["rule"] in ("R3", "R6") for f in r["flags"])
+
+
+def test_tz_aware_prev_shift_end_is_rejected_not_crashed(client):
+    """HIGH #1: a timezone-aware prev_shift_end is a clean validation error, not a
+    500. Schedule times are local-naive; mixing in an aware value used to crash
+    the score/flag path with a naive/aware datetime mismatch."""
+    doc = copy.deepcopy(ORG)
+    doc["employees"][0]["prev_shift_end"] = "2026-06-20T23:00:00+03:00"
+    built = client.post("/api/build", json={"requirements": doc}).json()
+    assert built["dataset"] is None
+    assert any("prev_shift_end" in e and "naive" in e for e in built["errors"]), built["errors"]
+    # the previously-crashing scoring path now returns a clean 200 + error
+    seat_id, _ = _worker_seat_id(client, ORG)   # a real seat id from the valid doc
+    r = client.post("/api/validate",
+                    json={"requirements": doc, "assignments": {seat_id: "dana"}})
+    assert r.status_code == 200
+    body = r.json()
+    assert body["errors"] and body["score"] is None
+
+
+# A single Friday Night Shift (Fri 22:00 -> Sat 06:00): a weekend + night burden.
+WEEKEND_ORG = {
+    "sites": [{"id": "hq", "name": "HQ"}],
+    "roles": [{"id": "dev", "name": "Dev"}],
+    "shift_types": [{"id": "n", "name": "Night", "start": 22, "end": 6, "is_night": True}],
+    "teams": [{"id": "a", "name": "Alpha", "site": "hq"}],
+    "projects": [{"id": "p", "name": "Apollo", "team": "a"}],
+    "employees": [{"id": "dana", "name": "Dana", "team": "a", "roles": ["dev"],
+                   "projects": ["p"], "can_manage": True}],
+    "demand": [{"team": "a", "shift_type": "n", "days": ["Fri"], "crew": {"p": {"dev": 1}}}],
+    "week_start": "2026-06-21",
+}
+
+
+def _week1_seed(client):
+    """Run week 1 (Dana works the Friday night) and return its next_carryover seed."""
+    seat_id, _ = _worker_seat_id(client, WEEKEND_ORG)
+    wk1 = client.post("/api/validate",
+                      json={"requirements": WEEKEND_ORG,
+                            "assignments": {seat_id: "dana"}}).json()
+    return wk1["next_carryover"]
+
+
+def test_next_carryover_envelope_is_self_describing(client):
+    """The seed carries week identity + feasibility, and one entry per employee."""
+    seed = _week1_seed(client)
+    assert seed["source_week_start"] == "2026-06-21"
+    assert seed["target_week_start"] == "2026-06-28"
+    assert seed["source_feasible"] is True
+    dana = seed["employees"]["dana"]
+    assert dana["worked_last_weekend"] is True
+    assert dana["prev_shift_was_night"] is True
+    assert dana["prev_shift_end"] == "2026-06-27T06:00:00"   # local-naive, no offset
+    assert dana["carryover_burden"] == 1
+
+
+def test_seed_replayed_as_request_drives_next_week(client):
+    """ADR-0002 round-trip via the validated seam: submit week 1's whole seed as
+    week 2's carryover_seed; the server applies it and R7 (consecutive weekends)
+    fires — no hand-merging of fields by the client."""
+    seed = _week1_seed(client)
+    wk2_doc = copy.deepcopy(WEEKEND_ORG)
+    wk2_doc["week_start"] = "2026-06-28"
+    seat_id2, _ = _worker_seat_id(client, wk2_doc)
+    wk2 = client.post("/api/validate",
+                      json={"requirements": wk2_doc, "carryover_seed": seed,
+                            "assignments": {seat_id2: "dana"}}).json()
+    assert wk2["errors"] == [], wk2["errors"]
+    assert any(f["rule"] == "R7" and f["kind"] == "soft" for f in wk2["flags"])
+
+    # Control: same week-2 assignment without the seed raises no R7.
+    plain = client.post("/api/validate",
+                        json={"requirements": wk2_doc,
+                              "assignments": {seat_id2: "dana"}}).json()
+    assert not any(f["rule"] == "R7" for f in plain["flags"])
+
+
+def test_wrong_week_seed_is_rejected(client):
+    """A seed whose target_week_start != the requested week is a clean error (#4),
+    not a silent splice of carry-over from the wrong week."""
+    seed = _week1_seed(client)                 # target_week_start == 2026-06-28
+    doc = copy.deepcopy(WEEKEND_ORG)
+    doc["week_start"] = "2026-07-05"           # asking for a different week
+    r = client.post("/api/build", json={"requirements": doc, "carryover_seed": seed}).json()
+    assert r["dataset"] is None
+    assert any("seed targets week" in e for e in r["errors"]), r["errors"]
+
+
+def test_seed_without_target_week_is_rejected(client):
+    """A non-empty seed must declare a matching target_week_start; a missing/empty
+    one is rejected rather than silently splicing carry-over into some week (#4)."""
+    seed = copy.deepcopy(_week1_seed(client))
+    seed["target_week_start"] = None
+    doc = copy.deepcopy(WEEKEND_ORG)
+    doc["week_start"] = "2026-06-28"
+    r = client.post("/api/build", json={"requirements": doc, "carryover_seed": seed}).json()
+    assert r["dataset"] is None
+    assert any("target_week_start" in e for e in r["errors"]), r["errors"]
+
+
+def test_infeasible_source_seed_warns(client):
+    """A seed flagged source_feasible=False is applied but warns (#6)."""
+    seed = _week1_seed(client)
+    seed = copy.deepcopy(seed)
+    seed["source_feasible"] = False
+    seed["target_week_start"] = "2026-06-28"
+    doc = copy.deepcopy(WEEKEND_ORG)
+    doc["week_start"] = "2026-06-28"
+    r = client.post("/api/build", json={"requirements": doc, "carryover_seed": seed}).json()
+    assert r["dataset"] is not None
+    assert any("infeasible schedule" in w for w in r["warnings"]), r["warnings"]
+
+
+def test_solve_response_includes_next_carryover(client):
+    """The seam is exposed on /api/solve too, with one entry per employee."""
+    r = client.post("/api/solve", json={"requirements": ORG, "seconds": 1}).json()
+    assert r["errors"] == [], r["errors"]
+    assert set(r["next_carryover"]["employees"]) == {"dana"}
+    assert set(r["next_carryover"]["employees"]["dana"]) == {
+        "carryover_burden", "worked_last_weekend", "prev_shift_end", "prev_shift_was_night"}
+
+
+def test_error_responses_keep_the_full_response_shape(client):
+    """next_carryover (empty envelope) and assignments are present even on error
+    responses, so the declared SolveResponse/ValidateResponse types hold everywhere."""
+    doc = copy.deepcopy(ORG)
+    doc["employees"][0]["prev_shift_end"] = "2026-06-20T23:00:00+03:00"  # tz-aware -> error
+    for path in ("/api/validate", "/api/solve"):
+        body = client.post(path, json={"requirements": doc, "assignments": {}}).json()
+        assert body["errors"]
+        assert body["assignments"] == {}
+        assert body["next_carryover"]["employees"] == {}
+        assert body["next_carryover"]["source_week_start"] is None
diff --git a/backend/tests/test_carryover.py b/backend/tests/test_carryover.py
index ec1b17c..8fc24ea 100644
--- a/backend/tests/test_carryover.py
+++ b/backend/tests/test_carryover.py
@@ -53,3 +53,36 @@ def test_carryover_burden_alone_raises_nothing():
     _score, flags = evaluate([seat(sh, [a], a)], employees=[a, b])
     # high carry-over with no fresh burden imbalance shouldn't, by itself, flag
     assert "R9" not in soft_rules(flags)
+
+
+def test_prev_shift_overlapping_current_is_a_hard_cross_boundary_overlap():
+    """A prior-week shift ending AFTER a current shift starts (negative gap) is a
+    cross-boundary overlap: hard R3. R1 can't catch it — last week's shift isn't a
+    Seat in this Schedule. (Reproduced blocker #1.)"""
+    a = emp("a", prev_shift_end=BASE + timedelta(hours=6))   # last week ended Sun 06:00
+    sh = shift_h(2, 6, id="s")                               # current starts Sun 02:00
+    score, flags = evaluate([seat(sh, [a], a)], [a])
+    assert score.hard_score < 0
+    assert "R3" in hard_rules(flags)
+    assert "Overlaps" in next(f["detail"] for f in flags if f["rule"] == "R3")
+
+
+def test_prev_night_overlap_also_flags_soft_recovery():
+    a = emp("a", prev_shift_was_night=True, prev_shift_end=BASE + timedelta(hours=6))
+    sh = shift_h(2, 6, id="s")
+    score, flags = evaluate([seat(sh, [a], a)], [a])
+    assert "R3" in hard_rules(flags)     # the overlap is hard
+    assert "R6" in soft_rules(flags)     # and a night-recovery compromise
+
+
+def test_carryover_rest_is_per_seat_and_matches_the_authoritative_score():
+    """Parity (#5): constraints (Timefold) and analysis both pair last week's shift
+    with EACH current-week seat. Two current shifts within legal rest of the prior
+    end => 2 carry-over R3 + 1 within-week R3, and the hard score counts the same 3."""
+    a = emp("a", prev_shift_end=BASE)        # last week ended Sun 00:00
+    s1 = shift_h(2, 3, id="s1")              # Sun 02:00-05:00 (gap 2h from prev)
+    s2 = shift_h(6, 3, id="s2")              # Sun 06:00-09:00 (gap 6h from prev)
+    score, flags = evaluate([seat(s1, [a], a), seat(s2, [a], a)], [a])
+    r3_hard = [f for f in flags if f["rule"] == "R3" and f["kind"] == "hard"]
+    assert len(r3_hard) == 3
+    assert score.hard_score == -3           # analysis flag count == Timefold hard matches
diff --git a/backend/tests/test_requirements.py b/backend/tests/test_requirements.py
index 75065f8..7417266 100644
--- a/backend/tests/test_requirements.py
+++ b/backend/tests/test_requirements.py
@@ -77,6 +77,7 @@ def _bad_hours(d): d["shift_types"][0]["start"] = 25
 def _equal_hours(d): d["shift_types"][0]["end"] = 8
 def _neg_carry(d): d["employees"][0]["carryover_burden"] = -2
 def _bad_prev_end(d): d["employees"][0]["prev_shift_end"] = "not-a-datetime"
+def _tz_prev_end(d): d["employees"][0]["prev_shift_end"] = "2026-06-20T23:00:00+03:00"
 def _bad_week_start(d): d["week_start"] = "2026-13-99"
 def _too_many_seats(d): d["demand"][0]["crew"] = {"p": {"dev": 20001}}
 
@@ -107,6 +108,7 @@ ERROR_CASES = [
     (_equal_hours, "must differ"),
     (_neg_carry, "cannot be negative"),
     (_bad_prev_end, "valid ISO datetime"),
+    (_tz_prev_end, "timezone-naive"),
     (_bad_week_start, "valid ISO date"),
     (_too_many_seats, "Problem too large"),
 ]
@@ -174,3 +176,14 @@ def test_to_dataset_carries_prev_shift_and_preferences():
     assert e.prev_shift_end == datetime(2026, 6, 20, 23, 0)
     assert e.prev_shift_was_night is True
     assert e.avoid_shift_ids == frozenset({"shift-x"})
+
+
+@pytest.mark.parametrize("aware", ["2026-06-20T23:00:00+03:00", "2026-06-20T23:00:00Z"])
+def test_to_dataset_rejects_timezone_aware_prev_shift_end(aware):
+    """Defence in depth (independent of validate_requirements): conversion itself
+    refuses a tz-aware prev_shift_end — including a trailing 'Z' — so a direct
+    to_dataset caller fails loudly here instead of crashing the naive solve path."""
+    d = copy.deepcopy(BASE)
+    d["employees"][0]["prev_shift_end"] = aware
+    with pytest.raises(ValueError, match="naive"):
+        to_dataset(RequirementsIn(**d))
diff --git a/backend/tests/test_score_authority.py b/backend/tests/test_score_authority.py
index da5cfc9..e1d5192 100644
--- a/backend/tests/test_score_authority.py
+++ b/backend/tests/test_score_authority.py
@@ -80,16 +80,36 @@ def test_soft_only_scenarios_are_feasible_but_report_a_compromise(builder):
     seats, employees = builder()
     score, flags = evaluate(seats, employees)
     assert score.hard_score == 0
-    assert score.soft_score < 0
+    if builder is s_understaffed_soft:
+        # Coverage (R4) is a Compromise scored on the MEDIUM level, not soft.
+        assert score.medium_score < 0 and score.soft_score == 0
+    else:
+        assert score.soft_score < 0 and score.medium_score == 0
     assert [f for f in flags if f["kind"] == "soft"] != []
 
 
+def test_coverage_outranks_fairness_regardless_of_carryover():
+    """R4 coverage sits on MEDIUM, above R9 fairness (soft), so filling a burden
+    seat always beats leaving it empty — even at a huge carry-over burden that
+    under the old single-soft-level model made R9 outweigh R4 (the reproduced bug)."""
+    a = emp("a", carryover_burden=1000)
+    burden = shift_h(5 * 24 + 22, 8, night=True, id="fn")   # Friday night = weekend+night
+    assigned, _ = evaluate([seat(burden, [a], a)], [a])
+    unfilled, _ = evaluate([seat(burden, [a], None)], [a])
+    assert assigned.medium_score == 0 and unfilled.medium_score < 0
+    # higher (hard, medium) is better; coverage must win on the medium level
+    assert (assigned.hard_score, assigned.medium_score) > (unfilled.hard_score, unfilled.medium_score)
+
+
 def test_constraint_metadata_is_well_formed():
     from app.constraints import CONSTRAINTS
     assert CONSTRAINTS, "registry must not be empty"
     for name, meta in CONSTRAINTS.items():
         assert meta["kind"] in ("hard", "soft"), name
+        assert meta["level"] in ("hard", "medium", "soft"), name
         assert meta["rule"]
+    # exactly one Compromise scored on the medium level: demand coverage (R4)
+    assert [m["rule"] for m in CONSTRAINTS.values() if m["level"] == "medium"] == ["R4"]
 
 
 def test_score_breakdown_shape_and_known_constraints(default_solution):
@@ -97,8 +117,10 @@ def test_score_breakdown_shape_and_known_constraints(default_solution):
     from app.constraints import CONSTRAINTS
     from app.solver import score_breakdown
     bd = score_breakdown(solved)
-    assert set(bd) >= {"score", "hard_score", "soft_score", "feasible", "constraints"}
+    assert set(bd) >= {"score", "hard_score", "medium_score", "soft_score",
+                       "feasible", "constraints"}
     assert isinstance(bd["constraints"], list)
     for c in bd["constraints"]:
         assert c["name"] in CONSTRAINTS, f"unmapped constraint surfaced: {c['name']}"
         assert c["kind"] in ("hard", "soft")
+        assert c["level"] in ("hard", "medium", "soft")
diff --git a/docs/adr/0002-schedules-are-continuous-across-weeks.md b/docs/adr/0002-schedules-are-continuous-across-weeks.md
index c11d99f..f38ab80 100644
--- a/docs/adr/0002-schedules-are-continuous-across-weeks.md
+++ b/docs/adr/0002-schedules-are-continuous-across-weeks.md
@@ -19,3 +19,34 @@ The system is not stateless per week. There is coupling between consecutive
 Schedules, and the accepted Schedule (including manual Overrides) must be
 persisted as the source of next week's Carry-over. We accept this coupling over
 the simplicity of independent weekly solves.
+
+## The continuity seam
+
+The HTTP service itself stays stateless (it persists nothing — see `main.py`), so
+the coupling is realised as a *data seam* rather than server-side storage:
+
+  * **In:** `RequirementsIn.employees` carry `carryover_burden`,
+    `worked_last_weekend`, `prev_shift_end` and `prev_shift_was_night`, which feed
+    R3/R6-carry-over, R7 and R9.
+  * **Out:** `/api/solve` and `/api/validate` return `next_carryover` — a
+    self-describing seed envelope derived from the accepted Schedule by
+    `carryover.carryover_seed`: `{source_week_start, target_week_start,
+    source_feasible, employees: {employee_id: {…}}}`. The per-employee field
+    shapes match `EmployeeIn` (single-sourced as `requirements.CarryoverFields`).
+  * **Back in:** the client submits that envelope verbatim as the optional
+    `carryover_seed` on the next week's build/solve/validate request.
+    `requirements.apply_carryover_seed` checks `target_week_start` equals the
+    requested week (rejecting a wrong-week splice) and then merges it onto the
+    employees, so the server — not the client — owns the merge.
+
+The client (or a future persistence layer) owns storing the accepted Schedule and
+replaying the envelope; the server only computes and re-applies the seed.
+`prev_shift_end` is emitted local-naive, matching the input datetime contract.
+
+Guards on the seam: a cross-week **overlap** (last week's shift ending after a
+current shift starts) is a hard R3 violation, not a silently-ignored negative gap;
+`source_feasible` warns when a seed came from a hard-infeasible schedule (e.g. a
+bad Override); and `carryover_burden` is capped so an unbounded rolling count
+can't overflow or swamp the soft score. Demand coverage (R4) sits on the MEDIUM
+score level, above Fairness (R9) and the other soft rules, so carry-over can never
+make leaving a coverable seat empty look cheaper than filling it.
diff --git a/frontend/src/App.tsx b/frontend/src/App.tsx
index 67f177a..65b109f 100644
--- a/frontend/src/App.tsx
+++ b/frontend/src/App.tsx
@@ -1,6 +1,8 @@
 import { useCallback, useEffect, useMemo, useRef, useState } from "react";
 import { build as apiBuild, getRequirements, solve as apiSolve, validate as apiValidate } from "./api";
-import type { Assignments, Dataset, Flag, RequirementsDoc, ScoreInfo } from "./types";
+import type {
+  Assignments, CarryoverSeed, Dataset, Flag, RequirementsDoc, ScoreInfo,
+} from "./types";
 import { countFilled, siteIssues } from "./lib/lookups";
 import ScheduleGrid from "./components/ScheduleGrid";
 import FlagsPanel from "./components/FlagsPanel";
@@ -27,6 +29,10 @@ export default function App() {
   const [validating, setValidating] = useState(false);
   const [siteId, setSiteId] = useState<string>("");
   const [fatal, setFatal] = useState<string | null>(null);
+  // Carry-over (ADR-0002): `carryover` is the seed currently applied to this week;
+  // `nextCarryover` is the seed the latest solve/validate produced for the NEXT week.
+  const [carryover, setCarryover] = useState<CarryoverSeed | null>(null);
+  const [nextCarryover, setNextCarryover] = useState<CarryoverSeed | null>(null);
   const reqToken = useRef(0);
   const buildToken = useRef(0);
 
@@ -39,10 +45,13 @@ export default function App() {
   // Editing the org invalidates any existing solution, so the schedule resets.
   useEffect(() => {
     if (!req) return;
+    // Invalidate the stale next-week seed IMMEDIATELY (not after the debounce), so
+    // the "Carry to next week" button can't be clicked during the rebuild window.
+    setNextCarryover(null);
     const token = ++buildToken.current;
     const h = setTimeout(async () => {
       try {
-        const r = await apiBuild(req);
+        const r = await apiBuild(req, carryover ?? undefined);
         if (token !== buildToken.current) return;
         setErrors(r.errors);
         setWarnings(r.warnings);
@@ -59,13 +68,22 @@ export default function App() {
     }, 350);
     return () => clearTimeout(h);
     // eslint-disable-next-line react-hooks/exhaustive-deps
-  }, [req]);
+  }, [req, carryover]);
 
+  // `reqToken` is the op-generation guard: every solve/validate captures it and
+  // refuses to write its (possibly stale) response — score, flags, next-week seed —
+  // if a newer override or requirements change has since bumped it. This is what
+  // stops an in-flight response from repopulating a stale nextCarryover after the
+  // org changed. Spinners reset unconditionally so a superseded op never leaves one stuck.
   const handleSolve = useCallback(async () => {
     if (!req) return;
+    ++buildToken.current;              // cancel any pending debounced build
+    const token = ++reqToken.current;  // this op is the latest; older responses bail
+    setValidating(false);              // supersede any in-flight validate (shared token)
     setSolving(true);
     try {
-      const r = await apiSolve(req);
+      const r = await apiSolve(req, undefined, carryover ?? undefined);
+      if (token !== reqToken.current) return;   // a newer edit/override superseded us
       setErrors(r.errors);
       setWarnings(r.warnings);
       if (r.errors.length > 0 || !r.dataset) {
@@ -76,14 +94,17 @@ export default function App() {
       setAssignments(r.assignments);
       setScore(r.score);
       setFlags(r.flags);
+      setNextCarryover(r.next_carryover);
       setView("schedule");
       if (!r.dataset.sites.some((s) => s.id === siteId)) setSiteId(r.dataset.sites[0]?.id ?? "");
     } catch (e) {
       setFatal(String(e));
     } finally {
-      setSolving(false);
+      // Only the latest op clears its spinner (avoids an early hide while a newer
+      // op is still in flight); a superseding edit clears it synchronously instead.
+      if (token === reqToken.current) setSolving(false);
     }
-  }, [req, siteId]);
+  }, [req, siteId, carryover]);
 
   const handleChange = useCallback(
     async (seatId: string, employeeId: string | null) => {
@@ -91,12 +112,14 @@ export default function App() {
       const next = { ...assignments, [seatId]: employeeId };
       setAssignments(next);
       const token = ++reqToken.current;
+      setSolving(false);     // supersede any in-flight solve (shared token)
       setValidating(true);
       try {
-        const r = await apiValidate(req, next);
+        const r = await apiValidate(req, next, carryover ?? undefined);
         if (token === reqToken.current && r.score) {
           setScore(r.score);
           setFlags(r.flags);
+          setNextCarryover(r.next_carryover);   // seed reflects the latest overrides
         }
       } catch (e) {
         setFatal(String(e));
@@ -104,9 +127,42 @@ export default function App() {
         if (token === reqToken.current) setValidating(false);
       }
     },
-    [req, assignments],
+    [req, assignments, carryover],
   );
 
+  // Edits to the org invalidate any seed derived from the now-stale schedule, AND
+  // any in-flight solve/validate (via the reqToken bump). Clearing nextCarryover in
+  // the SAME update as setReq guarantees no committed render shows a stale,
+  // clickable Carry button (the build-effect clear is only a backstop).
+  const handleRequirementsChange = useCallback((next: RequirementsDoc) => {
+    ++reqToken.current;       // bail any in-flight solve/validate write
+    ++buildToken.current;     // bail any in-flight build before its microtask resolves
+    setNextCarryover(null);
+    setSolving(false);        // a superseded op won't clear its own spinner (token-gated)
+    setValidating(false);
+    setReq(next);
+  }, []);
+
+  // Advance to the next week, seeded by the accepted schedule's carry-over
+  // (ADR-0002). Bumps week_start to the seed's target week and applies the seed;
+  // the build effect then re-materialises the (empty) next week.
+  const handleCarryForward = useCallback(() => {
+    if (!req || !nextCarryover?.target_week_start) return;
+    ++reqToken.current;    // invalidate any in-flight solve/validate for the old week
+    ++buildToken.current;  // and any in-flight build
+    // Reset the displayed schedule synchronously so the new (unsolved) week never
+    // shows the prior week's solved grid during the debounced rebuild.
+    setScore(null);
+    setFlags([]);
+    setSolving(false);
+    setValidating(false);
+    setAssignments(emptyAssignments(dataset));
+    setReq({ ...req, week_start: nextCarryover.target_week_start });
+    setCarryover(nextCarryover);
+    setNextCarryover(null);
+    setView("schedule");
+  }, [req, nextCarryover, dataset]);
+
   const issues = useMemo(() => (dataset ? siteIssues(dataset, assignments) : {}), [dataset, assignments]);
 
   if (fatal && !req) return <div className="fatal" role="alert">Failed to load: {fatal}</div>;
@@ -124,6 +180,7 @@ export default function App() {
           <h1>Shift Scheduler</h1>
           <span className="topbar__site">
             {req.sites.length} sites · {req.employees.length} people{weekRange ? ` · ${weekRange}` : ""}
+            {carryover && <span className="topbar__seeded" data-testid="seeded-tag"> · seeded from prior week</span>}
           </span>
         </div>
         <div className="topbar__actions">
@@ -140,12 +197,19 @@ export default function App() {
             disabled={solving || blocked} title={blocked ? "Fix requirement errors first" : ""}>
             {solving ? "Solving…" : score ? "Re-solve" : "Generate schedule"}
           </button>
+          {nextCarryover?.target_week_start && (
+            <button className="btn" data-testid="carry-button" onClick={handleCarryForward}
+              disabled={solving || validating || blocked}
+              title={`Seed the week of ${fmt(nextCarryover.target_week_start)} from this schedule`}>
+              Carry to {fmt(nextCarryover.target_week_start)} →
+            </button>
+          )}
         </div>
       </header>
 
       {view === "editor" ? (
         <main className="editorwrap">
-          <Editor req={req} onChange={setReq} errors={errors} warnings={warnings} />
+          <Editor req={req} onChange={handleRequirementsChange} errors={errors} warnings={warnings} />
         </main>
       ) : (
         <>
@@ -195,10 +259,13 @@ function ScoreBadge({ score, filled, total }: { score: ScoreInfo | null; filled:
   return (
     <span className={`badge ${score.feasible ? "badge--ok" : "badge--bad"}`}
       data-testid="score-badge" data-feasible={score.feasible} data-filled={filled} data-total={total}
-      data-soft={score.soft_score}>
+      data-medium={score.medium_score} data-soft={score.soft_score}>
       <span className="badge__dot" aria-hidden />
       {score.feasible ? "Feasible" : "Infeasible"}
       <span className="badge__sep">·</span>{filled}/{total} filled
+      {score.medium_score < 0 && (
+        <><span className="badge__sep">·</span>coverage −{Math.abs(score.medium_score)}</>
+      )}
       <span className="badge__sep">·</span>penalty {Math.abs(score.soft_score)}
     </span>
   );
diff --git a/frontend/src/api.ts b/frontend/src/api.ts
index db80c44..6756a74 100644
--- a/frontend/src/api.ts
+++ b/frontend/src/api.ts
@@ -1,6 +1,7 @@
 import type {
   Assignments,
   BuildResult,
+  CarryoverSeed,
   RequirementsDoc,
   SolveResponse,
   ValidateResponse,
@@ -23,17 +24,31 @@ export function getRequirements(): Promise<RequirementsDoc> {
   return fetch("/api/requirements").then((r) => json<RequirementsDoc>(r));
 }
 
-export function build(requirements: RequirementsDoc): Promise<BuildResult> {
-  return post<BuildResult>("/api/build", { requirements });
+// `carryoverSeed` (optional): a prior week's next_carryover envelope, replayed to
+// seed this week's carry-over. The server checks it targets this week (ADR-0002).
+export function build(
+  requirements: RequirementsDoc,
+  carryoverSeed?: CarryoverSeed,
+): Promise<BuildResult> {
+  return post<BuildResult>("/api/build", { requirements, carryover_seed: carryoverSeed });
 }
 
-export function solve(requirements: RequirementsDoc, seconds?: number): Promise<SolveResponse> {
-  return post<SolveResponse>("/api/solve", { requirements, seconds });
+export function solve(
+  requirements: RequirementsDoc,
+  seconds?: number,
+  carryoverSeed?: CarryoverSeed,
+): Promise<SolveResponse> {
+  return post<SolveResponse>("/api/solve", { requirements, seconds, carryover_seed: carryoverSeed });
 }
 
 export function validate(
   requirements: RequirementsDoc,
   assignments: Assignments,
+  carryoverSeed?: CarryoverSeed,
 ): Promise<ValidateResponse> {
-  return post<ValidateResponse>("/api/validate", { requirements, assignments });
+  return post<ValidateResponse>("/api/validate", {
+    requirements,
+    assignments,
+    carryover_seed: carryoverSeed,
+  });
 }
diff --git a/frontend/src/styles.css b/frontend/src/styles.css
index 60845a6..5374b55 100644
--- a/frontend/src/styles.css
+++ b/frontend/src/styles.css
@@ -67,6 +67,7 @@ h1, h2, h3, p { margin: 0; }
 .topbar__brand { display: flex; flex-direction: column; min-width: 0; }
 .topbar__brand h1 { font-size: 19px; letter-spacing: -0.01em; }
 .topbar__site { font-size: 12.5px; color: var(--ink-faint); overflow-wrap: anywhere; }
+.topbar__seeded { color: var(--accent, #2563eb); font-weight: 600; }
 .topbar__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
 
 .btn {
diff --git a/frontend/src/types.ts b/frontend/src/types.ts
index 32767b3..faee5d8 100644
--- a/frontend/src/types.ts
+++ b/frontend/src/types.ts
@@ -16,6 +16,8 @@ export interface Employee {
   avoid_shift_ids: string[];
   carryover_burden: number;
   worked_last_weekend: boolean;
+  prev_shift_end: string | null; // local-naive ISO datetime; R3/R6 across the week boundary
+  prev_shift_was_night: boolean;
 }
 
 export interface Shift {
@@ -58,11 +60,17 @@ export interface Dataset {
 }
 
 export interface ConstraintTotal {
-  name: string; rule: string; kind: "hard" | "soft"; match_count: number; score: string;
+  name: string;
+  rule: string;
+  kind: "hard" | "soft";            // domain taxonomy: Infeasibility | Compromise
+  level: "hard" | "medium" | "soft"; // score level the penalty lands on
+  match_count: number;
+  score: string;
 }
 export interface ScoreInfo {
   score: string;
   hard_score: number;
+  medium_score: number;             // demand coverage (R4) — above all soft rules
   soft_score: number;
   feasible: boolean;
   constraints: ConstraintTotal[];
@@ -104,7 +112,7 @@ export interface ReqEmployee {
   // Carry-over (ADR-0002): prior-week state that feeds this week's solve.
   carryover_burden: number;
   worked_last_weekend: boolean;
-  prev_shift_end: string | null; // ISO datetime; R3/R6 across the week boundary
+  prev_shift_end: string | null; // local-naive ISO datetime; R3/R6 across the week boundary
   prev_shift_was_night: boolean;
   avoid_shift_ids: string[]; // negative preferences (R10); round-tripped, not yet edited here
 }
@@ -126,6 +134,26 @@ export interface RequirementsDoc {
   config?: { legal_rest_hours: number; night_rest_hours: number; weekend_days: string[] };
 }
 
+// Per-employee carry-over fields (ADR-0002). Shapes match ReqEmployee's carry-over
+// fields so each entry can be pasted onto / replayed for next week's employee.
+export interface Carryover {
+  carryover_burden: number;
+  worked_last_weekend: boolean;
+  prev_shift_end: string | null;
+  prev_shift_was_night: boolean;
+}
+
+// Self-describing seed envelope for the *next* week, derived from an accepted
+// Schedule. Carries week identity (so a wrong-week replay is rejected) and whether
+// the source schedule was feasible. Submit it back verbatim as a request's
+// `carryover_seed` to seed the following week.
+export interface CarryoverSeed {
+  source_week_start: string | null;
+  target_week_start: string | null;
+  source_feasible: boolean;
+  employees: Record<string, Carryover>;
+}
+
 export interface BuildResult {
   errors: string[];
   warnings: string[];
@@ -135,11 +163,13 @@ export interface SolveResponse extends BuildResult {
   assignments: Assignments;
   score: ScoreInfo | null;
   flags: Flag[];
+  next_carryover: CarryoverSeed;
 }
 export interface ValidateResponse extends BuildResult {
   assignments: Assignments;
   score: ScoreInfo | null;
   flags: Flag[];
+  next_carryover: CarryoverSeed;
 }
 
 export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
```
