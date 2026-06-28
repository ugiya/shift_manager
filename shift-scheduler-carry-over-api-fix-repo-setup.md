---
type: session-summary
project: "Adili Shift Scheduler"
topic: "Shift Scheduler — Carry-over API Fix & Repo Setup"
session_type: "development"
created: 2026-06-22
---

# Shift Scheduler — Carry-over API Fix & Repo Setup

**Date:** 2026-06-22 (Monday)
**Duration:** 16:33 - 17:42 (~68 min)
**Type:** personal

## Objective
Remediate a code-review report against the shift-scheduler workspace, then bring the
project under version control with a clean `baseline → fixes` history (the project
had never been `git init`-ed).

## Summary
The session started from a code-review report (2 HIGH, 4 MEDIUM, 2 LOW) on the
shift-scheduler MVP — a Timefold/OptaPlanner constraint solver behind a stateless
FastAPI requirements API, with a React/Vite editor. Rather than trust the report,
every finding was verified against the source first. The headline finding (HIGH #1)
held and was actually broader than reported: the `Employee` domain carries carry-over
state (`prev_shift_end`, `prev_shift_was_night`) consumed by the R3/R6 cross-week-rest
constraints, but the public requirements API never accepted or round-tripped those
fields — so the constraints were dead from every real data path. The review missed
that `avoid_shift_ids` (R10 preferences) had the identical gap. ADR-0002 explicitly
promises week-to-week continuity, so this contradicted a documented decision.

The fix round-tripped all three fields through `EmployeeIn → to_dataset →
dataset_to_requirements`, ISO-validated `prev_shift_end` and `week_start`, added
editor inputs for the two scalar carry-over fields, and proved the constraints now
fire from real API input via new regression tests. The remaining findings were
addressed calibrated for the stated deployment context (local single-user): solver
`seconds` and problem size are bounded, oversized bodies rejected via middleware,
CORS restricted to localhost dev origins (dev/prod are both same-origin anyway),
`week_start` and assignment keys/values validated up front, and a rule-parity test
added so `constraints.CONSTRAINTS` and `analysis` flag emission can't silently drift.
Backend went from 838 → **856 passing tests**; frontend build + new e2e typecheck green.

The second half was version control. `git status` confirmed no repo anywhere up the
tree, though a real `.gitignore` existed — so it was meant to be a repo but never
initialized (confirmed: `git init`/`git commit` appear 0 times across all 4 session
transcripts). The user asked for a specific history: initial commit on a branch →
merge to main → fixes on a branch → merge to main. Because this session's fixes were
already intermingled in the working tree with no VCS to separate them, a true pre-fix
baseline had to be **reconstructed**: back up the 13 fixed files, revert the tree to
original, and verify the reconstruction by reproducing **exactly 838 tests**. The
baseline was committed on `init` (bd3fcfc), `main` fast-forwarded onto it, the fixes
were restored on a `fixes` branch (fea0cf7), and merged into `main` with `--no-ff`
(c446a65). The fixes lockfile was deliberately rebuilt on top of the baseline lock so
its diff shows only the `@types/node` addition, not incidental transitive churn.

## Work Log
1. Verified every review finding against source (`domain.py`, `requirements.py`, `constraints.py`, `main.py`, `serialize.py`, `data.py`, `analysis.py`, ADR-0002, frontend `types.ts`/`Editor.tsx`) before editing anything.
2. Confirmed HIGH #1; found the review missed `avoid_shift_ids`/R10 (same gap); grep confirmed R3/R6-carryover + R10 were dead from all real data paths (only set in unit tests).
3. Backend fixes: round-tripped `prev_shift_end`/`prev_shift_was_night`/`avoid_shift_ids`; ISO-validated `prev_shift_end` + `week_start`; added `config` limits + estimated-seat cap; restricted CORS to localhost; added Content-Length body-size middleware; bounded `/api/solve` seconds; added `validate_assignments`.
4. Frontend fixes: added carry-over fields to `ReqEmployee` + two editor inputs; replaced `as any` chip patch with typed `Partial<ReqEmployee>`; added `tsconfig.e2e.json` + `typecheck:e2e` + `@types/node`.
5. Added tests: `test_api_carryover.py` (R3/R6/R10 via API), `test_rule_parity.py` (AST parity), plus guard/validation cases in `test_api.py` and `test_requirements.py`.
6. Verified fixes: 856 backend tests (was 838), frontend build + `typecheck:e2e` green.
7. Investigated missing repo: `git status` failed in project + parent; only a `.gitignore` present; confirmed across all 4 transcripts that `git init`/`commit` never ran.
8. Added `.claude/`/`.omx/` to `.gitignore`; backed up the 13 fixed files to scratchpad; reverted the working tree to the pre-fix baseline (rewrote originals, removed new files); regenerated a pristine baseline lockfile (`npm uninstall @types/node` → `rm -rf node_modules package-lock.json` → `npm install`).
9. Verified baseline reconstruction: **exactly 838 tests** + clean build (the correctness gate).
10. `git init -b init`; reviewed staged tree (58 files, no ignored dirs leaked); committed baseline `bd3fcfc`; `git switch -c main` (fast-forward "merge" of initial into main).
11. `git switch -c fixes`; restored the 13 fixed files; took the baseline lock and layered `npm install` so the fixes lock diff is only `@types/node` (+ `undici-types`); verified 856 tests + build + typecheck; committed `fea0cf7`.
12. `git switch main`; `git merge --no-ff fixes` → `c446a65`; final verification on `main`: 856 tests, build, typecheck all green; working tree clean.

## Key Identifiers
- **Repo:** `/Users/uri/projects/adili/shift_manager` (local only; no remote)
- **Commits:** `bd3fcfc` (init / baseline), `fea0cf7` (fixes), `c446a65` (merge into main)
- **Branches:** `init` → baseline, `fixes` → review fixes, `main` → merged (HEAD)
- **Test counts:** 838 (baseline) → 856 (with fixes, +18)

## Deliverables

### Obsidian Note
- [Session note in Obsidian](file:///Users/uri/obsidian/work_notes/2026/06_June/week_4_21_27/22_Monday/shift-scheduler-carry-over-api-fix-repo-setup.md)

### Task Folder — backend (modified)
- [config.py](file:///Users/uri/projects/adili/shift_manager/backend/app/config.py) — resource limits + ALLOWED_ORIGINS
- [main.py](file:///Users/uri/projects/adili/shift_manager/backend/app/main.py) — CORS allowlist, body middleware, seconds bound, assignment validation
- [requirements.py](file:///Users/uri/projects/adili/shift_manager/backend/app/requirements.py) — carry-over/preference round-trip, week_start + size validation
- [serialize.py](file:///Users/uri/projects/adili/shift_manager/backend/app/serialize.py) — validate_assignments
- [test_api.py](file:///Users/uri/projects/adili/shift_manager/backend/tests/test_api.py) — guard tests
- [test_requirements.py](file:///Users/uri/projects/adili/shift_manager/backend/tests/test_requirements.py) — validation cases

### Task Folder — backend (new)
- [test_api_carryover.py](file:///Users/uri/projects/adili/shift_manager/backend/tests/test_api_carryover.py) — R3/R6-carryover + R10 via the API
- [test_rule_parity.py](file:///Users/uri/projects/adili/shift_manager/backend/tests/test_rule_parity.py) — constraints↔analysis rule parity

### Task Folder — frontend
- [types.ts](file:///Users/uri/projects/adili/shift_manager/frontend/src/types.ts) — ReqEmployee carry-over fields
- [Editor.tsx](file:///Users/uri/projects/adili/shift_manager/frontend/src/components/Editor.tsx) — carry-over inputs, typed chip patch
- [tsconfig.e2e.json](file:///Users/uri/projects/adili/shift_manager/frontend/tsconfig.e2e.json) — e2e typecheck (new)
- [package.json](file:///Users/uri/projects/adili/shift_manager/frontend/package.json) — typecheck:e2e + @types/node

## Key Decisions
- **`avoid_shift_ids` contract-only, no widget:** it keys on concrete shift-instance IDs that don't exist at requirements-edit time, so it round-trips through the API + types + tests but gets no bespoke editor picker. That's a separate feature.
- **No carry-over persistence:** ADR-0002's *Consequences* suggest deriving carry-over from a persisted prior accepted schedule, but no persistence layer exists and the server is deliberately stateless. Scope was to make the API boundary honest, not build persistence.
- **DoS/CORS calibrated for local single-user:** CORS restricted to localhost; sane (not paranoid) solver/size caps; body-size middleware kept because the user asked for "everything in the report."
- **Reconstructed a true pre-fix baseline** rather than committing the fixed tree as the initial commit, so the review fixes are an independently reviewable/mergeable unit. Used the 838-test count as the reconstruction correctness gate.
- **Rebuilt the fixes lockfile on the baseline lock** to keep its diff to only `@types/node` (a fresh baseline `npm install` had pulled newer browserslist/nanoid, which would have read as spurious downgrades).

## Technical Context
- **Domain/constraints:** `Employee` carries carry-over state; `constraints.py` R3/R6-carryover read `prev_shift_end`/`prev_shift_was_night`, R10 reads `avoid_shift_ids`; `analysis.py` mirrors all three for human-readable flags.
- **Stateless API:** the requirements doc is posted on every call; round-trip is `dataset_to_requirements` (GET /api/requirements) ↔ `to_dataset` (POST). The contract gap was these three fields being dropped on both sides.
- **Same-origin frontend:** Vite proxies `/api` in dev; FastAPI serves the built SPA in prod — so restricting CORS to localhost is safe (the browser never makes a genuine cross-origin call).
- **Rule parity:** `test_rule_parity.py` AST-scans `analysis._flag(...)` rule literals and compares to `constraints.CONSTRAINTS`; the frontend treats `rule` as an opaque string, so there's no third surface to sync.

## Current Status & Next Steps
- **Resolved:** all HIGH/MEDIUM/LOW review findings; repo initialized; `main` = baseline + fixes; 856 tests + build + e2e typecheck green; working tree clean.
- **Pending:** local only — no remote/`origin`/push. `avoid_shift_ids` editor UI not built. Carry-over persistence (ADR-0002) not built. This summary md is an untracked file in the repo.
- **Next action:** optionally add a remote and push; gitignore/commit/delete the loose summary md per preference; build the per-shift preference picker + carry-over persistence when prioritized.
- **Blockers:** none.

## Related Topics
- Timefold / OptaPlanner constraint scheduling
- FastAPI stateless requirements API + validation
- ADR-0002 carry-over (week-to-week continuity)
- Code-review remediation
- Git baseline reconstruction & branch/merge workflow
