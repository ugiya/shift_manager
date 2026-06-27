# Handoff — resume point (read CLAUDE.md → DATA_MODEL.md → this file)

**Repo:** `/Users/uri/projects/adili/shift_manager`.
**Baseline commit:** `edad485` on branch **`feat/employee-features-and-views`** (branched
off `main` @ `c446a65`), pushed to **origin = github.com/ugiya/shift_manager** (private).
Everything through Phase 2 *code* is committed there as a WIP checkpoint; the tree is
clean. New work goes on top; `git diff edad485` shows it.
The data model is authoritative in `docs/DATA_MODEL.md` (+ `CONTEXT.md`, `docs/adr/`) —
those win over any memory; re-read before acting.

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

- **Phase 1 — cross-site projects (ADR-0003): DONE + verified.** Backend hard cutover
  `Project.team_id`→`team_ids`; worker eligibility gained same-team rule (cross-site fill =
  Exceptional); coverage predicate updated; frontend multi-team checkboxes. Backend 881
  passed, full e2e 65 passed, codex APPROVE (only a doc line fixed). `test_crosssite.py` added.
- **Phase 2 — inactive employees + HR metadata: CODE COMPLETE, VERIFICATION UNFINISHED.**
  Done: `EmployeeIn` gained `status` + `employee_number/email/phone/hire_date/notes`
  (`EMPLOYEE_STATUSES`); `validate_requirements` checks the status value; `_coverage_warnings`
  + `to_dataset` use **active-only**; `dataset_to_requirements` emits HR defaults; frontend
  `ReqEmployee` fields + Editor **status selector** (`data-testid="employee-status"`) + add-
  employee defaults; `DATA_MODEL.md` §3 updated, §8 HR bullet removed. `tests/test_employee_status.py`
  added — **6 pass in isolation**; frontend build + typecheck:e2e pass.
  **NOT yet done (resume here):** (1) run the FULL backend suite (`pytest -q`) to confirm no
  regression; (2) run e2e (at least `editor.spec.ts`; ideally full); (3) `/consult-codex` on
  Phase 2 and relate to findings. Then mark Phase 2 done.
- **Phases 3–6: NOT STARTED** (specs above + in DATA_MODEL.md §8).

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
- consult-codex: `python3 ~/.claude/skills/consult-codex/scripts/ask_codex.py --cd <repo>
  --effort xhigh --timeout 600 --file <prompt.md>`. ⚠️ Build the prompt file with
  `printf`/`cat`, NOT inline backticks in a heredoc (the shell runs them as substitution).
- Codex repeatedly notes new files are untracked `??` — expected; nothing is committed yet.
