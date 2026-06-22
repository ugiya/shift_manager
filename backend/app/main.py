"""FastAPI app — requirements-driven scheduling.

The client (the interactive editor) holds a *requirements* document and posts it
with every call. The server validates it, materialises it into a domain Dataset,
and builds / solves / re-validates — staying stateless so it's deterministic and
"any Override re-validates the whole Schedule" stays literally true.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .analysis import derive_flags
from .data import build_lookup, build_schedule, default_dataset
from .requirements import (RequirementsIn, dataset_to_requirements, to_dataset,
                           validate_requirements)
from .serialize import apply_assignments, assignments_of, dataset_payload
from .solver import score_breakdown, solve


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm up the JVM / Timefold class generation so the first request is fast.
    score_breakdown(build_schedule(default_dataset()))
    yield


app = FastAPI(title="Shift Scheduler", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


class BuildRequest(BaseModel):
    requirements: RequirementsIn


class SolveRequest(BaseModel):
    requirements: RequirementsIn
    seconds: int | None = None


class ValidateRequest(BaseModel):
    requirements: RequirementsIn
    assignments: dict[str, str | None]


def _materialize(req: RequirementsIn):
    """(dataset, schedule, lookup) or None if there are blocking errors."""
    errors, warnings = validate_requirements(req)
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
    mat, errors, warnings = _materialize(req.requirements)
    if mat is None:
        return {"errors": errors, "warnings": warnings, "dataset": None}
    ds, schedule, _lookup = mat
    return {"errors": [], "warnings": warnings, "dataset": dataset_payload(ds, schedule)}


@app.post("/api/solve")
def post_solve(req: SolveRequest) -> dict:
    mat, errors, warnings = _materialize(req.requirements)
    if mat is None:
        return {"errors": errors, "warnings": warnings, "dataset": None,
                "assignments": {}, "score": None, "flags": []}
    ds, schedule, lookup = mat
    solved = solve(schedule, spent=(req.seconds or 8), unimproved=2)
    return {
        "errors": [], "warnings": warnings,
        "dataset": dataset_payload(ds, solved),
        "assignments": assignments_of(solved),
        "score": score_breakdown(solved),
        "flags": derive_flags(solved, lookup),
    }


@app.post("/api/validate")
def post_validate(req: ValidateRequest) -> dict:
    mat, errors, warnings = _materialize(req.requirements)
    if mat is None:
        return {"errors": errors, "warnings": warnings, "dataset": None,
                "score": None, "flags": []}
    ds, schedule, lookup = mat
    apply_assignments(schedule, req.assignments, {e.id: e for e in ds.employees})
    return {
        "errors": [], "warnings": warnings,
        "dataset": dataset_payload(ds, schedule),
        "assignments": assignments_of(schedule),
        "score": score_breakdown(schedule),
        "flags": derive_flags(schedule, lookup),
    }


# --- Serve the built frontend (single-origin for e2e / Claude-in-Chrome) -----
_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="frontend")
