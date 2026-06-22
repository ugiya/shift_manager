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
        "projects": [{"id": p.id, "name": p.name, "team_id": p.team_id} for p in dataset.projects],
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


def apply_assignments(schedule: Schedule, assignments: dict[str, str | None],
                      employees_by_id: dict) -> Schedule:
    """Set each seat's employee from a {seat_id: employee_id|null} map.

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
