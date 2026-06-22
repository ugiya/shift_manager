"""Tunable scheduling parameters and soft-constraint weights.

These are the "configurable with sane defaults" knobs from CONTEXT.md. The soft
weights encode a *rough* severity ordering only — the authoritative ordering is
still an open product decision (see docs/adr/0001). They are deliberately spread
far apart so the solver's trade-offs are legible.
"""

# --- Time / rest model -------------------------------------------------------
# A Shift is counted on the calendar day it STARTS; rest is measured in real
# clock minutes between one shift's end and the next shift's start.
LEGAL_REST_MINUTES = 8 * 60      # hard: legal turnaround between any two shifts
NIGHT_REST_MINUTES = 24 * 60     # soft-strong: recovery after a Night Shift

# Weekend = the weekly rest block. Python weekday(): Mon=0 .. Sun=6.
WEEKEND_WEEKDAYS = frozenset({4, 5})   # Friday, Saturday

DAYS_IN_WEEK = 7

# --- Soft-constraint weights (severity ordering, provisional) ----------------
W_UNDERSTAFF = 100        # R4  exact demand: an unfilled seat
W_OVERSTAFF = 100         # R4  exact demand: a surplus assignment (equal weight)
W_ONE_SHIFT_PER_DAY = 80  # R5  at most one shift per calendar day
W_NIGHT_RECOVERY = 70     # R6  rest after a night shift
W_CONSECUTIVE_WEEKEND = 60  # R7  two weekends in a row
W_EXCEPTIONAL = 50        # Exceptional Assignment (eligibility-exceeding override)
W_SIXTH_DAY = 20          # R8  working a 6th day (only one day off)
W_PREFERENCE = 10         # R10 working an avoided shift
W_FAIRNESS = 5            # R9  burden-shift imbalance (per squared unit)
