# Projects can run across multiple teams (and therefore sites)

A Project may now run under **more than one Team**. Since each Team sits at one Site, a
multi-team Project spans multiple Sites. This supersedes the original model where a
Project belonged to exactly one Team (one Site).

## Why

Real projects are staffed at several sites at once, and their stakeholders need to see
the project's entire cross-site schedule in one place (the Project view). The previous
one-Team-per-Project model could not represent this at all — it was a hard wall, not a
missing view.

## What changes

- `Project` carries `team_ids` (a set) instead of a single `team_id`. The input model's
  `ProjectIn.teams` replaces `ProjectIn.team`. Internal cutover is hard: domain, payload,
  and tests all use the plural form. (A legacy singular `team` may be accepted only at the
  API edge if previously-saved user documents need it — not relied on internally.)
- **Validation:** every team in `project.teams` must exist; an Employee may only list a
  Project whose `teams` includes the Employee's own team; a Demand row's crew Project must
  have the Demand's team in its `teams`.
- **Worker eligibility gains an explicit same-team rule:** a worker is eligible for a seat
  only if the Project and Role match *and* `employee.team_id == seat.team_id`. So each
  Site automatically staffs its own seats; staffing a seat from another Site is an
  **Exceptional Assignment** reachable only by a manual override (matching CONTEXT.md's
  definition of Exceptional = a Team/Site the employee doesn't belong to). This rule is a
  no-op for previously-valid single-team data.

## Consequences

- Coverage warnings must apply the same `employee.team == demand.team` predicate, or they
  would drift from real eligibility.
- Fairness (grouped by `employee.team_id`) and the carry-over seam (per employee) are
  unaffected — they don't key off a project's team.
- `build_schedule` is unchanged in shape: it is demand-driven, so one Project id appearing
  in demand rows of several teams simply produces seats across those teams/sites.
- The Project view aggregates seats by `project_id` across all teams/sites.
- Cross-site staffing being override-only (not automatic) is a deliberate default; if a
  deployment wants automatic cross-site fills, that is a separate future decision.
