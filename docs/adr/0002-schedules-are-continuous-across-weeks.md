# Schedules are continuous across weeks (Carry-over), not independent

Each weekly solve takes prior weeks as input via **Carry-over**, rather than
treating every week as an independent problem. Carry-over carries two kinds of
state: recent facts that drive rules (who worked last weekend; who worked a Night
Shift on the last day) and rolling cumulative counts that drive Fairness (how many
Burden Shifts each employee has recently worked).

## Why

Several accepted rules are impossible without it: consecutive-weekend protection
needs last weekend's assignments; night recovery straddles the week boundary; and
fairness measured within a single week is meaningless — burden must be balanced
cumulatively across weeks.

## Consequences

The system is not stateless per week. There is coupling between consecutive
Schedules, and the accepted Schedule (including manual Overrides) must be
persisted as the source of next week's Carry-over. We accept this coupling over
the simplicity of independent weekly solves.
