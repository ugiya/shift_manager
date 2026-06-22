import type { Dataset, Employee, Seat } from "../types";
import { seatState } from "../lib/lookups";

interface Props {
  seat: Seat;
  ds: Dataset;
  assignedId: string | null;
  onChange: (seatId: string, employeeId: string | null) => void;
}

function options(ds: Dataset, seat: Seat): { eligible: Employee[]; other: Employee[] } {
  const eligible: Employee[] = [];
  const other: Employee[] = [];
  const elig = new Set(seat.eligible_employee_ids);
  for (const e of ds.employees) {
    if (elig.has(e.id)) eligible.push(e);
    else other.push(e);
  }
  return { eligible, other };
}

export default function SeatCell({ seat, ds, assignedId, onChange }: Props) {
  const state = seatState(seat, assignedId);
  const { eligible, other } = options(ds, seat);

  return (
    <div className={`seat seat--${state}`} data-testid="seat" data-seat-id={seat.id} data-state={state}>
      <div className="seat__label" title={seat.label}>
        {seat.kind === "manager" && <span className="seat__pin" aria-hidden>★</span>}
        <span className="seat__labeltext">{seat.label}</span>
      </div>
      <select
        className="seat__select"
        data-testid={`seat-select-${seat.id}`}
        value={assignedId ?? ""}
        onChange={(e) => onChange(seat.id, e.target.value || null)}
      >
        <option value="">— unfilled —</option>
        <optgroup label="Eligible">
          {eligible.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Exceptional (needs sign-off)">
          {other.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </optgroup>
      </select>
      {state === "exceptional" && <span className="seat__tag seat__tag--exc">sign-off</span>}
    </div>
  );
}
