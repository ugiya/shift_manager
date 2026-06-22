"""Data-driven invariants over the whole 4-site seed dataset.

Parametrized over every Site, Team, Project, Employee, Shift and Seat — each
entity gets its own test case, so the org model is checked exhaustively (and any
future dataset edit is validated automatically).
"""
from __future__ import annotations

from datetime import timedelta

import pytest

from app.data import build_schedule, default_dataset

DS = default_dataset()
SCHED = build_schedule(DS)

ROLE_IDS = {r.id for r in DS.roles}
TEAM_IDS = {t.id for t in DS.teams}
SITE_IDS = {s.id for s in DS.sites}
PROJECT_IDS = {p.id for p in DS.projects}
EMP_IDS = {e.id for e in DS.employees}
TEAM_BY_ID = {t.id: t for t in DS.teams}
PROJECT_BY_ID = {p.id: p for p in DS.projects}


# --- structural sanity -------------------------------------------------------

def test_ids_are_unique():
    for coll in (DS.sites, DS.roles, DS.teams, DS.projects, DS.employees, DS.shift_types):
        ids = [x.id for x in coll]
        assert len(ids) == len(set(ids)), f"duplicate id in {coll[0].__class__.__name__}"
    seat_ids = [s.id for s in SCHED.seats]
    assert len(seat_ids) == len(set(seat_ids))


def test_dataset_overall_shape():
    assert len(DS.sites) == 4
    assert len(DS.teams) == 6
    assert len(SCHED.seats) == 135


# --- per-entity (these expand into one test case each) -----------------------

@pytest.mark.parametrize("site", DS.sites, ids=lambda s: s.id)
def test_site_has_at_least_one_team(site):
    assert any(t.site_id == site.id for t in DS.teams)


@pytest.mark.parametrize("team", DS.teams, ids=lambda t: t.id)
def test_team_is_well_formed(team):
    assert team.site_id in SITE_IDS
    assert any(p.team_id == team.id for p in DS.projects), f"{team.id} has no project"
    mgrs = [e for e in DS.employees if e.team_id == team.id and e.can_manage]
    assert mgrs, f"{team.id} has no shift-manager-eligible employee"


@pytest.mark.parametrize("project", DS.projects, ids=lambda p: p.id)
def test_project_belongs_to_existing_team(project):
    assert project.team_id in TEAM_IDS


@pytest.mark.parametrize("emp", DS.employees, ids=lambda e: e.id)
def test_employee_is_well_formed(emp):
    assert emp.team_id in TEAM_IDS
    assert emp.role_ids <= ROLE_IDS, f"{emp.id} has unknown role"
    assert emp.project_ids <= PROJECT_IDS, f"{emp.id} has unknown project"
    # every project the employee is on belongs to that employee's team
    for pid in emp.project_ids:
        assert PROJECT_BY_ID[pid].team_id == emp.team_id
    # everyone has a function: a worker role and/or shift-manager capability
    assert emp.role_ids or emp.can_manage
    assert emp.carryover_burden >= 0


@pytest.mark.parametrize("shift", SCHED.shifts, ids=lambda s: s.id)
def test_shift_is_well_formed(shift):
    assert DS.week_start <= shift.start_date <= DS.week_start + timedelta(days=6)
    assert shift.start_dt < shift.end_dt
    assert shift.team_id in TEAM_IDS
    assert shift.site_id == TEAM_BY_ID[shift.team_id].site_id
    assert shift.is_night == shift.shift_type.is_night


@pytest.mark.parametrize("seat", SCHED.seats, ids=lambda s: s.id)
def test_seat_eligibility_is_correct(seat):
    assert seat.eligible, f"{seat.id} has an empty eligible pool (would be unstaffable)"
    if seat.kind == "worker":
        assert seat.project_id in PROJECT_IDS and seat.role_id in ROLE_IDS
        for e in seat.eligible:
            assert seat.project_id in e.project_ids, f"{e.id} not on {seat.project_id}"
            assert seat.role_id in e.role_ids, f"{e.id} lacks role {seat.role_id}"
    else:  # manager seat
        assert seat.project_id is None and seat.role_id is None
        for e in seat.eligible:
            assert e.can_manage and e.team_id == seat.team_id


@pytest.mark.parametrize("seat", SCHED.seats, ids=lambda s: s.id)
def test_seat_team_matches_its_shift(seat):
    assert seat.team_id == seat.shift.team_id
