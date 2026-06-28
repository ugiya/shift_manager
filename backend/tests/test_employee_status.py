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


# --- Codex Phase-2 review follow-ups (relate-to-findings) ---------------------

def test_inactive_employees_do_not_count_against_max_employees(monkeypatch):
    """Finding 1: MAX_EMPLOYEES bounds *problem facts* (active employees only). Retained
    inactive/on-leave HR rows are not materialised, so they must not count — otherwise
    status would leak into the solve-size guard for a large archived roster."""
    import app.requirements as R
    monkeypatch.setattr(R, "MAX_EMPLOYEES", 1)
    doc = copy.deepcopy(ORG)
    doc["employees"][1]["status"] = "inactive"          # 1 active + 1 inactive
    errors, _ = R.validate_requirements(RequirementsIn(**doc))
    assert not any("Too many" in e for e in errors), errors
    doc["employees"][1]["status"] = "active"            # 2 active > cap of 1
    errors, _ = R.validate_requirements(RequirementsIn(**doc))
    assert any("Too many active employees" in e for e in errors), errors


def test_inactive_employee_does_not_get_unusable_warning(client):
    """Finding 3: the 'no role and cannot manage — unusable' warning is meaningless for
    an inactive HR-only row (never scheduled). It fires only for an active one."""
    doc = copy.deepcopy(ORG)
    doc["employees"].append({"id": "zoe", "name": "Zoe", "team": "a", "roles": [],
                             "projects": [], "can_manage": False, "status": "inactive"})
    built = client.post("/api/build", json={"requirements": doc}).json()
    assert not any("zoe" in w and "unusable" in w for w in built["warnings"]), built["warnings"]
    doc["employees"][-1]["status"] = "active"
    built = client.post("/api/build", json={"requirements": doc}).json()
    assert any("zoe" in w and "unusable" in w for w in built["warnings"]), built["warnings"]


def test_inactive_override_is_rejected_with_a_not_active_message(client):
    """Finding 4: overriding a seat with an inactive employee is rejected (they cannot be
    scheduled even exceptionally) — with a clear 'not active' message, not 'unknown'."""
    doc = copy.deepcopy(ORG)
    doc["employees"][1]["status"] = "inactive"          # Evan inactive
    built = client.post("/api/build", json={"requirements": doc}).json()
    worker = next(s for s in built["dataset"]["seats"] if s["kind"] == "worker")
    resp = client.post("/api/validate",
                       json={"requirements": doc, "assignments": {worker["id"]: "evan"}}).json()
    assert resp["score"] is None
    assert any("not active" in e for e in resp["errors"]), resp["errors"]
    assert not any("unknown employee" in e for e in resp["errors"]), resp["errors"]


def test_truly_unknown_override_still_says_unknown(client):
    """The clearer 'not active' message must not mask a genuinely unknown id."""
    doc = copy.deepcopy(ORG)
    built = client.post("/api/build", json={"requirements": doc}).json()
    worker = next(s for s in built["dataset"]["seats"] if s["kind"] == "worker")
    resp = client.post("/api/validate",
                       json={"requirements": doc, "assignments": {worker["id"]: "ghost"}}).json()
    assert any("unknown employee" in e for e in resp["errors"]), resp["errors"]


def test_carryover_freezes_through_an_inactive_week():
    """Finding 2: ADR-0002 continuity across a leave. An employee inactive for a week is
    absent from next_carryover (not a problem fact), and a seed lacking them leaves their
    retained EmployeeIn carry-over untouched — burden freezes during leave, resumes on
    reactivation (no continuity loss as long as the client keeps the requirements doc)."""
    from app.carryover import next_week_carryover
    from app.data import build_schedule
    from app.requirements import CarryoverSeedIn, apply_carryover_seed

    wk1 = copy.deepcopy(ORG)
    wk1["employees"][1]["status"] = "inactive"
    wk1["employees"][1]["carryover_burden"] = 5
    seed = next_week_carryover(build_schedule(to_dataset(RequirementsIn(**wk1))))
    assert "evan" not in seed                            # inactive -> not carried forward

    wk2 = copy.deepcopy(ORG)
    wk2["week_start"] = "2026-06-28"
    wk2["employees"][1]["carryover_burden"] = 5          # client retained it on the doc
    req = RequirementsIn(**wk2)
    errors, _ = apply_carryover_seed(req, CarryoverSeedIn(
        source_week_start="2026-06-21", target_week_start="2026-06-28",
        source_feasible=True, employees=seed))
    assert errors == []
    evan = next(e for e in req.employees if e.id == "evan")
    assert evan.carryover_burden == 5                    # frozen across the leave, resumes


def test_coverage_warnings_match_built_seat_eligibility():
    """Finding 5: the active-only/same-team/role/project predicate is duplicated between
    _coverage_warnings (input layer) and build_schedule (domain layer). Pin them: for every
    demanded (team, project, role), 'warned unfillable' iff the built worker seat has empty
    eligibility — so the two cannot silently drift."""
    from app.data import build_schedule
    from app.requirements import validate_requirements

    doc = copy.deepcopy(ORG)
    doc["roles"].append({"id": "qa", "name": "QA"})      # a role nobody holds
    doc["employees"][1]["status"] = "inactive"           # only Dana active
    doc["demand"] = [{"team": "a", "shift_type": "m", "days": ["Sun"],
                      "crew": {"p": {"dev": 1, "qa": 1}}}]
    req = RequirementsIn(**doc)
    _errs, warnings = validate_requirements(req)
    sched = build_schedule(to_dataset(req))

    empty = {(s.team_id, s.project_id, s.role_id)
             for s in sched.seats if s.kind == "worker" and not s.eligible}
    demanded = {(d["team"], pid, rid) for d in doc["demand"]
                for pid, roles in d["crew"].items() for rid in roles}
    for (team, pid, rid) in demanded:
        warned = any(f"fill {rid} on {pid}" in w for w in warnings)
        assert ((team, pid, rid) in empty) == warned, (team, pid, rid)


def test_manager_coverage_warning_matches_built_manager_seats():
    """Finding 5 (manager arm): a team with demand but no active can_manage employee is
    warned, and its materialised manager seats are built with empty eligibility."""
    from app.data import build_schedule
    from app.requirements import validate_requirements

    doc = copy.deepcopy(ORG)
    doc["employees"][0]["can_manage"] = False            # Dana no longer manages
    doc["employees"][1]["status"] = "inactive"           # Evan (the other manager) inactive
    req = RequirementsIn(**doc)
    _errs, warnings = validate_requirements(req)
    sched = build_schedule(to_dataset(req))
    mgr_empty = [s for s in sched.seats if s.kind == "manager" and not s.eligible]
    assert mgr_empty                                     # manager seats unfillable
    assert any("shift-manager-eligible" in w for w in warnings), warnings
