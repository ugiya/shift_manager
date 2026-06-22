---
type: session-summary
project: "Adili Shift Manager"
topic: "Shift Scheduling Domain Model"
session_type: "creative"
created: 2026-06-13
---

# Shift Scheduling Domain Model

**Date:** 2026-06-13 (Saturday)
**Duration:** 20:25 - 23:58 (~213 min)
**Type:** personal

## Objective

What is the domain model, vocabulary, and rule set for a dynamic weekly
shift-scheduling product — before any technology, schema, solver, or UI is
chosen? Converge on a clean, shared product/domain model via a relentless
grilling session.

## Summary

This was a design-discovery (grilling) session for a greenfield shift-scheduling
product. Working from a candidate brief, we walked the entire decision tree
one question at a time, sharpening terminology and pinning down 16 design
decisions. The session produced a complete domain glossary (`CONTEXT.md`), two
architectural decision records, an accepted-rules table, a list of deferred
decisions, and a set of concrete test scenarios. No implementation work — the
session stayed strictly at the domain/product-modeling level by design.

The spine of the model is the **constraint philosophy** (ADR-0001): the system
is a *best-effort optimizer*, not a feasibility solver. It always produces a
complete weekly **Schedule** and reports every place it bent a rule, rather than
ever declaring a week infeasible. Only a minimal core is **hard** — physical
impossibility (one person, one seat, one moment) and the legal floor of one day
off per calendar week. Everything else (demand exactness, rest beyond the legal
turnaround, night recovery, weekend protection, the preferred second day off,
fairness, preferences) is **soft**: a reported **Compromise**.

The single most consequential moment was a mid-session reframe of the org model.
The initial single-axis "Role" matching was **overturned**: the real structure is
a nested hierarchy — **Site** (geographic) → **Team** (one Shift Manager, several
Projects) → **Project** (owns crew-composition demand) — and worker demand is
matched on the **two axes (Project × Role)**. The Team is a *soft* boundary
(rare, sign-off-gated cross-team fill-in). A crucial invariant emerged:
multi-Project membership only widens the *pool* eligible for a seat — it never
lets one person fill two seats in the same time slot. "Group" from the original
brief was dropped entirely, having split cleanly into Team, Fairness, and Demand.

A second hard-to-reverse decision (ADR-0002) is that **Schedules are continuous
across weeks** via **Carry-over** — the system is not stateless per week. Each
solve takes prior-week facts (last weekend worked, last-day night shifts) and
rolling cumulative burden counts as input, because consecutive-weekend
protection, cross-boundary night recovery, and cumulative Fairness are impossible
without it. The workflow was settled as: the system is the **system of record**;
output is authoritative with first-class **Overrides**; any Override re-validates
the *whole* Schedule (validation is global, not local); v1 is scheduler-entered
(no employee self-service, no pending-request state) and solves each week once
(mid-week re-optimization and the "locked day" concept are deferred).

## Key Decisions

1. **Best-effort optimizer, not feasibility solver** (ADR-0001). Always produce a
   Schedule + report Compromises. Hard core limited to physical impossibility +
   1-day-off/week legal floor.
2. **Org reframe → two-axis matching.** Site → Team → Project hierarchy; worker
   demand matched on (Project × Role); Shift Manager demand is 1 per Team per
   shift. *This reversed the earlier single-axis Role recommendation.*
3. **Team is a soft boundary.** A worker belongs to exactly one Team; cross-team
   fill-in is rare and requires sign-off (an Exceptional Assignment).
4. **One person, one seat, one moment** is hard — multi-Project membership widens
   the eligible pool but never double-counts a person.
5. **Demand is exact** — under- and over-staffing weighted equally; crew
   composition varies per concrete Shift (per day/shift), not a fixed template.
6. **Shift time model:** count by *start day*, rest by *real clock time*; "night"
   is an explicit classification flag, never inferred from name/hours.
7. **Carry-over** (ADR-0002): schedules continuous across weeks; prior-week facts
   + rolling burden counts feed each solve.
8. **Fairness** is a soft objective, scoped within Team × eligible-for-shift,
   measured cumulatively across weeks.
9. **System of record + global re-validation:** authoritative output, Overrides
   are first-class, any Override re-validates the whole Schedule.
10. **v1 scope cuts:** scheduler-entered availability (no pending state), solve
    once per week (defer mid-week re-optimization + "locked day").

## Technical Context

- **Glossary (`CONTEXT.md`)** organizes vocabulary in three clusters:
  Organization (Site, Team, Project, Employee, Role, Shift Manager, Scheduler),
  Shifts (Shift Type, Shift, Cross, Night Shift, Weekend, Weekend Shift, Rest
  Gap, Burden Shift), and Demand & Scheduling (Demand, Carry-over, Assignment,
  Schedule, Compromise, Infeasibility, Override, Exceptional Assignment, Fairness,
  Unavailability, Preference).
- **Hard vs soft is the organizing axis** for the whole rule set (see rules table
  below). Two rest minimums: a hard legal turnaround + a soft night-recovery
  (~24h default), both configurable.
- **Accepted rules:** R1 one-seat-per-moment (hard); R2 ≥1 day off/week (hard);
  R3 legal turnaround rest (hard); R4 exact demand (soft); R5 ≤1 shift/day
  (soft-strong); R6 night recovery (soft-strong); R7 no consecutive weekends
  (soft-strong); R8 preferred 2nd day off (soft-mild); R9 fairness (soft
  objective); R10 preferences (soft-mild); Exceptional Assignments require
  sign-off.
- **Test scenarios** captured for spec/QA: holiday-week unstaffable slot;
  Dana double-seat conflict; multi-project auto-sub; night-recovery rest math;
  cumulative weekend fairness; Override cascade flags; v1 sick-call by hand.

## Deliverables

### Obsidian Note
- [Session note in Obsidian](file:///Users/uri/obsidian/work_notes/2026/06_June/week_2_07_13/13_Saturday/shift-scheduling-domain-model.md) — bidirectional link

### Task Folder
- [Domain Glossary (CONTEXT.md)](file:///Users/uri/projects/adili/shift_manager/CONTEXT.md)
- [ADR-0001: Best-effort scheduling with minimal hard core](file:///Users/uri/projects/adili/shift_manager/docs/adr/0001-best-effort-scheduling-with-minimal-hard-core.md)
- [ADR-0002: Schedules are continuous across weeks](file:///Users/uri/projects/adili/shift_manager/docs/adr/0002-schedules-are-continuous-across-weeks.md)

## Current Status & Next Steps

- **Resolved:** Full domain glossary, accepted rule set (hard/soft classified),
  org model (Site/Team/Project/Role), constraint philosophy, fairness model,
  workflow & v1 scope, two ADRs.
- **Pending (open product decisions):**
  1. **Severity ordering** of soft constraints — the optimizer's objective
     weighting (the main open decision; flagged in ADR-0001).
  2. Locked-day / mid-week re-optimization (deferred).
  3. Employee self-service + pending/approved request state (deferred past v1).
  4. Output/sharing — how an accepted Schedule reaches employees.
  5. Weekend per-Site (global Fri+Sat for now).
  6. Burden-set extensibility beyond nights + weekends.
- **Next action:** Grill out the **severity ordering** (open decision #1) — it is
  the only soft spot left before the model is fully pinned. Then, if requested,
  move to an implementation plan (explicitly deferred this session).
- **Blockers:** None.

## Related Topics

- Workforce / shift scheduling
- Constraint optimization & solver design
- Domain-driven design (glossary + ADRs)
- Grilling / design-discovery method
