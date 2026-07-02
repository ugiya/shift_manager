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
  can_manage`, plus `avoid_shift_ids: frozenset` (shifts they'd rather not work),
  `unavailable_dates: frozenset[date]` (dates they can't work — see eligibility below),
  `preferred_shift_type_ids: frozenset[str]` (preferred shift TYPES — drives R11), and
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
(`employee.team_id == seat.team_id`, ADR-0003), `:226`). **Unavailability:** an employee
whose `unavailable_dates` contains the shift's `start_date` is **removed from that seat's
`eligible`** (worker *and* manager, `:226`/`:234`), so the solver never assigns them then.
The solver never assigns outside `eligible`; a manual override outside it — including
staffing a cross-site project's seat from another site, or assigning someone on an
unavailable date — is an **Exceptional Assignment** (see §4).

Stable id formats: shift `shift-{team}-{shiftType}-{date}`; manager seat
`seat-{shift_id}-mgr`; worker seat `seat-{shift_id}-{project}-{role}-{n}`. A concrete
`(team, shift_type, day)` shift must be defined by a **single** demand row: duplicate
`(team, shift_type)` pairs across rows are allowed as long as their day sets are
**disjoint** (crew composition can vary by day, per CONTEXT.md); a shared day is rejected
by validation (one shift with two defining rows means colliding seat ids when the crews
share a `(project, role)`, ambiguous demand otherwise). And because the ids concatenate
their parts with `-`, validation also rejects two *different* `(team, shift_type)` pairs —
or, within one row, two different `(project, role)` crew entries — whose concatenation
produces the same id string (e.g. teams `t`+`t-a` with shift types `a-b`+`b` both mint
`shift-t-a-b-{date}`).

---

## 3. Input model (`backend/app/requirements.py`)

`RequirementsIn` (`:111`) = `{sites, roles, shift_types, teams, projects, employees,
demand, week_start}`. The sub-models (`SiteIn, RoleIn, ShiftTypeIn, TeamIn, ProjectIn,
EmployeeIn, DemandIn`) mirror the domain but reference by id and use input-friendly
field names (e.g. `ShiftTypeIn.start/end`, `TeamIn.site`, `ProjectIn.teams`).

- **DemandIn** (`:80`) — `team, shift_type, days: [weekday names], crew: {project: {role: count}}`.
  Demand is **exact**: each required position is one seat; an unfilled seat is
  understaffing (a Compromise). `week_start` defaults to the seed week
  (`Dataset.week_start`) in validation/materialisation, but `GET /api/requirements`
  overrides it to the **current week** — the Sunday on or before today, local-naive
  (`main.current_week_start`) — so a fresh session schedules *this* week, not the week
  the seed data was written for. The seed's demand is by weekday name, so the org
  re-dates cleanly. `SEED_WEEK_START` (env) pins the answer for deterministic tests;
  e2e pins `2026-06-21` because seat ids embed the week's dates.
- **Carry-over shape is single-sourced** as `CarryoverFields` (`:87`) — the four fields
  `{carryover_burden, worked_last_weekend, prev_shift_end, prev_shift_was_night}`. A
  contract test pins `EmployeeIn`, the seed output, and the frontend types against it.
- **Nullable single refs (2026-07-02 "null-out deletes")**: `TeamIn.site`,
  `EmployeeIn.team`, `DemandIn.team`, `DemandIn.shift_type` are `str | None`. Deleting an
  entity in the editor never blocks and never cascades: single references to it become
  `None` (rendered as a "Please choose" pending select), list/keyed references (employee
  roles/projects, project teams, preferred types, crew entries) just drop the entry. A
  `None` ref is a **blocking validation error** with an actionable message ("Team 'X' has
  no site — choose one."), and the shift-identity (duplicate/concat) checks skip rows with
  a pending pair. `to_dataset` only runs on validated docs, so `None` never reaches the
  domain layer.
- **Per-week project tick**: `ProjectIn.runs_this_week: bool = True`. Unticked, the
  project stays fully in the org (memberships, demand rows, export) but
  `_effective_demand` — shared by `to_dataset` AND the coverage warnings — drops its crew
  for the week: no seats materialise, no warnings fire. A demand row whose *entire* crew
  is paused doesn't run at all (not even its manager seat); an **authored** empty-crew row
  is still a deliberate manager-only shift. JSON export/import round-trips the tick; the
  employee-preferences UI hides paused projects' chips.
- **HR metadata** on `EmployeeIn` (round-trip only): `status` (`active`|`on-leave`|`inactive`),
  `employee_number, email, phone, hire_date, notes`. Only `status == "active"` employees are
  materialised by `to_dataset` and counted in coverage warnings; inactive/on-leave people
  stay in the roster (and export) but are never scheduled. The domain `Employee` does NOT
  carry HR metadata — it's an input/export concern. Because status must never affect the
  solve, **non-active rows also don't count against `MAX_EMPLOYEES`** (which bounds problem
  facts) — only `active` employees do; total roster size is bounded by `MAX_REQUEST_BYTES`.
  The "no role and cannot manage — unusable" warning is **active-only** for the same reason.
  A manual override naming a non-active employee is **rejected** (not made Exceptional) with
  a "not active" error, since inactive people cannot be scheduled even exceptionally.
- **Unavailability** on `EmployeeIn`: `unavailable_dates: list[str]` (strict ISO `YYYY-MM-DD`;
  `_bad_date` rejects non-canonical forms). Each entry is validated as a real date (a bad value
  is a blocking error); `to_dataset` converts them to the domain `frozenset[date]`. A date
  **outside the scheduled week is retained but inert** (it only affects the week it falls in) —
  intentional, so a client can keep a persistent roster of future leave. Coverage warnings are
  **availability-aware**:
  besides the structural "No employee can fill {role} on {project}", a date on which *every*
  otherwise-eligible worker/manager is unavailable yields an "everyone … is unavailable on
  {date}" / "no available shift manager on {date}" warning.
- **Preferred shift types** on `EmployeeIn`: `preferred_shift_type_ids: list[str]` (each must
  reference a known shift type — an unknown id is a blocking error). A **non-empty** set means
  "I prefer these types"; being assigned any *other* type is a soft Compromise (R11, a PENALTY
  — never a reward). Empty ⇒ no preference. `to_dataset` converts to the domain `frozenset[str]`.
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
| **R11** | Honor a "prefers these shift types" preference — assigning a non-preferred type is penalised (a PENALTY for an unmet preference, never a reward; empty preference set = no penalty) | soft |
| **EXC** | Exceptional Assignment — someone placed outside their normal role/project/team eligibility (or on a date they're **unavailable**); only via a manual override, needs sign-off. When the cause is unavailability, `analysis.py` names the date in the flag detail. | soft |

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
- **Continuity across a leave (status interaction):** `next_carryover` only emits entries
  for materialised (active) employees, so an employee inactive for a week is *absent* from
  it. `apply_carryover_seed` only overwrites employees present in the seed, so an absent
  employee's carry-over fields on the client's retained `EmployeeIn` are left untouched.
  Net effect: an employee's carry-over **freezes at its last value during a leave** (they
  accrue no new burden because they work nothing) and **resumes on reactivation** — no
  continuity loss, provided the client keeps the requirements doc (its source of truth).

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
`POST /api/solve`, `POST /api/validate`, `POST /api/export`, `POST /api/import`. Solve/validate
return `{errors, warnings, dataset, assignments, score, flags, next_carryover}`.

**Import / export** (`backend/app/portability.py`, Phase 5): `POST /api/export`
`{requirements, format}` → `{content, filename, lossy}`. `POST /api/import`
`{requirements, format, mode, content}` → `{errors, warnings, requirements}` (the merged doc,
or `null` on a parse error). Two formats:
- **JSON** — *lossless*: the full `RequirementsIn` document; import always replaces the whole
  document (any non-`replace` mode is ignored with a warning).
- **CSV** — *lossy* employee roster only: references (team/roles/projects/preferred shift
  types) written by **name**, internal `id` in **column 1**, `;`-separated multi-values.
  `avoid_shift_ids` and the carry-over fields are **not exported**. On a **replace** import (and
  for newly-added rows) they reset to defaults; on an **upsert** of a matched employee they are
  **preserved** from the existing record (the CSV only patches the fields it carries). Names with
  commas/quotes round-trip (CSV quoting); a name containing `;` cannot (it's the multi-value
  separator) and an **ambiguous (duplicated) reference name is a hard error** — the lossy roster
  assumes reference names are `;`-free and unique. The `id` column lets a round-trip match rows
  back exactly.

Import is **mode-pluggable** (`ImportMode`): `replace` (default), `upsert_by_id`,
`upsert_by_name` (matches by name, never rewrites the matched employee's `id`),
`replace_autocreate_refs` (replace + create any referenced role/shift-type/project/team that
doesn't exist — auto-created teams land under the first site; an auto-created project unions in
the team of every row that uses it). Duplicate upsert keys (in the base or the file) are
rejected. The merged document is validated through the normal `validate_requirements` flow
(reused, not duplicated); a structurally-valid import with validation errors is still returned
so the editor can surface them. An oversized upload is rejected before parsing.

`dataset_payload` (`serialize.py:9`) carries everything the UI needs to render ANY view
without more backend work: `sites, week_start, days[7], weekend_weekdays (the Python
weekday() ints that count as weekend — [4, 5] = Fri/Sat with default config), roles,
teams, projects, shift_types, employees, shifts (with
team_id/site_id/date/is_night/is_weekend), seats
(with team_id/project_id/role_id/label/eligible_employee_ids)`, plus `assignments`
`{seat_id: employee_id|null}`. The frontend mirror of all these shapes is
`frontend/src/types.ts` — **keep it in sync**.

Because the payload is view-agnostic, the frontend offers four **view modes** over the same
data (Phase 6, frontend-only): **Site** (seat grid per team), **Project** (seat-centric,
aggregating a project's seats across teams/sites per ADR-0003), **Team** and **Employee**
(people-as-rows rosters). The "View by" selector orders them **Project · Team · Employee ·
Site** and defaults to **Project** (Round 2 #3).

**All four views are editable for assignments** (Round 2 #2/#4 — this *reverses* the original
Phase-6 "overrides only in the Site view" decision). Site & Project place people via a seat
dropdown (`SeatCell`); Team & Employee use a per-cell **seat-picker** (eligible seats first,
then exceptional). Every assignment override is **immediate** and re-validates the whole week
(the *who-fills-a-slot* edit kind). The **Project view additionally edits requirements** — per
`(team, shift_type, role)` crew **counts** (steppers) and which **days** the shift runs
(toggles), including reducing a project to **none** ("No requirements this week"). Those are
the *requirements* edit kind: they mutate the **draft** and take effect only on **Save**.

The editor (and the Project view's requirement controls) edit a **local draft** (Round 2 #1):
field edits do not rebuild or re-validate until the user clicks **Save** (Discard reverts; an
import / carry-forward / initial load resyncs the draft). Solve and Carry are gated while
there are unsaved edits, so a stale doc can't be solved. **Assignment editing is also paused
in every view while requirement edits are unsaved, a rebuild is in flight, or a solve is
running** — the Save rebuild resets assignments (and a mid-solve edit would silently discard
the solve), so editing then would lose work. This is a UI-interaction concern only — it does
not change the data model, the scoring levels, or the carry-over contract.

**Client-side session & conveniences (Round 3, frontend-only — no data-model change):**
- **Autosave/restore** (`frontend/src/lib/persist.ts`): the whole working session — committed
  doc, unsaved draft, assignments, the applied carry-over seed, and UI position — persists to
  localStorage (debounced) and is restored on load; restored assignments are filtered to
  still-existing seats/employees and **re-validated against the backend** (score/flags/seed
  are never trusted from storage — the scoring authority stays Timefold). "Reset to seed" (in
  the editor, two-step confirm) fetches the server seed first, then discards the session.
  Known limitation: one localStorage key — two tabs are last-writer-wins.
- **Seed lifecycle**: an applied carry-over seed is dropped automatically when the committed
  doc's week no longer matches its `target_week_start` (week edit / import of another week),
  and always on an **import** (the imported doc's own carry-over fields are the new truth).
  The topbar "seeded" tag has a **×** to remove the seed manually. In the editor, employees a
  seed covers show the **seed's** carry-over values, disabled (the doc's own values are not
  what the solve uses).
- **Undo/redo** for assignment overrides (snapshot stack, ⌘Z/⇧⌘Z + buttons); history
  re-baselines (clears) on rebuild, solve and carry-forward.
- **Week navigation** (2026-07-02): the topbar has a **week picker** — any picked date
  snaps to its week's **Sunday** (`lib/dates.ts weekStartOf`; a mid-week start would skew
  the 7-day grid against the weekday-name demand model). Changing week is a *requirements*
  edit: it commits through the normal change path (score resets, rebuild, week-mismatched
  seed dropped) and is gated while `dirty || building || solving`. On load, a **restored**
  session whose week is strictly before today's week gets an **ask-on-load dialog** —
  "Stay on {old week}" vs "Start current week" (jump = the same requirements edit). Fresh
  starts never ask: the server already hands out the current week (§3). The frontend
  mirrors the backend's Sunday rule in one helper (`currentWeekStart`).
- **Workload tab** (side panel): per-employee shifts / nights / weekend shifts and cumulative
  burden (carry-over + this week's night-or-weekend shifts — same `is_burden` notion as §2)
  vs the team average. Derived from payload + assignments; display only.
- **Schedule export**: a print-only rendering of the whole week (browser Print/PDF) and a
  **schedule CSV** (one row per seat incl. UNFILLED; distinct from the Phase-5 requirements
  CSV, which round-trips the org document).
- **i18n**: English/Hebrew UI chrome with RTL (`frontend/src/lib/i18n.tsx`); weekend shading
  everywhere derives from the payload's `weekend_weekdays` (backend config), not a hardcoded
  Fri/Sat. Backend-generated flag prose stays English.
- **Editor layout (2026-07-02)**: three tabs — **Organization** (sites, roles, shift types,
  teams, projects), **Employee Preferences** (the employee roster, filterable by team — a
  team lead's view), **Project Requirements** (the per-week "Working this week" project
  ticks + demand, filterable by project — a project lead's view; the filter also narrows
  each row's crew chunks to that project). One draft/Save bar and one issues panel span all
  tabs. Deletes follow the null-out model (§3); an unreachable backend surfaces as a
  friendly "server unreachable, session saved locally" message, not a raw fetch error.

---

## 8. Planned / in-flight changes (NOT yet built — do not treat as current)

_All planned features through Phase 6 have landed and moved into the sections above._
New plans get added here first, then move up as they ship.
