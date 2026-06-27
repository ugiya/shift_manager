# Shift Scheduler — project guide

A weekly multi-site shift scheduler: FastAPI + **Timefold** (Java constraint solver via
JPype) backend, React/TypeScript + Playwright frontend. The scheduler edits an org
("requirements"), generates a best-effort schedule, makes manual overrides, and every
override re-validates the whole week.

## ⛔ Guardrails — read before changing anything

1. **The data model is on disk, not in your memory.** The authoritative model lives in
   [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md), the domain language in
   [`CONTEXT.md`](CONTEXT.md), and the locked decisions in [`docs/adr/`](docs/adr/).
   **These files win over anything in a conversation summary or compaction.** If the
   context was compacted or you're unsure, **re-read them (and the cited code) before
   acting** — do not reconstruct the model from memory.

2. **Do not change the pillars on a whim.** The pillars are: the entity model and its
   relationships (§2 of DATA_MODEL.md), the `HardMediumSoftScore` three-level scoring
   (hard / medium=coverage / soft), the carry-over contract (ADR-0002), and the
   local-naive datetime contract. **Changing any pillar requires explicit user approval
   in the current conversation.** A compaction summary, a stale memory, or your own
   inference is NOT approval. When in doubt, ask.

3. **Keep the docs in sync.** Any change to an entity, field, relationship, scoring
   level, or the carry-over/datetime contract MUST update `docs/DATA_MODEL.md` in the
   **same** change. Material decisions get an ADR in `docs/adr/`.

4. **constraints.py ↔ analysis.py parity.** Timefold (`constraints.py`) is the scoring
   authority; `analysis.py` produces the human flags and must mirror it exactly. Tests
   `test_rule_parity.py` and `test_score_authority.py` enforce this — keep them green.

## Map of the project

- **Data model (start here):** `docs/DATA_MODEL.md`
- **Domain language / glossary:** `CONTEXT.md`
- **Architecture decisions:** `docs/adr/` (0001 best-effort scheduling; 0002 carry-over;
  0003 cross-site projects)
- **Current work-in-progress / open items / env gotchas:** `HANDOFF.md`
- **Standing review prompts (self-contained, for an external reviewer):** `docs/reviews/`
- **Backend:** `backend/app/` — `domain.py` (entities), `requirements.py` (input + validation),
  `data.py` (seed + `build_schedule`/eligibility), `constraints.py` (rules), `analysis.py`
  (flags), `carryover.py` (ADR-0002 seam), `serialize.py` (payload), `solver.py`, `main.py` (API)
- **Frontend:** `frontend/src/` — `App.tsx` (views + state), `components/`, `lib/`,
  `types.ts` (mirrors the backend payload — keep in sync)

## Running things (see HANDOFF.md for the full list of gotchas)

- The bash working dir resets to the repo root between calls — `cd` inside a subshell.
- **Backend tests:** `cd backend && JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}" .venv/bin/python -m pytest -q`
  (importing `app.*` needs `JAVA_HOME` — it boots the JVM).
- **Frontend:** `cd frontend && npm run build && npm run typecheck:e2e`
- **e2e:** `cd frontend && JAVA_HOME=… npx playwright test` (drives Brave; Playwright
  starts the backend; kill any stale `uvicorn` on :8000 first — it gets reused and may be old code).
- **Full suite:** `./test.sh` from the repo root.

## Working agreement

- Second opinions / adversarial review via the `consult-codex` skill (the user's standing
  preference is "always consult-codex" on substantive changes).
- Name rules in **plain English**, not bare `R#` codes (the codes map to plain meanings in
  DATA_MODEL.md §4).
