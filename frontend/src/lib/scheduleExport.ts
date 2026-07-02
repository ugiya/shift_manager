import type { Assignments, Dataset } from "../types";
import { dayHeader } from "./lookups";

// Export of the RESULTING schedule (who works when) — distinct from the requirements
// import/export (Phase 5), which round-trips the org document. This is the artifact a
// scheduler hands to the staff: one row per seat, unfilled seats included (a gap is
// information, not noise).

function esc(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function hhmm(dt: string): string {
  return dt.includes("T") ? dt.slice(11, 16) : dt;
}

export function scheduleCsv(ds: Dataset, assignments: Assignments): string {
  const empById = new Map(ds.employees.map((e) => [e.id, e]));
  const shiftById = new Map(ds.shifts.map((s) => [s.id, s]));
  const siteName = new Map(ds.sites.map((s) => [s.id, s.name]));
  const teamName = new Map(ds.teams.map((t) => [t.id, t.name]));
  const projName = new Map(ds.projects.map((p) => [p.id, p.name]));
  const roleName = new Map(ds.roles.map((r) => [r.id, r.name]));

  const header = ["date", "day", "site", "team", "shift", "start", "end", "seat",
    "project", "role", "employee_id", "employee", "status"];
  const rows = ds.seats.flatMap((seat) => {
    const sh = shiftById.get(seat.shift_id);
    if (!sh) return [];
    const empId = assignments[seat.id] ?? null;
    const emp = empId ? empById.get(empId) : undefined;
    const status = !empId ? "UNFILLED"
      : seat.eligible_employee_ids.includes(empId) ? "filled" : "exceptional";
    return [{
      sortKey: [sh.date, teamName.get(sh.team_id) ?? "", hhmm(sh.start), seat.label] as const,
      cols: [
        sh.date, dayHeader(sh.date, ds.weekend_weekdays).name,
        siteName.get(sh.site_id) ?? sh.site_id, teamName.get(sh.team_id) ?? sh.team_id,
        sh.shift_type_name, hhmm(sh.start), hhmm(sh.end),
        seat.kind === "manager" ? "shift manager" : "worker",
        (seat.project_id && (projName.get(seat.project_id) ?? seat.project_id)) || "",
        (seat.role_id && (roleName.get(seat.role_id) ?? seat.role_id)) || "",
        empId ?? "", emp?.name ?? "", status,
      ],
    }];
  });
  rows.sort((a, b) =>
    a.sortKey[0].localeCompare(b.sortKey[0]) || a.sortKey[1].localeCompare(b.sortKey[1]) ||
    a.sortKey[2].localeCompare(b.sortKey[2]) || a.sortKey[3].localeCompare(b.sortKey[3]));
  return [header.join(","), ...rows.map((r) => r.cols.map(esc).join(","))].join("\n") + "\n";
}

export function downloadText(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
