import type { Dataset, Employee, Seat } from "../types";
import { seatState } from "../lib/lookups";
import { roleAccent, roleChipStyle } from "../lib/roleColors";
import { useI18n } from "../lib/i18n";

interface Props {
  seat: Seat;
  ds: Dataset;
  assignedId: string | null;
  onChange: (seatId: string, employeeId: string | null) => void;
  // Round 2: while unsaved requirement edits (or a rebuild) are pending, the next Save resets
  // assignments — so the seat is read-only to avoid clobbering an edit that won't survive.
  locked?: boolean;
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

export default function SeatCell({ seat, ds, assignedId, onChange, locked = false }: Props) {
  const { t } = useI18n();
  const state = seatState(seat, assignedId);
  const { eligible, other } = options(ds, seat);

  // Role identity at a glance: the label wears its role's accent tint (managers get
  // the brand tint). The seat card's own edge still signals fill state — two
  // separate cues on two separate surfaces.
  const accent = seat.kind === "manager" ? "#4f46e5" : roleAccent(seat.role_id, ds.roles);

  return (
    <div className={`seat seat--${state}`} data-testid="seat" data-seat-id={seat.id} data-state={state}>
      <div className="seat__label seat__label--role" title={seat.label} style={roleChipStyle(accent)}>
        {seat.kind === "manager" && <span className="seat__pin" aria-hidden>★</span>}
        <span className="seat__labeltext">{seat.label}</span>
      </div>
      <select
        className="seat__select"
        data-testid={`seat-select-${seat.id}`}
        value={assignedId ?? ""}
        disabled={locked}
        title={locked ? t("finishReqFirst") : undefined}
        onChange={(e) => onChange(seat.id, e.target.value || null)}
      >
        <option value="">{t("unfilledOpt")}</option>
        <optgroup label={t("eligible")}>
          {eligible.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </optgroup>
        <optgroup label={t("exceptional")}>
          {other.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </optgroup>
      </select>
      {state === "exceptional" && <span className="seat__tag seat__tag--exc">{t("signoffTag")}</span>}
    </div>
  );
}
