"""Week scoping (2026-07-02): null'd references from editor deletes + the per-week
project tick (`runs_this_week`), and regressions pinning that a stripped-down org
(one team / one project / nothing at all) flows through the API without blowing up."""
from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from app.data import build_schedule
from app.main import app
from app.requirements import RequirementsIn, to_dataset, validate_requirements

BASE = {
    "sites": [{"id": "s", "name": "S"}],
    "roles": [{"id": "dev", "name": "Dev"}],
    "shift_types": [{"id": "m", "name": "Morning", "start": 8, "end": 16, "is_night": False}],
    "teams": [{"id": "t", "name": "T", "site": "s"}],
    "projects": [{"id": "p", "name": "P", "teams": ["t"]},
                 {"id": "q", "name": "Q", "teams": ["t"]}],
    "employees": [{"id": "e", "name": "E", "team": "t", "roles": ["dev"],
                   "projects": ["p", "q"], "can_manage": True}],
    "demand": [{"team": "t", "shift_type": "m", "days": ["Sun", "Mon"],
                "crew": {"p": {"dev": 1}, "q": {"dev": 1}}}],
}


def _mut(fn):
    d = copy.deepcopy(BASE)
    fn(d)
    return d


def _validate(doc: dict):
    return validate_requirements(RequirementsIn(**doc))


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


# --- null refs (editor delete leaves a "Please choose") -----------------------

def test_team_with_no_site_gets_a_choose_one_error():
    errors, _ = _validate(_mut(lambda d: d["teams"][0].update(site=None)))
    assert errors == ["Team 't' has no site — choose one."]


def test_employee_with_no_team_gets_a_choose_one_error():
    errors, _ = _validate(_mut(lambda d: d["employees"][0].update(team=None)))
    # The membership-vs-team check must stay quiet until a team is chosen.
    assert errors == ["Employee 'e' has no team — choose one."]


def test_demand_with_no_team_or_shift_type_gets_choose_one_errors():
    errors, _ = _validate(_mut(lambda d: d["demand"][0].update(team=None, shift_type=None)))
    assert "Demand #1 has no team — choose one." in errors
    assert "Demand #1 has no shift type — choose one." in errors


def test_two_half_empty_demand_rows_are_not_duplicates_of_each_other():
    def strip(d):
        d["demand"].append(copy.deepcopy(d["demand"][0]))
        for row in d["demand"]:
            row["team"] = None
    errors, _ = _validate(_mut(strip))
    assert all("duplicates" not in e and "same shift id" not in e for e in errors), errors


def test_null_refs_parse_when_fields_are_absent_entirely():
    """A hand-edited doc that OMITS team/site/shift_type parses to None (a normal
    'choose one' error), not a 422 at the model boundary."""
    doc = _mut(lambda d: (d["teams"][0].pop("site"), d["demand"][0].pop("team")))
    errors, _ = _validate(doc)
    assert "Team 't' has no site — choose one." in errors
    assert "Demand #1 has no team — choose one." in errors


# --- runs_this_week (per-week project tick) ------------------------------------

def _seats(doc):
    req = RequirementsIn(**doc)
    errors, _ = validate_requirements(req)
    assert errors == [], errors
    return build_schedule(to_dataset(req)).seats


def test_base_materialises_both_projects():
    seats = _seats(copy.deepcopy(BASE))
    workers = [s for s in seats if s.kind == "worker"]
    assert {s.project_id for s in workers} == {"p", "q"}
    assert len(workers) == 4    # 2 projects × 1 dev × 2 days


def test_unticked_project_materialises_no_seats():
    doc = _mut(lambda d: d["projects"][1].update(runs_this_week=False))
    workers = [s for s in _seats(doc) if s.kind == "worker"]
    assert {s.project_id for s in workers} == {"p"}
    assert len(workers) == 2
    # The shift itself still runs (project p still needs it): manager seats remain.
    assert any(s.kind == "manager" for s in _seats(doc))


def test_row_serving_only_unticked_projects_does_not_run():
    def pause_all(d):
        d["projects"][0]["runs_this_week"] = False
        d["projects"][1]["runs_this_week"] = False
    seats = _seats(_mut(pause_all))
    assert seats == []          # no workers AND no manager-only leftover shifts


def test_authored_empty_crew_row_still_runs_manager_only():
    """An explicitly empty crew is a deliberate manager-only shift — the tick filter
    must not confuse it with a row emptied by pausing."""
    doc = _mut(lambda d: d["demand"][0].update(crew={}))
    seats = _seats(doc)
    assert seats and all(s.kind == "manager" for s in seats)


def test_paused_only_row_is_not_a_duplicate_of_an_active_row():
    """A row that doesn't run this week mints no shifts — overlapping an active row is
    not a collision (codex round-4 finding #1). Re-ticking makes the check fire again."""
    def add_overlap(d):
        d["demand"].append({"team": "t", "shift_type": "m", "days": ["Sun"],
                            "crew": {"q": {"dev": 1}}})
        d["projects"][1]["runs_this_week"] = False
    errors, _ = _validate(_mut(add_overlap))
    assert errors == []

    def reticked(d):
        add_overlap(d)
        d["projects"][1]["runs_this_week"] = True
    errors, _ = _validate(_mut(reticked))
    assert any("duplicates" in e for e in errors)


def test_paused_crew_does_not_count_toward_the_seat_guard():
    """The MAX_SEATS estimate must ignore crew that will never materialise."""
    def huge_paused(d):
        d["demand"][0]["crew"]["q"]["dev"] = 50_000   # way past MAX_SEATS…
        d["projects"][1]["runs_this_week"] = False    # …but paused this week
    errors, _ = _validate(_mut(huge_paused))
    assert errors == []

    def huge_active(d):
        d["demand"][0]["crew"]["q"]["dev"] = 50_000
    errors, _ = _validate(_mut(huge_active))
    assert any("Problem too large" in e for e in errors)


def test_unticked_project_stops_its_coverage_warnings():
    # Nobody can fill q — normally a warning; pausing q must silence it.
    def nobody_on_q(d):
        d["employees"][0]["projects"] = ["p"]
    _, warnings = _validate(_mut(nobody_on_q))
    assert any("q" in w for w in warnings)

    def paused_q(d):
        nobody_on_q(d)
        d["projects"][1]["runs_this_week"] = False
    _, warnings = _validate(_mut(paused_q))
    assert not any("q" in w for w in warnings), warnings


def test_runs_this_week_defaults_true_and_round_trips(client):
    seed = client.get("/api/requirements").json()
    assert all(p["runs_this_week"] is True for p in seed["projects"])
    # JSON export is lossless: the tick survives an export → import round trip.
    doc = _mut(lambda d: d["projects"][1].update(runs_this_week=False))
    exported = client.post("/api/export", json={"requirements": doc, "format": "json"}).json()
    assert exported["errors"] == []
    imported = client.post("/api/import", json={
        "requirements": doc, "format": "json", "mode": "replace",
        "content": exported["content"]}).json()
    assert imported["errors"] == []
    assert [p["runs_this_week"] for p in imported["requirements"]["projects"]] == [True, False]


# --- stripped-org regressions (the "one team, one project" week) ---------------

def test_stripped_org_builds_and_validates_via_api(client):
    doc = copy.deepcopy(BASE)
    r = client.post("/api/build", json={"requirements": doc}).json()
    assert r["errors"] == [] and r["dataset"] is not None

    zero = _mut(lambda d: d.update(demand=[]))
    for path, payload in [
        ("/api/build", {"requirements": zero}),
        ("/api/solve", {"requirements": zero, "seconds": 1}),
        ("/api/validate", {"requirements": zero, "assignments": {}}),
    ]:
        r = client.post(path, json=payload).json()
        assert r["errors"] == [], (path, r["errors"])
        assert r["dataset"] is not None and r["dataset"]["seats"] == []

    # Seats but nobody eligible: still a clean (all-unfilled) response, not a crash.
    lonely = _mut(lambda d: d["employees"][0].update(projects=[], can_manage=False))
    r = client.post("/api/solve", json={"requirements": lonely, "seconds": 1}).json()
    assert r["errors"] == []
    assert all(v is None for v in r["assignments"].values())
