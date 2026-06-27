"""Phase 2: employee.status. Only `active` employees are scheduled; inactive/on-leave
stay in the roster (and export) but are excluded from coverage, eligibility, and the
materialised dataset. A bad status value is a validation error."""
from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.requirements import RequirementsIn, to_dataset

ORG = {
    "sites": [{"id": "hq", "name": "HQ"}],
    "roles": [{"id": "dev", "name": "Dev"}],
    "shift_types": [{"id": "m", "name": "Morning", "start": 8, "end": 16, "is_night": False}],
    "teams": [{"id": "a", "name": "Alpha", "site": "hq"}],
    "projects": [{"id": "p", "name": "Apollo", "teams": ["a"]}],
    "employees": [
        {"id": "dana", "name": "Dana", "team": "a", "roles": ["dev"], "projects": ["p"], "can_manage": True},
        {"id": "evan", "name": "Evan", "team": "a", "roles": ["dev"], "projects": ["p"], "can_manage": True},
    ],
    "demand": [{"team": "a", "shift_type": "m", "days": ["Sun"], "crew": {"p": {"dev": 1}}}],
    "week_start": "2026-06-21",
}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_inactive_employee_is_not_scheduled(client):
    doc = copy.deepcopy(ORG)
    doc["employees"][1]["status"] = "inactive"
    built = client.post("/api/build", json={"requirements": doc}).json()
    assert built["errors"] == [], built["errors"]
    assert {e["id"] for e in built["dataset"]["employees"]} == {"dana"}   # Evan absent
    worker = next(s for s in built["dataset"]["seats"] if s["kind"] == "worker")
    assert "evan" not in worker["eligible_employee_ids"]


def test_to_dataset_drops_non_active():
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["status"] = "on-leave"
    doc["employees"][1]["status"] = "inactive"
    assert to_dataset(RequirementsIn(**doc)).employees == []   # neither is active


def test_inactive_manager_does_not_suppress_no_manager_warning(client):
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["status"] = "inactive"   # the only can_manage, now inactive
    doc["employees"][1]["can_manage"] = False     # Evan active but not a manager
    built = client.post("/api/build", json={"requirements": doc}).json()
    assert any("shift-manager-eligible" in w for w in built["warnings"]), built["warnings"]


def test_inactive_worker_triggers_coverage_warning(client):
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["status"] = "inactive"
    doc["employees"][1]["status"] = "inactive"
    built = client.post("/api/build", json={"requirements": doc}).json()
    assert any("No employee can fill" in w for w in built["warnings"]), built["warnings"]


def test_bad_status_is_a_validation_error(client):
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["status"] = "retired"
    built = client.post("/api/build", json={"requirements": doc}).json()
    assert built["dataset"] is None
    assert any("invalid status" in e for e in built["errors"]), built["errors"]


def test_hr_metadata_round_trips_through_the_seed_doc(client):
    """GET /api/requirements exposes the HR fields (defaults) so the editor/export see them."""
    emp = client.get("/api/requirements").json()["employees"][0]
    for k in ("status", "employee_number", "email", "phone", "hire_date", "notes"):
        assert k in emp
    assert emp["status"] == "active"
