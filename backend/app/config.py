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

# --- Resource limits (DoS / accidental blow-up guards) -----------------------
# Generous bounds for a real org; they only reject pathological inputs. The
# client controls solve time and problem size, so these cap both.
MAX_SOLVE_SECONDS = 60        # per /api/solve call
MAX_SEATS = 20_000            # materialised planning entities per problem
MAX_EMPLOYEES = 5_000         # problem facts per problem
MAX_REQUEST_BYTES = 5_000_000  # request body ceiling (~5 MB)
# Cap on client-supplied rolling burden. R9 squares (carryover_burden + this week),
# so an unbounded client value could overflow the (32-bit) soft score or swamp the
# other soft rules. Coverage (R4) is on a higher score level, so this is purely an
# overflow / soft-domination guard, not what protects coverage. A real deployment
# should decay/window the rolling count rather than sum forever.
MAX_CARRYOVER_BURDEN = 1_000

# Browser origins allowed to call the API. Dev and prod are both effectively
# same-origin (Vite proxies /api in dev; FastAPI serves the SPA in prod), so
# only the local dev server's direct origins need listing.
ALLOWED_ORIGINS = [
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:8000", "http://127.0.0.1:8000",
]
