import { useMemo } from "react";
import type { Assignments, Dataset, Team } from "../types";
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
  return (
    <>
      <div className={`grid__rowhdr${isNight ? " is-night" : ""}`}>{stName}</div>
      {ds.days.map((d) => {
        const shift = findShift(ds, team.id, stId, d);
        const cellWeekend = dayHeader(d, ds.weekend_weekdays, weekdayNames).weekend;
        if (!shift) {
          return <div key={d} className={`cell cell--empty${cellWeekend ? " is-weekend" : ""}`}>·</div>;
        }
        const seats = lk.seatsByShift.get(shift.id) ?? [];
        return (
          <div
            key={d}
            className={`cell${isNight ? " is-night" : ""}${cellWeekend ? " is-weekend" : ""}`}
            data-testid="shift-cell"
            data-shift-id={shift.id}
          >
            {seats.map((seat) => (
              <SeatCell
                key={seat.id}
                seat={seat}
                ds={ds}
                assignedId={assignments[seat.id] ?? null}
                onChange={onChange}
                locked={locked}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}
