# Shift Scheduler — MVP

A working web app that staffs a **week of shifts across four sites** with a
constraint solver, then explains every place it bent or broke a rule. It
implements the domain modelled in [`CONTEXT.md`](./CONTEXT.md) and the decisions
in [`docs/adr/`](./docs/adr).

- **Best-effort optimizer, not a feasibility solver** — it always returns a
  complete schedule and reports each **Compromise** (soft-rule violation) and
  **Infeasibility** (hard-rule violation), rather than refusing on a hard week.
- **Whole-schedule re-validation** — any manual Override re-checks the *entire*
  schedule and re-raises every flag it affects, anywhere.
- **Carry-over** — the solve is not stateless: prior-week facts (last weekend
  worked, last night shift) and cumulative burden counts feed the current week.
- **Bring your own org** — an in-browser **Requirements editor** lets you define
  sites, roles, shift types, teams, projects, employees and per-shift demand from
  scratch (or edit the seed), with live validation, then solve it.

## Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Scheduling engine | **Timefold Solver** (Python SDK) | Successor to OptaPlanner. Its constraint-stream scoring gives a per-constraint breakdown that maps directly onto the "report every Compromise" requirement. Runs a JVM under the hood via JPype. |
| Backend | **FastAPI** (Python 3.12) | Thin, typed API; serves the built SPA single-origin. |
| Frontend | **React + TypeScript + Vite** | Responsive schedule grid, per-seat override dropdowns, live flags panel. |
| Tests | **pytest** + **Playwright** (driving **Brave**) | 838 backend + 62 e2e. |

> Python is pinned to **3.12** (Timefold/JPype have no wheels for 3.13+), and a
> **JDK 17+** must be present at runtime (`JAVA_HOME`).

## The four sites

| Site | Character | Teams |
|------|-----------|-------|
| Tel Aviv HQ | Software, Sun–Thu + a couple of nights | Team Alpha, Team Bravo |
| Haifa Plant | 24/7 operations, heavy nights & weekends | Smelter, Packaging |
| Jerusalem Office | Weekday office (support / sales) | Helpdesk |
| Beersheba Lab | Research, light, occasional experiment night | Research Lab |

40 employees · 6 teams · 9 projects · ~49 shifts · **135 seats**.

## Prerequisites

> **On Windows or Linux?** See the step-by-step cross-platform guide
> [`docs/OPERATIONS.md`](./docs/OPERATIONS.md) (install · run · test · maintain for
> Windows / macOS / Linux). The quickstart below is macOS.

```bash
brew install openjdk@21        # any JDK 17+; JAVA_HOME defaults to this path
# Python 3.12 via uv (https://docs.astral.sh/uv/) and Node 18+
```

## Setup & run

```bash
./setup.sh        # backend venv (py3.12) + frontend deps
./run.sh          # builds the SPA, serves app + API at http://127.0.0.1:8000
```

Open http://127.0.0.1:8000, press **Generate schedule**, switch between site
tabs, and edit any seat — the flags panel updates against the whole schedule.
Use the **Requirements** tab to build or edit the org (sites, people, skills,
projects, shift types, demand); it validates live and blocks solving on errors.

The app starts from the 4-site seed, but it's fully data-driven: the editor posts
a *requirements document* to the backend, so you can model any org. The same
document is also the API contract (see endpoints below).

Dev mode (hot-reload frontend, proxied to the backend):

```bash
cd backend && JAVA_HOME=/opt/homebrew/opt/openjdk@21 .venv/bin/python -m uvicorn app.main:app --port 8000
cd frontend && npm run dev      # http://localhost:5173
```

## Tests

```bash
./test.sh         # backend (pytest) + e2e (Playwright CLI on Brave)
```

- **Backend — 838 tests.** Per-rule boundary sweeps (R1–R10 + Exceptional
  Assignment), the time model (count-by-start-day, rest-by-clock, night
  classification, weekend-by-start-day), carry-over, override cascades,
  **requirements validation** (referential integrity, duplicates, coverage), and
  **data-driven invariants parametrized over every site / team / project /
  employee / shift / seat** in the dataset (both static and on the solved
  schedule). Timefold is the scoring authority; the derived flags are
  cross-checked against it so they can't drift.
- **e2e — 62 tests on Brave.** Functional flows, site switching, the
  **requirements editor** (CRUD, reference-guarded deletes, validation blocks
  solving, edit-then-solve), override cascades, and **overflow audits across
  6 viewports × 4 sites** (pre- and post-solve) asserting nothing escapes its box
  and the page never scrolls horizontally.

```bash
cd backend && JAVA_HOME=/opt/homebrew/opt/openjdk@21 .venv/bin/python -m pytest -q
cd frontend && npx playwright test           # uses BRAVE_PATH (Brave by default)
```

## API

All endpoints are stateless — the client posts its *requirements document* (and,
for `/validate`, the current assignments) on every call.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/requirements` | the seed org as an editable requirements doc |
| `POST /api/build` | validate + materialise → `{errors, warnings, dataset}` |
| `POST /api/solve` | validate + solve → `{…, assignments, score, flags}` (errors block) |
| `POST /api/validate` | re-score a hand-edited assignment (Override path) |

## Layout

```
backend/
  app/
    domain.py       Timefold planning domain (facts, Seat entity, Schedule)
    constraints.py  the hard core + soft rules (R1–R10 + Exceptional Assignment)
    solver.py       solver factory, solve, authoritative score breakdown
    analysis.py     human-readable Compromise / Infeasibility flags
    data.py         the 4-site seed dataset + Schedule assembly
    requirements.py user requirements doc: validation + Dataset builder
    serialize.py    domain <-> JSON
    main.py         FastAPI endpoints; serves the built SPA
  tests/            838 pytest cases
frontend/
  src/
    App.tsx         state, Schedule|Requirements view toggle, build/solve/validate
    components/     ScheduleGrid, SeatCell, FlagsPanel, Editor (requirements CRUD)
  e2e/              62 Playwright specs (Brave)
docs/adr/           architecture decision records
CONTEXT.md          domain glossary (ubiquitous language)
```

## Domain → code

| CONTEXT.md term | Where |
|---|---|
| Site / Team / Project / Role / Employee | `app/domain.py` (problem facts) |
| Seat (worker / manager), eligibility | `app/domain.py` `Seat` + per-seat value range |
| Demand (exact) | `data.py` crew specs → seats; `constraints.understaffing` |
| Assignment, one-seat-per-moment | `constraints.one_assignment_per_moment` |
| Carry-over | `Employee` carry-over fields + carry-over constraints |
| Compromise / Infeasibility | `analysis.derive_flags` (soft / hard) |
| Override + whole-schedule re-validation | `POST /api/validate` (stateless) |
| Exceptional Assignment (sign-off) | `constraints.exceptional_assignment` |
| Fairness (burden, cumulative) | `constraints.fairness_burden` |
| User-supplied requirements + validation | `requirements.py`, `components/Editor.tsx` |
