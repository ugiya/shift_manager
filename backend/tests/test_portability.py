"""Phase 5: import / export.

JSON is lossless (full document, round-trips exactly). CSV is a lossy employee roster:
references by NAME, internal id in column 1, `;`-multi-value; carry-over and avoid_shift_ids
are dropped (reset on a replace import). Import is mode-pluggable (replace / upsert by id /
upsert by name / replace + auto-create refs) and reuses validate_requirements.
"""
from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.portability import (EMPLOYEE_CSV_COLUMNS, ImportMode, export,
                             import_document, requirements_to_csv)
from app.requirements import RequirementsIn, validate_requirements

ORG = {
    "sites": [{"id": "hq", "name": "HQ"}],
    "roles": [{"id": "dev", "name": "Developer"}, {"id": "qa", "name": "QA"}],
    "shift_types": [
        {"id": "m", "name": "Morning", "start": 8, "end": 16, "is_night": False},
        {"id": "n", "name": "Night", "start": 22, "end": 6, "is_night": True},
    ],
    "teams": [{"id": "a", "name": "Alpha", "site": "hq"}],
    "projects": [{"id": "p", "name": "Apollo", "teams": ["a"]}],
    "employees": [
        {"id": "dana", "name": "Dana", "team": "a", "roles": ["dev"], "projects": ["p"],
         "can_manage": True, "status": "active", "email": "dana@x.com",
         "preferred_shift_type_ids": ["m"], "unavailable_dates": ["2026-06-22"],
         "carryover_burden": 5, "avoid_shift_ids": ["shift-x"]},
        {"id": "evan", "name": "Evan", "team": "a", "roles": ["dev", "qa"], "projects": ["p"],
         "status": "on-leave"},
    ],
    "demand": [{"team": "a", "shift_type": "m", "days": ["Sun"], "crew": {"p": {"dev": 1}}}],
    "week_start": "2026-06-21",
}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def base():
    return RequirementsIn(**copy.deepcopy(ORG))


# --- JSON: lossless ----------------------------------------------------------

def test_json_round_trip_is_lossless():
    req = base()
    content, fname = export(req, "json")
    assert fname.endswith(".json")
    merged, errors, _ = import_document(req, content, "json", ImportMode.REPLACE)
    assert errors == []
    assert RequirementsIn(**merged).model_dump() == req.model_dump()   # byte-for-byte in meaning


def test_json_import_replaces_whole_document_and_warns_on_nonreplace_mode():
    req = base()
    other = copy.deepcopy(ORG)
    other["employees"] = [other["employees"][0]]            # drop evan
    content = __import__("json").dumps(other)
    merged, errors, warnings = import_document(req, content, "json", ImportMode.UPSERT_ID)
    assert errors == []
    assert len(merged["employees"]) == 1                    # whole-doc replace, not a merge
    assert any("ignores mode" in w for w in warnings)


def test_invalid_json_is_an_error_and_keeps_base():
    req = base()
    merged, errors, _ = import_document(req, "{not json", "json", ImportMode.REPLACE)
    assert any("Invalid JSON" in e for e in errors)
    assert merged == req.model_dump()                       # base unchanged


# --- CSV: lossy roster -------------------------------------------------------

def test_csv_has_id_first_and_resolves_names():
    csv_text = requirements_to_csv(base())
    header, dana, _evan = csv_text.splitlines()[0], csv_text.splitlines()[1], csv_text.splitlines()[2]
    assert header.split(",")[0] == "id"                     # id is column 1
    assert header.split(",") == EMPLOYEE_CSV_COLUMNS
    assert dana.startswith("dana,Dana,Alpha,")              # references written by NAME
    assert "Morning" in dana                                # preferred shift type by name


def test_csv_round_trip_preserves_roster_but_drops_carryover():
    req = base()
    content, fname = export(req, "csv")
    assert fname.endswith(".csv")
    merged, errors, _ = import_document(req, content, "csv", ImportMode.REPLACE)
    assert errors == []
    m = {e.id: e for e in RequirementsIn(**merged).employees}
    dana = m["dana"]
    # roster fields preserved (refs resolved back to ids)
    assert dana.team == "a" and set(dana.roles) == {"dev"} and set(dana.projects) == {"p"}
    assert dana.can_manage and dana.status == "active" and dana.email == "dana@x.com"
    assert dana.preferred_shift_type_ids == ["m"] and dana.unavailable_dates == ["2026-06-22"]
    assert set(m["evan"].roles) == {"dev", "qa"} and m["evan"].status == "on-leave"
    # lossy: carry-over + avoid_shift_ids reset to defaults
    assert dana.carryover_burden == 0 and dana.avoid_shift_ids == []


def test_csv_multivalue_is_semicolon_separated():
    csv_text = requirements_to_csv(base())
    evan = next(l for l in csv_text.splitlines() if l.startswith("evan,"))
    assert "Developer;QA" in evan or "QA;Developer" in evan


# --- import modes ------------------------------------------------------------

def _csv(rows: list[list[str]]) -> str:
    head = ",".join(EMPLOYEE_CSV_COLUMNS)
    return head + "\n" + "\n".join(",".join(r) for r in rows) + "\n"


def _row(id="x", name="X", team="Alpha", roles="Developer", projects="Apollo",
         can_manage="false", status="active", **extra):
    base_row = {"id": id, "name": name, "team": team, "roles": roles, "projects": projects,
                "can_manage": can_manage, "status": status, "employee_number": "", "email": "",
                "phone": "", "hire_date": "", "notes": "", "preferred_shift_types": "",
                "unavailable_dates": ""}
    base_row.update(extra)
    return [base_row[c] for c in EMPLOYEE_CSV_COLUMNS]


def test_replace_mode_replaces_all_employees():
    merged, errors, _ = import_document(base(), _csv([_row(id="zoe", name="Zoe")]), "csv", ImportMode.REPLACE)
    assert errors == []
    assert [e["id"] for e in merged["employees"]] == ["zoe"]     # dana + evan gone


def test_upsert_by_id_updates_existing_and_keeps_others():
    merged, errors, _ = import_document(
        base(), _csv([_row(id="dana", name="Dana Renamed")]), "csv", ImportMode.UPSERT_ID)
    assert errors == []
    by_id = {e["id"]: e for e in merged["employees"]}
    assert by_id["dana"]["name"] == "Dana Renamed"               # updated
    assert "evan" in by_id                                       # untouched, kept


def test_upsert_blank_id_does_not_overwrite_unrelated_employee():
    """A new hire with a blank id whose name slugs to an id already used by an UNRELATED
    existing employee must be ADDED, not silently merged over that employee (regression:
    used_ids omitted existing employee ids, so `emp-dana` collided and upsert overwrote)."""
    doc = copy.deepcopy(ORG)
    doc["employees"] = [
        {"id": "emp-dana", "name": "Dana", "team": "a", "roles": ["dev"], "projects": ["p"],
         "can_manage": True, "status": "active", "email": "original@x.com"},
    ]
    merged, errors, _ = import_document(
        RequirementsIn(**doc), _csv([_row(id="", name="Dana", email="new@x.com")]),
        "csv", ImportMode.UPSERT_ID)
    assert errors == []
    by_id = {e["id"]: e for e in merged["employees"]}
    assert by_id["emp-dana"]["email"] == "original@x.com"          # existing record untouched
    assert len(merged["employees"]) == 2                           # new hire added, not merged over
    new = [e for e in merged["employees"] if e["id"] != "emp-dana"]
    assert len(new) == 1 and new[0]["email"] == "new@x.com"        # got a fresh, distinct id


def test_replace_blank_id_reuses_discarded_ids_stably():
    """REPLACE discards existing employees, so a blank-id row is free to reuse their ids —
    keeping the slug stable/idempotent across repeated imports (guards against unioning
    existing ids into used_ids for REPLACE, which would mint `emp-dana-2` and flip on re-import)."""
    doc = copy.deepcopy(ORG)
    doc["employees"] = [
        {"id": "emp-dana", "name": "Dana", "team": "a", "roles": ["dev"], "projects": ["p"]},
    ]
    csv = _csv([_row(id="", name="Dana")])
    merged, errors, _ = import_document(RequirementsIn(**doc), csv, "csv", ImportMode.REPLACE)
    assert errors == []
    assert [e["id"] for e in merged["employees"]] == ["emp-dana"]  # reused, not emp-dana-2
    merged2, errors2, _ = import_document(RequirementsIn(**merged), csv, "csv", ImportMode.REPLACE)
    assert errors2 == [] and [e["id"] for e in merged2["employees"]] == ["emp-dana"]  # idempotent


def test_upsert_by_name_matches_on_name():
    merged, errors, _ = import_document(
        base(), _csv([_row(id="newid", name="Dana", can_manage="true")]), "csv", ImportMode.UPSERT_NAME)
    assert errors == []
    danas = [e for e in merged["employees"] if e["name"] == "Dana"]
    assert len(danas) == 1                                       # matched by name, not duplicated


def test_unknown_reference_errors_without_autocreate():
    merged, errors, _ = import_document(
        base(), _csv([_row(roles="Designer")]), "csv", ImportMode.REPLACE)
    assert any("unknown role 'Designer'" in e for e in errors)


def test_autocreate_creates_missing_refs():
    merged, errors, _ = import_document(
        base(), _csv([_row(roles="Designer", preferred_shift_types="Evening")]),
        "csv", ImportMode.REPLACE_AUTOCREATE)
    assert errors == []
    assert any(r["name"] == "Designer" for r in merged["roles"])
    assert any(s["name"] == "Evening" for s in merged["shift_types"])
    # and the new employee references the freshly-created ids
    m = RequirementsIn(**merged)
    new = m.employees[0]
    assert new.roles and new.preferred_shift_type_ids


def test_csv_without_id_or_name_header_is_an_error():
    merged, errors, _ = import_document(base(), "foo,bar\n1,2\n", "csv", ImportMode.REPLACE)
    assert any("header" in e for e in errors)
    assert merged == base().model_dump()


# --- partial-column CSVs (the file only patches the fields it carries) --------

def _partial_csv(header: list[str], rows: list[list[str]]) -> str:
    return ",".join(header) + "\n" + "\n".join(",".join(r) for r in rows) + "\n"


def test_partial_csv_upsert_patches_only_carried_columns():
    """A column absent from the header must not reset a matched employee's field to a
    default on upsert — DATA_MODEL §7: the CSV only patches the fields it carries."""
    merged, errors, _ = import_document(
        base(), _partial_csv(["id", "name", "status"], [["dana", "Dana", "on-leave"]]),
        "csv", ImportMode.UPSERT_ID)
    assert errors == []
    dana = next(e for e in merged["employees"] if e["id"] == "dana")
    assert dana["status"] == "on-leave"                        # carried column applied
    assert dana["team"] == "a" and dana["roles"] == ["dev"]    # absent columns untouched
    assert dana["projects"] == ["p"] and dana["can_manage"] is True
    assert dana["preferred_shift_type_ids"] == ["m"]
    assert dana["unavailable_dates"] == ["2026-06-22"]
    assert dana["email"] == "dana@x.com"


def test_partial_csv_upsert_without_status_does_not_reactivate():
    """An omitted status column must not flip an on-leave employee back to 'active'
    (the old code materialised every field per row, defaulting status)."""
    merged, errors, _ = import_document(
        base(), _partial_csv(["id", "name"], [["evan", "Evan Renamed"]]),
        "csv", ImportMode.UPSERT_ID)
    assert errors == []
    evan = next(e for e in merged["employees"] if e["id"] == "evan")
    assert evan["name"] == "Evan Renamed"
    assert evan["status"] == "on-leave"                        # NOT re-activated


def test_partial_csv_replace_defaults_absent_columns():
    """Replace-mode rows from a partial file get defaults for the absent columns and go
    through normal validation (an empty team is a validation error, not a crash)."""
    merged, errors, _ = import_document(
        base(), _partial_csv(["id", "name"], [["zoe", "Zoe"]]), "csv", ImportMode.REPLACE)
    assert errors == []                                        # parses cleanly
    zoe = next(e for e in merged["employees"] if e["id"] == "zoe")
    assert zoe["team"] == "" and zoe["roles"] == [] and zoe["status"] == "active"
    assert zoe["carryover_burden"] == 0 and zoe["avoid_shift_ids"] == []
    v_errors, _ = validate_requirements(RequirementsIn(**merged))  # shape-valid, no crash
    assert any("unknown team ''" in e for e in v_errors)


# --- csv module edge cases -----------------------------------------------------

def test_csv_round_trips_a_long_notes_field(client):
    """A legally-exported `notes` can exceed csv's default 128 KiB per-field limit; the
    import must parse it (the real bound is MAX_IMPORT_BYTES), never 500."""
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["notes"] = "n" * 200_000
    exported = client.post("/api/export", json={"requirements": doc, "format": "csv"}).json()
    assert exported["errors"] == []
    r = client.post("/api/import", json={"requirements": doc, "format": "csv",
                                         "mode": "replace", "content": exported["content"]}).json()
    assert r["errors"] == []
    dana = next(e for e in r["requirements"]["employees"] if e["id"] == "dana")
    assert dana["notes"] == "n" * 200_000


def test_malformed_csv_is_a_parse_error_not_an_exception():
    """Input that trips csv.Error (here a bare carriage return in an unquoted field)
    comes back as a normal parse error per the endpoint contract, never an exception."""
    merged, errors, _ = import_document(base(), "id,name\nx,a\rb\n", "csv", ImportMode.REPLACE)
    assert any("Invalid CSV" in e for e in errors)
    assert merged == base().model_dump()                       # base unchanged


# --- endpoints ---------------------------------------------------------------

def test_export_endpoint_json_and_csv(client):
    for fmt, ext in [("json", ".json"), ("csv", ".csv")]:
        r = client.post("/api/export", json={"requirements": ORG, "format": fmt}).json()
        assert r["errors"] == [] and r["content"] and r["filename"].endswith(ext)
    assert client.post("/api/export", json={"requirements": ORG, "format": "csv"}).json()["lossy"] is True


# --- codex Phase-5 review follow-ups -----------------------------------------

def test_upsert_preserves_carryover_and_avoid_for_matched_employees():
    """Codex HIGH #1: upsert must NOT wipe ADR-0002 carry-over / avoid_shift_ids on a matched
    employee (the CSV doesn't carry them). Only replace/new rows reset them to defaults."""
    merged, errors, _ = import_document(
        base(), _csv([_row(id="dana", name="Dana Updated")]), "csv", ImportMode.UPSERT_ID)
    assert errors == []
    dana = next(e for e in merged["employees"] if e["id"] == "dana")
    assert dana["name"] == "Dana Updated"                # CSV-carried field updated
    assert dana["carryover_burden"] == 5                 # NOT carried by CSV -> preserved
    assert dana["avoid_shift_ids"] == ["shift-x"]        # preserved


def test_duplicate_reference_name_is_a_loud_error():
    """Codex HIGH #2: a duplicated reference name is ambiguous; import errors rather than
    silently resolving to the first id (which corrupted the round-trip)."""
    doc = copy.deepcopy(ORG)
    doc["roles"].append({"id": "dev2", "name": "Developer"})   # duplicate role name
    merged, errors, _ = import_document(
        RequirementsIn(**doc), _csv([_row(roles="Developer")]), "csv", ImportMode.REPLACE)
    assert any("Ambiguous role name 'Developer'" in e for e in errors)


def test_semicolon_in_reference_name_fails_loud():
    """Codex HIGH #3: a name containing the multi-value separator can't round-trip; the import
    fails loud (unknown ref) instead of silently splitting/corrupting."""
    doc = copy.deepcopy(ORG)
    doc["roles"] = [{"id": "devops", "name": "Dev;Ops"}]
    doc["employees"] = [{"id": "x", "name": "X", "team": "a", "roles": ["devops"], "projects": ["p"]}]
    doc["demand"] = [{"team": "a", "shift_type": "m", "days": ["Sun"], "crew": {"p": {"devops": 1}}}]
    req = RequirementsIn(**doc)
    merged, errors, _ = import_document(req, requirements_to_csv(req), "csv", ImportMode.REPLACE)
    assert any("unknown role 'Dev'" in e for e in errors)


def test_upsert_by_name_keeps_existing_id():
    """Codex MED #4: name-upsert updates the matched record in place and never rewrites its id."""
    merged, errors, _ = import_document(
        base(), _csv([_row(id="differentid", name="Dana", can_manage="true")]),
        "csv", ImportMode.UPSERT_NAME)
    assert errors == []
    danas = [e for e in merged["employees"] if e["name"] == "Dana"]
    assert len(danas) == 1 and danas[0]["id"] == "dana"  # identity preserved
    assert danas[0]["can_manage"] is True


def test_upsert_rejects_duplicate_keys_in_file():
    """Codex MED #4: duplicate upsert keys within the file are rejected, not silently picked."""
    merged, errors, _ = import_document(
        base(), _csv([_row(id="a", name="Same"), _row(id="b", name="Same")]),
        "csv", ImportMode.UPSERT_NAME)
    assert any("two rows with name 'Same'" in e for e in errors)


def test_autocreate_project_unions_teams_across_rows():
    """Codex MED #5: an auto-created project referenced by rows on different teams becomes a
    valid multi-team project (ADR-0003), independent of row order."""
    doc = copy.deepcopy(ORG)
    doc["teams"].append({"id": "b", "name": "Beta", "site": "hq"})
    merged, errors, _ = import_document(RequirementsIn(**doc), _csv([
        _row(id="r1", name="R1", team="Alpha", projects="NewProj"),
        _row(id="r2", name="R2", team="Beta", projects="NewProj"),
    ]), "csv", ImportMode.REPLACE_AUTOCREATE)
    assert errors == []
    np = next(p for p in merged["projects"] if p["name"] == "NewProj")
    assert set(np["teams"]) == {"a", "b"}


def test_oversized_import_is_rejected():
    """Codex MED #6: bound the parser's input independent of the header-only request guard."""
    from app.portability import MAX_IMPORT_BYTES
    merged, errors, _ = import_document(base(), "x" * (MAX_IMPORT_BYTES + 1), "json", ImportMode.REPLACE)
    assert any("too large" in e for e in errors)
    assert merged == base().model_dump()                 # unchanged


def test_import_endpoint_validates_via_requirements_flow(client):
    # a CSV that references an unknown project, with autocreate OFF -> parse error surfaced
    bad = "id,name,team,roles,projects,can_manage,status\nx,X,Alpha,Developer,Ghost,false,active\n"
    r = client.post("/api/import", json={"requirements": ORG, "format": "csv",
                                         "mode": "replace", "content": bad}).json()
    assert r["requirements"] is None and any("unknown project 'Ghost'" in e for e in r["errors"])

    # a good JSON import returns the merged document + validation result
    good = __import__("json").dumps(ORG)
    r = client.post("/api/import", json={"requirements": ORG, "format": "json",
                                         "mode": "replace", "content": good}).json()
    assert r["errors"] == [] and r["requirements"]["employees"][0]["id"] == "dana"
