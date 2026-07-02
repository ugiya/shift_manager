import { useMemo } from "react";
import type { Assignments, Dataset, Seat, Team } from "../types";
import { buildLookups, dayHeader, findShift, shiftTypesForTeam } from "../lib/lookups";
import { fmtFull } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import SeatCell from "./SeatCell";

interface Props {
  ds: Dataset;
  teams: Team[];
  assignments: Assignments;
  onChange: (seatId: string, employeeId: string | null) => void;
  locked?: boolean;
  dirty?: boolean;
}

export default function ScheduleGrid({ ds, teams, assignments, onChange, locked = false, dirty = false }: Props) {
  const { t } = useI18n();
  const lk = useMemo(() => buildLookups(ds), [ds]);
  return (
    <div className="schedule">
      {locked && (
        <div className="banner banner--warn" data-testid="site-locked" role="status">
          {dirty ? t("lockedDirty") : t("lockedWorking")}
        </div>
      )}
      {teams.map((team) => (
        <TeamGrid key={team.id} team={team} ds={ds} lk={lk} assignments={assignments} onChange={onChange} locked={locked} />
      ))}
    </div>
  );
}

function TeamGrid({
  team,
  ds,
  lk,
  assignments,
  onChange,
  locked,
}: {
  team: Team;
  ds: Dataset;
  lk: ReturnType<typeof buildLookups>;
  assignments: Assignments;
  onChange: (seatId: string, employeeId: string | null) => void;
  locked: boolean;
}) {
  const { t, lang, weekdayNames } = useI18n();
  const types = shiftTypesForTeam(ds, team.id, lk);
  return (
    <section className="team" data-testid="team-section" data-team-id={team.id}>
      <h2 className="team__title">{team.name}</h2>
      <div className="grid-scroll">
        <div
          className="grid"
          style={{ gridTemplateColumns: `var(--rowhdr) repeat(7, minmax(150px, 1fr))` }}
        >
          {/* header row */}
          <div className="grid__corner" />
          {ds.days.map((d, i) => {
            const h = dayHeader(d, ds.weekend_weekdays, weekdayNames, lang === "he" ? "he-IL" : undefined);
            return (
              <div key={d} className={`grid__dayhdr${h.weekend ? " is-weekend" : ""}`}
                title={fmtFull(d, lang)}>
                <span className="grid__dayname">{h.name}</span>
                {/* the month shows where it orients: the first column and a month change */}
                <span className="grid__daydom">{h.dom}{(i === 0 || h.monthStart) ? ` ${h.mon}` : ""}</span>
                {h.weekend && <span className="grid__wkend">{t("weekend")}</span>}
              </div>
            );
          })}

          {/* one row per shift type */}
          {types.map((st) => (
            <RowFragment
              key={st.id}
              stId={st.id}
              stName={st.name}
              isNight={st.is_night}
              team={team}
              ds={ds}
              lk={lk}
              assignments={assignments}
              onChange={onChange}
              locked={locked}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function RowFragment({
  stId,
  stName,
  isNight,
  team,
  ds,
  lk,
  assignments,
  onChange,
  locked,
}: {
  stId: string;
  stName: string;
  isNight: boolean;
  team: Team;
  ds: Dataset;
  lk: ReturnType<typeof buildLookups>;
  assignments: Assignments;
  onChange: (seatId: string, employeeId: string | null) => void;
  locked: boolean;
}) {
  const { weekdayNames } = useI18n();
  // Seat-matrix layout (user feedback 2026-07-02): every seat is its OWN grid row, so
  // a seat reads as one continuous band across the week with a real rule under it —
  // stacking seats inside a day cell left rows visually untrackable.
  // Alignment is by a STABLE SEAT KEY (kind + project + role + ordinal), not by the
  // day's positional index: disjoint-day demand rows may vary the crew per day, and a
  // bare index would visually chain two different seats into one "row" (codex).
  const perDay = ds.days.map((d) => {
    const shift = findShift(ds, team.id, stId, d);
    if (!shift) return null;
    const byKey = new Map<string, Seat>();
    const counters = new Map<string, number>();
    for (const s of lk.seatsByShift.get(shift.id) ?? []) {   // pre-sorted: manager first
      const base = `${s.kind}|${s.project_id ?? ""}|${s.role_id ?? ""}`;
      const ord = counters.get(base) ?? 0;
      counters.set(base, ord + 1);
      byKey.set(`${base}|${ord}`, s);
    }
    return { id: shift.id, byKey };
  });
  // Row identities: union of the per-day keys, in first-appearance order (day order,
  // and within a day the sorted seat order) — so common rows lead, day-specific follow.
  const rowKeys: string[] = [];
  const seen = new Set<string>();
  for (const day of perDay) {
    if (!day) continue;
    for (const key of day.byKey.keys()) {
      if (!seen.has(key)) { seen.add(key); rowKeys.push(key); }
    }
  }
  const rows = Math.max(1, rowKeys.length);
  return (
    // display:contents — cells stay direct grid children; the row-header spans the
    // lane's rows, and each sub-row wrapper gives whole-row hover highlighting.
    <div style={{ display: "contents" }} data-testid="grid-row">
      <div className={`grid__rowhdr${isNight ? " is-night" : ""}`}
        style={{ gridRow: `span ${rows}` }}>{stName}</div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={rowKeys[i] ?? i} className={`gridrow${i === rows - 1 ? " gridrow--laneend" : ""}`}
          style={{ display: "contents" }}>
          {ds.days.map((d, di) => {
            const day = perDay[di];
            const cellWeekend = dayHeader(d, ds.weekend_weekdays, weekdayNames).weekend;
            if (!day) {
              return (
                <div key={d} className={`cell cell--empty${cellWeekend ? " is-weekend" : ""}`}>
                  {i === 0 ? "·" : ""}
                </div>
              );
            }
            const seat = rowKeys[i] ? day.byKey.get(rowKeys[i]) : undefined;
            return (
              <div
                key={d}
                className={`cell cell--slim${isNight ? " is-night" : ""}${cellWeekend ? " is-weekend" : ""}`}
                data-testid="shift-cell"
                data-shift-id={day.id}
              >
                {seat && (
                  <SeatCell
                    key={seat.id}
                    seat={seat}
                    ds={ds}
                    assignedId={assignments[seat.id] ?? null}
                    onChange={onChange}
                    locked={locked}
                  />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
