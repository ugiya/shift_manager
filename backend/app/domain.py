"""Timefold planning domain for weekly shift scheduling.

Maps directly onto CONTEXT.md:

  * Problem facts (immutable): Site, Role, Team, Project, Employee, ShiftType, Shift
  * Planning entity:            Seat  -- one required position in one Shift
  * Planning variable:          Seat.employee (nullable -> best-effort under-staffing)
  * Per-seat value range:       Seat.eligible -- only employees eligible for the seat,
                                so the solver NEVER auto-creates an Exceptional Assignment.
  * Planning solution:          Schedule
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Optional

from timefold.solver.domain import (PlanningEntityCollectionProperty, PlanningId,
                                     PlanningScore, PlanningVariable,
                                     ProblemFactCollectionProperty, ValueRangeProvider,
                                     planning_entity, planning_solution)
from timefold.solver.score import HardMediumSoftScore

from .config import WEEKEND_WEEKDAYS


# --- Problem facts -----------------------------------------------------------

@dataclass(frozen=True)
class Site:
    id: str
    name: str


@dataclass(frozen=True)
class Role:
    id: str
    name: str


@dataclass(frozen=True)
class Team:
    id: str
    name: str
    site_id: str


@dataclass(frozen=True)
class Project:
    id: str
    name: str
    team_ids: frozenset[str]   # ADR-0003: a project may run under multiple teams/sites


@dataclass(frozen=True)
class ShiftType:
    id: str
    name: str
    is_night: bool
    start_hour: int   # 0..23
    end_hour: int     # 0..23 ; if <= start_hour the shift crosses midnight


@dataclass(frozen=True)
class Employee:
    """A person who may be assigned to shifts.

    The trailing fields are Carry-over (see ADR-0002): facts and cumulative
    counts from prior weeks that feed this week's solve.
    """
    id: str
    name: str
    team_id: str
    role_ids: frozenset[str]
    project_ids: frozenset[str]
    can_manage: bool = False                     # eligible to be this team's Shift Manager
    avoid_shift_ids: frozenset[str] = frozenset()  # negative Preferences (R10)
    # --- Carry-over ---
    carryover_burden: int = 0                    # burden shifts in recent weeks (R9 fairness)
    worked_last_weekend: bool = False            # R7 consecutive-weekend protection
    prev_shift_end: Optional[datetime] = None    # last shift end in prior week (R3/R6 across boundary)
    prev_shift_was_night: bool = False           # whether that last shift was a Night Shift


@dataclass(frozen=True)
class Shift:
    """A Shift Type occurring on a concrete date for one Team at one Site.

    Computed time fields are stored so constraints stay free of config lookups.
    """
    id: str
    shift_type: ShiftType
    team_id: str
    site_id: str
    start_dt: datetime
    end_dt: datetime

    @property
    def is_night(self) -> bool:
        return self.shift_type.is_night

    @property
    def start_date(self):
        return self.start_dt.date()

    @property
    def is_weekend(self) -> bool:
        # "worked the weekend" keys off the day the shift STARTS.
        return self.start_dt.weekday() in WEEKEND_WEEKDAYS


# --- Planning entity ---------------------------------------------------------

@planning_entity
@dataclass
class Seat:
    """One required position to fill: a worker seat (Shift x Project x Role) or a
    manager seat (Shift x Team). `eligible` is this seat's value range."""
    id: Annotated[str, PlanningId]
    kind: str                       # 'worker' | 'manager'
    shift: Shift
    team_id: str
    project_id: Optional[str]       # worker seats only
    role_id: Optional[str]          # worker seats only
    eligible: Annotated[list[Employee], ValueRangeProvider] = field(default_factory=list)
    employee: Annotated[Optional[Employee],
                        PlanningVariable(allows_unassigned=True)] = field(default=None)

    @property
    def is_burden(self) -> bool:
        # By default any Night Shift or Weekend Shift is a Burden Shift (R9).
        return self.shift.is_night or self.shift.is_weekend

    def is_eligible(self, emp: Employee) -> bool:
        return emp in self.eligible


# --- Planning solution -------------------------------------------------------

@planning_solution
@dataclass
class Schedule:
    employees: Annotated[list[Employee], ProblemFactCollectionProperty]
    shifts: Annotated[list[Shift], ProblemFactCollectionProperty]
    seats: Annotated[list[Seat], PlanningEntityCollectionProperty]
    score: Annotated[Optional[HardMediumSoftScore], PlanningScore] = field(default=None)
