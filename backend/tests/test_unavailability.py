"""Phase 3: date-based employee Unavailability.

An employee is removed from a Seat's eligibility (value range) for shifts on a date in
their `unavailable_dates` — worker and manager seats alike — so the solver never assigns
them then. A manual Override onto such a seat is an Exceptional Assignment whose flag
names the unavailability. Coverage warnings are availability-aware. Bad dates are errors.
"""
from __future__ import annotations

import copy
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from conftest import WEEK_SUN, day_shift, emp, evaluate, seat
from app.carryover import next_week_carryover
from app.data import build_schedule
from app.domain import Schedule
from app.main import app
from app.requirements import RequirementsIn, to_dataset, validate_requirements

MON = (WEEK_SUN + timedelta(days=1)).isoformat()   # 2026-06-22 (Monday)
SUN = WEEK_SUN.isoformat()                          # 2026-06-21 (Sunday)

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
    "demand": [{"team": "a", "shift_type": "m", "days": ["Sun", "Mon"], "crew": {"p": {"dev": 1}}}],
    "week_start": SUN,
}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _seats_by_date(dataset, kind):
    date_of = {sh["id"]: sh["date"] for sh in dataset["shifts"]}
    out: dict[str, list] = {}
    for s in dataset["seats"]:
        if s["kind"] == kind:
            out.setdefault(date_of[s["shift_id"]], []).append(s)
    return out


def test_unavailable_employee_removed_from_worker_eligibility(client):
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["unavailable_dates"] = [MON]   # Dana off Monday only
    built = client.post("/api/build", json={"requirements": doc}).json()
    assert built["errors"] == [], built["errors"]
    by_date = _seats_by_date(built["dataset"], "worker")
    mon_elig = {eid for s in by_date[MON] for eid in s["eligible_employee_ids"]}
    sun_elig = {eid for s in by_date[SUN] for eid in s["eligible_employee_ids"]}
    assert "dana" not in mon_elig          # excluded on her unavailable date
    assert "dana" in sun_elig              # still eligible on other dates
    assert "evan" in mon_elig and "evan" in sun_elig


def test_unavailable_manager_removed_from_manager_eligibility(client):
    doc = copy.deepcopy(ORG)
    doc["employees"][1]["can_manage"] = False          # only Dana manages
    doc["employees"][0]["unavailable_dates"] = [MON]   # Dana off Monday
    built = client.post("/api/build", json={"requirements": doc}).json()
    by_date = _seats_by_date(built["dataset"], "manager")
    mon_mgr = {eid for s in by_date[MON] for eid in s["eligible_employee_ids"]}
    sun_mgr = {eid for s in by_date[SUN] for eid in s["eligible_employee_ids"]}
    assert "dana" not in mon_mgr
    assert "dana" in sun_mgr


def test_override_onto_unavailable_is_exceptional_with_enriched_message():
    """A manual override placing an Unavailable employee fires EXC, and the flag detail
    names the unavailability (the actionable cause) rather than the generic message."""
    d = WEEK_SUN + timedelta(days=1)                   # Monday 2026-06-22
    a = emp("a", unavailable_dates=frozenset({d}))
    s = seat(day_shift(1, id="mon"), [], a)            # assigned but not eligible (override)
    _score, flags = evaluate([s], employees=[a])
    exc = [f for f in flags if f["rule"] == "EXC"]
    assert exc, flags
    assert "unavailable on" in exc[0]["detail"].lower(), exc[0]["detail"]


def test_exceptional_for_other_reasons_keeps_generic_message():
    """An exceptional assignment NOT caused by unavailability keeps the generic wording."""
    a, b = emp("a"), emp("b")
    s = seat(day_shift(1, id="mon"), [a], b)           # b ineligible (wrong eligibility), available
    _score, flags = evaluate([s], employees=[a, b])
    exc = [f for f in flags if f["rule"] == "EXC"]
    assert exc, flags
    assert "unavailable on" not in exc[0]["detail"].lower()
    assert "outside the normal eligibility" in exc[0]["detail"]


def test_availability_aware_coverage_warning_for_workers(client):
    doc = copy.deepcopy(ORG)
    doc["employees"][1]["status"] = "inactive"         # only Dana could fill dev/p
    doc["employees"][0]["unavailable_dates"] = [MON]   # ...and she's off Monday
    built = client.post("/api/build", json={"requirements": doc}).json()
    warns = built["warnings"]
    assert any(f"unavailable on {MON}" in w and "fill dev on p" in w for w in warns), warns
    # Sunday is still coverable -> no availability warning for that date
    assert not any(f"unavailable on {SUN}" in w for w in warns), warns


def test_availability_aware_coverage_warning_for_managers(client):
    doc = copy.deepcopy(ORG)
    doc["employees"][1]["can_manage"] = False          # only Dana manages
    doc["employees"][0]["unavailable_dates"] = [MON]
    built = client.post("/api/build", json={"requirements": doc}).json()
    warns = built["warnings"]
    assert any("no available shift manager" in w and MON in w for w in warns), warns


def test_invalid_unavailable_date_is_a_validation_error(client):
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["unavailable_dates"] = ["2026-13-99"]
    built = client.post("/api/build", json={"requirements": doc}).json()
    assert built["dataset"] is None
    assert any("not a valid ISO date" in e and "unavailable" in e for e in built["errors"]), built["errors"]


def test_unavailable_dates_round_trip_through_the_seed_doc(client):
    emp_doc = client.get("/api/requirements").json()["employees"][0]
    assert "unavailable_dates" in emp_doc
    assert emp_doc["unavailable_dates"] == []          # seed has none


def test_coverage_availability_warnings_match_built_seat_eligibility():
    """Parity (extends the Phase-2 coverage↔eligibility test to the date dimension): for
    each (date, project, role) demanded, an availability warning is emitted iff the built
    worker seat on that date has empty eligibility while the role/project is otherwise
    fillable — so the duplicated date-aware predicate cannot drift from build_schedule."""
    doc = copy.deepcopy(ORG)
    doc["employees"][1]["status"] = "inactive"         # only Dana active for dev/p
    doc["employees"][0]["unavailable_dates"] = [MON]   # off Monday
    req = RequirementsIn(**doc)
    _errs, warnings = validate_requirements(req)
    sched = build_schedule(to_dataset(req))

    empty_by_date = {(s.shift.start_date.isoformat(), s.project_id, s.role_id)
                     for s in sched.seats if s.kind == "worker" and not s.eligible}
    for dt in (SUN, MON):
        warned = any(f"fill dev on p is unavailable on {dt}" in w for w in warnings)
        assert ((dt, "p", "dev") in empty_by_date) == warned, (dt, empty_by_date, warnings)


def test_manager_availability_warnings_match_built_manager_seats():
    """Codex finding 1: rigor for the manager arm. A 'no available shift manager on {date}'
    warning is emitted iff that date's (deduped) manager seat is built empty because the only
    manager is unavailable. Two shift types share Monday to exercise the per-date dedup."""
    doc = copy.deepcopy(ORG)
    doc["shift_types"].append({"id": "e", "name": "Evening", "start": 16, "end": 22, "is_night": False})
    doc["employees"][1]["status"] = "inactive"          # only Dana can manage
    doc["employees"][0]["unavailable_dates"] = [MON]
    doc["demand"] = [
        {"team": "a", "shift_type": "m", "days": ["Sun", "Mon"], "crew": {"p": {"dev": 1}}},
        {"team": "a", "shift_type": "e", "days": ["Mon"], "crew": {"p": {"dev": 1}}},  # 2nd Mon shift
    ]
    req = RequirementsIn(**doc)
    _errs, warnings = validate_requirements(req)
    sched = build_schedule(to_dataset(req))

    empty_mgr_dates = {s.shift.start_date.isoformat()
                       for s in sched.seats if s.kind == "manager" and not s.eligible}
    for dt in (SUN, MON):
        warned = any("no available shift manager" in w and dt in w for w in warnings)
        assert (dt in empty_mgr_dates) == warned, (dt, empty_mgr_dates, warnings)
    # one warning for Monday despite two Monday shifts (manager seat is deduped per date)
    assert len([w for w in warnings if "no available shift manager" in w and MON in w]) == 1


def test_unavailable_employee_overridden_onto_burden_still_accrues_burden():
    """Codex finding 2: carry-over reads the accepted schedule (incl. Overrides), independent
    of availability. An all-week-unavailable employee manually placed on a burden (weekend)
    seat still rolls burden forward, and next_carryover emits only the four ADR-0002 fields
    (no `unavailable_dates` leak)."""
    sat = WEEK_SUN + timedelta(days=6)                  # Saturday = weekend = burden
    a = emp("a", carryover_burden=2, unavailable_dates=frozenset({sat}))
    s = seat(day_shift(6, id="sat"), [], a)             # override: assigned though unavailable
    co = next_week_carryover(Schedule([a], [s.shift], [s]))
    assert co["a"]["carryover_burden"] == 3             # 2 carried + 1 burden this week
    assert co["a"]["worked_last_weekend"] is True
    assert set(co["a"]) == {"carryover_burden", "worked_last_weekend",
                            "prev_shift_end", "prev_shift_was_night"}
