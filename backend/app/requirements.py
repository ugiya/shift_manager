"""User-supplied scheduling requirements.

The interactive editor builds one of these documents and posts it to /api/build,
/api/solve and /api/validate. This module parses it (pydantic), validates it
(referential integrity + coverage warnings) and turns it into a domain `Dataset`.

Rule constants (legal/night rest, weekend days) stay global defaults — the editor
configures the org, people, skills, projects, shift types (incl. hours + night
flag) and demand.
"""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from .config import LEGAL_REST_MINUTES, NIGHT_REST_MINUTES, WEEKEND_WEEKDAYS
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
    carryover_burden: int = 0
    worked_last_weekend: bool = False


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
                 can_manage=e.can_manage, carryover_burden=e.carryover_burden,
                 worked_last_weekend=e.worked_last_weekend)
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
            "can_manage": e.can_manage, "carryover_burden": e.carryover_burden,
            "worked_last_weekend": e.worked_last_weekend,
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
