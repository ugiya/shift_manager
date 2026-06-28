"""JSON (de)serialization between the API and the Timefold domain."""
from __future__ import annotations

from .analysis import seat_label, shift_label
from .data import Dataset, build_lookup, build_schedule
from .domain import Schedule, Seat


def dataset_payload(dataset: Dataset, schedule: Schedule) -> dict:
    """Static structure the frontend needs to render the grid (pre-solve)."""
    lookup = build_lookup(dataset)
    return {
        "sites": [{"id": s.id, "name": s.name} for s in dataset.sites],
        "week_start": dataset.week_start.isoformat(),
        "days": [d for d in _week_days(dataset)],
        "roles": [{"id": r.id, "name": r.name} for r in dataset.roles],
        "teams": [{"id": t.id, "name": t.name, "site_id": t.site_id} for t in dataset.teams],
        "projects": [{"id": p.id, "name": p.name, "team_ids": sorted(p.team_ids)} for p in dataset.projects],
        "shift_types": [{"id": st.id, "name": st.name, "is_night": st.is_night,
                         "start_hour": st.start_hour, "end_hour": st.end_hour}
                        for st in dataset.shift_types],
        "employees": [{
            "id": e.id, "name": e.name, "team_id": e.team_id,
            "role_ids": sorted(e.role_ids), "project_ids": sorted(e.project_ids),
            "can_manage": e.can_manage,
            "avoid_shift_ids": sorted(e.avoid_shift_ids),
            "carryover_burden": e.carryover_burden,
            "worked_last_weekend": e.worked_last_weekend,
            "prev_shift_end": e.prev_shift_end.isoformat() if e.prev_shift_end else None,
            "prev_shift_was_night": e.prev_shift_was_night,
        } for e in dataset.employees],
        "shifts": [_shift_payload(s) for s in _sorted_shifts(schedule)],
        "seats": [_seat_payload(s, lookup) for s in schedule.seats],
    }


def _week_days(dataset: Dataset) -> list[str]:
    from datetime import timedelta
    return [(dataset.week_start + timedelta(days=i)).isoformat() for i in range(7)]


def _sorted_shifts(schedule: Schedule):
    return sorted(schedule.shifts, key=lambda s: (s.start_dt, s.team_id))


def _shift_payload(s) -> dict:
    return {
        "id": s.id,
        "shift_type_id": s.shift_type.id,
        "shift_type_name": s.shift_type.name,
        "team_id": s.team_id,
        "site_id": s.site_id,
        "date": s.start_date.isoformat(),
        "weekday": s.start_dt.weekday(),
        "start": s.start_dt.isoformat(),
        "end": s.end_dt.isoformat(),
        "is_night": s.is_night,
        "is_weekend": s.is_weekend,
        "label": shift_label(s),
    }


def _seat_payload(seat: Seat, lookup: dict) -> dict:
    return {
        "id": seat.id,
        "kind": seat.kind,
        "shift_id": seat.shift.id,
        "team_id": seat.team_id,
        "project_id": seat.project_id,
        "role_id": seat.role_id,
        "label": seat_label(seat, lookup),
        "eligible_employee_ids": [e.id for e in seat.eligible],
    }


def assignments_of(schedule: Schedule) -> dict[str, str | None]:
    return {s.id: (s.employee.id if s.employee else None) for s in schedule.seats}


def validate_assignments(schedule: Schedule, assignments: dict[str, str | None],
                         employees_by_id: dict, inactive_ids: set | None = None) -> list[str]:
    """Errors for an assignments map: every key must be a real seat id and every
    non-null value a real employee id. Catches stale client state instead of
    silently masking an unknown employee as 'unfilled'.

    `employees_by_id` holds only the schedulable (active) employees. An override
    that names a *retained but non-active* employee (in `inactive_ids`) is rejected
    with a clear "not active" message rather than the misleading "unknown" — inactive
    / on-leave people cannot be scheduled even via an Exceptional override.

    Snapshot semantics (not patch): the map is the *complete* desired state. The
    service is stateless — each call rebuilds the Schedule with every seat empty and
    then applies the map — so a seat that is absent (or null) is intentionally
    unassigned. There is no prior server state to "leave unchanged", which is why a
    missing seat id is not an error: best-effort scheduling allows unfilled seats."""
    inactive_ids = inactive_ids or set()
    errors: list[str] = []
    seat_ids = {s.id for s in schedule.seats}
    for seat_id, emp_id in assignments.items():
        if seat_id not in seat_ids:
            errors.append(f"Assignment references unknown seat id {seat_id!r}.")
        if emp_id is not None and emp_id not in employees_by_id:
            if emp_id in inactive_ids:
                errors.append(f"Assignment for seat {seat_id!r} references employee "
                              f"id {emp_id!r}, who is not active and cannot be scheduled.")
            else:
                errors.append(f"Assignment for seat {seat_id!r} references unknown "
                              f"employee id {emp_id!r}.")
    return errors


def apply_assignments(schedule: Schedule, assignments: dict[str, str | None],
                      employees_by_id: dict) -> Schedule:
    """Set each seat's employee from a {seat_id: employee_id|null} map.

    Snapshot, not patch: a seat absent from the map is left unassigned (see
    `validate_assignments`). Send the full desired state every call.

    Employees that are not in a seat's eligible list are still applied (that is an
    Exceptional Assignment from an Override) -- re-validation will flag them.
    """
    for seat in schedule.seats:
        emp_id = assignments.get(seat.id)
        seat.employee = employees_by_id.get(emp_id) if emp_id else None
    return schedule


def fresh_schedule_and_index(dataset: Dataset):
    schedule = build_schedule(dataset)
    employees_by_id = {e.id: e for e in dataset.employees}
    return schedule, employees_by_id
