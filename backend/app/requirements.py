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

from datetime import date, datetime, timedelta

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
    # None = the referenced site was deleted; the editor shows "Please choose" and
    # validation blocks with a clear "choose one" error until a site is picked.
    site: str | None = None


class ProjectIn(BaseModel):
    id: str
    name: str
    teams: list[str] = Field(default_factory=list)   # ADR-0003: one-or-more teams/sites
    # The editor's per-week tick: an unticked project stays in the org (memberships,
    # demand rows) but none of its crew materialises seats this week.
    runs_this_week: bool = True


EMPLOYEE_STATUSES = ("active", "on-leave", "inactive")


class EmployeeIn(BaseModel):
    id: str
    name: str
    team: str | None = None   # None = deleted team, pending a "Please choose"
    roles: list[str] = Field(default_factory=list)
    projects: list[str] = Field(default_factory=list)
    can_manage: bool = False
    # --- HR metadata (round-trip only; only `status` affects scheduling) ---
    # Only `status == "active"` employees are scheduled; others are kept in the roster
    # (and export) but excluded from coverage/eligibility/the materialised dataset.
    status: str = "active"
    employee_number: str | None = None
    email: str | None = None
    phone: str | None = None
    hire_date: str | None = None
    notes: str | None = None
    # --- Carry-over (ADR-0002): prior-week state that feeds this week's solve ---
    carryover_burden: int = 0
    worked_last_weekend: bool = False
    prev_shift_end: str | None = None        # local-naive ISO datetime; R3/R6 across the week boundary
    prev_shift_was_night: bool = False       # whether that last shift was a Night Shift
    avoid_shift_ids: list[str] = Field(default_factory=list)  # negative Preferences (R10)
    unavailable_dates: list[str] = Field(default_factory=list)  # ISO dates the person can't work
    preferred_shift_type_ids: list[str] = Field(default_factory=list)  # preferred shift TYPES (R11)


class DemandIn(BaseModel):
    team: str | None = None         # None = deleted team, pending a "Please choose"
    shift_type: str | None = None   # None = deleted shift type, ditto
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
    # Strict canonical YYYY-MM-DD only. `date.fromisoformat` also accepts ISO basic/week
    # forms (e.g. '20260622', '2026-W26-1'); round-tripping through `.isoformat()` rejects
    # those so the stored/round-tripped value is always canonical (matches the error text
    # and keeps week-identity comparisons in the carry-over seed exact).
    try:
        return date.fromisoformat(s).isoformat() != s
    except (ValueError, TypeError):
        return True


def _estimated_seats(req: RequirementsIn) -> int:
    """Upper bound on materialised seats: per demand row, one manager seat plus
    the crew total, for each selected day. Over-counts shifts shared across rows,
    which is fine for a guard. Counts EFFECTIVE demand — crew paused by the
    per-week project tick never materialises, so it must not trip the guard."""
    total = 0
    for _i, d, crew in _effective_demand(req):
        crew_total = sum(c for roles in crew.values() for c in roles.values() if c > 0)
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

    # teams -> sites. A None ref is a deleted site awaiting the editor's "Please
    # choose" — a distinct, actionable error rather than a spooky unknown-ref one.
    for t in req.teams:
        if t.site is None:
            errors.append(f"Team {t.id!r} has no site — choose one.")
        elif t.site not in site_ids:
            errors.append(f"Team {t.id!r} references unknown site {t.site!r}.")

    # projects -> teams (ADR-0003: a project runs under one or more teams)
    for p in req.projects:
        if not p.teams:
            errors.append(f"Project {p.id!r} must belong to at least one team.")
        for tid in p.teams:
            if tid not in team_ids:
                errors.append(f"Project {p.id!r} references unknown team {tid!r}.")

    # employees
    for e in req.employees:
        if e.status not in EMPLOYEE_STATUSES:
            errors.append(f"Employee {e.id!r} has invalid status {e.status!r} "
                          f"(expected one of {', '.join(EMPLOYEE_STATUSES)}).")
        if e.team is None:
            errors.append(f"Employee {e.id!r} has no team — choose one.")
        elif e.team not in team_ids:
            errors.append(f"Employee {e.id!r} references unknown team {e.team!r}.")
        for r in e.roles:
            if r not in role_ids:
                errors.append(f"Employee {e.id!r} has unknown role {r!r}.")
        for pid in e.projects:
            proj = project_by_id.get(pid)
            if proj is None:
                errors.append(f"Employee {e.id!r} on unknown project {pid!r}.")
            elif e.team is not None and e.team not in proj.teams:
                # With no team at all, the "choose one" error above is the real problem;
                # membership can only be judged once a team is picked.
                errors.append(f"Employee {e.id!r} is on project {pid!r} which does not run in their team.")
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
        for d in e.unavailable_dates:
            if _bad_date(d):
                errors.append(f"Employee {e.id!r}: unavailable date {d!r} is not a valid "
                              f"ISO date (YYYY-MM-DD).")
        for stid in e.preferred_shift_type_ids:
            if stid not in st_ids:
                errors.append(f"Employee {e.id!r} prefers unknown shift type {stid!r}.")
        # Only active employees are scheduled, so an "unusable" warning is meaningless
        # for inactive / on-leave HR rows (they are intentionally never scheduled).
        if e.status == "active" and not e.roles and not e.can_manage:
            warnings.append(f"Employee {e.id!r} has no role and cannot manage — unusable.")

    # demand
    # A concrete shift is (team, shift_type, day): build_schedule mints one Shift per
    # selected day. Two rows MAY share a (team, shift_type) pair with disjoint days —
    # crew composition can vary by day (CONTEXT.md) — but a day covered twice means one
    # concrete shift with two defining rows: colliding seat ids when the crews share a
    # (project, role), ambiguous demand otherwise. Reject only the overlapping day(s).
    seen_days: dict[tuple[str, str], set[str]] = {}
    # Shift ids concatenate the pair with '-' (data.py: shift-{team}-{shiftType}-{date}),
    # so two DIFFERENT pairs can mint the same id string (teams 't' + 't-a' with shift
    # types 'a-b' + 'b' both give 'shift-t-a-b-…'). The second row would silently reuse
    # the first row's Shift and collide seat ids — reject the ambiguity outright.
    seen_concat: dict[str, tuple[int, tuple[str, str]]] = {}
    # Rows that will not run this week (their entire crew is paused by the per-week
    # project tick) mint no shifts, so the shift-identity checks below must skip them —
    # an active row overlapping a paused-only row is NOT a collision this week. (If the
    # project is re-ticked later, validation fires then, when it's real.)
    running_rows = {i for i, _d, _crew in _effective_demand(req)}
    for i, d in enumerate(req.demand):
        where = f"Demand #{i + 1}"
        if d.team is None:
            errors.append(f"{where} has no team — choose one.")
        elif d.team not in team_ids:
            errors.append(f"{where} references unknown team {d.team!r}.")
        if d.shift_type is None:
            errors.append(f"{where} has no shift type — choose one.")
        elif d.shift_type not in st_ids:
            errors.append(f"{where} references unknown shift type {d.shift_type!r}.")
        # The shift-identity checks only make sense for a fully-specified pair — a row
        # with a pending "choose one" is already blocked above, and two half-empty rows
        # must not spuriously read as duplicates of each other. Paused-only rows mint
        # no shifts at all (see above), so they skip these checks too.
        if d.team is not None and d.shift_type is not None and i in running_rows:
            pair = (d.team, d.shift_type)
            first_concat = seen_concat.setdefault(f"{d.team}-{d.shift_type}", (i, pair))
            if first_concat[1] != pair:
                errors.append(f"{where} (team {d.team!r} + shift type {d.shift_type!r}) and "
                              f"Demand #{first_concat[0] + 1} (team {first_concat[1][0]!r} + "
                              f"shift type {first_concat[1][1]!r}) mint the same shift id "
                              f"'shift-{d.team}-{d.shift_type}-…'; rename the team or shift "
                              f"type ids so they don't collide.")
            earlier_days = seen_days.setdefault(pair, set())
            overlap = sorted(set(d.days) & earlier_days,
                             key=lambda day: (DAY_ORDER.index(day) if day in DAY_ORDER
                                              else len(DAY_ORDER), day))
            if overlap:
                errors.append(f"{where} duplicates team {d.team!r} + shift type {d.shift_type!r} "
                              f"on {', '.join(overlap)} — already defined by an earlier demand "
                              f"row; a (team, shift type, day) shift must come from a single row.")
            earlier_days.update(d.days)
        if not d.days:
            errors.append(f"{where} has no days selected.")
        for day in d.days:
            if day not in DAY_TO_WEEKDAY:
                errors.append(f"{where} has invalid day {day!r}.")
        # Within one row, seat ids concatenate project + role the same way
        # (data.py: seat-{shift_id}-{project}-{role}-{n}), so two different crew
        # entries can mint identical Seat PlanningIds — Timefold rejects those hard.
        seen_crew_concat: dict[str, tuple[str, str]] = {}
        for pid, roles in d.crew.items():
            proj = project_by_id.get(pid)
            if proj is None:
                errors.append(f"{where} crew references unknown project {pid!r}.")
            elif d.team is not None and d.team not in proj.teams:
                errors.append(f"{where} crew project {pid!r} does not run in team {d.team!r}.")
            for rid, count in roles.items():
                first_crew = seen_crew_concat.setdefault(f"{pid}-{rid}", (pid, rid))
                if first_crew != (pid, rid):
                    errors.append(f"{where} crew entries {first_crew[0]!r}/{first_crew[1]!r} "
                                  f"and {pid!r}/{rid!r} mint the same seat id fragment "
                                  f"'{pid}-{rid}'; rename the project or role ids so they "
                                  f"don't collide.")
                if rid not in role_ids:
                    errors.append(f"{where} crew references unknown role {rid!r}.")
                if count < 1:
                    errors.append(f"{where} crew count for {pid}/{rid} must be ≥ 1.")

    # week start
    if req.week_start is not None and _bad_date(req.week_start):
        errors.append(f"week_start {req.week_start!r} is not a valid ISO date.")

    # problem-size guards (resource exhaustion). MAX_EMPLOYEES bounds *problem facts*
    # — only active employees are materialised into the solve (to_dataset), so inactive
    # / on-leave HR rows must not count against it (status never affects the solve).
    # Total roster size (incl. inactive) is bounded separately by MAX_REQUEST_BYTES.
    active_count = sum(1 for e in req.employees if e.status == "active")
    if active_count > MAX_EMPLOYEES:
        errors.append(f"Too many active employees: {active_count} exceeds the "
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
    if seed.employees and not seed.source_feasible:
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


def _unavailable_on(emp: EmployeeIn, day: date) -> bool:
    # `unavailable_dates` are validated as ISO before coverage runs (only reached when
    # there are no blocking errors), so direct parsing is safe.
    return any(date.fromisoformat(d) == day for d in emp.unavailable_dates)


def _effective_demand(req: RequirementsIn) -> list[tuple[int, DemandIn, dict[str, dict[str, int]]]]:
    """(row index, row, effective crew) for the demand rows that materialise THIS
    week: crew of paused projects (the editor's `runs_this_week` tick, off) is
    dropped, and a row whose crew existed only for paused projects doesn't run at
    all. An authored empty-crew row is different — that's a deliberate manager-only
    shift and still runs. `to_dataset`, the coverage warnings, the seat estimate and
    the shift-identity validation all go through here so they can't disagree."""
    runs = {p.id: p.runs_this_week for p in req.projects}
    eff: list[tuple[int, DemandIn, dict[str, dict[str, int]]]] = []
    for i, d in enumerate(req.demand):
        crew = {pid: roles for pid, roles in d.crew.items() if runs.get(pid, True)}
        if d.crew and not crew:
            continue
        eff.append((i, d, crew))
    return eff


def _demand_dates(week_start: date, days: list[str]) -> list[date]:
    """The concrete dates a demand's weekday names land on, mirroring build_schedule."""
    weekdays = {DAY_TO_WEEKDAY[d] for d in days if d in DAY_TO_WEEKDAY}
    return [week_start + timedelta(days=off) for off in range(7)
            if (week_start + timedelta(days=off)).weekday() in weekdays]


def _coverage_warnings(req: RequirementsIn, warnings: list[str]) -> None:
    # Only active employees are scheduled, so coverage must reason about them only —
    # otherwise an inactive manager would suppress the no-manager warning, etc.
    # Mirrors worker/manager eligibility in data.py (active-only, same-team, role/project,
    # and Unavailability per date); test_unavailability pins the two against built seats.
    active = [e for e in req.employees if e.status == "active"]
    week_start = date.fromisoformat(req.week_start) if req.week_start else Dataset.week_start
    # Rows/crew paused by the per-week project tick don't materialise seats, so they
    # must not warn either (same filter as to_dataset).
    effective = [(d, crew) for _i, d, crew in _effective_demand(req)]
    teams_with_demand = {d.team for d, _ in effective}
    for team in req.teams:
        if team.id not in teams_with_demand:
            continue
        managers = [e for e in active if e.team == team.id and e.can_manage]
        if not managers:
            warnings.append(f"Team {team.id!r} has demand but no shift-manager-eligible "
                            f"employee — manager seats will be unfilled.")
            continue
        # Availability-aware: a date on which every eligible manager is unavailable.
        dates = sorted({dt for d, _ in effective if d.team == team.id
                        for dt in _demand_dates(week_start, d.days)})
        for dt in dates:
            if all(_unavailable_on(m, dt) for m in managers):
                warnings.append(f"Team {team.id!r} has no available shift manager on "
                                f"{dt.isoformat()} — that manager seat will be unfilled.")
    for d, crew in effective:
        dates = _demand_dates(week_start, d.days)
        for pid, roles in crew.items():
            for rid in roles:
                # Same-team predicate mirrors worker eligibility (ADR-0003): only an
                # active employee in the demand's team can fill its seats automatically.
                eligible = [e for e in active
                            if pid in e.projects and rid in e.roles and e.team == d.team]
                if not eligible:
                    warnings.append(f"No employee can fill {rid} on {pid} — those seats "
                                    f"will be unfilled.")
                    continue
                # Availability-aware: a date on which every eligible worker is unavailable.
                for dt in dates:
                    if all(_unavailable_on(e, dt) for e in eligible):
                        warnings.append(f"Everyone who can fill {rid} on {pid} is unavailable "
                                        f"on {dt.isoformat()} — those seats will be unfilled.")


# --- conversion --------------------------------------------------------------

def to_dataset(req: RequirementsIn) -> Dataset:
    sites = [Site(s.id, s.name) for s in req.sites]
    roles = [Role(r.id, r.name) for r in req.roles]
    shift_types = [ShiftType(s.id, s.name, s.is_night, s.start, s.end) for s in req.shift_types]
    teams = [Team(t.id, t.name, t.site) for t in req.teams]
    projects = [Project(p.id, p.name, frozenset(p.teams)) for p in req.projects]
    # Only active employees are materialised into the solve (HR status, Phase 2);
    # inactive / on-leave people stay in the roster + export but are never scheduled.
    employees = [
        Employee(e.id, e.name, e.team, frozenset(e.roles), frozenset(e.projects),
                 can_manage=e.can_manage,
                 avoid_shift_ids=frozenset(e.avoid_shift_ids),
                 unavailable_dates=frozenset(date.fromisoformat(d) for d in e.unavailable_dates),
                 preferred_shift_type_ids=frozenset(e.preferred_shift_type_ids),
                 carryover_burden=e.carryover_burden,
                 worked_last_weekend=e.worked_last_weekend,
                 prev_shift_end=_naive_datetime(e.prev_shift_end),
                 prev_shift_was_night=e.prev_shift_was_night)
        for e in req.employees if e.status == "active"
    ]
    # Per-week project tick: paused crew never materialises (shared _effective_demand
    # filter — coverage warnings use the same one).
    demand = [
        (d.team, d.shift_type, [DAY_TO_WEEKDAY[day] for day in d.days], crew)
        for _i, d, crew in _effective_demand(req)
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
        "projects": [{"id": p.id, "name": p.name, "teams": sorted(p.team_ids),
                      "runs_this_week": True} for p in ds.projects],
        "employees": [{
            "id": e.id, "name": e.name, "team": e.team_id,
            "roles": sorted(e.role_ids), "projects": sorted(e.project_ids),
            "can_manage": e.can_manage,
            "status": "active", "employee_number": None, "email": None,
            "phone": None, "hire_date": None, "notes": None,
            "avoid_shift_ids": sorted(e.avoid_shift_ids),
            "unavailable_dates": sorted(d.isoformat() for d in e.unavailable_dates),
            "preferred_shift_type_ids": sorted(e.preferred_shift_type_ids),
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
