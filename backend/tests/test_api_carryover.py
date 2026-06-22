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
