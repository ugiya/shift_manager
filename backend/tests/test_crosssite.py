"""ADR-0003: a Project can run across teams/sites. Each site staffs its own seats
automatically; a cross-site fill is only reachable as an Exceptional Assignment."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

# Project 'apollo' runs in BOTH teams: t1 @ site s1 and t2 @ site s2.
ORG = {
    "sites": [{"id": "s1", "name": "S1"}, {"id": "s2", "name": "S2"}],
    "roles": [{"id": "dev", "name": "Dev"}],
    "shift_types": [{"id": "m", "name": "Morning", "start": 8, "end": 16, "is_night": False}],
    "teams": [{"id": "t1", "name": "T1", "site": "s1"}, {"id": "t2", "name": "T2", "site": "s2"}],
    "projects": [{"id": "apollo", "name": "Apollo", "teams": ["t1", "t2"]}],
    "employees": [
        {"id": "e1", "name": "E1", "team": "t1", "roles": ["dev"], "projects": ["apollo"], "can_manage": True},
        {"id": "e2", "name": "E2", "team": "t2", "roles": ["dev"], "projects": ["apollo"], "can_manage": True},
    ],
    "demand": [
        {"team": "t1", "shift_type": "m", "days": ["Sun"], "crew": {"apollo": {"dev": 1}}},
        {"team": "t2", "shift_type": "m", "days": ["Sun"], "crew": {"apollo": {"dev": 1}}},
    ],
    "week_start": "2026-06-21",
}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _worker_seat(built, team_id):
    return next(s for s in built["dataset"]["seats"]
                if s["kind"] == "worker" and s["team_id"] == team_id)


def test_cross_site_project_is_valid_and_staffs_per_site(client):
    built = client.post("/api/build", json={"requirements": ORG}).json()
    assert built["errors"] == [], built["errors"]
    # each site's worker seat only offers its OWN team's employee (same-team eligibility)
    assert _worker_seat(built, "t1")["eligible_employee_ids"] == ["e1"]
    assert _worker_seat(built, "t2")["eligible_employee_ids"] == ["e2"]


def test_cross_site_override_is_exceptional(client):
    built = client.post("/api/build", json={"requirements": ORG}).json()
    t1_seat = _worker_seat(built, "t1")["id"]
    # putting t2's employee on t1's (other-site) seat is an Exceptional Assignment
    cross = client.post("/api/validate",
                        json={"requirements": ORG, "assignments": {t1_seat: "e2"}}).json()
    assert cross["errors"] == [], cross["errors"]
    assert any(f["rule"] == "EXC" for f in cross["flags"])
    # the same-team assignment is clean (no Exceptional)
    same = client.post("/api/validate",
                       json={"requirements": ORG, "assignments": {t1_seat: "e1"}}).json()
    assert not any(f["rule"] == "EXC" for f in same["flags"])
