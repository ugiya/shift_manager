import { useMemo } from "react";
import type { Assignments, Dataset } from "../types";
import { buildLookups, dayHeader, findShift, shiftTypesForTeam } from "../lib/lookups";
import { fmtWeekRange } from "../lib/dates";
import { useI18n } from "../lib/i18n";

// Print-only rendering of the whole week — every team, every site — as compact tables:
// one row per shift type, one column per day, names in the cells. Hidden on screen
// (.printonly); @media print hides the app chrome and shows this instead, so the browser's
// Print (or "Save as PDF") produces a clean handout of the current assignments.

export default function PrintSchedule({ ds, assignments }: {
  ds: Dataset | null; assignments: Assignments;
}) {
  const { t, lang, weekdayNames } = useI18n();
  const lk = useMemo(() => (ds ? buildLookups(ds) : null), [ds]);
  if (!ds || !lk) return null;
  const siteName = new Map(ds.sites.map((s) => [s.id, s.name]));
  const roleName = new Map(ds.roles.map((r) => [r.id, r.name]));
  const projName = new Map(ds.projects.map((p) => [p.id, p.name]));

  return (
    <div className="printonly" data-testid="print-schedule">
      <h1 className="print__title">{t("printScheduleTitle", { week: fmtWeekRange(ds.week_start, lang) })}</h1>
      {ds.teams.map((team) => {
        const types = shiftTypesForTeam(ds, team.id, lk);
        if (types.length === 0) return null;
        return (
          <section key={team.id} className="print__team">
            <h2>{team.name} <span className="print__site">({siteName.get(team.site_id) ?? team.site_id})</span></h2>
            <table className="print__table">
              <thead>
                <tr>
                  <th>Shift</th>
                  {ds.days.map((d, i) => {
                    const h = dayHeader(d, ds.weekend_weekdays, weekdayNames, lang === "he" ? "he-IL" : undefined);
                    return (
                      <th key={d} className={h.weekend ? "is-weekend" : ""}>
                        {h.name} {h.dom}{(i === 0 || h.monthStart) ? ` ${h.mon}` : ""}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {types.map((st) => (
                  <tr key={st.id}>
                    <th className="print__shift">{st.name}</th>
                    {ds.days.map((d) => {
                      const shift = findShift(ds, team.id, st.id, d);
                      const seats = shift ? lk.seatsByShift.get(shift.id) ?? [] : [];
                      return (
                        <td key={d}>
                          {seats.map((seat) => {
                            const empId = assignments[seat.id] ?? null;
                            const name = empId ? lk.empById.get(empId)?.name ?? empId : "—";
                            const what = seat.kind === "manager"
                              ? "★"
                              : `${seat.project_id ? projName.get(seat.project_id) ?? "" : ""}/${seat.role_id ? roleName.get(seat.role_id) ?? "" : ""}`;
                            return (
                              <div key={seat.id} className={`print__seat${empId ? "" : " is-unfilled"}`}>
                                <span className="print__what">{what}</span> {name}
                              </div>
                            );
                          })}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}
