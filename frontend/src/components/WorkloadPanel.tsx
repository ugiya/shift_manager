import { useMemo, useState } from "react";
import type { Assignments, Dataset } from "../types";
import { useI18n } from "../lib/i18n";
import { workloadRows, type WorkloadRow } from "../lib/workload";

// Who works how much, at a glance: shifts / nights / weekends per employee, heaviest
// first. The fairness bookkeeping (cumulative burden + vs-team delta) confused more
// than it helped (user feedback 2026-07-02), so it hides behind an "Advanced" toggle —
// the fairness rule itself always runs; this is display only.

type SortKey = "name" | "shifts" | "nights" | "weekends" | "burden" | "vsTeam";
type Sort = { key: SortKey; dir: 1 | -1 };
// null = no user selection: workloadRows() default order (heaviest first), no arrow.

function sortValue(r: WorkloadRow, key: SortKey): number {
  switch (key) {
    case "shifts": return r.shifts;
    case "nights": return r.nights;
    case "weekends": return r.weekends;
    case "burden": return r.totalBurden;
    // One decimal, like the cell renders: rows that LOOK equal must tie (then A→Z).
    case "vsTeam": return Math.round((r.totalBurden - r.teamAvg) * 10) / 10;
    case "name": return 0; // names compare via localeCompare below
  }
}

export default function WorkloadPanel({ ds, assignments }: {
  ds: Dataset | null; assignments: Assignments;
}) {
  const { t } = useI18n();
  const [advanced, setAdvanced] = useState(false);
  const [sort, setSort] = useState<Sort | null>(null);
  const rows = useMemo(() => {
    const base = ds ? workloadRows(ds, assignments) : [];
    if (!sort) return base;
    return [...base].sort((a, b) => {
      const cmp = sort.key === "name"
        ? a.employee.name.localeCompare(b.employee.name)
        : sortValue(a, sort.key) - sortValue(b, sort.key);
      return cmp * sort.dir || a.employee.name.localeCompare(b.employee.name);
    });
  }, [ds, assignments, sort]);
  const maxBurden = Math.max(1, ...rows.map((r) => r.totalBurden));

  if (!ds || rows.length === 0) {
    return (
      <div className="workload" data-testid="workload-panel">
        <p className="workload__empty">{t("wlEmpty")}</p>
      </div>
    );
  }

  const header = (key: SortKey, label: string, opts?: { title?: string; className?: string }) => {
    const dir = sort?.key === key ? sort.dir : 0; // 0 = not the active sort column
    return (
      <th className={opts?.className} title={opts?.title}
        aria-sort={dir === 0 ? undefined : dir === 1 ? "ascending" : "descending"}>
        <button type="button" className={`workload__sort${dir !== 0 ? " is-active" : ""}`}
          data-testid={`workload-sort-${key}`}
          onClick={() => setSort((s) => s?.key === key
            ? { key, dir: s.dir === 1 ? -1 : 1 }
            : { key, dir: key === "name" ? 1 : -1 })}>
          {label}
          {dir !== 0 && (
            <span className="workload__sort-arrow" aria-hidden>
              {dir === 1 ? "▲" : "▼"}
            </span>
          )}
        </button>
      </th>
    );
  };

  return (
    <div className="workload" data-testid="workload-panel">
      <div className="workload__bar-head">
        <button type="button" className={`btn btn--sm${advanced ? " is-on" : ""}`}
          data-testid="workload-advanced" data-on={advanced}
          onClick={() => setAdvanced((v) => {
            const next = !v;
            // Never leave the table sorted by a column that just went invisible.
            if (!next && (sort?.key === "burden" || sort?.key === "vsTeam")) setSort(null);
            return next;
          })} title={t("wlAdvancedTitle")}>
          {t("wlAdvanced")}
        </button>
      </div>
      <table className="workload__table">
        <thead>
          <tr>
            {header("name", t("wlEmployee"), { className: "workload__name" })}
            {header("shifts", t("wlShifts"), { title: t("wlShiftsTitle") })}
            {header("nights", t("wlNights"), { title: t("wlNightsTitle") })}
            {header("weekends", t("wlWeekend"), { title: t("wlWeekendTitle") })}
            {advanced && header("burden", t("wlBurden"), { title: t("wlBurdenTitle") })}
            {advanced && header("vsTeam", t("wlVsTeam"), { title: t("wlVsTeamTitle") })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const delta = r.totalBurden - r.teamAvg;
            const over = delta > 0.5; // meaningfully above the team average
            return (
              <tr key={r.employee.id} data-testid="workload-row" data-emp-id={r.employee.id}
                data-shifts={r.shifts} data-burden={r.totalBurden}>
                <td className="workload__name">
                  <span className="workload__emp">{r.employee.name}</span>
                  <span className="workload__team">{r.teamName}</span>
                </td>
                <td data-testid="workload-shifts">{r.shifts}</td>
                <td>{r.nights}</td>
                <td>{r.weekends}</td>
                {advanced && (
                  <td className="workload__burden">
                    <span className="workload__bar" aria-hidden
                      style={{ width: `${(r.totalBurden / maxBurden) * 100}%` }} />
                    <span className="workload__num" title={
                      t("wlCarriedTitle", { carried: r.employee.carryover_burden, week: r.weekBurden })}>
                      {r.totalBurden}
                    </span>
                  </td>
                )}
                {advanced && (
                  <td className={`workload__delta${over ? " is-over" : ""}`}>
                    {delta === 0 ? "·" : `${delta > 0 ? "+" : ""}${round1(delta)}`}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="workload__note">
        {advanced ? t("wlAdvancedNote") : t("wlNote")}
      </p>
    </div>
  );
}

function round1(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}
