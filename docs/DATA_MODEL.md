# Data Model — Shift Scheduler (authoritative)

> **This file is the source of truth for the app's data model.** It is derived from
> the code (file:line cited throughout) — not from conversational memory. If a
> session summary, compaction, or anything you "remember" disagrees with this file,
> **this file wins**; re-read the cited code to confirm before acting.
>
> **Maintenance rule:** any change to an entity, field, relationship, the scoring
> model, or the carry-over contract MUST update this file in the *same* change.
> See `CLAUDE.md` for the guardrails.

Last verified against the working tree on 2026-06-27.

---

## 1. The three layers

Data lives in three forms; know which one you're touching.

| Layer | What | Where |
|-------|------|-------|
| **Input** (`*In`) | The editable "requirements document" the client holds and POSTs. Pydantic models. References by **id**. | `backend/app/requirements.py` |
| **Domain** | Immutable Timefold problem facts + planning entity. Built from input by `to_dataset` + `build_schedule`. | `backend/app/domain.py`, `backend/app/data.py` |
| **Output** (payload) | JSON the frontend renders: dataset payload, score breakdown, flags, carry-over seed. | `backend/app/serialize.py`, `backend/app/solver.py`, `backend/app/carryover.py` |

Flow: `RequirementsIn` → `validate_requirements` → `to_dataset` (→ `Dataset`) →
`build_schedule` (→ `Schedule` of `Seat`s) → solve/score → `dataset_payload` + score + flags + `next_carryover`.

---

## 2. Domain entities (`backend/app/domain.py`)

Problem facts are **immutable** (`@dataclass(frozen=True)`). IDs are the stable keys;
names are display only.

- **Site** (`:29`) — `id, name`. A physical location.
- **Role** (`:35`) — `id, name`. A skill (e.g. Developer, QA). No built-ins.
- **Team** (`:41`) — `id, name, site_id`. **A team belongs to exactly one site.**
- **Project** (`:48`) — `id, name, team_ids: frozenset`. **A project may run under one or
  more teams** (ADR-0003), and since each team is at one site, a multi-team project spans
  sites. `ProjectIn.teams` (input) is the list form.
- **ShiftType** (`:55`) — `id, name, is_night, start_hour (0-23), end_hour (0-23)`.
  `end_hour <= start_hour` ⇒ the shift crosses midnight. Reusable, date-independent.
- **Employee** (`:64`) — `id, name, team_id, role_ids: frozenset, project_ids: frozenset,
  can_manage`, plus `avoid_shift_ids: frozenset` (shifts they'd rather not work) and
  the **carry-over** fields `carryover_burden, worked_last_weekend, prev_shift_end, prev_shift_was_night`.
  An employee is in **one team**, holds **roles**, and (as a worker) belongs to **projects** within that team.
- **Shift** (`:85`) — `id, shift_type, team_id, site_id, start_dt, end_dt`. A ShiftType
  on a concrete date for one team at one site. Derived: `is_night`, `start_date`,
  `is_weekend` (keys off the **start** day; weekend = Fri/Sat per config).
- **Seat** (`:114`, the **planning entity**) — one required position to fill:
  - *worker seat* = (Shift × Project × Role), or *manager seat* = (Shift × Team).
  - `kind ('worker'|'manager'), shift, team_id, project_id, role_id`.
  - `eligible: list[Employee]` — the **value range** (only these may fill it).
  - `employee: Optional[Employee]` — the **planning variable**, nullable
    (`allows_unassigned=True`) ⇒ best-effort: a seat may be left unfilled.
  - Derived: `is_burden` = the shift is night or weekend.
- **Schedule** (`:140`, the **planning solution**) — `employees, shifts, seats, score`.

**Seat materialisation & eligibility** (`backend/app/data.py:build_schedule` `:234`):
for each demand row, for each selected weekday in the week, create the Shift, **one
manager seat** (eligible = team members with `can_manage`, `:230`), and **one worker
seat per (project, role, count)** (eligible = employees who have that project in
`project_ids`, that role in `role_ids`, **and are in the seat's own team**
(`employee.team_id == seat.team_id`, ADR-0003), `:226`). The solver never assigns
outside `eligible`; a manual override outside it — including staffing a cross-site
project's seat from another site — is an **Exceptional Assignment** (see §4).

Stable id formats: shift `shift-{team}-{shiftType}-{date}`; manager seat
`seat-{shift_id}-mgr`; worker seat `seat-{shift_id}-{project}-{role}-{n}`.

---

## 3. Input model (`backend/app/requirements.py`)

`RequirementsIn` (`:111`) = `{sites, roles, shift_types, teams, projects, employees,
demand, week_start}`. The sub-models (`SiteIn, RoleIn, ShiftTypeIn, TeamIn, ProjectIn,
EmployeeIn, DemandIn`) mirror the domain but reference by id and use input-friendly
field names (e.g. `ShiftTypeIn.start/end`, `TeamIn.site`, `ProjectIn.teams`).

- **DemandIn** (`:80`) — `team, shift_type, days: [weekday names], crew: {project: {role: count}}`.
  Demand is **exact**: each required position is one seat; an unfilled seat is
  understaffing (a Compromise). `week_start` defaults to the seed week.
- **Carry-over shape is single-sourced** as `CarryoverFields` (`:87`) — the four fields
  `{carryover_burden, worked_last_weekend, prev_shift_end, prev_shift_was_night}`. A
  contract test pins `EmployeeIn`, the seed output, and the frontend types against it.
- **HR metadata** on `EmployeeIn` (round-trip only): `status` (`active`|`on-leave`|`inactive`),
  `employee_number, email, phone, hire_date, notes`. Only `status == "active"` employees are
  materialised by `to_dataset` and counted in coverage warnings; inactive/on-leave people
  stay in the roster (and export) but are never scheduled. The domain `Employee` does NOT
  carry HR metadata — it's an input/export concern.
- `validate_requirements` returns `(errors, warnings)`; `to_dataset` converts to `Dataset`.

---

## 4. Scoring model (`backend/app/constraints.py`, `backend/app/solver.py`)

Timefold is the **scoring authority**; `analysis.py` produces the human-readable
**flags** and MUST mirror `constraints.py` exactly (pinned by `tests/test_rule_parity.py`
and `test_score_authority.py`).

**Score type: `HardMediumSoftScore`** (three levels, each strictly dominates the next):
- **HARD** — physical/legal impossibilities. Any hard violation = *Infeasible*.
- **MEDIUM** — **demand coverage** only. Sits above all soft rules so coverage can never
  be sacrificed for a soft preference.
- **SOFT** — the preference/fairness rules.

Two orthogonal axes in the rule registry (`constraints.py:28`): `kind` (domain taxonomy:
`hard`=Infeasibility, `soft`=Compromise) vs `level` (score level: `hard|medium|soft`).
They usually match; the deliberate exception is coverage (`kind=soft`, `level=medium`).

**The rules** (plain English — the codes are just the ids in `constraints.py`):

| Code | Meaning | Level |
|------|---------|-------|
| **R1** | One person can't work two overlapping shifts at once | hard |
| **R2** | At least one day off per week | hard |
| **R3** | Minimum legal rest gap between any two shifts (incl. across the week boundary via carry-over) | hard |
| **R4** | Meet staffing demand — an unfilled required seat is understaffing | **medium (coverage)** |
| **R5** | At most one shift per calendar day | soft |
| **R6** | Long recovery after a night shift (incl. across the week boundary) | soft |
| **R7** | Don't work two weekends in a row | soft |
| **R8** | Prefer a second day off (working 6 days is discouraged) | soft |
| **R9** | Fairness — spread night/weekend "burden" shifts evenly (cumulative across weeks) | soft |
| **R10** | Respect "I'd rather not work this shift" preferences | soft |
| **EXC** | Exceptional Assignment — someone placed outside their normal role/project/team eligibility; only via a manual override, needs sign-off | soft |

`score_breakdown` (`solver.py:60`) returns `{score, hard_score, medium_score, soft_score,
feasible (=hard>=0), constraints:[{name, rule, kind, level, match_count, score}]}`.

Tunables in `backend/app/config.py`: `LEGAL_REST_MINUTES` (8h), `NIGHT_REST_MINUTES`
(24h), `WEEKEND_WEEKDAYS` ({Fri,Sat}), the soft weights, and the resource caps
(`MAX_SEATS`, `MAX_EMPLOYEES`, `MAX_CARRYOVER_BURDEN=1000`, `MAX_REQUEST_BYTES`, `MAX_SOLVE_SECONDS`).

---

## 5. Carry-over across weeks (ADR-0002) — `backend/app/carryover.py`

Schedules are **continuous**: an accepted week seeds the next. The four carry-over
fields on each employee drive R3/R6 across the boundary, R7, and R9. See
`docs/adr/0002-schedules-are-continuous-across-weeks.md` for the full decision; do not
re-derive it from memory.

- **Out:** `/api/solve` and `/api/validate` return `next_carryover`, a self-describing
  envelope `{source_week_start, target_week_start, source_feasible, employees:{id: {the
  four fields}}}` (`carryover.carryover_seed`).
- **Back in:** the client submits that envelope as the optional request field
  `carryover_seed`; `apply_carryover_seed` rejects a non-empty seed whose
  `target_week_start` is missing or ≠ the requested week, then merges it.

---

## 6. Datetime contract (load-bearing)

**All schedule datetimes are local-naive** (no timezone), built via `datetime.combine`
in `data.py:_mk_shift`. `prev_shift_end` is the only datetime a client sends, so it
**must be local-naive too** — enforced at the API edge (`validate_requirements`) and in
`to_dataset` (`_naive_datetime`, raises on a tz-aware value, incl. a trailing `Z`).
Mixing aware + naive crashes the solver/score path; don't reintroduce it.

---

## 7. Output payload & API (`backend/app/serialize.py`, `backend/app/main.py`)

Endpoints: `GET /api/health`, `GET /api/requirements` (seed doc), `POST /api/build`,
`POST /api/solve`, `POST /api/validate`. Solve/validate return
`{errors, warnings, dataset, assignments, score, flags, next_carryover}`.

`dataset_payload` (`serialize.py:9`) carries everything the UI needs to render ANY view
without more backend work: `sites, week_start, days[7], roles, teams, projects,
shift_types, employees, shifts (with team_id/site_id/date/is_night/is_weekend), seats
(with team_id/project_id/role_id/label/eligible_employee_ids)`, plus `assignments`
`{seat_id: employee_id|null}`. The frontend mirror of all these shapes is
`frontend/src/types.ts` — **keep it in sync**.

---

## 8. Planned / in-flight changes (NOT yet built — do not treat as current)

Agreed in conversation, pending implementation. Move each into the sections above
**as it lands**, and delete it from here.

- **Employee import/export**: CSV (HR-friendly, lossy, references by name, `id` as col 1)
  + JSON (lossless). Replace-all default, mode-pluggable (upsert / auto-create-refs).
- **New read-only views**: Team & Employee (people-as-rows roster), Project (seat-centric).
  Site view stays editable. Frontend-only (data already in the payload).
- **Unavailability** (new): date-based `unavailable_dates` on the employee; enforced by
  removing them from `Seat.eligible` for shifts on those dates (override ⇒ Exceptional,
  plus availability-aware coverage warnings).
- **Preferred shifts** (new, **shift-type level**): a soft rule penalising an unmet
  preference (e.g. worked a Night while preferring Mornings). Will add a new rule id +
  mirror in `analysis.py` + extend the parity CANON.
