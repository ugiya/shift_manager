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
    "projects": [{"id": "p", "name": "Apollo", "teams": ["a"]}],
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


def test_get_requirements_starts_on_the_current_week(client, monkeypatch):
    """A fresh session schedules the CURRENT week (the Sunday on or before today),
    not the week the seed data was written for."""
    monkeypatch.delenv("SEED_WEEK_START", raising=False)
    from datetime import date, timedelta
    ws = date.fromisoformat(client.get("/api/requirements").json()["week_start"])
    today = date.today()
    assert ws.weekday() == 6                      # a Sunday
    assert today - timedelta(days=6) <= ws <= today  # ...within the last week


def test_get_requirements_week_is_pinnable_for_determinism(client, monkeypatch):
    """SEED_WEEK_START pins the fresh-start week — e2e seat ids embed the dates."""
    monkeypatch.setenv("SEED_WEEK_START", "2026-06-21")
    assert client.get("/api/requirements").json()["week_start"] == "2026-06-21"


def test_current_week_start_snaps_to_sunday():
    """Every weekday maps to its week's Sunday; a Sunday maps to itself."""
    from datetime import date, timedelta

    from app.main import current_week_start
    sunday = date(2026, 6, 21)
    for offset in range(7):
        assert current_week_start(sunday + timedelta(days=offset)) == sunday


def test_pinned_week_must_be_a_valid_iso_date(monkeypatch):
    monkeypatch.setenv("SEED_WEEK_START", "not-a-date")
    from app.main import current_week_start
    with pytest.raises(RuntimeError, match="SEED_WEEK_START"):
        current_week_start()


def test_pinned_week_must_be_a_sunday(monkeypatch):
    """A mid-week pin would skew the 7-day grid against the weekday-name demand model."""
    monkeypatch.setenv("SEED_WEEK_START", "2026-06-24")   # a Wednesday
    from app.main import current_week_start
    with pytest.raises(RuntimeError, match="not a Sunday"):
        current_week_start()


def test_build_seed_materialises_135_seats(client):
    seed = client.get("/api/requirements").json()
    r = client.post("/api/build", json={"requirements": seed}).json()
    assert r["errors"] == []
    assert len(r["dataset"]["seats"]) == 135
    assert len(r["dataset"]["sites"]) == 4


def test_dataset_payload_exposes_weekend_weekdays(client):
    """The UI marks weekend columns from the payload, not a hardcoded Fri/Sat."""
    r = client.post("/api/build", json={"requirements": TINY}).json()
    assert r["dataset"]["weekend_weekdays"] == [4, 5]   # Python weekday(): Fri, Sat


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


def test_post_without_content_length_is_rejected(client):
    """A chunked POST (no Content-Length header) must not slip past the size guard
    into unbounded buffering; the middleware requires the header outright (411)."""
    r = client.post("/api/solve", content=iter([b"{}"]),   # iterator body -> chunked
                    headers={"content-type": "application/json"})
    assert r.status_code == 411


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


def test_date_boundary_id_splice_is_a_build_error_not_a_500(client):
    """The concat checks in validate_requirements can't see a collision that splices
    ACROSS the shift id's date: team 't'+shift 'm' with project 'x-2026-06-21-y', and
    team 't-m-2026-06-21'+shift 'x' with project 'y', both mint the worker seat id
    'seat-shift-t-m-2026-06-21-x-2026-06-21-y-z-0'. The mint-time uniqueness check in
    build_schedule must surface this as a normal document error (codex finding)."""
    doc = {
        "sites": [{"id": "s", "name": "S"}],
        "roles": [{"id": "z", "name": "Z"}],
        "shift_types": [
            {"id": "m", "name": "M", "start": 8, "end": 16, "is_night": False},
            {"id": "x", "name": "X", "start": 9, "end": 17, "is_night": False},
        ],
        "teams": [
            {"id": "t", "name": "T", "site": "s"},
            {"id": "t-m-2026-06-21", "name": "T2", "site": "s"},
        ],
        "projects": [
            {"id": "x-2026-06-21-y", "name": "P1", "teams": ["t"]},
            {"id": "y", "name": "P2", "teams": ["t-m-2026-06-21"]},
        ],
        "employees": [
            {"id": "e1", "name": "E1", "team": "t", "roles": ["z"],
             "projects": ["x-2026-06-21-y"], "can_manage": True},
        ],
        "demand": [
            {"team": "t", "shift_type": "m", "days": ["Sun"],
             "crew": {"x-2026-06-21-y": {"z": 1}}},
            {"team": "t-m-2026-06-21", "shift_type": "x", "days": ["Sun"],
             "crew": {"y": {"z": 1}}},
        ],
        "week_start": "2026-06-21",
    }
    r = client.post("/api/build", json={"requirements": doc})
    assert r.status_code == 200, r.text          # a document problem, never a 500
    body = r.json()
    assert body["dataset"] is None
    assert any("Ids collide" in e for e in body["errors"]), body["errors"]
