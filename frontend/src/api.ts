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

// Phase 5: import / export. JSON is lossless; CSV is a lossy employee roster.
export type ImportMode = "replace" | "upsert_by_id" | "upsert_by_name" | "replace_autocreate_refs";

export interface ExportResponse { errors: string[]; content: string; filename: string; lossy: boolean }
export interface ImportResponse { errors: string[]; warnings: string[]; requirements: RequirementsDoc | null }

export function exportDoc(requirements: RequirementsDoc, format: "json" | "csv"): Promise<ExportResponse> {
  return post<ExportResponse>("/api/export", { requirements, format });
}

export function importDoc(
  requirements: RequirementsDoc, format: "json" | "csv", mode: ImportMode, content: string,
): Promise<ImportResponse> {
  return post<ImportResponse>("/api/import", { requirements, format, mode, content });
}
