# Shift Scheduling

The language of a product that helps a scheduler build a weekly work schedule
across multiple sites and teams, then explains every place it had to bend or
break a rule.

## Language

### Organization

**Site**:
A geographic location where employees physically sit and work. Homes multiple
Teams, which may run different shift schedules. A Team usually belongs to one
Site.
_Avoid_: location, factory, branch.

**Team**:
A group of employees led by exactly one Shift Manager, working across several
Projects. The Team carries its own weekly shift schedule (which Shift Types it
runs). Usually sits at one Site; on rare occasions a Team is split across two
Sites while still sharing a single Shift Manager.
_Avoid_: crew, squad, unit, group.

**Project**:
A unit of continuous work owned by a Team. Each shift a Project runs is staffed
by a fixed crew composition expressed as Role counts (e.g. 1 developer + 1
product manager) so the work advances as many hours per day as possible. An
employee may belong to several Projects and is eligible to fill any of their
(Project, Role) slots.
_Avoid_: task, assignment, workstream.

**Employee**:
A person who may be assigned to shifts. Belongs to one Team and holds one or more
Roles. Workers also belong to one or more Projects within their Team; a Shift
Manager is classified at the Team level rather than per Project. Managers are
Employees.
_Avoid_: worker (when the umbrella is meant), staff, resource.

**Role**:
A skill an employee is qualified to perform (e.g. developer, QA, product
manager). A word like "manager" may appear in a Role name as description only and
implies no hierarchy. Worker demand is matched on the pair (Project, Role): the
eligible pool is employees who belong to that Project and hold that Role. Every
deployment defines its own Roles — none are built in.
_Avoid_: capability, skill, qualification, position.

**Shift Manager**:
The supervisory position in charge of an entire shift for a Team — a genuine
hierarchical role, distinct from any Role whose name merely contains "manager"
(e.g. product manager). Staffed one per Team per shift, never per Project. A Shift
Manager is also an Employee.
_Avoid_: supervisor, team lead, manager (unqualified).

**Scheduler**:
The user who runs schedule generation, reviews results, makes Overrides, and
accepts the Schedule. Holds authority over a set of Teams — covering both a
central planner managing many Teams and a Shift Manager scheduling only their
own. A role, not necessarily a distinct person.
_Avoid_: planner, admin, operator.

**Unavailability**:
A firm fact that an employee cannot work on a given day (approved time off, sick
leave, an external commitment). Granular **per date** (a calendar day) — every
Shift starting on that date is affected; employees are available by default. It is
enforced by **removing the employee from the eligibility (value range) of those
dates' Seats**, so the optimizer never assigns them then. A Scheduler may still
Override an unavailable employee onto a Seat; that is an Exceptional Assignment
(a Compromise that needs sign-off), not a hard block. In v1 it is entered by the
Scheduler and is simply true once entered — there is no pending/approval state.
_Avoid_: absence, leave, block.

**Preference**:
A soft statement that an employee would rather (or rather not) work certain
Shifts. Violating a Preference is a Compromise the optimizer may accept
automatically and report — never a hard block. Two forms exist: a *negative*
per-Shift preference ("I'd rather not work this shift", R10) and a *positive*
per-Shift-Type preference ("I prefer Mornings", R11) — the latter penalises being
assigned a type the employee did not list (an empty list means no preference).
_Avoid_: wish, request, constraint.

### Shifts

**Shift Type**:
A reusable, date-independent template for a shift: a name plus an explicit
classification (e.g. whether it is a night shift). Its concrete start/end clock
hours are bound per Site, so the same Shift Type can run different hours at
different Sites. Examples: Morning, Evening, Night, Cross.
_Avoid_: shift name, shift category.

**Shift**:
A Shift Type occurring on a specific calendar date, for a specific Team, at a
specific Site — the concrete thing that carries staffing demand and that
employees are assigned to. For counting (demand, one-per-day), a Shift belongs to
the date on which it *starts*; rest rules instead use the actual end→next-start
gap in clock time.
_Avoid_: shift slot, occurrence.

**Cross (shift)**:
A Shift Type for a long shift that spans/crosses two normal shift windows
(Hebrew: משמרת חוצה) — e.g. a mid-day shift overlapping parts of both Morning
and Evening.

**Night Shift**:
A Shift whose Shift Type is explicitly classified as night. The classification is
set by the scheduler, never inferred from the shift's name or hours, because the
rest/recovery rules key off the classification.
_Avoid_: late shift, graveyard.

**Weekend**:
A configurable set of days treated as the weekly rest block, defaulting to Friday
+ Saturday, global across Sites. The days are independently assignable — an
employee may work only Friday or only Saturday.
_Avoid_: rest days, off days.

**Weekend Shift**:
A Shift that *starts* on a Weekend day. An employee "worked the weekend" if they
worked *any* Weekend Shift that week (not necessarily the whole weekend).
_Avoid_: weekend duty.

**Rest Gap**:
The elapsed clock time between an employee's shift end and their next shift start
(spanning the week boundary via Carry-over). Two configurable minimums govern it:
a legal turnaround minimum between any two shifts, and a longer night-recovery
minimum after a Night Shift (default ~24h / a full day off).
_Avoid_: break, downtime, cooldown.

**Burden Shift**:
A Shift considered unpopular and therefore subject to Fairness — by default any
Night Shift or Weekend Shift, with the set configurable per deployment.
_Avoid_: unpopular shift, bad shift.

**Fairness**:
A soft optimization objective that spreads Burden Shifts evenly, measured
cumulatively across weeks (via Carry-over), among employees within the same Team
who are eligible for that shift. Never a hard constraint — Fairness influences
*who* gets a burden, never *whether* it is covered.
_Avoid_: equity, balance, rotation.

### Demand & Scheduling

**Demand**:
The staffing required for the Shifts in a week, in two parts: exactly one Shift
Manager per Team per shift the Team runs, and — per Project running that shift — a
count per Role (the crew composition, e.g. 1 developer + 1 product manager).
Demand is **exact**: both understaffing and overstaffing are Compromises, weighted
equally. Crew composition can vary by day and by shift, reflecting how advanced a
Project is, so Demand is defined per concrete Shift rather than as a fixed weekly
template.
_Avoid_: requirement, headcount, quota.

**Assignment**:
A single employee placed in a single seat — one (Shift, Project, Role) for a
worker, or (Shift, Team) for a Shift Manager. An employee fills at most one seat
at any one time, and that seat counts toward exactly one demand. Multi-Project
membership only widens the pool eligible for a seat; it never lets one person
satisfy two seats in the same time slot (a hard impossibility — neither seat
counts as filled).
_Avoid_: placement, booking.

**Carry-over**:
State from prior weeks that feeds the current week's solve. Two kinds: recent
facts that drive rules (who worked last weekend, who worked a Night Shift on the
last day) and rolling cumulative counts that drive Fairness (how many Burden
Shifts each employee has recently worked). The system is not stateless per week;
each solve takes prior weeks as input.
_Avoid_: history, state, continuity.

**Schedule**:
A complete set of employee-to-shift assignments for one week. Always fully
produced — the system never refuses to return one, even when rules are broken.
The system is the system of record: the accepted Schedule (including any
Overrides) is what feeds the next week's Carry-over.
_Avoid_: roster, plan, timetable.

**Override**:
A manual change the scheduler makes to a generated Schedule. Overrides are
first-class and recorded, never silent. Any Override re-validates the *whole*
Schedule and re-raises all Compromises and Infeasibilities it affects anywhere —
so a single swap may surface several flags at once (e.g. a replacement landing on
both a 2nd consecutive weekend and a 6-day week). The scheduler can outrank the
optimizer, but never silently.
_Avoid_: manual edit, adjustment, tweak.

**Compromise**:
A soft-rule violation the system knowingly accepted in a produced Schedule and
surfaced to the scheduler, instead of failing to produce a Schedule. The system
optimizes to minimize Compromises; it never hides them.
_Avoid_: error, warning, conflict.

**Infeasibility**:
A hard-core violation — something illegal or physically impossible (one person in
two places at once; the legal minimum of one day off per calendar week). Unlike a
Compromise, a hard constraint is never knowingly broken; the affected slice is
left unfilled instead.
_Avoid_: failure, exception.

**Exceptional Assignment**:
An assignment reaching outside an employee's normal eligibility — covering a Role
they don't hold (substitution by Role), a Project they don't belong to, a Team
they don't belong to (cross-team fill-in), or a Site their Team isn't at (a split
Team). All are rare. The optimizer never places these automatically; it surfaces
them as suggestions for the scheduler to approve when demand cannot otherwise be
met. Contrast with multi-Project membership within one's own Team (common,
automatic) and Preference violations (automatic, reported as Compromises).
_Avoid_: override, manual assignment, substitution.
