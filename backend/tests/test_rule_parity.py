"""Rule-contract parity (MEDIUM #4): the rule ids the solver scores
(`constraints.CONSTRAINTS`) and the rule ids the explainer emits
(`analysis._flag(...)`) must be the same set. Without this they can drift as
rules evolve -- a constraint added without a matching flag (or vice versa) would
silently change behaviour with no test catching it."""
from __future__ import annotations

import ast

from app import analysis
from app.constraints import CONSTRAINTS

# The accepted rules from CONTEXT.md plus the override-only Exceptional Assignment.
CANON = {"R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "EXC"}


def _rules_emitted_by_analysis() -> set[str]:
    """Every literal rule id passed as the first arg to analysis._flag(...)."""
    tree = ast.parse(open(analysis.__file__).read())
    rules: set[str] = set()
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == "_flag" and node.args):
            first = node.args[0]
            assert isinstance(first, ast.Constant) and isinstance(first.value, str), (
                "_flag's rule arg should be a string literal so parity is checkable")
            rules.add(first.value)
    return rules


def test_constraints_cover_exactly_the_canonical_rules():
    assert {m["rule"] for m in CONSTRAINTS.values()} == CANON


def test_analysis_flags_cover_exactly_the_canonical_rules():
    assert _rules_emitted_by_analysis() == CANON


def test_constraints_and_analysis_agree():
    assert {m["rule"] for m in CONSTRAINTS.values()} == _rules_emitted_by_analysis()
