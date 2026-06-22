import type {
  Assignments,
  BuildResult,
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

export function build(requirements: RequirementsDoc): Promise<BuildResult> {
  return post<BuildResult>("/api/build", { requirements });
}

export function solve(requirements: RequirementsDoc, seconds?: number): Promise<SolveResponse> {
  return post<SolveResponse>("/api/solve", { requirements, seconds });
}

export function validate(
  requirements: RequirementsDoc,
  assignments: Assignments,
): Promise<ValidateResponse> {
  return post<ValidateResponse>("/api/validate", { requirements, assignments });
}
