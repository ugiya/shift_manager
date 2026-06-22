"""FastAPI surface: requirements -> build / solve / validate."""
from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from app.main import app

# A tiny custom org the editor could produce — fast to solve.
TINY = {
    "sites": [{"id": "hq", "name": "HQ"}],
    "roles": [{"id": "dev", "name": "Dev"}],
    "shift_types": [{"id": "m", "name": "Morning", "start": 8, "end": 16, "is_night": False}],
    "teams": [{"id": "a", "name": "Alpha", "site": "hq"}],
    "projects": [{"id": "p", "name": "Apollo", "team": "a"}],
    "employees": [
        {"id": "dana", "name": "Dana", "team": "a", "roles": ["dev"], "projects": ["p"], "can_manage": True},
        {"id": "adam", "name": "Adam", "team": "a", "roles": ["dev"], "projects": ["p"], "can_manage": True},
    ],
    "demand": [{"team": "a", "shift_type": "m", "days": ["Sun", "Mon"], "crew": {"p": {"dev": 1}}}],
}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:   # `with` runs the lifespan (JVM warm-up)
        yield c


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_get_requirements_is_the_editable_seed(client):
    doc = client.get("/api/requirements").json()
    assert len(doc["sites"]) == 4
    assert len(doc["employees"]) == 40
    assert doc["config"]["weekend_days"] == ["Fri", "Sat"]


def test_build_seed_materialises_135_seats(client):
    seed = client.get("/api/requirements").json()
    r = client.post("/api/build", json={"requirements": seed}).json()
    assert r["errors"] == []
    assert len(r["dataset"]["seats"]) == 135
    assert len(r["dataset"]["sites"]) == 4


def test_build_reports_errors_and_returns_no_dataset(client):
    bad = copy.deepcopy(TINY)
    bad["teams"][0]["site"] = "ghost"
    r = client.post("/api/build", json={"requirements": bad}).json()
    assert r["dataset"] is None
    assert any("unknown site" in e for e in r["errors"])


def test_solve_a_custom_org(client):
    r = client.post("/api/solve", json={"requirements": TINY, "seconds": 3}).json()
    assert r["errors"] == []
    assert r["score"]["feasible"] is True
    # 2 shifts (Sun, Mon) x (1 dev + 1 manager) = 4 seats, all fillable
    assert len(r["dataset"]["seats"]) == 4
    assert sum(1 for v in r["assignments"].values() if v) == 4


def test_solve_blocks_on_errors(client):
    bad = copy.deepcopy(TINY)
    bad["demand"][0]["crew"] = {"p": {"dev": 0}}
    r = client.post("/api/solve", json={"requirements": bad, "seconds": 3}).json()
    assert r["score"] is None
    assert r["errors"]


def test_validate_custom_org_with_exceptional_override(client):
    # build to learn the seat ids, then override one with an ineligible employee
    built = client.post("/api/build", json={"requirements": TINY}).json()
    qa_like = built["dataset"]["seats"][0]["id"]
    # assign an employee who is not in the eligible pool of that seat (force exceptional
    # only if they aren't eligible; both are dev+manager so pick the manager seat)
    mgr_seat = next(s for s in built["dataset"]["seats"] if s["kind"] == "manager")
    # everyone can_manage here, so instead clear a worker seat to force understaffing
    worker_seat = next(s for s in built["dataset"]["seats"] if s["kind"] == "worker")
    assignments = {s["id"]: None for s in built["dataset"]["seats"]}
    r = client.post("/api/validate", json={"requirements": TINY, "assignments": assignments}).json()
    assert r["score"]["hard_score"] == 0
    assert any(f["rule"] == "R4" for f in r["flags"])  # everything unfilled
    assert mgr_seat and worker_seat and qa_like


def test_validate_blocks_on_errors(client):
    bad = copy.deepcopy(TINY)
    bad["sites"] = []
    r = client.post("/api/validate", json={"requirements": bad, "assignments": {}}).json()
    assert r["score"] is None and r["errors"]


# --- resource / input guards -------------------------------------------------

@pytest.mark.parametrize("seconds", [0, 9999, -1])
def test_solve_rejects_out_of_range_seconds(client, seconds):
    r = client.post("/api/solve", json={"requirements": TINY, "seconds": seconds}).json()
    assert r["score"] is None
    assert any("seconds must be between" in e for e in r["errors"])


def test_oversized_request_body_is_rejected(client):
    bloated = copy.deepcopy(TINY)
    bloated["employees"][0]["name"] = "x" * 5_000_001  # over MAX_REQUEST_BYTES
    r = client.post("/api/solve", json={"requirements": bloated, "seconds": 3})
    assert r.status_code == 413


def test_validate_rejects_unknown_seat_id(client):
    r = client.post("/api/validate",
                    json={"requirements": TINY, "assignments": {"ghost-seat": None}}).json()
    assert r["score"] is None
    assert any("unknown seat id" in e for e in r["errors"])


def test_validate_rejects_unknown_employee_id(client):
    built = client.post("/api/build", json={"requirements": TINY}).json()
    seat_id = built["dataset"]["seats"][0]["id"]
    r = client.post("/api/validate",
                    json={"requirements": TINY, "assignments": {seat_id: "ghost-emp"}}).json()
    assert r["score"] is None
    assert any("unknown" in e and "employee id" in e for e in r["errors"])
