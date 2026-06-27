"""Solver factory, solve, and Timefold-authoritative scoring.

The SolverFactory is built once (JVM class generation is expensive). `solve`
runs local search; `analyze` returns Timefold's authoritative score breakdown
without re-solving -- this is what backs Override re-validation (ADR: an Override
re-validates the *whole* Schedule).
"""
from __future__ import annotations

from functools import lru_cache

from timefold.solver import SolutionManager, SolverFactory
from timefold.solver.config import (Duration, ScoreDirectorFactoryConfig, SolverConfig,
                                     TerminationConfig)

from .constraints import CONSTRAINTS, define_constraints
from .domain import Schedule, Seat

DEFAULT_SPENT_SECONDS = 8
DEFAULT_UNIMPROVED_SECONDS = 2


@lru_cache(maxsize=1)
def _solver_factory(spent: int = DEFAULT_SPENT_SECONDS,
                    unimproved: int = DEFAULT_UNIMPROVED_SECONDS) -> SolverFactory:
    config = SolverConfig(
        solution_class=Schedule,
        entity_class_list=[Seat],
        score_director_factory_config=ScoreDirectorFactoryConfig(
            constraint_provider_function=define_constraints),
        termination_config=TerminationConfig(
            spent_limit=Duration(seconds=spent),
            unimproved_spent_limit=Duration(seconds=unimproved)),
    )
    return SolverFactory.create(config)


@lru_cache(maxsize=1)
def _solution_manager() -> SolutionManager:
    return SolutionManager.create(_solver_factory())


def solve(problem: Schedule, spent: int = DEFAULT_SPENT_SECONDS,
          unimproved: int = DEFAULT_UNIMPROVED_SECONDS) -> Schedule:
    """Generate a complete Schedule (best-effort: always returns one)."""
    return _solver_factory(spent, unimproved).build_solver().solve(problem)


def analyze(problem: Schedule):
    """Timefold's authoritative ScoreAnalysis for an (already-assigned) solution.

    Also writes the score back onto `problem.score`, so a hand-edited Schedule
    coming from an Override gets re-scored without a re-solve.
    """
    sm = _solution_manager()
    sm.update(problem)            # recompute and set problem.score
    return sm.analyze(problem)


def score_breakdown(problem: Schedule) -> dict:
    """Per-constraint totals from Timefold, classified hard/soft via CONSTRAINTS."""
    analysis = analyze(problem)
    score = problem.score
    constraints = []
    for ca in analysis.constraint_analyses:
        name = str(ca.constraint_name)
        meta = CONSTRAINTS.get(name, {"kind": "soft", "level": "soft", "rule": "?"})
        constraints.append({
            "name": name,
            "rule": meta["rule"],
            "kind": meta["kind"],
            "level": meta.get("level", meta["kind"]),
            "match_count": int(ca.match_count),
            "score": str(ca.score),
        })
    return {
        "score": str(score),
        "hard_score": score.hard_score,
        "medium_score": score.medium_score,
        "soft_score": score.soft_score,
        "feasible": score.hard_score >= 0,
        "constraints": constraints,
    }
