import type {
  Assignments,
  BuildResult,
  CarryoverSeed,
  RequirementsDoc,
  SolveResponse,
  ValidateResponse,
} from "./types";

// fetch() itself rejects ONLY on network-level failures (server down, connection
// refused/reset) — never on HTTP error statuses. Wrapping just that rejection gives the
// app a precise "backend unreachable" signal; anything else (bad status, shape drift,
// client bugs) keeps its real error and is never mislabelled.
export class ServerUnreachableError extends Error {
  constructor(cause: unknown) {
    super(String(cause));
    this.name = "ServerUnreachableError";
  }
}

async function reach(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new ServerUnreachableError(e);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // Surface the backend's structured detail (e.g. "Request body too large") instead
    // of a bare status code — it's what the user needs to act on.
    const body = await res.text().catch(() => "");
    let detail = "";
    try {
      detail = String(JSON.parse(body)?.detail ?? "");
    } catch {
      detail = body.slice(0, 200);
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  return res.json() as Promise<T>;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return reach(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => json<T>(r));
}

export function getRequirements(): Promise<RequirementsDoc> {
  return reach("/api/requirements").then((r) => json<RequirementsDoc>(r));
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
