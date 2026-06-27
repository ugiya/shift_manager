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
                projects.append(Project(pid, pname, frozenset({t["id"]})))
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


def _eligible_workers(employees, project_id, role_id, team_id):
    # ADR-0003: a worker is eligible only for seats in their OWN team. For a project
    # that runs across teams/sites, each site staffs its own seats; a cross-site fill
    # is an Exceptional Assignment reachable only via a manual override.
    return [e for e in employees
            if project_id in e.project_ids and role_id in e.role_ids and e.team_id == team_id]


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
                            eligible=_eligible_workers(dataset.employees, project_id, role_id, team_id)))

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
