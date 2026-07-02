# Handoff — resume point (read CLAUDE.md → DATA_MODEL.md → this file)

**Repo:** `/Users/uri/projects/adili/shift_manager`.
**Baseline:** branch **`fix/code-review-findings`** (on top of the committed
`feat/employee-features-and-views` history), origin = github.com/ugiya/shift_manager
(private). Everything below the Round 3 block is committed history context; Round 3
itself is **uncommitted** on this branch.
The data model is authoritative in `docs/DATA_MODEL.md` (+ `CONTEXT.md`, `docs/adr/`) —
those win over any memory; re-read before acting.

## ⏭️ CURRENT WORK — Round 5: UI clarity (2026-07-02, branch feat/ui-clarity-round5, uncommitted)

> **STATUS:** implemented + verified at write time (backend **973 passed**, full e2e
> **115 passed** pre-final-run — see session for the last run; build/typecheck clean;
> visual pass done). Codex: main review APPROVE-WITH-NITS (3 fixed), seat-matrix delta
> review CHANGES-NEEDED → the MEDIUM (index-alignment) fixed, LOW (shift-cell testid per
> sub-row) accepted. Commit when the user asks; then merge to main.
> User decisions (do NOT re-ask): workload = simple by default + "Advanced" toggle;
> badge = amber on unfilled, DROP כיסוי/קנס, "?" legend; flags = translate STATIC text
> only, configured names (roles/projects/people/shift types) stay as entered.

- **Project picker** (`ProjectView`, `SavedUi.projectId`): one project at a time
  ("" = first, "*" = all); persists; `project-pick`/`project-pick-all` testids.
- **Seat-matrix grids** (user-annotated feedback): Site grid + Project view render one
  grid SUB-ROW per seat (`gridRow: span N` headers, display:contents sub-row wrappers,
  whole-row hover via `filter: brightness`). Site grid aligns rows by a STABLE seat key
  (kind|project|role|ordinal) — NOT positional index (codex: disjoint-day crews would
  chain different seats into one visual row). Dark `--grid-line` between day columns +
  2px lane ends; light hairlines between seat rows.
- **Role accents** (`lib/roleColors.ts`): 8-slot CVD-validated palette (validated with
  the dataviz validator against #fff), keyed by role position, tint+edge on the seat
  label chip; manager = brand. Identity never color-alone.
- **Score badge** (`App.ScoreBadge`): data-state idle/ok/warn/bad; green ONLY when
  feasible AND full; amber "{n} empty shifts"; coverage/penalty text REMOVED (data-*
  attrs kept for e2e); "?" legend popover (`score-legend`/`score-legend-button`).
- **Workload**: simple columns by default; `workload-advanced` toggle reveals burden +
  vs-team + explanatory note.
- **Hebrew flags**: analysis.py flags gained `msg` + `params` (names as entered, ISO
  dates, counts) — English title/detail UNTOUCHED (tests pin them);
  `frontend/src/lib/flagText.ts` composes Hebrew (bidi-isolated names via FSI/PDI,
  "undefined/NaN" guard falls back to English). FlagsPanel renders via flagText.
- **BUG (round-4 regression, caught in the visual pass): language toggle wiped the
  schedule** — fatalOf's t() dependency re-ran the seed-fetch mount effect. Fixed with a
  module-level sentinel (`__server-unreachable__`, translated at render); pinned by
  clarity.spec "switching language never resets the working schedule".
- New e2e: `frontend/e2e/clarity.spec.ts` (6). Docs: DATA_MODEL §7 round-5 bullets
  (incl. the flag-localization decision reversal).

---

## Round 4: week navigation + editor rework (2026-07-02, committed in 3363bef)

> **STATUS: DONE + verified.** Backend **973 passed** · full e2e **109 passed** · build +
> `typecheck:e2e` clean · visual pass (Brave screenshots: fresh current week, month-change
> headers, stale dialog, tabs+filters, RTL, print) all good. Codex (gpt-5.5 xhigh):
> CHANGES-NEEDED (6 findings) → all fixed → re-review **APPROVE**. Nothing committed —
> commit when the user asks.
> Locked user decisions (do NOT re-ask): fresh start = current week; stale restored
> session = ASK on load (dialog); full week picker (snap to Sunday); deletes = **null-out**
> ("Please choose", never block/cascade); per-week project **tick** decides what runs this
> week; editor = 3 tabs (Organization | Employee Preferences (team filter) | Project
> Requirements (project filter + ticks)).
>
> **Codex round-4 findings → fixes (all landed):** (1) paused-only demand rows now skip
> the duplicate/overlap/concat checks and `_estimated_seats` counts effective crew only
> (`_effective_demand` returns row indices; re-tick re-fires validation — tested);
> (2) stale-week **Jump is gated on `dirty`** (a restored unsaved draft would be silently
> discarded — same rule as the picker; e2e-pinned); (3) malformed `week_start` can't crash
> the render (persist.ts shape-check + non-throwing date formatters); (4) fetch failures
> are a dedicated `api.ts ServerUnreachableError` (a client-side TypeError is never
> mislabelled "server unreachable"); (5) `e2e/global-setup.ts` fails fast when a stale
> unpinned uvicorn on :8000 would be reused; (6) a non-Sunday `SEED_WEEK_START` raises.

**A. Current-week fresh start:** `GET /api/requirements` re-dates the seed to the Sunday
on or before today (`main.current_week_start`, local-naive). `SEED_WEEK_START` env pins it
— set to `2026-06-21` in `playwright.config.ts` (e2e seat ids embed dates). Unit tests
pin Sunday-snap + the pin + the invalid-pin error.

**B. Week UX (frontend):** stale-week **ask-on-load dialog** (`stale-week-dialog/-stay/-jump`
testids; only for RESTORED sessions, fresh starts never ask); topbar **week picker**
(`week-picker`, snaps any picked date to Sunday via `lib/dates.ts weekStartOf`; gated
while dirty/building/solving; commits through `handleRequirementsChange` so score resets
+ mismatched carry-over seed drops). Date display: week range with year via
`Intl.formatRange` in `<bdi>`; grid day headers show month on col 1 + month change and a
full-date tooltip (`dayHeader` gained `mon`/`monthStart` + locale); print title formatted.
e2e: `session.spec.ts` uses `page.clock.setFixedTime` (backend pinned + clock faked keeps
the dialog deterministic) + polls localStorage for the autosaved week before reloading
(fixed-sleep was racy — the save debounce restarts on rebuild churn).

**C. Editor rework (user-reported, clarified 2026-07-02):**
- **Null-out deletes**: delete always enabled; single refs → `null` ("Please choose",
  `.in--pending` warn styling, backend "choose one" blocking errors — `TeamIn.site`,
  `EmployeeIn.team`, `DemandIn.team/shift_type` now `str|None`); list/keyed refs (roles,
  projects, preferred types, crew entries) drop the entry. Helpers in `lib/req.ts`
  (`deleteSite/Role/ShiftType/Team/Project`); the old `*Referenced` gates are GONE.
- **Per-week tick**: `ProjectIn.runs_this_week=True`; `_effective_demand` (shared by
  `to_dataset` + coverage warnings) drops paused crew; row emptied by pausing doesn't run
  at all; authored empty-crew row stays manager-only. Paused projects hidden from employee
  chips; "(not this week)" badges in Project view + crew chunks.
- **Tabs**: Organization | Employee Preferences (`employee-team-filter`) | Project
  Requirements (`project-filter` narrows rows AND crew chunks; `project-thisweek` ticks).
- **"Failed to fetch"**: could NOT be reproduced server-side (hostile-input sweep: zero
  demand/employees/eligibles, dangling refs — all clean; `tests/test_week_scoping.py`
  pins them). Root cause = backend unreachable (user runs uvicorn manually). Fetch
  rejections now surface as a friendly i18n'd "server unreachable, session saved locally"
  message (`App.fatalOf`).

Docs updated: DATA_MODEL §3 (week default, nullable refs, runs_this_week) + §7 (week
navigation, editor tabs). New tests: `backend/tests/test_week_scoping.py` (12),
week/pin tests in `test_api.py` (4), e2e stale-week/picker in `session.spec.ts` (4) +
rewritten `editor.spec.ts` (tabs/filters/deletes/tick). Remaining when resuming: full
e2e confirmation, visual pass, consult-codex round, commit when the user asks.

---

## Round 3: features + review fixes (2026-07-01/02, uncommitted)

> **STATUS:** All features + fixes implemented; backend and full-e2e suites re-running at
> handoff time after the codex round (previously: backend **953+1 passed**, new-feature
> e2e specs all green individually). Remaining: graphics polish (user asked to "improve
> graphics"), final full-suite confirmation, commit when the user asks.

**Features shipped (user-picked):** localStorage **autosave/restore** of the whole session
(`lib/persist.ts`; restore re-validates, never trusts a stored score) + "Reset to seed"
(two-step confirm); **undo/redo** for assignment overrides (⌘Z/⇧⌘Z, snapshot stacks,
re-baselined on rebuild/solve/carry, gated to the schedule view and off during solve);
**Workload tab** in the side panel (`lib/workload.ts` — burden counted PER SEAT to match
R9/carry-over; shifts/nights/weekends per distinct shift); **print view** (`PrintSchedule`,
`@media print`) + **schedule CSV** (`lib/scheduleExport.ts`, one row per seat incl.
UNFILLED); **Hebrew/RTL i18n** (`lib/i18n.tsx`, EN strings byte-identical to the old
literals so e2e text assertions hold; `data-testid="lang-toggle"`; ErrorBoundary reads the
persisted lang directly — crash path can't rely on context). New e2e: `session.spec.ts`,
`features.spec.ts`, `i18n.spec.ts`.

**Bug fixes from a 3-agent review + codex (gpt-5.5 xhigh) round — all landed:**
- Backend: CSV partial-column upsert now patches only carried columns; csv.field_size_limit
  + csv.Error as parse errors; **composite-id collisions** — concat checks in
  `validate_requirements` PLUS the authoritative mint-time uniqueness backstop
  (`data.IdCollisionError` raised in `build_schedule`, caught in `main._materialize` →
  normal error; pinned by the date-splice test in `test_api.py`); duplicate-demand
  rejection **narrowed to overlapping days** (per-day crew variation is legal again per
  CONTEXT.md — DATA_MODEL §2 rewritten); R9 flag ids unique per team; R9 overflow clamp
  (`FAIRNESS_SQUARE_CAP`); 411 for POSTs without Content-Length; solver-factory cache
  maxsize 8; `weekend_weekdays` in the dataset payload (frontend shading follows config).
- Frontend: stale carry-over seed reconciliation (dropped on week change + on import;
  removable via topbar × with synchronous invalidation); editor shows the SEED's carry-over
  values (disabled) for seeded employees; atomic reset-to-seed (fetch before destroy);
  assignment editing locked during solve in all views; employee team-change keeps
  still-valid cross-team projects; ProjectView edits demand rows **by index** (same-pair
  disjoint-day rows render as separate groups; `setCrewCount`/`setDemandDays` take
  `rowIndex`); hardened `loadSession` shape checks; backend error detail surfaced in api.ts.

**Env note:** the claude-in-chrome MCP disconnected mid-session; the browser-verification
step was covered by Playwright (drives Brave) instead.

---

## Round 2: UI tweaks (DONE — verified + codex'd; committed in 7579dbf)

> **STATUS:** All five tweaks DONE + verified + consult-codex'd. Verification: frontend build
> + e2e typecheck clean; **full e2e 87 passed**; backend **937 passed** (no backend changes
> this round). Still uncommitted on `feat/employee-features-and-views` (commit when the user
> asks). Remaining optional: a `/task-summary`.
> - **#1 (draft/Save editor + recoverable errors): DONE + codex'd.** Editor edits a local
>   draft (lifted to `App.draft`); Save/Discard + unsaved indicator; Solve/Carry gated while
>   dirty + a `building` gate so no stale-feasible/enabled-Solve window. `ErrorBoundary`
>   (outer in `main.tsx` + inner around editor / schedule content, keyed so a crashed view is
>   escapable) + a recoverable initial-load fatal screen + dismissible fatal banner. Codex:
>   CHANGES-NEEDED → 3 findings fixed → re-reviewed, confirmed.
> - **#3 (view order/default): DONE.** `Project · Team · Employee · Site`, default Project;
>   all Site-grid e2e specs now click `viewby-site` first; `views.spec` rewritten.
> - **#4 (Team/Employee person-row editing): DONE.** Inline seat-picker per cell (Eligible /
>   Exceptional / "Replace someone") + chip × to remove; immediate re-validate. User-approved.
> - **#2 (Project view editing): DONE.** Inline count steppers + per-day run toggles
>   (draft→Save), seat assignment via the shared `SeatCell` (immediate), add-requirement
>   control, and the "No requirements this week" empty state (#4-the-tweak's zero case).
>   User-approved "inline +/-", reconciled with the demand model: counts are per
>   `(team,shift_type,role)`, days are per `(team,shift_type)` shown at the shift-group level.
> - **Assignment lock (codex-driven):** while requirement edits are unsaved OR a rebuild is in
>   flight (`locked = dirty || building`), assignment editing is paused in **all four** views
>   (Site `SeatCell` selects disabled + banner; Project seats read-only; rosters hide
>   assign/remove + banner) — the Save rebuild resets assignments, so an edit then would be
>   lost. This was the key chunk-2 finding.
> - **Codex chunk 2 (#2/#4):** CHANGES-NEEDED (×2 rounds: assignment-while-dirty clobber, then
>   the Site-grid lock gap) → all fixed → final verdict **APPROVE-WITH-NITS** (the one nit —
>   banner copy — addressed). Edge-case e2e added: decrement-to-zero, all-days-off→error,
>   replace-someone, dirty-locks-every-view, eligible-first ordering.
> - **Docs:** `docs/DATA_MODEL.md` §7 updated for the approved "all four views editable"
>   reversal of the Phase-6 "overrides only in Site view" rule + the draft/lock behavior.
>   CONTEXT.md Override is already view-agnostic (no change needed).
>
> New components: `frontend/src/components/ErrorBoundary.tsx`; rewritten `RosterView.tsx` +
> `ProjectView.tsx` (editable); `SeatCell.tsx`/`ScheduleGrid.tsx` gained a `locked` prop; new
> helpers `setCrewCount`/`setDemandDays`/`defaultDaysForTeam` in `lib/req.ts`; new e2e
> `editable_views.spec.ts`. Also touched: `App.tsx`, `components/Editor.tsx`, `styles.css`,
> `main.tsx`, most `e2e/*.spec.ts`.

The 6-phase build below is **DONE + verified** (backend 937 / e2e 74, all uncommitted on
`feat/employee-features-and-views`). The user then ran the app and requested 5 tweaks; I asked
clarifying questions and **these answers are LOCKED — do NOT re-ask**:

1. **Editor save model = Draft + Save button.** Edits stay LOCAL in the editor; nothing validates
   or rebuilds until the user clicks **Save**. Add **Save + Discard** + an unsaved-changes
   indicator. Resync the draft to the committed `req` when it changes externally (import,
   carry-forward, initial load). This removes the mid-edit error class. Also **reproduce + fix a
   bug**: an in-progress invalid edit (user said "left a project unticked") produced an error that
   required a **page refresh** to escape — make every error/fatal state recoverable (suspected: a
   render crash or the `setFatal` path; App only shows fatal when `!req`, so dig for an actual
   uncaught render exception with an empty-`teams` project).
2. **Project view editable = BOTH** — (a) set the project's **weekly requirements** per
   `(team, shift_type, role)` (counts/days, **including none for a week** = tweak #4) via
   **draft→Save→rebuild**; (b) **assign people** to the resulting seats (immediate override).
3. **All four views editable (assignments)** — Site (already), Project (from #2 above), and **Team
   & Employee** people-as-rows views get a NEW interaction: click a person's day-cell to assign/
   remove them from a seat that day. **Show the user this novel interaction before finalizing it.**
4. **#4** (project may have no requirements for a week) is the "zero" case of #2's requirements
   editing — verify a project absent from demand already renders cleanly ("No requirements this
   week") and never errors.
5. **View order + default (tweak #3): `Project · Team · Employee · Site`, default = Project.**
   (Currently `Site · Team · Project · Employee`, default Site — see `App.tsx` `SCHEDULE_VIEWS`
   + `scheduleView` initial state. Update `views.spec.ts` default-view expectations.)

**KEY DESIGN SPLIT (align all work to this):** two edit kinds —
- *Requirements* (counts/days incl. zero) → restructure the schedule → **draft → Save → rebuild**
  (the editor, and now the Project view).
- *Who fills a slot* (assignment) → **immediate**, re-validates the whole week (today's behavior)
  → available in **all four views**.

**Recommended sequence:** #3 (quick) → #1 (draft/Save + bug fix, medium) → #2/#4 (Project
requirements+assignment editing, large) → Team/Employee person-row assignment editing (novel UX,
confirm with user). Keep `DATA_MODEL.md`/`CONTEXT.md` in sync (this **reverses** the documented
"overrides only in the Site view" Phase-6 decision — that's an approved change now). Run
`/consult-codex` on the substantive parts (standing preference). Session task list (IDs 6–9) will
NOT survive /clear — these five bullets are the source of truth.

Relevant files: `frontend/src/App.tsx` (views + `scheduleView` state + `handleChange` override
path + `handleRequirementsChange`), `frontend/src/components/Editor.tsx` (becomes draft-based),
`ProjectView.tsx`/`RosterView.tsx` (gain editing), `ScheduleGrid.tsx`/`SeatCell.tsx` (the editable
seat-cell pattern to reuse), `backend/app/requirements.py` (DemandIn — for project requirements
editing). A non-coder ran the app via **Option B**: `cd frontend && npm run build`, then
`cd backend && JAVA_HOME=/opt/homebrew/opt/openjdk@21 .venv/bin/python -m uvicorn app.main:app
--port 8000 --host 127.0.0.1`, open http://localhost:8000.

---

## Active goal (a session Stop hook enforces this — re-set it after /clear)

> all phases are ready - all tests green: unit, e2e. write new edge cases test, also
> should pass. for each phase, /consult-codex is ran, and you relate to its output.

The `/goal` Stop hook is session-scoped and will NOT survive `/clear`. After clearing,
**re-run `/goal` with the exact text above** so the fresh context is driven by it.

## The work: a 6-phase feature build on top of the (also-uncommitted) carry-over work

Prior context: a carry-over review hardened the app (HardMediumSoftScore, ADR-0002 seam,
datetime contract, "carry to next week" UI). That's done + green. Then the user asked for
two features → decomposed into 6 phases. Per-phase workflow (do this for EVERY phase):
**implement → unit + e2e green → update `docs/DATA_MODEL.md` in the same change →
`/consult-codex` (gpt-5.5 xhigh) → relate to its output / fix findings → re-verify.**

Phase specs + agreed design decisions live in `docs/DATA_MODEL.md` §8 ("Planned/in-flight").
Decisions already made (do NOT re-ask the user):

- **Phase 3 Unavailability:** date-based `unavailable_dates` on the employee; enforce by
  removing them from `Seat.eligible` for shifts on those dates (worker + manager); override
  ⇒ Exceptional; add an availability-aware coverage warning; **enrich the Exceptional (EXC)
  flag message to name the unavailability** when that's the cause. Validate ISO dates.
- **Phase 4 Preferred shifts:** **shift-TYPE level** (e.g. "prefers Mornings"). Model as a
  **soft PENALTY for an unmet preference** (NOT a reward — codex: a reward has no flag and
  breaks the constraints↔analysis parity model). New rule: add to `constraints.py` +
  mirror flag in `analysis.py` + `CONSTRAINTS` metadata (kind=soft, level=soft) + extend the
  parity CANON in `tests/test_rule_parity.py` + score/parity tests. Name it in plain English.
- **Phase 5 Import/export:** CSV (lossy roster, references by NAME, internal `id` as column
  1, `;`-multivalue) + JSON (lossless). Import default = **Replace all**, but built
  **mode-pluggable** (enum also: upsert by id/name; replace+auto-create refs). Reuse the
  existing `/api/build` validate flow. Label CSV lossy in the UI.
- **Phase 6 Views:** "View by: Site | Team | Project | Employee" selector. **Per-view best
  fit:** Site & Project = seat-centric grid (Site stays editable); Team & Employee =
  people-as-rows roster. All new views **read-only** (overrides still only in Site view).
  Frontend-only (data already in the payload). Project view aggregates seats by `project_id`
  **across teams/sites** (cross-site projects now exist — ADR-0003).

## Phase status

> **ALL 6 PHASES COMPLETE + verified** (unit + e2e green, codex run + related-to per phase,
> edge-case tests added, DATA_MODEL/CONTEXT kept in sync). Nothing is committed yet — the work
> sits on `feat/employee-features-and-views`; commit when ready. DATA_MODEL §8 is now empty.

- **Phase 1 — cross-site projects (ADR-0003): DONE + verified.** Backend hard cutover
  `Project.team_id`→`team_ids`; worker eligibility gained same-team rule (cross-site fill =
  Exceptional); coverage predicate updated; frontend multi-team checkboxes. Backend 881
  passed, full e2e 65 passed, codex APPROVE (only a doc line fixed). `test_crosssite.py` added.
- **Phase 2 — inactive employees + HR metadata: DONE + verified.**
  `EmployeeIn` gained `status` + `employee_number/email/phone/hire_date/notes`
  (`EMPLOYEE_STATUSES`); `validate_requirements` checks the status value; `_coverage_warnings`
  + `to_dataset` use **active-only**; `dataset_to_requirements` emits HR defaults; frontend
  `ReqEmployee` fields + Editor **status selector** (`data-testid="employee-status"`).
  Verification: backend **894 passed**, full e2e **65 passed**, targeted e2e re-run after the
  codex fixes (`ui_edge`+`editor`) **19 passed**. Codex (gpt-5.5 xhigh) returned CHANGES-NEEDED;
  all 5 findings addressed: (1) `MAX_EMPLOYEES` now counts **active only** (status must not leak
  into the solve-size guard); (2) carry-over continuity across a leave **documented** (DATA_MODEL
  §5 — burden freezes on the retained `EmployeeIn`, resumes on reactivation) + pinned by a test;
  (3) "unusable" warning is now **active-only**; (4) an override naming a non-active employee is
  rejected with a clear **"not active"** error (not "unknown"); (5) added a **coverage↔built-seat-
  eligibility parity test** (worker + manager arms) to stop the duplicated predicate drifting.
  7 new edge-case tests in `tests/test_employee_status.py`. DATA_MODEL §3/§5 updated.
- **Phase 3 — Unavailability (date-based): DONE + verified.** Domain `Employee` +
  `EmployeeIn` gained `unavailable_dates` (strict ISO `YYYY-MM-DD`); `build_schedule` removes
  an employee from a Seat's eligibility (worker + manager) for shifts starting on an
  unavailable date (`_eligible_workers`/`_eligible_managers` now take `day`); EXC flag detail
  names the unavailability when that's the cause (`analysis.py`); `_coverage_warnings` is
  availability-aware (per-date worker + manager). Frontend: `ReqEmployee.unavailable_dates`
  + `UnavailableDates` editor control (`data-testid` `employee-unavailable`/`unavail-add`/
  `unavail-date`). Verification: backend **905 passed** (11 in `test_unavailability.py`), full
  e2e **66 passed**. Codex (gpt-5.5 xhigh) APPROVE-WITH-NITS; all 3 nits fixed: strict
  `_bad_date` (canonical YYYY-MM-DD), rigorous by-date manager parity test, override-accrues-
  burden regression. Docs: DATA_MODEL §2/§3/§4 updated (§8 bullet removed); CONTEXT.md
  "Unavailability" reconciled per-Shift→**per-date** to match the locked decision.
- **Phase 4 — Preferred shift types (R11): DONE + verified.** New soft rule R11 (penalty for
  an unmet shift-TYPE preference, never a reward): `Employee.preferred_shift_type_ids` +
  `Seat.is_dispreferred_type()` (shared by `constraints.preferred_shift_type` and `analysis.py`
  → parity); `W_PREFERRED_SHIFT_TYPE=8`; registry + `define_constraints` + parity `CANON`
  extended. `EmployeeIn.preferred_shift_type_ids` validated against known shift types. Frontend
  "prefers" chips + `lib/req.ts shiftTypeReferenced` now also blocks deleting a type referenced
  by a preference. ⚠️ **GOTCHA**: Timefold's jpyinterpreter has no `frozenset.__bool__` — a
  `bool(set)`/`not set` in a constraint path errors or silently INVERTS; use `len(set)==0`
  (the predicate is in a domain method for this reason). Verification: backend **916 passed**
  (`test_preferred_shift_type.py`), e2e **67 + delete-gate** green. Codex (gpt-5.5 xhigh)
  CHANGES-NEEDED → fixed: shift-type delete gate (referential integrity) + edge tests
  (duplicate-normalization, all-types-preferred, EXC+R11 stacking). DATA_MODEL §2/§3/§4
  updated (§8 bullet removed); CONTEXT.md "Preference" extended to cover R11.
- **Phase 5 — Import / export: DONE + verified.** New `backend/app/portability.py` + endpoints
  `POST /api/export`, `POST /api/import`; frontend `ImportExport` toolbar atop the editor. JSON
  is lossless (whole doc); CSV is a lossy employee roster (refs by name, id col 1, `;`-multivalue;
  carry-over + avoid_shift_ids dropped). Mode-pluggable (`ImportMode`: replace / upsert_by_id /
  upsert_by_name / replace_autocreate_refs); merged doc validated via the normal
  `validate_requirements`. Verification: backend **937 passed** (`test_portability.py`, 21), e2e
  full **72** + portability **4**. Codex (gpt-5.5 xhigh) CHANGES-NEEDED → all 7 fixed: upsert now
  PRESERVES carry-over/avoid for matched rows (HIGH), ambiguous ref names are a loud error (HIGH),
  `;`-in-name fails loud (HIGH), name-upsert keeps existing id + rejects dup keys (MED), autocreate
  unions project teams across rows (MED), import size cap (MED), frontend surfaces import errors
  (LOW). DATA_MODEL §7 updated (§8 import/export bullet removed).
- **Phase 6 — read-only views (Site|Team|Project|Employee): DONE + verified.** Frontend-only:
  a "View by" selector (`App.tsx`, `data-testid` `view-by`/`viewby-*`) over the existing
  payload. **Site** = the editable `ScheduleGrid` (overrides only here; sitebar shown only here);
  **Project** (`ProjectView.tsx`) = read-only seat grid per project, lanes = `(team,role)`,
  aggregating seats across teams/sites (ADR-0003); **Team**/**Employee** (`RosterView.tsx`) =
  read-only people-as-rows rosters (per-team / flat). Read-only views render no `SeatCell`.
  Verification: full e2e **73** (`views.spec.ts`). Codex (gpt-5.5 xhigh) CHANGES-NEEDED → 3
  ProjectView fixes: normalized null-role lane key, each cell names its shift type (two same-day
  seats are distinguishable), cross-team badge from `project.team_ids` (the contract, not this
  week's seats). DATA_MODEL §7 notes the view modes; §8 is now empty (all phases shipped).
  Note: schedule views show materialized (active) employees only — inactive-roster management
  is the Editor/export's job, by design.

## How to resume (fresh/compacted context)

1. Read `CLAUDE.md`, then `docs/DATA_MODEL.md` (esp. §8), then this file.
2. Re-run the `/goal` above.
3. Finish Phase 2 verification (full backend pytest + e2e + codex), then proceed 3→6.
4. Track phases here (the in-session task list does not survive `/clear`).

## Environment gotchas (these will bite)

- Bash cwd resets to repo root between calls — `cd .../backend && …` or `.../frontend && …` per call.
- Backend tests need `JAVA_HOME` (imports boot the JVM):
  `cd backend && JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}" .venv/bin/python -m pytest -q`
- Frontend: `cd frontend && npm run build && npm run typecheck:e2e`. e2e:
  `cd frontend && JAVA_HOME=… npx playwright test` (drives Brave; Playwright starts the backend).
  ⚠️ **Kill any stale `uvicorn` on :8000 before e2e** (`lsof -ti tcp:8000 | xargs kill`) — it
  gets reused (`reuseExistingServer`) and may serve OLD backend code, causing phantom failures.
  ⚠️ **Run the e2e suite solo** — running backend pytest (a second JVM) concurrently starves
  the solver and flakes the timing-sensitive solve assertions.
- consult-codex: `python3 ~/.claude/skills/consult-codex/scripts/ask_codex.py --cd <repo>
  --effort xhigh --timeout 600 --file <prompt.md>`. ⚠️ Build the prompt file with
  `printf`/`cat`, NOT inline backticks in a heredoc (the shell runs them as substitution).
- Codex repeatedly notes new files are untracked `??` — expected; nothing is committed yet.
