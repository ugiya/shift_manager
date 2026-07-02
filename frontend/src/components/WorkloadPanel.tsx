import { useMemo, useState } from "react";
import type { Assignments, Dataset } from "../types";
import { useI18n } from "../lib/i18n";
import { workloadRows } from "../lib/workload";

// Who works how much, at a glance: shifts / nights / weekends per employee, heaviest
// first. The fairness bookkeeping (cumulative burden + vs-team delta) confused more
// than it helped (user feedback 2026-07-02), so it hides behind an "Advanced" toggle —
// the fairness rule itself always runs; this is display only.

export default function WorkloadPanel({ ds, assignments }: {
  ds: Dataset | null; assignments: Assignments;
}) {
  const { t } = useI18n();
  const [advanced, setAdvanced] = useState(false);
  const rows = useMemo(() => (ds ? workloadRows(ds, assignments) : []), [ds, assignments]);
  const maxBurden = Math.max(1, ...rows.map((r) => r.totalBurden));

  if (!ds || rows.length === 0) {
    return (
      <div className="workload" data-testid="workload-panel">
        <p className="workload__empty">{t("wlEmpty")}</p>
      </div>
    );
  }

  return (
    <div className="workload" data-testid="workload-panel">
      <div className="workload__bar-head">
        <button type="button" className={`btn btn--sm${advanced ? " is-on" : ""}`}
          data-testid="workload-advanced" data-on={advanced}
          onClick={() => setAdvanced((v) => !v)} title={t("wlAdvancedTitle")}>
          {t("wlAdvanced")}
        </button>
      </div>
      <table className="workload__table">
        <thead>
          <tr>
            <th className="workload__name">{t("wlEmployee")}</th>
            <th title={t("wlShiftsTitle")}>{t("wlShifts")}</th>
            <th title={t("wlNightsTitle")}>{t("wlNights")}</th>
            <th title={t("wlWeekendTitle")}>{t("wlWeekend")}</th>
            {advanced && <th title={t("wlBurdenTitle")}>{t("wlBurden")}</th>}
            {advanced && <th title={t("wlVsTeamTitle")}>{t("wlVsTeam")}</th>}
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
