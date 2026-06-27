# Adversarial architectural review — shift-scheduler carry-over change

You are a principal engineer doing a **deep, adversarial** review of a change to a
Python/FastAPI weekly shift-scheduler that uses **Timefold** (a Java constraint
solver driven from Python via a JPype bridge). Reason from first principles about
correctness **across multiple consecutive weeks**, not just one HTTP request.

**Everything you need is inline in this document** — the domain spec, the ADRs,
all relevant source files (current state), the new tests, and the git diff. You do
not need repo access. Be specific: cite `file:line`. Assume the author is
competent — find the *subtle* problems, not the obvious ones.

## Background: the two findings this change addresses

A prior review (against commit `c446a65`) returned REQUEST CHANGES with:

1. **HIGH — naive/aware datetime crash.** All schedule datetimes are local-naive
   (built via `datetime.combine` in `data.py:_mk_shift`, no tzinfo). `prev_shift_end`
   is the only datetime the client sends. A timezone-aware value (e.g.
   `2026-06-20T23:00:00+03:00`, or a trailing `Z`) passed validation, became an
   aware datetime in `to_dataset`, then crashed (a) the Timefold/Java score path
   (`solver.score_breakdown` → `analyze` → `sm.update`, `java.time.DateTimeException`)
   and (b) `analysis.derive_flags` (`_gap_minutes`, Python `TypeError: can't
   subtract offset-naive and offset-aware datetimes`).

2. **ARCHITECTURE — carry-over continuity seam.** ADR-0002 says the accepted
   Schedule (incl. manual Overrides) must seed the next week's Carry-over, but no
   route produced that seed and the schedule payload dropped
   `prev_shift_end`/`prev_shift_was_night`.

## What the change does

- **Datetime contract:** `validate_requirements` (HTTP edge) *and* `to_dataset`
  (`_naive_datetime`, defence-in-depth for direct callers) reject tz-aware
  `prev_shift_end`, including a trailing `Z`.
- **Continuity seam:** new `carryover.next_week_carryover(schedule)` derives, per
  employee, the seed for the *following* week:
  - `prev_shift_end` = end of the latest-ending assigned shift this week
    (tie-break `(end_dt, start_dt, id)`); `None` if they worked nothing.
  - `prev_shift_was_night` = that last shift's night flag.
  - `worked_last_weekend` = worked any Weekend Shift this week.
  - `carryover_burden` = prior `carryover_burden` + this week's burden-seat count
    (cumulative, **no decay window**).
  Returned as `next_carryover` on `/api/solve` and `/api/validate` (and on their
  error responses). `serialize.dataset_payload` now also emits `prev_shift_end` /
  `prev_shift_was_night`. Frontend `types.ts` mirrors the shape. ADR-0002 gained a
  "continuity seam" section.

## Questions to attack (be concrete; walk examples)

1. **Multi-week soundness.** Feed `next_carryover` back as next week's
   `EmployeeIn` fields, week after week. Does any rule (R3/R6 across the boundary,
   R7 consecutive-weekend, R9 fairness) become wrong, double-counted, or silently
   dropped? Walk a concrete 3-week example for a Friday-night worker, citing the
   exact filter in `constraints.py`/`analysis.py` each week.
2. **Last-shift semantics.** Is "latest `end_dt`" the right notion of "previous
   shift" for R3/R6 in *every* case — overnight shifts, a late-ending non-night
   after an earlier night, two shifts tying on `end_dt`? On an `end_dt` tie the
   reported `prev_shift_was_night` follows the id tie-break; can that misreport the
   night flag, and does R1 (no overlap for one employee) make it moot?
3. **Burden growth.** Cumulative `carryover_burden` has no decay. R9 penalizes
   `W_FAIRNESS * ((c + carryover)**2 - carryover**2)`. Does unbounded carryover
   distort fairness, integer-overflow (Java side), or saturate the score? Does
   ADR-0002's "rolling cumulative" *require* a window/cap, or is monotonic growth
   acceptable?
4. **Crash closure.** Is the naive/aware crash now *fully* closed? Consider every
   ingress: `to_dataset` direct callers, `week_start` (a `date`), the
   `dataset_to_requirements` round-trip, `'Z'`/offset handling by
   `datetime.fromisoformat` on Python 3.12, and whether `next_week_carryover`'s
   emitted `prev_shift_end` (from `.isoformat()`) re-enters cleanly next week.
5. **Contract drift.** The carry-over key set lives in four places: `EmployeeIn`,
   `next_week_carryover`, `serialize.dataset_payload`, `types.ts`. A backend test
   pins the first two. What is the strongest *single* guard against all four
   drifting apart?
6. **Statelessness vs. the ADR.** ADR-0002 says the accepted Schedule "must be
   persisted." This change keeps the server stateless and hands the seed to the
   client. Faithful realization or a dodge? What breaks if the client mishandles
   Overrides or replays a stale/wrong-week seed (there is no week-identity check)?
7. **Anything that should block** — correctness, security, error paths, or
   parity between `constraints.py` (authoritative score) and `analysis.py` (flags).

End with a line `VERDICT: APPROVE` or `VERDICT: REQUEST CHANGES`, then a
prioritized list separating must-fix from nice-to-have.

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

## ADR-0001 — best-effort scheduling

```markdown
# Best-effort scheduling with a minimal hard core

The system always produces a complete weekly Schedule rather than declaring a week
infeasible and refusing output. Only a minimal core of constraints is **hard**:
physical impossibilities (one person occupies one seat at one moment) and the
legal minimum of one day off per calendar week. When a hard constraint can't be
met, the affected slice is left unfilled (an Infeasibility) — the rest of the
Schedule is still produced.

Everything else is **soft** — demand exactness, rest beyond the legal turnaround,
night recovery, weekend protection, the preferred second day off, and fairness.
The optimizer minimizes these and reports each one it accepts as a Compromise; it
never hides them.

## Why

A scheduler under time pressure on a hard week needs *something to edit*, not an
error message. A pure feasibility solver is most brittle exactly when it matters
most. We chose best-effort + reporting (Product B) over a feasibility solver
(Product A).

## Consequences

We take on the obligation to define a **severity ordering** over the soft
constraints — what the optimizer sacrifices first. That ordering is itself a
product decision and is currently unresolved.
```

## ADR-0002 — schedules are continuous across weeks (UPDATED by this change)

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
    `{employee_id: {…}}` map derived from the accepted Schedule by
    `carryover.next_week_carryover`. Its field names and shapes match
    `EmployeeIn`, so the client pastes each entry onto the corresponding employee
    to seed the following week.

The client (or a future persistence layer) owns storing the accepted Schedule and
replaying `next_carryover`; the server only computes the seed. `prev_shift_end` is
emitted local-naive, matching the input datetime contract.
```

## backend/app/config.py

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

# Browser origins allowed to call the API. Dev and prod are both effectively
# same-origin (Vite proxies /api in dev; FastAPI serves the SPA in prod), so
# only the local dev server's direct origins need listing.
ALLOWED_ORIGINS = [
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:8000", "http://127.0.0.1:8000",
]
```

## backend/app/domain.py

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
from timefold.solver.score import HardSoftScore

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
    score: Annotated[Optional[HardSoftScore], PlanningScore] = field(default=None)
```

## backend/app/data.py

```python
"""Seed dataset + Schedule assembly — four Sites.

The org spans four Sites with deliberately different rhythms, to exercise the full
rule set:

  * Tel Aviv HQ  — software; Sun–Thu day work + a couple of nights.
  * Haifa Plant  — 24/7 operations; heavy nights and weekend coverage.
  * Jerusalem    — office support/sales; weekday day shifts only.
  * Beersheba Lab— research; light, with the occasional experiment night.

Sites are declared compactly below and flattened into the generic `Dataset`.
`build_schedule` materialises Shifts + Seats with per-seat eligibility, exactly as
before — it never needed to know how many Sites there are.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from .domain import (Employee, Project, Role, Schedule, Seat, Shift, ShiftType, Site, Team)

WEEK_START = date(2026, 6, 21)  # Sunday

# Python weekday(): Mon=0 .. Sun=6
SUN, MON, TUE, WED, THU, FRI, SAT = 6, 0, 1, 2, 3, 4, 5
WORK_WEEK = [SUN, MON, TUE, WED, THU]
ALL_DAYS = [SUN, MON, TUE, WED, THU, FRI, SAT]


@dataclass
class Dataset:
    sites: list[Site]
    roles: list[Role]
    teams: list[Team]
    projects: list[Project]
    employees: list[Employee]
    shift_types: list[ShiftType]
    # demand: (team_id, shift_type_id, [weekday ints], {project_id: {role_id: count}})
    demand: list[tuple]
    week_start: date = WEEK_START


# --- Shift types (global templates: name + classification + default hours) ----
ST_MORNING = ShiftType("st-morning", "Morning", False, 6, 14)
ST_EVENING = ShiftType("st-evening", "Evening", False, 14, 22)
ST_NIGHT = ShiftType("st-night", "Night", True, 22, 6)   # crosses midnight
ST_DAY = ShiftType("st-day", "Day", False, 8, 16)
SHIFT_TYPES = [ST_MORNING, ST_EVENING, ST_NIGHT, ST_DAY]

# --- Roles (global skills) ----------------------------------------------------
ROLES = [
    Role("role-dev", "Developer"),
    Role("role-qa", "QA"),
    Role("role-support", "Support"),
    Role("role-operator", "Operator"),
    Role("role-technician", "Technician"),
    Role("role-sales", "Sales"),
    Role("role-researcher", "Researcher"),
    Role("role-labtech", "Lab Technician"),
]


def _emp(id, name, roles, projects, team, can_manage=False, **carry):
    return Employee(id, name, team, frozenset(roles), frozenset(projects),
                    can_manage=can_manage, **carry)


# --- Declarative org spec -----------------------------------------------------
# Each team lists its projects, employees and demand. Staffing is sized
# generously so the seed week is feasible and fully staffable.
SITES_SPEC = [
    {
        "id": "site-ta", "name": "Tel Aviv HQ",
        "teams": [
            {
                "id": "team-alpha", "name": "Team Alpha",
                "projects": [("proj-apollo", "Apollo"), ("proj-borealis", "Borealis")],
                "employees": [
                    ("emp-dana", "Dana", ["role-dev"], ["proj-apollo", "proj-borealis"], False, {"carryover_burden": 2}),
                    ("emp-adam", "Adam", ["role-dev"], ["proj-apollo"], False, {}),
                    ("emp-david", "David", ["role-dev"], ["proj-borealis"], False, {}),
                    ("emp-yossi", "Yossi", ["role-dev"], ["proj-apollo", "proj-borealis"], False, {}),
                    ("emp-jamie", "Jamie", ["role-qa"], ["proj-apollo", "proj-borealis"], False, {}),
                    ("emp-maya", "Maya", ["role-qa"], ["proj-apollo"], False, {}),
                    ("emp-noa", "Noa", [], ["proj-apollo", "proj-borealis"], True, {}),
                    ("emp-itai", "Itai", [], ["proj-apollo", "proj-borealis"], True, {}),
                ],
                "demand": [
                    ("st-morning", WORK_WEEK, {"proj-apollo": {"role-dev": 1, "role-qa": 1},
                                               "proj-borealis": {"role-dev": 1}}),
                    ("st-night", [TUE, THU], {"proj-apollo": {"role-dev": 1}}),
                ],
            },
            {
                "id": "team-bravo", "name": "Team Bravo",
                "projects": [("proj-cobalt", "Cobalt")],
                "employees": [
                    ("emp-rivka", "Rivka", ["role-support"], ["proj-cobalt"], False,
                     {"worked_last_weekend": True, "carryover_burden": 3}),
                    ("emp-omer", "Omer", ["role-support"], ["proj-cobalt"], False, {"carryover_burden": 2}),
                    ("emp-lior", "Lior", ["role-support"], ["proj-cobalt"], False, {}),
                    ("emp-gil", "Gil", ["role-support"], ["proj-cobalt"], True, {"carryover_burden": 1}),
                    ("emp-tal", "Tal", ["role-support"], ["proj-cobalt"], True, {}),
                    ("emp-ehud", "Ehud", ["role-support"], ["proj-cobalt"], True, {}),
                ],
                "demand": [
                    ("st-morning", ALL_DAYS, {"proj-cobalt": {"role-support": 1}}),
                    ("st-evening", [SUN, TUE, THU], {"proj-cobalt": {"role-support": 1}}),
                    ("st-night", [WED, SAT], {"proj-cobalt": {"role-support": 1}}),
                ],
            },
        ],
    },
    {
        "id": "site-hf", "name": "Haifa Plant",
        "teams": [
            {
                "id": "team-smelter", "name": "Smelter",
                "projects": [("proj-furnace", "Furnace"), ("proj-casting", "Casting")],
                "employees": [
                    ("emp-boaz", "Boaz", ["role-operator"], ["proj-furnace", "proj-casting"], False,
                     {"carryover_burden": 2}),
                    ("emp-chen", "Chen", ["role-operator"], ["proj-furnace", "proj-casting"], False,
                     {"worked_last_weekend": True}),
                    ("emp-dror", "Dror", ["role-operator"], ["proj-furnace", "proj-casting"], False, {}),
                    ("emp-eitan", "Eitan", ["role-operator"], ["proj-furnace", "proj-casting"], False, {}),
                    ("emp-gadi", "Gadi", ["role-technician"], ["proj-furnace", "proj-casting"], False, {}),
                    ("emp-hila", "Hila", ["role-technician"], ["proj-furnace", "proj-casting"], False, {}),
                    ("emp-ron", "Ron", ["role-operator"], ["proj-furnace", "proj-casting"], True, {}),
                    ("emp-sara", "Sara", ["role-operator"], ["proj-furnace", "proj-casting"], True, {}),
                ],
                "demand": [
                    ("st-morning", [SUN, MON, TUE, WED, THU, FRI],
                     {"proj-furnace": {"role-operator": 1, "role-technician": 1},
                      "proj-casting": {"role-operator": 1}}),
                    ("st-night", [MON, WED, FRI], {"proj-furnace": {"role-operator": 1}}),
                ],
            },
            {
                "id": "team-packaging", "name": "Packaging",
                "projects": [("proj-packing", "Packing")],
                "employees": [
                    ("emp-tom", "Tom", ["role-operator"], ["proj-packing"], False, {}),
                    ("emp-vera", "Vera", ["role-operator"], ["proj-packing"], False, {"carryover_burden": 1}),
                    ("emp-yael", "Yael", ["role-operator"], ["proj-packing"], False, {}),
                    ("emp-noam", "Noam", ["role-operator"], ["proj-packing"], False, {}),
                    ("emp-ziv", "Ziv", ["role-operator"], ["proj-packing"], True, {}),
                    ("emp-avi", "Avi", ["role-operator"], ["proj-packing"], True, {}),
                ],
                "demand": [
                    ("st-morning", WORK_WEEK, {"proj-packing": {"role-operator": 2}}),
                    ("st-evening", WORK_WEEK, {"proj-packing": {"role-operator": 1}}),
                ],
            },
        ],
    },
    {
        "id": "site-jm", "name": "Jerusalem Office",
        "teams": [
            {
                "id": "team-helpdesk", "name": "Helpdesk",
                "projects": [("proj-tickets", "Tickets"), ("proj-outbound", "Outbound")],
                "employees": [
                    ("emp-hadas", "Hadas", ["role-support"], ["proj-tickets"], False, {}),
                    ("emp-ilan", "Ilan", ["role-support"], ["proj-tickets"], False, {}),
                    ("emp-keren", "Keren", ["role-sales"], ["proj-outbound"], False, {}),
                    ("emp-lev", "Lev", ["role-sales"], ["proj-outbound"], False, {}),
                    ("emp-mira", "Mira", [], ["proj-tickets", "proj-outbound"], True, {}),
                    ("emp-nadav", "Nadav", [], ["proj-tickets", "proj-outbound"], True, {}),
                ],
                "demand": [
                    ("st-day", WORK_WEEK, {"proj-tickets": {"role-support": 1},
                                           "proj-outbound": {"role-sales": 1}}),
                ],
            },
        ],
    },
    {
        "id": "site-bs", "name": "Beersheba Lab",
        "teams": [
            {
                "id": "team-lab", "name": "Research Lab",
                "projects": [("proj-genome", "Genome")],
                "employees": [
                    ("emp-ofir", "Ofir", ["role-researcher"], ["proj-genome"], False, {"carryover_burden": 1}),
                    ("emp-pnina", "Pnina", ["role-researcher"], ["proj-genome"], False, {}),
                    ("emp-rami", "Rami", ["role-labtech"], ["proj-genome"], False, {}),
                    ("emp-shir", "Shir", ["role-labtech"], ["proj-genome"], False, {}),
                    ("emp-tova", "Tova", [], ["proj-genome"], True, {}),
                    ("emp-udi", "Udi", [], ["proj-genome"], True, {}),
                ],
                "demand": [
                    ("st-morning", WORK_WEEK, {"proj-genome": {"role-researcher": 1, "role-labtech": 1}}),
                    ("st-night", [TUE], {"proj-genome": {"role-labtech": 1}}),
                ],
            },
        ],
    },
]


def default_dataset() -> Dataset:
    sites, teams, projects, employees, demand = [], [], [], [], []
    for site_spec in SITES_SPEC:
        sites.append(Site(site_spec["id"], site_spec["name"]))
        for t in site_spec["teams"]:
            teams.append(Team(t["id"], t["name"], site_spec["id"]))
            for pid, pname in t["projects"]:
                projects.append(Project(pid, pname, t["id"]))
            for eid, ename, roles, projs, can_manage, carry in t["employees"]:
                employees.append(_emp(eid, ename, roles, projs, t["id"], can_manage, **carry))
            for st_id, weekdays, crew in t["demand"]:
                demand.append((t["id"], st_id, weekdays, crew))
    return Dataset(sites, list(ROLES), teams, projects, employees, list(SHIFT_TYPES), demand)


# --- Schedule assembly --------------------------------------------------------

def _mk_shift(shift_id: str, st: ShiftType, day: date, team_id: str, site_id: str) -> Shift:
    start = datetime.combine(day, time(st.start_hour))
    end_day = day if st.end_hour > st.start_hour else day + timedelta(days=1)
    end = datetime.combine(end_day, time(st.end_hour))
    return Shift(shift_id, st, team_id, site_id, start, end)


def _eligible_workers(employees, project_id, role_id):
    return [e for e in employees if project_id in e.project_ids and role_id in e.role_ids]


def _eligible_managers(employees, team_id):
    return [e for e in employees if e.team_id == team_id and e.can_manage]


def build_schedule(dataset: Dataset) -> Schedule:
    """Materialise Shifts + Seats (with eligibility) into an unsolved Schedule."""
    st_by_id = {st.id: st for st in dataset.shift_types}
    team_by_id = {t.id: t for t in dataset.teams}
    shifts: dict[str, Shift] = {}
    seats: list[Seat] = []
    seen_mgr: set[str] = set()

    for team_id, st_id, weekdays, crew in dataset.demand:
        st = st_by_id[st_id]
        team = team_by_id[team_id]
        for offset in range(7):
            day = dataset.week_start + timedelta(days=offset)
            if day.weekday() not in weekdays:
                continue
            shift_id = f"shift-{team_id}-{st_id}-{day.isoformat()}"
            if shift_id not in shifts:
                shifts[shift_id] = _mk_shift(shift_id, st, day, team_id, team.site_id)
            shift = shifts[shift_id]
            mgr_seat_id = f"seat-{shift_id}-mgr"
            if mgr_seat_id not in seen_mgr:
                seen_mgr.add(mgr_seat_id)
                seats.append(Seat(
                    mgr_seat_id, "manager", shift, team_id, None, None,
                    eligible=_eligible_managers(dataset.employees, team_id)))
            for project_id, role_counts in crew.items():
                for role_id, count in role_counts.items():
                    for n in range(count):
                        seats.append(Seat(
                            f"seat-{shift_id}-{project_id}-{role_id}-{n}",
                            "worker", shift, team_id, project_id, role_id,
                            eligible=_eligible_workers(dataset.employees, project_id, role_id)))

    return Schedule(list(dataset.employees), list(shifts.values()), seats)


def build_lookup(dataset: Dataset) -> dict:
    """Name lookups for human-readable flags / serialization."""
    return {
        "employees": {e.id: e.name for e in dataset.employees},
        "teams": {t.id: t.name for t in dataset.teams},
        "projects": {p.id: p.name for p in dataset.projects},
        "roles": {r.id: r.name for r in dataset.roles},
        "sites": {s.id: s.name for s in dataset.sites},
    }
```

## backend/app/requirements.py (CHANGED)

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

from .config import (LEGAL_REST_MINUTES, MAX_EMPLOYEES, MAX_SEATS,
                     NIGHT_REST_MINUTES, WEEKEND_WEEKDAYS)
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
    if dt.tzinfo is not None:
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
        if e.prev_shift_end is not None:
            dt = _parse_datetime(e.prev_shift_end)
            if dt is None:
                errors.append(f"Employee {e.id!r}: prev_shift_end {e.prev_shift_end!r} "
                              f"is not a valid ISO datetime.")
            elif dt.tzinfo is not None:
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

## backend/app/carryover.py (NEW)

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
        # The shift that ends latest is the one that drives turnaround / night
        # recovery across the boundary. Tie-break deterministically so the seed
        # is stable for the same input.
        last = max(worked,
                   key=lambda s: (s.shift.end_dt, s.shift.start_dt, s.shift.id),
                   default=None)
        burden_this_week = sum(1 for s in worked if s.is_burden)
        out[emp.id] = {
            # Rolling cumulative burden: prior weeks + this week (R9). Employees
            # who didn't work still carry their accumulated burden forward.
            "carryover_burden": emp.carryover_burden + burden_this_week,
            # Next week's "last weekend" is this week's weekend (R7).
            "worked_last_weekend": any(s.shift.is_weekend for s in worked),
            # Local-naive ISO, matching the input contract (requirements.py).
            "prev_shift_end": last.shift.end_dt.isoformat() if last else None,
            "prev_shift_was_night": last.shift.is_night if last else False,
        }
    return out
```

## backend/app/constraints.py

```python
"""Constraint provider: the hard core + soft rules from CONTEXT.md.

`for_each(Seat)` yields only ASSIGNED seats (the planning variable is nullable),
so `s.employee` is never None inside these streams. Unassigned seats are reached
only via `for_each_including_unassigned` (used for under-staffing).
"""
from __future__ import annotations

from datetime import datetime

from timefold.solver.score import (ConstraintCollectors, ConstraintFactory, Constraint,
                                    HardSoftScore, Joiners, constraint_provider)

from .config import (DAYS_IN_WEEK, LEGAL_REST_MINUTES, NIGHT_REST_MINUTES,
                     W_CONSECUTIVE_WEEKEND, W_EXCEPTIONAL, W_FAIRNESS,
                     W_NIGHT_RECOVERY, W_ONE_SHIFT_PER_DAY, W_PREFERENCE,
                     W_SIXTH_DAY, W_UNDERSTAFF)
from .domain import Seat, Shift


# --- Constraint names + metadata (used by the solver service for reporting) ---
# kind: 'hard' -> Infeasibility, 'soft' -> Compromise
CONSTRAINTS: dict[str, dict] = {
    "R1 one assignment per moment": {"kind": "hard", "rule": "R1"},
    "R2 at least one day off per week": {"kind": "hard", "rule": "R2"},
    "R3 legal turnaround rest": {"kind": "hard", "rule": "R3"},
    "R3 legal turnaround rest (carry-over)": {"kind": "hard", "rule": "R3"},
    "R4 exact demand (understaffing)": {"kind": "soft", "rule": "R4"},
    "R5 at most one shift per day": {"kind": "soft", "rule": "R5"},
    "R6 night recovery": {"kind": "soft", "rule": "R6"},
    "R6 night recovery (carry-over)": {"kind": "soft", "rule": "R6"},
    "R7 no consecutive weekends": {"kind": "soft", "rule": "R7"},
    "R8 preferred second day off": {"kind": "soft", "rule": "R8"},
    "R9 fairness (burden balance)": {"kind": "soft", "rule": "R9"},
    "R10 respect preferences": {"kind": "soft", "rule": "R10"},
    "Exceptional Assignment (needs sign-off)": {"kind": "soft", "rule": "EXC"},
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
            .penalize(HardSoftScore.ONE_HARD)
            .as_constraint("R1 one assignment per moment"))


def at_least_one_day_off(cf: ConstraintFactory) -> Constraint:
    # R2 (hard): legal floor of >= 1 day off per calendar week.
    return (cf.for_each(Seat)
            .group_by(lambda s: s.employee,
                      ConstraintCollectors.count_distinct(lambda s: s.shift.start_date))
            .filter(lambda emp, days: days >= DAYS_IN_WEEK)
            .penalize(HardSoftScore.ONE_HARD)
            .as_constraint("R2 at least one day off per week"))


def legal_turnaround_rest(cf: ConstraintFactory) -> Constraint:
    # R3 (hard): minimum legal rest between any two shifts.
    return (cf.for_each_unique_pair(Seat, Joiners.equal(lambda s: s.employee))
            .filter(lambda a, b: not _overlap(a.shift, b.shift)
                    and 0 <= _pair_gap_minutes(a, b) < LEGAL_REST_MINUTES)
            .penalize(HardSoftScore.ONE_HARD)
            .as_constraint("R3 legal turnaround rest"))


def legal_turnaround_rest_carryover(cf: ConstraintFactory) -> Constraint:
    # R3 (hard) across the week boundary, via Carry-over (ADR-0002).
    return (cf.for_each(Seat)
            .filter(lambda s: s.employee.prev_shift_end is not None
                    and 0 <= _gap_minutes(s.employee.prev_shift_end, s.shift.start_dt)
                    < LEGAL_REST_MINUTES)
            .penalize(HardSoftScore.ONE_HARD)
            .as_constraint("R3 legal turnaround rest (carry-over)"))


def understaffing(cf: ConstraintFactory) -> Constraint:
    # R4 (soft): exact demand. A seat left unfilled is an under-staffing Compromise.
    # (Over-staffing cannot occur: demand is modelled as exactly one seat each.)
    return (cf.for_each_including_unassigned(Seat)
            .filter(lambda s: s.employee is None)
            .penalize(HardSoftScore.of_soft(W_UNDERSTAFF))
            .as_constraint("R4 exact demand (understaffing)"))


def at_most_one_shift_per_day(cf: ConstraintFactory) -> Constraint:
    # R5 (soft-strong): at most one shift per calendar (start) day.
    return (cf.for_each(Seat)
            .group_by(lambda s: (s.employee, s.shift.start_date), ConstraintCollectors.count())
            .filter(lambda key, c: c > 1)
            .penalize(HardSoftScore.ONE_SOFT, lambda key, c: W_ONE_SHIFT_PER_DAY * (c - 1))
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
            .penalize(HardSoftScore.of_soft(W_NIGHT_RECOVERY))
            .as_constraint("R6 night recovery"))


def night_recovery_carryover(cf: ConstraintFactory) -> Constraint:
    # R6 (soft-strong) across the week boundary, via Carry-over.
    return (cf.for_each(Seat)
            .filter(lambda s: s.employee.prev_shift_was_night
                    and s.employee.prev_shift_end is not None
                    and 0 <= _gap_minutes(s.employee.prev_shift_end, s.shift.start_dt)
                    < NIGHT_REST_MINUTES)
            .penalize(HardSoftScore.of_soft(W_NIGHT_RECOVERY))
            .as_constraint("R6 night recovery (carry-over)"))


def no_consecutive_weekends(cf: ConstraintFactory) -> Constraint:
    # R7 (soft-strong): don't work two weekends in a row (uses Carry-over).
    return (cf.for_each(Seat)
            .filter(lambda s: s.shift.is_weekend and s.employee.worked_last_weekend)
            .group_by(lambda s: s.employee)
            .penalize(HardSoftScore.of_soft(W_CONSECUTIVE_WEEKEND))
            .as_constraint("R7 no consecutive weekends"))


def preferred_second_day_off(cf: ConstraintFactory) -> Constraint:
    # R8 (soft-mild): people prefer a 2nd day off; working 6 days violates it.
    return (cf.for_each(Seat)
            .group_by(lambda s: s.employee,
                      ConstraintCollectors.count_distinct(lambda s: s.shift.start_date))
            .filter(lambda emp, days: days == DAYS_IN_WEEK - 1)
            .penalize(HardSoftScore.of_soft(W_SIXTH_DAY))
            .as_constraint("R8 preferred second day off"))


def fairness_burden(cf: ConstraintFactory) -> Constraint:
    # R9 (soft objective): spread Burden Shifts (night/weekend) evenly, measured
    # cumulatively across weeks via carry-over. Penalising the marginal squared
    # load makes piling burdens on an already-loaded person progressively costly.
    return (cf.for_each(Seat)
            .filter(lambda s: s.is_burden)
            .group_by(lambda s: s.employee, ConstraintCollectors.count())
            .penalize(HardSoftScore.ONE_SOFT,
                      lambda emp, c: W_FAIRNESS
                      * ((c + emp.carryover_burden) ** 2 - emp.carryover_burden ** 2))
            .as_constraint("R9 fairness (burden balance)"))


def respect_preferences(cf: ConstraintFactory) -> Constraint:
    # R10 (soft-mild): avoid shifts the employee asked not to work.
    return (cf.for_each(Seat)
            .filter(lambda s: s.shift.id in s.employee.avoid_shift_ids)
            .penalize(HardSoftScore.of_soft(W_PREFERENCE))
            .as_constraint("R10 respect preferences"))


def exceptional_assignment(cf: ConstraintFactory) -> Constraint:
    # Eligibility-exceeding assignment. The solver can never create one (value
    # range = eligible only); it appears only via a manual Override and is
    # surfaced as a Compromise that needs sign-off.
    return (cf.for_each(Seat)
            .filter(lambda s: not s.is_eligible(s.employee))
            .penalize(HardSoftScore.of_soft(W_EXCEPTIONAL))
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

## backend/app/analysis.py

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

    # R3 / R6 carry-over across the week boundary
    for emp_id, seats in by_emp.items():
        emp = seats[0].employee
        if emp.prev_shift_end is None:
            continue
        earliest = min(seats, key=lambda s: s.shift.start_dt)
        gap = _gap_minutes(emp.prev_shift_end, earliest.shift.start_dt)
        if 0 <= gap < LEGAL_REST_MINUTES:
            flags.append(_flag(
                "R3", "hard", 0,
                f"{emp_name(emp)} too little rest from last week",
                f"Only {_hours(gap)} between last week's shift and {shift_label(earliest.shift)}.",
                employee=emp_id, seats=(earliest,)))
        if emp.prev_shift_was_night and 0 <= gap < NIGHT_REST_MINUTES:
            flags.append(_flag(
                "R6", "soft", W_NIGHT_RECOVERY,
                f"{emp_name(emp)} short night recovery from last week",
                f"Only {_hours(gap)} after last week's night shift before {shift_label(earliest.shift)}.",
                employee=emp_id, seats=(earliest,)))

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

## backend/app/solver.py

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
        meta = CONSTRAINTS.get(name, {"kind": "soft", "rule": "?"})
        constraints.append({
            "name": name,
            "rule": meta["rule"],
            "kind": meta["kind"],
            "match_count": int(ca.match_count),
            "score": str(ca.score),
        })
    return {
        "score": str(score),
        "hard_score": score.hard_score,
        "soft_score": score.soft_score,
        "feasible": score.hard_score >= 0,
        "constraints": constraints,
    }
```

## backend/app/serialize.py (CHANGED)

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
    silently masking an unknown employee as 'unfilled'."""
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

## backend/app/main.py (CHANGED)

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
from .carryover import next_week_carryover
from .config import ALLOWED_ORIGINS, MAX_REQUEST_BYTES, MAX_SOLVE_SECONDS
from .data import build_lookup, build_schedule, default_dataset
from .requirements import (RequirementsIn, dataset_to_requirements, to_dataset,
                           validate_requirements)
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


class SolveRequest(BaseModel):
    requirements: RequirementsIn
    seconds: int | None = None


class ValidateRequest(BaseModel):
    requirements: RequirementsIn
    assignments: dict[str, str | None]


def _materialize(req: RequirementsIn):
    """(dataset, schedule, lookup) or None if there are blocking errors."""
    errors, warnings = validate_requirements(req)
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
    mat, errors, warnings = _materialize(req.requirements)
    if mat is None:
        return {"errors": errors, "warnings": warnings, "dataset": None}
    ds, schedule, _lookup = mat
    return {"errors": [], "warnings": warnings, "dataset": dataset_payload(ds, schedule)}


@app.post("/api/solve")
def post_solve(req: SolveRequest) -> dict:
    if req.seconds is not None and not (1 <= req.seconds <= MAX_SOLVE_SECONDS):
        return {"errors": [f"seconds must be between 1 and {MAX_SOLVE_SECONDS}."],
                "warnings": [], "dataset": None, "assignments": {}, "score": None,
                "flags": [], "next_carryover": {}}
    mat, errors, warnings = _materialize(req.requirements)
    if mat is None:
        return {"errors": errors, "warnings": warnings, "dataset": None,
                "assignments": {}, "score": None, "flags": [], "next_carryover": {}}
    ds, schedule, lookup = mat
    solved = solve(schedule, spent=(req.seconds or 8), unimproved=2)
    return {
        "errors": [], "warnings": warnings,
        "dataset": dataset_payload(ds, solved),
        "assignments": assignments_of(solved),
        "score": score_breakdown(solved),
        "flags": derive_flags(solved, lookup),
        "next_carryover": next_week_carryover(solved),
    }


@app.post("/api/validate")
def post_validate(req: ValidateRequest) -> dict:
    mat, errors, warnings = _materialize(req.requirements)
    if mat is None:
        return {"errors": errors, "warnings": warnings, "dataset": None,
                "assignments": {}, "score": None, "flags": [], "next_carryover": {}}
    ds, schedule, lookup = mat
    employees_by_id = {e.id: e for e in ds.employees}
    assignment_errors = validate_assignments(schedule, req.assignments, employees_by_id)
    if assignment_errors:
        return {"errors": assignment_errors, "warnings": warnings, "dataset": None,
                "assignments": {}, "score": None, "flags": [], "next_carryover": {}}
    apply_assignments(schedule, req.assignments, employees_by_id)
    return {
        "errors": [], "warnings": warnings,
        "dataset": dataset_payload(ds, schedule),
        "assignments": assignments_of(schedule),
        "score": score_breakdown(schedule),
        "flags": derive_flags(schedule, lookup),
        "next_carryover": next_week_carryover(schedule),
    }


# --- Serve the built frontend (single-origin for e2e / Claude-in-Chrome) -----
_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="frontend")
```

## frontend/src/types.ts (CHANGED)

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
  name: string; rule: string; kind: "hard" | "soft"; match_count: number; score: string;
}
export interface ScoreInfo {
  score: string;
  hard_score: number;
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
  prev_shift_end: string | null; // ISO datetime; R3/R6 across the week boundary
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

// Carry-over seed for the *next* week, derived from an accepted Schedule
// (ADR-0002). Keyed by employee id; field shapes match ReqEmployee's carry-over
// fields so each entry can be pasted onto next week's employee.
export interface Carryover {
  carryover_burden: number;
  worked_last_weekend: boolean;
  prev_shift_end: string | null;
  prev_shift_was_night: boolean;
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
  next_carryover: Record<string, Carryover>;
}
export interface ValidateResponse extends BuildResult {
  assignments: Assignments;
  score: ScoreInfo | null;
  flags: Flag[];
  next_carryover: Record<string, Carryover>;
}

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
```

## backend/tests/test_next_carryover.py (NEW)

```python
"""next_week_carryover (ADR-0002 continuity seam): the accepted Schedule for one
week derives the next week's carry-over seed. These pin the derivation edges;
test_api_carryover proves the seed actually round-trips through the public API."""
from __future__ import annotations

from app.carryover import next_week_carryover
from app.domain import Schedule
from app.requirements import EmployeeIn
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


def test_seed_keys_are_valid_employee_input_fields():
    """Every next_carryover key must be a real EmployeeIn carry-over field, so a
    seed entry pastes onto next week's employee without drift (the shape is also
    mirrored in serialize.py and the frontend types)."""
    a = emp("a")
    keys = set(next_week_carryover(_schedule([], [a]))["a"])
    assert keys == {"carryover_burden", "worked_last_weekend",
                    "prev_shift_end", "prev_shift_was_night"}
    assert keys <= set(EmployeeIn.model_fields)


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

## backend/tests/test_carryover.py (existing — domain-level carry-over rules)

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
```

## backend/tests/test_api_carryover.py (CHANGED)

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


def test_next_carryover_round_trips_and_drives_next_week(client):
    """The continuity seam (ADR-0002): working a weekend night this week produces a
    next_carryover seed that, replayed as next week's input, fires R7 (consecutive
    weekends) — proving the accepted Schedule actually seeds the following week."""
    # Week 1: Dana works the Friday night.
    seat_id, _ = _worker_seat_id(client, WEEKEND_ORG)
    wk1 = client.post("/api/validate",
                      json={"requirements": WEEKEND_ORG,
                            "assignments": {seat_id: "dana"}}).json()
    seed = wk1["next_carryover"]["dana"]
    assert seed["worked_last_weekend"] is True
    assert seed["prev_shift_was_night"] is True
    assert seed["prev_shift_end"] == "2026-06-27T06:00:00"   # local-naive, no offset
    assert seed["carryover_burden"] == 1

    # Week 2: same org, next week, Dana seeded from week 1's carry-over.
    wk2_doc = copy.deepcopy(WEEKEND_ORG)
    wk2_doc["week_start"] = "2026-06-28"
    wk2_doc["employees"][0].update(seed)
    seat_id2, _ = _worker_seat_id(client, wk2_doc)
    wk2 = client.post("/api/validate",
                      json={"requirements": wk2_doc,
                            "assignments": {seat_id2: "dana"}}).json()
    assert wk2["errors"] == [], wk2["errors"]
    assert any(f["rule"] == "R7" and f["kind"] == "soft" for f in wk2["flags"])

    # Control: without the seed, the identical week-2 assignment raises no R7.
    bare = copy.deepcopy(WEEKEND_ORG)
    bare["week_start"] = "2026-06-28"
    seat_id3, _ = _worker_seat_id(client, bare)
    plain = client.post("/api/validate",
                        json={"requirements": bare,
                              "assignments": {seat_id3: "dana"}}).json()
    assert not any(f["rule"] == "R7" for f in plain["flags"])


def test_solve_response_includes_next_carryover(client):
    """The seam is exposed on /api/solve too, with one entry per employee."""
    r = client.post("/api/solve", json={"requirements": ORG, "seconds": 1}).json()
    assert r["errors"] == [], r["errors"]
    assert set(r["next_carryover"]) == {"dana"}
    assert set(r["next_carryover"]["dana"]) == {
        "carryover_burden", "worked_last_weekend", "prev_shift_end", "prev_shift_was_night"}


def test_error_responses_keep_the_full_response_shape(client):
    """next_carryover and assignments are present even on error responses, so the
    declared SolveResponse/ValidateResponse types hold on every path."""
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["prev_shift_end"] = "2026-06-20T23:00:00+03:00"  # tz-aware -> error
    v = client.post("/api/validate", json={"requirements": doc, "assignments": {}}).json()
    assert v["errors"] and v["next_carryover"] == {} and v["assignments"] == {}
    s = client.post("/api/solve", json={"requirements": doc}).json()
    assert s["errors"] and s["next_carryover"] == {} and s["assignments"] == {}
```

## backend/tests/conftest.py (test builders)

```python
"""Shared builders for scheduling tests.

Two builder styles:
  * ``shift_h`` — place a shift at an absolute number of hours after the week
    start. Ideal for rest-gap / night-recovery boundary tests (minute precision).
  * ``day_shift`` — place a shift on a weekday offset (0=Sun .. 6=Sat). Ideal for
    day-off / weekend / one-shift-per-day tests.

``evaluate`` scores a hand-set assignment with Timefold (authoritative) and derives
the human-readable flags, mirroring the Override re-validation path exactly.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from itertools import count

import pytest

from app.analysis import derive_flags
from app.config import LEGAL_REST_MINUTES, NIGHT_REST_MINUTES
from app.domain import Employee, Schedule, Seat, Shift, ShiftType
from app.solver import analyze

WEEK_SUN = date(2026, 6, 21)            # Sunday
BASE = datetime(2026, 6, 21, 0, 0)      # week start, midnight
LEGAL_H = LEGAL_REST_MINUTES / 60       # 8h
NIGHT_H = NIGHT_REST_MINUTES / 60       # 24h

_ids = count(1)


def _sid(prefix: str) -> str:
    return f"{prefix}-{next(_ids)}"


def emp(id, roles=("r",), projects=("p",), team="t1", **kw) -> Employee:
    return Employee(id, id.capitalize(), team, frozenset(roles), frozenset(projects), **kw)


def shift_h(start_h: float, dur_h: float, night=False, team="t1", id=None) -> Shift:
    """A shift starting ``start_h`` hours after the week's Sunday 00:00."""
    s = BASE + timedelta(hours=start_h)
    e = s + timedelta(hours=dur_h)
    sid = id or _sid("shift")
    st = ShiftType(f"st-{sid}", "S", night, s.hour, e.hour)
    return Shift(sid, st, team, "s1", s, e)


def day_shift(day_offset: int, start=8.0, dur=8.0, night=False, team="t1", id=None) -> Shift:
    return shift_h(day_offset * 24 + start, dur, night=night, team=team, id=id)


def seat(sh: Shift, eligible, employee=None, project="p", role="r", kind="worker",
         sid=None) -> Seat:
    return Seat(sid or _sid("seat"), kind, sh, sh.team_id, project, role,
               eligible=list(eligible), employee=employee)


def manager_seat(sh: Shift, eligible, employee=None, sid=None) -> Seat:
    return Seat(sid or _sid("mseat"), "manager", sh, sh.team_id, None, None,
               eligible=list(eligible), employee=employee)


def evaluate(seats, employees=None):
    """Score a hand-set assignment and return (timefold_score, flags)."""
    shifts = list({s.shift.id: s.shift for s in seats}.values())
    if employees is None:
        seen = {}
        for s in seats:
            for e in list(s.eligible) + ([s.employee] if s.employee else []):
                seen[e.id] = e
        employees = list(seen.values())
    sched = Schedule(list(employees), shifts, list(seats))
    analyze(sched)
    return sched.score, derive_flags(sched)


def rules(flags, kind=None):
    return [f["rule"] for f in flags if kind is None or f["kind"] == kind]


def has(flags, rule, kind=None):
    return rule in rules(flags, kind)


def hard_rules(flags):
    return rules(flags, "hard")


def soft_rules(flags):
    return rules(flags, "soft")


@pytest.fixture(scope="session")
def default_solution():
    """Solve the real seed dataset once for the whole session."""
    from app.data import build_lookup, build_schedule, default_dataset
    from app.solver import solve
    ds = default_dataset()
    solved = solve(build_schedule(ds), spent=10, unimproved=3)
    return ds, solved, build_lookup(ds)
```

## git diff (tracked changes only; the NEW files above are untracked)

```diff
diff --git a/backend/app/main.py b/backend/app/main.py
index 94d7205..9e097a9 100644
--- a/backend/app/main.py
+++ b/backend/app/main.py
@@ -17,6 +17,7 @@ from fastapi.staticfiles import StaticFiles
 from pydantic import BaseModel
 
 from .analysis import derive_flags
+from .carryover import next_week_carryover
 from .config import ALLOWED_ORIGINS, MAX_REQUEST_BYTES, MAX_SOLVE_SECONDS
 from .data import build_lookup, build_schedule, default_dataset
 from .requirements import (RequirementsIn, dataset_to_requirements, to_dataset,
@@ -95,11 +96,12 @@ def post_build(req: BuildRequest) -> dict:
 def post_solve(req: SolveRequest) -> dict:
     if req.seconds is not None and not (1 <= req.seconds <= MAX_SOLVE_SECONDS):
         return {"errors": [f"seconds must be between 1 and {MAX_SOLVE_SECONDS}."],
-                "warnings": [], "dataset": None, "assignments": {}, "score": None, "flags": []}
+                "warnings": [], "dataset": None, "assignments": {}, "score": None,
+                "flags": [], "next_carryover": {}}
     mat, errors, warnings = _materialize(req.requirements)
     if mat is None:
         return {"errors": errors, "warnings": warnings, "dataset": None,
-                "assignments": {}, "score": None, "flags": []}
+                "assignments": {}, "score": None, "flags": [], "next_carryover": {}}
     ds, schedule, lookup = mat
     solved = solve(schedule, spent=(req.seconds or 8), unimproved=2)
     return {
@@ -108,6 +110,7 @@ def post_solve(req: SolveRequest) -> dict:
         "assignments": assignments_of(solved),
         "score": score_breakdown(solved),
         "flags": derive_flags(solved, lookup),
+        "next_carryover": next_week_carryover(solved),
     }
 
 
@@ -116,13 +119,13 @@ def post_validate(req: ValidateRequest) -> dict:
     mat, errors, warnings = _materialize(req.requirements)
     if mat is None:
         return {"errors": errors, "warnings": warnings, "dataset": None,
-                "score": None, "flags": []}
+                "assignments": {}, "score": None, "flags": [], "next_carryover": {}}
     ds, schedule, lookup = mat
     employees_by_id = {e.id: e for e in ds.employees}
     assignment_errors = validate_assignments(schedule, req.assignments, employees_by_id)
     if assignment_errors:
         return {"errors": assignment_errors, "warnings": warnings, "dataset": None,
-                "score": None, "flags": []}
+                "assignments": {}, "score": None, "flags": [], "next_carryover": {}}
     apply_assignments(schedule, req.assignments, employees_by_id)
     return {
         "errors": [], "warnings": warnings,
@@ -130,6 +133,7 @@ def post_validate(req: ValidateRequest) -> dict:
         "assignments": assignments_of(schedule),
         "score": score_breakdown(schedule),
         "flags": derive_flags(schedule, lookup),
+        "next_carryover": next_week_carryover(schedule),
     }
 
 
diff --git a/backend/app/requirements.py b/backend/app/requirements.py
index cc692c7..6f28a4c 100644
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
 
@@ -67,7 +72,7 @@ class EmployeeIn(BaseModel):
     # --- Carry-over (ADR-0002): prior-week state that feeds this week's solve ---
     carryover_burden: int = 0
     worked_last_weekend: bool = False
-    prev_shift_end: str | None = None        # ISO datetime; R3/R6 across the week boundary
+    prev_shift_end: str | None = None        # local-naive ISO datetime; R3/R6 across the week boundary
     prev_shift_was_night: bool = False       # whether that last shift was a Night Shift
     avoid_shift_ids: list[str] = Field(default_factory=list)  # negative Preferences (R10)
 
@@ -99,12 +104,27 @@ def _dupes(ids: list[str]) -> list[str]:
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
+    if dt.tzinfo is not None:
+        raise ValueError(f"prev_shift_end must be a local (timezone-naive) ISO "
+                         f"datetime, got {s!r}")
+    return dt
 
 
 def _bad_date(s: str) -> bool:
@@ -188,9 +208,18 @@ def validate_requirements(req: RequirementsIn) -> tuple[list[str], list[str]]:
                 errors.append(f"Employee {e.id!r} is on project {pid!r} which is not in their team.")
         if e.carryover_burden < 0:
             errors.append(f"Employee {e.id!r}: carry-over burden cannot be negative.")
-        if e.prev_shift_end is not None and _bad_datetime(e.prev_shift_end):
-            errors.append(f"Employee {e.id!r}: prev_shift_end {e.prev_shift_end!r} "
-                          f"is not a valid ISO datetime.")
+        if e.prev_shift_end is not None:
+            dt = _parse_datetime(e.prev_shift_end)
+            if dt is None:
+                errors.append(f"Employee {e.id!r}: prev_shift_end {e.prev_shift_end!r} "
+                              f"is not a valid ISO datetime.")
+            elif dt.tzinfo is not None:
+                # Schedule times are local-naive (data.py builds them with
+                # datetime.combine, no tz). A timezone-aware carry-over time would
+                # later be subtracted from naive shift times and crash the
+                # solve/score path, so reject it at the edge.
+                errors.append(f"Employee {e.id!r}: prev_shift_end {e.prev_shift_end!r} "
+                              f"must be a local (timezone-naive) ISO datetime.")
         if not e.roles and not e.can_manage:
             warnings.append(f"Employee {e.id!r} has no role and cannot manage — unusable.")
 
@@ -270,7 +299,7 @@ def to_dataset(req: RequirementsIn) -> Dataset:
                  avoid_shift_ids=frozenset(e.avoid_shift_ids),
                  carryover_burden=e.carryover_burden,
                  worked_last_weekend=e.worked_last_weekend,
-                 prev_shift_end=datetime.fromisoformat(e.prev_shift_end) if e.prev_shift_end else None,
+                 prev_shift_end=_naive_datetime(e.prev_shift_end),
                  prev_shift_was_night=e.prev_shift_was_night)
         for e in req.employees
     ]
diff --git a/backend/app/serialize.py b/backend/app/serialize.py
index 883229c..9b16a29 100644
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
diff --git a/backend/tests/test_api_carryover.py b/backend/tests/test_api_carryover.py
index 64f49bb..d8adda2 100644
--- a/backend/tests/test_api_carryover.py
+++ b/backend/tests/test_api_carryover.py
@@ -92,3 +92,91 @@ def test_no_carryover_means_clean_first_shift_via_api(client):
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
+def test_next_carryover_round_trips_and_drives_next_week(client):
+    """The continuity seam (ADR-0002): working a weekend night this week produces a
+    next_carryover seed that, replayed as next week's input, fires R7 (consecutive
+    weekends) — proving the accepted Schedule actually seeds the following week."""
+    # Week 1: Dana works the Friday night.
+    seat_id, _ = _worker_seat_id(client, WEEKEND_ORG)
+    wk1 = client.post("/api/validate",
+                      json={"requirements": WEEKEND_ORG,
+                            "assignments": {seat_id: "dana"}}).json()
+    seed = wk1["next_carryover"]["dana"]
+    assert seed["worked_last_weekend"] is True
+    assert seed["prev_shift_was_night"] is True
+    assert seed["prev_shift_end"] == "2026-06-27T06:00:00"   # local-naive, no offset
+    assert seed["carryover_burden"] == 1
+
+    # Week 2: same org, next week, Dana seeded from week 1's carry-over.
+    wk2_doc = copy.deepcopy(WEEKEND_ORG)
+    wk2_doc["week_start"] = "2026-06-28"
+    wk2_doc["employees"][0].update(seed)
+    seat_id2, _ = _worker_seat_id(client, wk2_doc)
+    wk2 = client.post("/api/validate",
+                      json={"requirements": wk2_doc,
+                            "assignments": {seat_id2: "dana"}}).json()
+    assert wk2["errors"] == [], wk2["errors"]
+    assert any(f["rule"] == "R7" and f["kind"] == "soft" for f in wk2["flags"])
+
+    # Control: without the seed, the identical week-2 assignment raises no R7.
+    bare = copy.deepcopy(WEEKEND_ORG)
+    bare["week_start"] = "2026-06-28"
+    seat_id3, _ = _worker_seat_id(client, bare)
+    plain = client.post("/api/validate",
+                        json={"requirements": bare,
+                              "assignments": {seat_id3: "dana"}}).json()
+    assert not any(f["rule"] == "R7" for f in plain["flags"])
+
+
+def test_solve_response_includes_next_carryover(client):
+    """The seam is exposed on /api/solve too, with one entry per employee."""
+    r = client.post("/api/solve", json={"requirements": ORG, "seconds": 1}).json()
+    assert r["errors"] == [], r["errors"]
+    assert set(r["next_carryover"]) == {"dana"}
+    assert set(r["next_carryover"]["dana"]) == {
+        "carryover_burden", "worked_last_weekend", "prev_shift_end", "prev_shift_was_night"}
+
+
+def test_error_responses_keep_the_full_response_shape(client):
+    """next_carryover and assignments are present even on error responses, so the
+    declared SolveResponse/ValidateResponse types hold on every path."""
+    doc = copy.deepcopy(ORG)
+    doc["employees"][0]["prev_shift_end"] = "2026-06-20T23:00:00+03:00"  # tz-aware -> error
+    v = client.post("/api/validate", json={"requirements": doc, "assignments": {}}).json()
+    assert v["errors"] and v["next_carryover"] == {} and v["assignments"] == {}
+    s = client.post("/api/solve", json={"requirements": doc}).json()
+    assert s["errors"] and s["next_carryover"] == {} and s["assignments"] == {}
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
diff --git a/docs/adr/0002-schedules-are-continuous-across-weeks.md b/docs/adr/0002-schedules-are-continuous-across-weeks.md
index c11d99f..f748e19 100644
--- a/docs/adr/0002-schedules-are-continuous-across-weeks.md
+++ b/docs/adr/0002-schedules-are-continuous-across-weeks.md
@@ -19,3 +19,21 @@ The system is not stateless per week. There is coupling between consecutive
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
+    `{employee_id: {…}}` map derived from the accepted Schedule by
+    `carryover.next_week_carryover`. Its field names and shapes match
+    `EmployeeIn`, so the client pastes each entry onto the corresponding employee
+    to seed the following week.
+
+The client (or a future persistence layer) owns storing the accepted Schedule and
+replaying `next_carryover`; the server only computes the seed. `prev_shift_end` is
+emitted local-naive, matching the input datetime contract.
diff --git a/frontend/src/types.ts b/frontend/src/types.ts
index 32767b3..ab1f204 100644
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
@@ -126,6 +128,16 @@ export interface RequirementsDoc {
   config?: { legal_rest_hours: number; night_rest_hours: number; weekend_days: string[] };
 }
 
+// Carry-over seed for the *next* week, derived from an accepted Schedule
+// (ADR-0002). Keyed by employee id; field shapes match ReqEmployee's carry-over
+// fields so each entry can be pasted onto next week's employee.
+export interface Carryover {
+  carryover_burden: number;
+  worked_last_weekend: boolean;
+  prev_shift_end: string | null;
+  prev_shift_was_night: boolean;
+}
+
 export interface BuildResult {
   errors: string[];
   warnings: string[];
@@ -135,11 +147,13 @@ export interface SolveResponse extends BuildResult {
   assignments: Assignments;
   score: ScoreInfo | null;
   flags: Flag[];
+  next_carryover: Record<string, Carryover>;
 }
 export interface ValidateResponse extends BuildResult {
   assignments: Assignments;
   score: ScoreInfo | null;
   flags: Flag[];
+  next_carryover: Record<string, Carryover>;
 }
 
 export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
```
