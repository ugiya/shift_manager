import type {
  Assignments,
  BuildResult,
  CarryoverSeed,
  RequirementsDoc,
  SolveResponse,
  ValidateResponse,
} from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => json<T>(r));
}

export function getRequirements(): Promise<RequirementsDoc> {
  return fetch("/api/requirements").then((r) => json<RequirementsDoc>(r));
}

// `carryoverSeed` (optional): a prior week's next_carryover envelope, replayed to
// seed this week's carry-over. The server checks it targets this week (ADR-0002).
export function build(
  requirements: RequirementsDoc,
  carryoverSeed?: CarryoverSeed,
): Promise<BuildResult> {
  return post<BuildResult>("/api/build", { requirements, carryover_seed: carryoverSeed });
}

export function solve(
  requirements: RequirementsDoc,
  seconds?: number,
  carryoverSeed?: CarryoverSeed,
): Promise<SolveResponse> {
  return post<SolveResponse>("/api/solve", { requirements, seconds, carryover_seed: carryoverSeed });
}

export function validate(
  requirements: RequirementsDoc,
  assignments: Assignments,
  carryoverSeed?: CarryoverSeed,
): Promise<ValidateResponse> {
  return post<ValidateResponse>("/api/validate", {
    requirements,
    assignments,
    carryover_seed: carryoverSeed,
  });
}
