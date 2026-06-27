"""FastAPI app — requirements-driven scheduling.

The client (the interactive editor) holds a *requirements* document and posts it
with every call. The server validates it, materialises it into a domain Dataset,
and builds / solves / re-validates — staying stateless so it's deterministic and
"any Override re-validates the whole Schedule" stays literally true.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .analysis import derive_flags
from .carryover import carryover_seed, empty_carryover_seed
from .config import ALLOWED_ORIGINS, MAX_REQUEST_BYTES, MAX_SOLVE_SECONDS
from .data import build_lookup, build_schedule, default_dataset
from .requirements import (CarryoverSeedIn, RequirementsIn, apply_carryover_seed,
                           dataset_to_requirements, to_dataset, validate_requirements)
from .serialize import (apply_assignments, assignments_of, dataset_payload,
                        validate_assignments)
from .solver import score_breakdown, solve


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm up the JVM / Timefold class generation so the first request is fast.
    score_breakdown(build_schedule(default_dataset()))
    yield


app = FastAPI(title="Shift Scheduler", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["*"], allow_headers=["*"],
)


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    """Reject oversized bodies before they are read/parsed."""
    cl = request.headers.get("content-length")
    if cl is not None and cl.isdigit() and int(cl) > MAX_REQUEST_BYTES:
        return JSONResponse(status_code=413, content={"detail": "Request body too large."})
    return await call_next(request)


class BuildRequest(BaseModel):
    requirements: RequirementsIn
    carryover_seed: CarryoverSeedIn | None = None


class SolveRequest(BaseModel):
    requirements: RequirementsIn
    seconds: int | None = None
    carryover_seed: CarryoverSeedIn | None = None


class ValidateRequest(BaseModel):
    requirements: RequirementsIn
    assignments: dict[str, str | None]
    carryover_seed: CarryoverSeedIn | None = None


def _materialize(req: RequirementsIn, seed: CarryoverSeedIn | None = None):
    """(dataset, schedule, lookup) or None if there are blocking errors.

    An optional carry-over seed (ADR-0002) is replayed onto the employees first,
    after a week-identity check, so the merged values pass normal validation.
    """
    seed_warnings: list[str] = []
    if seed is not None:
        seed_errors, seed_warnings = apply_carryover_seed(req, seed)
        if seed_errors:
            return None, seed_errors, seed_warnings
    errors, warnings = validate_requirements(req)
    warnings = seed_warnings + warnings
    if errors:
        return None, errors, warnings
    ds = to_dataset(req)
    return (ds, build_schedule(ds), build_lookup(ds)), errors, warnings


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/requirements")
def get_requirements() -> dict:
    """The seed org as an editable requirements doc — the editor's starting point."""
    return dataset_to_requirements(default_dataset())


@app.post("/api/build")
def post_build(req: BuildRequest) -> dict:
    mat, errors, warnings = _materialize(req.requirements, req.carryover_seed)
    if mat is None:
        return {"errors": errors, "warnings": warnings, "dataset": None}
    ds, schedule, _lookup = mat
    return {"errors": [], "warnings": warnings, "dataset": dataset_payload(ds, schedule)}


@app.post("/api/solve")
def post_solve(req: SolveRequest) -> dict:
    if req.seconds is not None and not (1 <= req.seconds <= MAX_SOLVE_SECONDS):
        return {"errors": [f"seconds must be between 1 and {MAX_SOLVE_SECONDS}."],
                "warnings": [], "dataset": None, "assignments": {}, "score": None,
                "flags": [], "next_carryover": empty_carryover_seed()}
    mat, errors, warnings = _materialize(req.requirements, req.carryover_seed)
    if mat is None:
        return {"errors": errors, "warnings": warnings, "dataset": None, "assignments": {},
                "score": None, "flags": [], "next_carryover": empty_carryover_seed()}
    ds, schedule, lookup = mat
    solved = solve(schedule, spent=(req.seconds or 8), unimproved=2)
    score = score_breakdown(solved)
    return {
        "errors": [], "warnings": warnings,
        "dataset": dataset_payload(ds, solved),
        "assignments": assignments_of(solved),
        "score": score,
        "flags": derive_flags(solved, lookup),
        "next_carryover": carryover_seed(solved, ds.week_start, feasible=score["feasible"]),
    }


@app.post("/api/validate")
def post_validate(req: ValidateRequest) -> dict:
    mat, errors, warnings = _materialize(req.requirements, req.carryover_seed)
    if mat is None:
        return {"errors": errors, "warnings": warnings, "dataset": None, "assignments": {},
                "score": None, "flags": [], "next_carryover": empty_carryover_seed()}
    ds, schedule, lookup = mat
    employees_by_id = {e.id: e for e in ds.employees}
    assignment_errors = validate_assignments(schedule, req.assignments, employees_by_id)
    if assignment_errors:
        return {"errors": assignment_errors, "warnings": warnings, "dataset": None,
                "assignments": {}, "score": None, "flags": [],
                "next_carryover": empty_carryover_seed()}
    apply_assignments(schedule, req.assignments, employees_by_id)
    score = score_breakdown(schedule)
    return {
        "errors": [], "warnings": warnings,
        "dataset": dataset_payload(ds, schedule),
        "assignments": assignments_of(schedule),
        "score": score,
        "flags": derive_flags(schedule, lookup),
        "next_carryover": carryover_seed(schedule, ds.week_start, feasible=score["feasible"]),
    }


# --- Serve the built frontend (single-origin for e2e / Claude-in-Chrome) -----
_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="frontend")
