"""Import / export of the requirements document (Phase 5).

Two formats:
  * **JSON** — *lossless*. The exact `RequirementsIn` document; round-trips byte-for-byte
    in meaning. Import = replace the whole document.
  * **CSV** — *lossy* employee roster only. References (team / roles / projects / preferred
    shift types) are written by NAME for human editing; the internal `id` is column 1 so a
    round-trip can match rows back. Multi-value cells are `;`-separated. Carry-over fields
    and `avoid_shift_ids` are NOT exported (they are week-specific) and reset to defaults on
    a replace import — this is the lossiness.

Import is **mode-pluggable** (`ImportMode`): replace-all (default), upsert by id or name, or
replace + auto-create any referenced entity that doesn't exist yet. The merged document is
handed back to the caller, which validates it through the normal `validate_requirements`
flow (reused, not duplicated here).
"""
from __future__ import annotations

import csv
import io
import json
from enum import Enum

from .config import MAX_REQUEST_BYTES
from .requirements import RequirementsIn

# A row/byte cap for an uploaded file, independent of the (header-only) request-size
# middleware: CSV/JSON parsing happens before validate_requirements' MAX_EMPLOYEES cap,
# so bound the parser's input here too (defends a chunked/missing-Content-Length body).
MAX_IMPORT_BYTES = MAX_REQUEST_BYTES


class ImportMode(str, Enum):
    REPLACE = "replace"                       # imported roster replaces all employees
    UPSERT_ID = "upsert_by_id"                # merge by id (update existing, add new)
    UPSERT_NAME = "upsert_by_name"            # merge by name
    REPLACE_AUTOCREATE = "replace_autocreate_refs"  # replace + create missing referenced refs


EMPLOYEE_CSV_COLUMNS = [
    "id", "name", "team", "roles", "projects", "can_manage", "status",
    "employee_number", "email", "phone", "hire_date", "notes",
    "preferred_shift_types", "unavailable_dates",
]

# Roster fields the CSV drops (week-specific / shift-id-specific). On a replace import they
# return to these defaults — the documented lossiness of the CSV format.
_CSV_LOSSY_DEFAULTS = {
    "avoid_shift_ids": [], "carryover_burden": 0, "worked_last_weekend": False,
    "prev_shift_end": None, "prev_shift_was_night": False,
}

# Defaults for CSV-carried columns that a *partial* file omits. Imported rows include only
# the fields whose column is actually in the header (the CSV only patches what it carries),
# so a NEW employee built from a partial file needs the rest filled in: EmployeeIn requires
# `team`, and an empty team surfaces as a normal "unknown team ''" validation error instead
# of a crash. Matched upsert rows never use these — an absent column leaves the existing
# value untouched.
_CSV_NEW_ROW_DEFAULTS = {
    "team": "", "roles": [], "projects": [], "can_manage": False, "status": "active",
    "employee_number": None, "email": None, "phone": None, "hire_date": None, "notes": None,
    "preferred_shift_type_ids": [], "unavailable_dates": [],
}


# --- export ------------------------------------------------------------------

def requirements_to_json(req: RequirementsIn) -> str:
    """Lossless: the full document as pretty JSON."""
    return json.dumps(req.model_dump(), indent=2, ensure_ascii=False)


def _join(values) -> str:
    return ";".join(values)


def requirements_to_csv(req: RequirementsIn) -> str:
    """Lossy employee roster: id (col 1) + names for all references, `;`-multi-value."""
    team_name = {t.id: t.name for t in req.teams}
    role_name = {r.id: r.name for r in req.roles}
    proj_name = {p.id: p.name for p in req.projects}
    st_name = {s.id: s.name for s in req.shift_types}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(EMPLOYEE_CSV_COLUMNS)
    for e in req.employees:
        w.writerow([
            e.id, e.name, team_name.get(e.team, e.team),
            _join(role_name.get(r, r) for r in e.roles),
            _join(proj_name.get(p, p) for p in e.projects),
            "true" if e.can_manage else "false",
            e.status, e.employee_number or "", e.email or "", e.phone or "",
            e.hire_date or "", e.notes or "",
            _join(st_name.get(s, s) for s in e.preferred_shift_type_ids),
            _join(e.unavailable_dates),
        ])
    return buf.getvalue()


def export(req: RequirementsIn, fmt: str) -> tuple[str, str]:
    """Return (content, filename) for the requested format."""
    if fmt == "json":
        return requirements_to_json(req), "requirements.json"
    if fmt == "csv":
        return requirements_to_csv(req), "roster.csv"
    raise ValueError(f"unknown export format {fmt!r}")


# --- import ------------------------------------------------------------------

def _split(cell: str | None) -> list[str]:
    return [x.strip() for x in (cell or "").split(";") if x.strip()]


def _truthy(s: str | None) -> bool:
    return (s or "").strip().lower() in ("true", "1", "yes", "y")


def _slug(prefix: str, name: str, used: set[str]) -> str:
    base = prefix + "-" + "".join(c if c.isalnum() else "-" for c in name.strip().lower()).strip("-")
    base = base or prefix
    cand, n = base, 1
    while cand in used:
        n += 1
        cand = f"{base}-{n}"
    used.add(cand)
    return cand


def import_document(base: RequirementsIn, content: str, fmt: str,
                    mode: ImportMode) -> tuple[dict, list[str], list[str]]:
    """Merge `content` into `base` per `fmt`/`mode`. Returns (merged_doc, errors, warnings).

    `merged_doc` is a plain dict (a RequirementsIn-shaped document) that the caller
    validates with `validate_requirements`. On a parse error the merged_doc is the
    unchanged base so the caller can surface the errors without losing state.
    """
    if len(content.encode("utf-8")) > MAX_IMPORT_BYTES:
        return base.model_dump(), [f"Import is too large (>{MAX_IMPORT_BYTES} bytes)."], []
    if fmt == "json":
        return _import_json(base, content, mode)
    if fmt == "csv":
        return _import_csv(base, content, mode)
    return base.model_dump(), [f"Unknown import format {fmt!r}."], []


def _import_json(base: RequirementsIn, content: str, mode: ImportMode) -> tuple[dict, list[str], list[str]]:
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, ValueError) as exc:
        return base.model_dump(), [f"Invalid JSON: {exc}"], []
    if not isinstance(data, dict):
        return base.model_dump(), ["JSON import must be a requirements object."], []
    warnings: list[str] = []
    if mode is not ImportMode.REPLACE:
        # JSON is a lossless whole-document snapshot; only replace-all is meaningful.
        warnings.append(f"JSON import ignores mode {mode.value!r}; it replaces the whole document.")
    return data, [], warnings


def _import_csv(base: RequirementsIn, content: str, mode: ImportMode) -> tuple[dict, list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    autocreate = mode is ImportMode.REPLACE_AUTOCREATE

    # name -> id maps from the base document, plus the set of NON-UNIQUE names. A CSV
    # addresses references by name, so an ambiguous name cannot be resolved safely — it is a
    # hard error (silently picking one id would corrupt the round-trip), not a warning.
    def name_map(items):
        m: dict[str, str] = {}
        dups: set[str] = set()
        for it in items:
            if it.name in m:
                dups.add(it.name)
            else:
                m[it.name] = it.id
        return m, dups

    team_id, team_dups = name_map(base.teams)
    role_id, role_dups = name_map(base.roles)
    proj_id, proj_dups = name_map(base.projects)
    st_id, st_dups = name_map(base.shift_types)

    # working copies (autocreate appends here); start from base so existing refs survive.
    teams = [t.model_dump() for t in base.teams]
    roles = [r.model_dump() for r in base.roles]
    projects = [p.model_dump() for p in base.projects]
    shift_types = [s.model_dump() for s in base.shift_types]
    proj_by_id = {p["id"]: p for p in projects}
    autocreated_proj_ids: set[str] = set()
    used_ids = {x["id"] for x in teams + roles + projects + shift_types}
    # In merge modes the existing employees survive, so an auto-generated (blank-id) row
    # must not slug to an id already in use — otherwise a new hire whose name collides with
    # an unrelated existing employee would silently overwrite that record. REPLACE modes
    # discard the existing employees, so their ids stay reusable (keeps import idempotent).
    if mode not in (ImportMode.REPLACE, ImportMode.REPLACE_AUTOCREATE):
        used_ids |= {e.id for e in base.employees}

    def resolve(name, kind, id_map, dups, register):
        if name in dups:
            errors.append(f"Ambiguous {kind} name {name!r} (multiple {kind}s share it); "
                          f"rename for a unique CSV reference.")
            return None
        if name in id_map:
            return id_map[name]
        if autocreate:
            return register(name)
        errors.append(f"Row references unknown {kind} {name!r} (no such {kind} in the document).")
        return None

    def reg_role(name):
        rid = _slug("role", name, used_ids)
        roles.append({"id": rid, "name": name}); role_id[name] = rid
        return rid

    def reg_shift_type(name):
        sid = _slug("st", name, used_ids)
        shift_types.append({"id": sid, "name": name, "start": 8, "end": 16, "is_night": False})
        st_id[name] = sid
        return sid

    def reg_team(name):
        if not base.sites:
            errors.append(f"Cannot auto-create team {name!r}: the document has no sites.")
            return None
        tid = _slug("team", name, used_ids)
        teams.append({"id": tid, "name": name, "site": base.sites[0].id}); team_id[name] = tid
        return tid

    def resolve_project(name, row_team_id):
        # As `resolve`, but auto-created projects union in the team of EVERY row that uses
        # them — so two rows on different teams referencing one new project name produce a
        # valid multi-team project regardless of row order (ADR-0003).
        if name in proj_dups:
            errors.append(f"Ambiguous project name {name!r} (multiple projects share it); "
                          f"rename for a unique CSV reference.")
            return None
        pid = proj_id.get(name)
        if pid is None:
            if not autocreate:
                errors.append(f"Row references unknown project {name!r} (no such project in the document).")
                return None
            pid = _slug("proj", name, used_ids)
            entry = {"id": pid, "name": name, "teams": []}
            projects.append(entry); proj_by_id[pid] = entry; proj_id[name] = pid
            autocreated_proj_ids.add(pid)
        if pid in autocreated_proj_ids and row_team_id and row_team_id not in proj_by_id[pid]["teams"]:
            proj_by_id[pid]["teams"].append(row_team_id)
        return pid

    # A legally-exported field (an unbounded `notes`, say) can exceed csv's default
    # 128 KiB per-field limit; the import's own byte cap is the real bound. And any
    # csv.Error is a normal parse error in the response contract — never a 500.
    csv.field_size_limit(MAX_IMPORT_BYTES)
    reader = csv.DictReader(io.StringIO(content))
    try:
        fieldnames = reader.fieldnames
    except csv.Error as exc:
        return base.model_dump(), [f"Invalid CSV: {exc}"], warnings
    if fieldnames is None or "id" not in fieldnames or "name" not in fieldnames:
        return base.model_dump(), ["CSV must have a header row with at least 'id' and 'name' columns."], warnings
    cols = set(fieldnames)

    imported: list[dict] = []                           # CSV-carried fields only (no lossy defaults)
    seen_ids: set[str] = set()
    try:
        rows = list(enumerate(reader, start=2))         # row 1 is the header
    except csv.Error as exc:
        return base.model_dump(), [f"Invalid CSV: {exc}"], warnings
    for n, row in rows:
        eid = (row.get("id") or "").strip()
        ename = (row.get("name") or "").strip()
        if not ename:
            errors.append(f"CSV row {n}: missing employee name.")
            continue
        if not eid:
            eid = _slug("emp", ename, used_ids)
        if eid in seen_ids:
            errors.append(f"CSV row {n}: duplicate id {eid!r} within the file.")
            continue
        seen_ids.add(eid)

        team = (resolve((row.get("team") or "").strip(), "team", team_id, team_dups, reg_team)
                if (row.get("team") or "").strip() else "")
        rids = [resolve(x, "role", role_id, role_dups, reg_role) for x in _split(row.get("roles"))]
        pids = [resolve_project(x, team) for x in _split(row.get("projects"))]
        stids = [resolve(x, "shift type", st_id, st_dups, reg_shift_type)
                 for x in _split(row.get("preferred_shift_types"))]
        # Include ONLY the fields whose column the file actually carries (DATA_MODEL §7:
        # "the CSV only patches the fields it carries") — a column absent from the header
        # must not reset a matched employee's value to a default on upsert.
        rec: dict = {"id": eid, "name": ename}
        if "team" in cols:
            rec["team"] = team or ""
        if "roles" in cols:
            rec["roles"] = [r for r in rids if r]
        if "projects" in cols:
            rec["projects"] = [p for p in pids if p]
        if "can_manage" in cols:
            rec["can_manage"] = _truthy(row.get("can_manage"))
        if "status" in cols:
            rec["status"] = (row.get("status") or "active").strip() or "active"
        for col in ("employee_number", "email", "phone", "hire_date", "notes"):
            if col in cols:
                rec[col] = (row.get(col) or "").strip() or None
        if "preferred_shift_types" in cols:
            rec["preferred_shift_type_ids"] = [s for s in stids if s]
        if "unavailable_dates" in cols:
            rec["unavailable_dates"] = _split(row.get("unavailable_dates"))
        imported.append(rec)

    merged_employees = _merge_employees([e.model_dump() for e in base.employees], imported, mode, errors)
    doc = base.model_dump()
    doc.update(employees=merged_employees, teams=teams, roles=roles,
               projects=projects, shift_types=shift_types)
    return doc, errors, warnings


def _merge_employees(existing: list[dict], imported: list[dict], mode: ImportMode,
                     errors: list[str]) -> list[dict]:
    """Merge CSV-carried employee fields into `existing` per mode. Each imported row holds
    only the fields whose column the file carries, so:
      * replace / new rows  → fields the file doesn't carry take `_CSV_LOSSY_DEFAULTS` +
        `_CSV_NEW_ROW_DEFAULTS` (a complete, validatable record);
      * upsert match        → every omitted field (carry-over, avoid_shift_ids, and any
        column absent from a partial file) is PRESERVED from the existing record, and the
        existing id is kept (name-upsert never rewrites identity). Duplicate upsert keys
        in base or file are rejected.
    """
    if mode in (ImportMode.REPLACE, ImportMode.REPLACE_AUTOCREATE):
        return [{**_CSV_LOSSY_DEFAULTS, **_CSV_NEW_ROW_DEFAULTS, **csv} for csv in imported]

    key = "id" if mode is ImportMode.UPSERT_ID else "name"
    by_key: dict[str, int] = {}
    for i, e in enumerate(existing):
        if e[key] in by_key:
            errors.append(f"Cannot upsert by {key}: the existing roster has two employees "
                          f"with {key} {e[key]!r}.")
        by_key.setdefault(e[key], i)
    seen_keys: set[str] = set()
    out = list(existing)
    for csv in imported:
        k = csv[key]
        if k in seen_keys:
            errors.append(f"Cannot upsert by {key}: the import has two rows with {key} {k!r}.")
            continue
        seen_keys.add(k)
        idx = by_key.get(k)
        if idx is None:                                  # new employee — omitted fields default
            by_key[k] = len(out)
            out.append({**_CSV_LOSSY_DEFAULTS, **_CSV_NEW_ROW_DEFAULTS, **csv})
        else:                                            # update in place — keep id + omitted fields
            out[idx] = {**out[idx], **csv, "id": out[idx]["id"]}
    return out
