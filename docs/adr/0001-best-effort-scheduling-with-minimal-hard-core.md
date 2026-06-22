# Best-effort scheduling with a minimal hard core

The system always produces a complete weekly Schedule rather than declaring a week
infeasible and refusing output. Only a minimal core of constraints is **hard**:
physical impossibilities (one person occupies one seat at one moment) and the
legal minimum of one day off per calendar week. When a hard constraint can't be
met, the affected slice is left unfilled (an Infeasibility) — the rest of the
Schedule is still produced.

Everything else is **soft** — demand exactness, rest beyond the legal turnaround,
night recovery, weekend protection, the preferred second day off, and fairness.
The optimizer minimizes these and reports each one it accepts as a Compromise; it
never hides them.

## Why

A scheduler under time pressure on a hard week needs *something to edit*, not an
error message. A pure feasibility solver is most brittle exactly when it matters
most. We chose best-effort + reporting (Product B) over a feasibility solver
(Product A).

## Consequences

We take on the obligation to define a **severity ordering** over the soft
constraints — what the optimizer sacrifices first. That ordering is itself a
product decision and is currently unresolved.
