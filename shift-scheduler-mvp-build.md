---
type: session-summary
project: "Adili Shift Manager"
topic: "Shift Scheduler MVP Build"
session_type: "development"
created: 2026-06-22
---

# Shift Scheduler MVP Build

**Date:** 2026-06-21 → 2026-06-22 (Monday)
**Duration:** 08:22 – 16:27 (~485 min today; the build spanned 2026-06-21 evening into 2026-06-22)
**Type:** personal

## Objective
Turn the shift-scheduling domain model (`CONTEXT.md`, ADRs) into a working,
fully-tested **multi-site web app** — a best-effort Timefold solver behind a
responsive UI — that passes Playwright-CLI (on Brave) and Claude-in-Chrome
verification, and lets the user **supply their own requirements** via an
interactive editor.

## Summary

Built a complete greenfield MVP for the dynamic shift scheduler. The engine is
**Timefold Solver** (OptaPlanner's successor) via its Python SDK, chosen because
its per-constraint score breakdown maps directly onto the domain's "report every
Compromise" requirement. Stack: Python 3.12 + FastAPI backend (Timefold runs a
JVM under JPype, so `openjdk@21` was installed and a 3.12 venv pinned — no
3.13+ wheels), React + TypeScript + Vite frontend, served single-origin by
FastAPI so there is one URL for tests and Chrome. The domain (`backend/app/`)
models Site → Team → Project → Role → Employee as problem facts and `Seat` as the
planning entity with a nullable employee variable and a **per-seat value range**
of eligible employees — so the solver fills what it can, leaves the rest unfilled
(best-effort), and never auto-creates an Exceptional Assignment. Hard core: one
seat per moment, ≥1 day off/week, legal rest. Soft: exact demand, ≤1 shift/day,
night recovery, no consecutive weekends, preferred 2nd day off, fairness,
preferences. Timefold is the scoring authority; `analysis.py` derives
human-readable flags that tests cross-check against the hard score so they can't
drift.

The app went through three explicit expansions driven by the user. **(1)** First
a single-site MVP: solve → schedule grid → per-seat override dropdowns → live
flags panel; verified in Chrome (responsive, no element/text overflow) and
covered by 9 Playwright e2e + 15 backend tests. **(2)** On feedback that 15 tests
was too thin, the backend suite was rebuilt with ergonomic builders and
parametrized boundary sweeps to **810 tests**, then (with the 4-site expansion)
**838**. **(3)** The org was expanded to **four sites** (Tel Aviv HQ software,
Haifa Plant 24/7 ops, Jerusalem office, Beersheba lab — 40 employees, 6 teams,
135 seats), with a **site tab bar** in the UI and per-site issue counts; e2e grew
to **52 tests on Brave** including 24 viewport×site overflow audits.

The final and largest piece (now complete): the user asked to **supply their own
requirements as input** and chose an **interactive UI editor**. The backend was
made requirements-driven — a pydantic `RequirementsIn` document with thorough
validation (referential integrity, duplicates, coverage warnings) and a
`to_dataset` builder; endpoints `GET /api/requirements`, `POST /api/build`,
`POST /api/solve`, `POST /api/validate` all take a requirements doc and stay
stateless. The frontend gained a full CRUD **Editor** (sites, roles, shift types,
teams, projects, employees with role/project chip-pickers + carry-over, and
per-shift demand with a crew matrix), reference-guarded deletes, live
errors/warnings, and a Schedule | Requirements view toggle. It is covered by a
10-test `editor.spec.ts`, verified in Claude-in-Chrome (added a site 4→5 and an
employee 40→41, edited-then-solved a custom org, zero overflow at 1067px/375px),
and documented in the README. **Final state: 838 backend + 62 Brave e2e = 900
tests, all green via `./test.sh`.**

A notable gotcha surfaced during Chrome verification: after removing the old
`/api/dataset` endpoint, the browser served a **stale cached bundle** that still
called it (404). A cache-busting reload fixed it; Playwright is unaffected (fresh
context each run).

## Work Log

1. Recon: confirmed Python 3.14 (too new for Timefold/JPype) and **no Java**.
   Installed `openjdk@21` via brew; pinned a Python **3.12** venv with `uv`.
2. Smoke-tested Timefold end-to-end (tiny balance problem) and verified two API
   details by experiment: **per-entity value ranges** and **nullable planning
   variables** (`PlanningVariable(allows_unassigned=True)`).
3. Wrote the domain (`domain.py`), constraint provider for R1–R10 + Exceptional
   Assignment (`constraints.py`), solver + authoritative score breakdown
   (`solver.py`), and human-readable flag derivation (`analysis.py`).
4. Built the seed dataset + Schedule assembly (`data.py`); ran an integration
   check — 48/48 seats filled, feasible, 1 fairness compromise.
5. Built FastAPI endpoints + serialization; verified solve and an exceptional
   override via the API.
6. Scaffolded the React/TS/Vite frontend: schedule grid, seat override dropdowns,
   flags panel, responsive CSS (border-box, min-width:0, single scroll container).
7. Verified in Claude-in-Chrome: solve fills the week, override flags an
   exceptional assignment, no overflow at desktop/tablet/mobile.
8. Wrote Playwright config to drive **Brave** via `executablePath` (per user:
   playwright-cli on Brave, not bundled Chromium); 9 e2e green.
9. Wrote the first backend suite; on user feedback ("15 tests?!") rebuilt it into
   810 parametrized + data-driven tests (fixed a pytest faulthandler×JVM SIGSEGV
   issue via `-p no:faulthandler`).
10. Expanded the dataset to **4 sites** (declarative `SITES_SPEC`); solver fills
    135/135 feasibly. Added site tabs + per-site issue counts to the UI.
11. Added multi-site + UI-edge e2e (52 total) incl. 24 viewport×site overflow
    audits; verified the 4-site app in Chrome (Haifa Smelter staffed, nights).
12. Made the backend **requirements-driven** (`requirements.py`: validation +
    `to_dataset` + `dataset_to_requirements`); reworked endpoints to
    build/solve/validate a posted requirements doc. 838 backend tests pass.
13. Built the interactive **Editor** (CRUD for every entity, crew matrix,
    reference-guarded deletes) + view toggle + debounced rebuild flow in `App`.
14. Verified the editor renders in Chrome (after diagnosing a stale-cache 404).
15. Wrote `editor.spec.ts` (10 tests); fixed one timing-only failure in
    `ui_edge.spec.ts` (await the grid before counting night/weekend cells).
16. Claude-in-Chrome editor verification: add site (4→5) + employee (40→41),
    role/project chips, edit-then-solve, overflow audit clean at 1067px & 375px
    (only the extension's phantom-cursor SVGs flagged, not the app).
17. Updated the README (editor, endpoints, 838+62 counts); ran `./test.sh` —
    **900 tests green** (838 backend + 62 Brave e2e).

## Key Decisions

- **Timefold (Python SDK) over OR-Tools** — its constraint-match explanations fit
  the "explain every bent rule" model; OR-Tools would need hand-built reporting.
- **Per-seat value range + nullable variable** — guarantees best-effort filling
  and that the solver never auto-creates Exceptional Assignments (those arise
  only via Override and are flagged for sign-off).
- **Stateless API** — the client posts the full requirements (+ assignments) on
  every call, making "any Override re-validates the whole Schedule" literal and
  the e2e deterministic.
- **Timefold = scoring authority; Python-derived flags = explanation** — tests
  assert feasibility agreement so the two cannot silently diverge.
- **Editor scope** — configures org + people + skills + projects + shift types
  (hours + night) + demand; rest-minutes/weekend-days stay global defaults
  (avoids a JVM-cached-constant refactor).
- **Single-origin serving** — FastAPI serves the built SPA so there's one URL for
  Playwright and Claude-in-Chrome.

## Technical Context

- **Backend** `backend/app/`: `domain.py` (facts + `Seat` entity), `constraints.py`
  (R1–R10 + Exceptional), `solver.py`, `analysis.py` (flags), `data.py` (4-site
  seed), `requirements.py` (validation + builder), `serialize.py`, `main.py`.
  Run with `JAVA_HOME=/opt/homebrew/opt/openjdk@21`.
- **Frontend** `frontend/src/`: `App.tsx` (state, view toggle, build/solve/validate
  flow), `components/{ScheduleGrid,SeatCell,FlagsPanel,Editor}.tsx`,
  `lib/{lookups,req}.ts`. Vite proxies `/api` in dev; built `dist/` served by
  FastAPI in prod.
- **Tests**: backend pytest (838) — boundary sweeps, time model, carry-over,
  override cascades, score authority, requirements validation, API, plus
  data-driven invariants parametrized over every entity. e2e Playwright on Brave
  (62) — functional, multi-site, UI edge cases, the requirements editor, and
  24 viewport×site overflow audits.
- **Gotchas**: pytest faulthandler misreads the JVM's SIGSEGV safepoints (disabled
  in `pytest.ini`); browser caches the SPA bundle aggressively (cache-bust on
  endpoint changes).

## Deliverables

### Obsidian Note
- [Session note in Obsidian](file:///Users/uri/obsidian/work_notes/2026/06_June/week_4_21_27/22_Monday/shift-scheduler-mvp-build.md) — bidirectional link

### Task Folder — docs
- [README](file:///Users/uri/projects/adili/shift_manager/README.md)
- [CONTEXT.md (domain glossary)](file:///Users/uri/projects/adili/shift_manager/CONTEXT.md)
- [Prior session: domain model](file:///Users/uri/projects/adili/shift_manager/shift-scheduling-domain-model.md)

### Task Folder — backend
- [domain.py](file:///Users/uri/projects/adili/shift_manager/backend/app/domain.py)
- [constraints.py](file:///Users/uri/projects/adili/shift_manager/backend/app/constraints.py)
- [solver.py](file:///Users/uri/projects/adili/shift_manager/backend/app/solver.py)
- [analysis.py](file:///Users/uri/projects/adili/shift_manager/backend/app/analysis.py)
- [data.py (4-site seed)](file:///Users/uri/projects/adili/shift_manager/backend/app/data.py)
- [requirements.py](file:///Users/uri/projects/adili/shift_manager/backend/app/requirements.py)
- [main.py (API)](file:///Users/uri/projects/adili/shift_manager/backend/app/main.py)
- [tests/](file:///Users/uri/projects/adili/shift_manager/backend/tests/)

### Task Folder — frontend
- [App.tsx](file:///Users/uri/projects/adili/shift_manager/frontend/src/App.tsx)
- [Editor.tsx](file:///Users/uri/projects/adili/shift_manager/frontend/src/components/Editor.tsx)
- [ScheduleGrid.tsx](file:///Users/uri/projects/adili/shift_manager/frontend/src/components/ScheduleGrid.tsx)
- [e2e/](file:///Users/uri/projects/adili/shift_manager/frontend/e2e/)

### Task Folder — scripts
- [setup.sh](file:///Users/uri/projects/adili/shift_manager/setup.sh) · [run.sh](file:///Users/uri/projects/adili/shift_manager/run.sh) · [test.sh](file:///Users/uri/projects/adili/shift_manager/test.sh)

## Current Status & Next Steps

- **Resolved (complete):** Working multi-site MVP (4 sites, 135 seats) on
  Timefold; solve + whole-schedule override re-validation; **interactive
  requirements editor** (define/edit your own org, live validation, solve it);
  responsive UI verified in Chrome with zero overflow at every viewport; backend
  made requirements-driven + validated. **900 tests green** (838 backend + 62
  Brave e2e) via `./test.sh`, incl. editor e2e + Claude-in-Chrome editor
  verification.
- **Pending:** None — the goal (working MVP, passes playwright-cli on Brave +
  Claude-in-Chrome, responsive/no-overflow, Timefold engine, exhaustive
  permutation/edge-case tests, 4 sites, user-supplied requirements) is met.
- **Possible future work (not requested):** per-request rule config
  (rest-minutes/weekend-days) — would need the constraints to read config
  dynamically rather than from JVM-cached module constants; persistence/save of
  requirements docs; the open product decision of a definitive soft-constraint
  severity ordering (see ADR-0001).
- **Next action:** none outstanding.
- **Blockers:** None. (App runs at http://127.0.0.1:8000; `./run.sh` to start.)

## Related Topics
- Workforce / shift scheduling
- Timefold Solver / constraint optimization
- FastAPI + React/TypeScript full-stack
- Playwright (Brave) + Claude-in-Chrome e2e
- Responsive UI / overflow testing
