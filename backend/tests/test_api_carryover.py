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
    "projects": [{"id": "p", "name": "Apollo", "teams": ["a"]}],
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
    "projects": [{"id": "p", "name": "Apollo", "teams": ["a"]}],
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


def test_empty_infeasible_seed_does_not_warn(client):
    """An empty seed carries no data, so a source_feasible=False flag on it must not
    produce a spurious 'infeasible schedule' warning (#9) — this is the exact shape of
    empty_carryover_seed() replayed back by a client."""
    doc = copy.deepcopy(WEEKEND_ORG)
    doc["week_start"] = "2026-06-28"
    seed = {"source_week_start": None, "target_week_start": None,
            "source_feasible": False, "employees": {}}
    r = client.post("/api/build", json={"requirements": doc, "carryover_seed": seed}).json()
    assert r["dataset"] is not None, r["errors"]
    assert not any("infeasible schedule" in w for w in r["warnings"]), r["warnings"]


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
