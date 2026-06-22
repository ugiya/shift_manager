import type { Assignments, Dataset, Team } from "../types";
import { buildLookups, dayHeader, findShift, shiftTypesForTeam } from "../lib/lookups";
import SeatCell from "./SeatCell";

interface Props {
  ds: Dataset;
  teams: Team[];
  assignments: Assignments;
  onChange: (seatId: string, employeeId: string | null) => void;
}

export default function ScheduleGrid({ ds, teams, assignments, onChange }: Props) {
  const lk = buildLookups(ds);
  return (
    <div className="schedule">
      {teams.map((team) => (
        <TeamGrid key={team.id} team={team} ds={ds} lk={lk} assignments={assignments} onChange={onChange} />
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
}: {
  team: Team;
  ds: Dataset;
  lk: ReturnType<typeof buildLookups>;
  assignments: Assignments;
  onChange: (seatId: string, employeeId: string | null) => void;
}) {
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
          {ds.days.map((d) => {
            const h = dayHeader(d);
            return (
              <div key={d} className={`grid__dayhdr${h.weekend ? " is-weekend" : ""}`}>
                <span className="grid__dayname">{h.name}</span>
                <span className="grid__daydom">{h.dom}</span>
                {h.weekend && <span className="grid__wkend">weekend</span>}
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
}: {
  stId: string;
  stName: string;
  isNight: boolean;
  team: Team;
  ds: Dataset;
  lk: ReturnType<typeof buildLookups>;
  assignments: Assignments;
  onChange: (seatId: string, employeeId: string | null) => void;
}) {
  return (
    <>
      <div className={`grid__rowhdr${isNight ? " is-night" : ""}`}>{stName}</div>
      {ds.days.map((d) => {
        const shift = findShift(ds, team.id, stId, d);
        const cellWeekend = dayHeader(d).weekend;
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
              />
            ))}
          </div>
        );
      })}
    </>
  );
}
