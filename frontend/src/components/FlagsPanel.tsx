import type { Flag, ScoreInfo } from "../types";

interface Props {
  flags: Flag[];
  score: ScoreInfo | null;
  validating: boolean;
}

export default function FlagsPanel({ flags, score, validating }: Props) {
  const hard = flags.filter((f) => f.kind === "hard");
  const soft = flags.filter((f) => f.kind === "soft");

  return (
    <aside className="flags" data-testid="flags-panel">
      <div className="flags__head">
        <h2 className="flags__title">Review</h2>
        {validating && <span className="flags__busy" data-testid="validating">re-checking…</span>}
      </div>

      {score && (
        <div
          className={`scoreline ${score.feasible ? "scoreline--ok" : "scoreline--bad"}`}
          data-testid="score-detail"
        >
          {score.feasible ? "No hard violations" : `${hard.length} hard violation(s)`} ·{" "}
          {soft.length} compromise(s)
        </div>
      )}

      <FlagGroup
        kind="hard"
        title="Infeasibilities"
        subtitle="Hard rules broken — must be fixed"
        flags={hard}
        emptyText="None — the schedule is legal."
      />
      <FlagGroup
        kind="soft"
        title="Compromises"
        subtitle="Soft rules bent — accepted & reported"
        flags={soft}
        emptyText="None — nothing was compromised."
      />
    </aside>
  );
}

function FlagGroup({
  kind,
  title,
  subtitle,
  flags,
  emptyText,
}: {
  kind: "hard" | "soft";
  title: string;
  subtitle: string;
  flags: Flag[];
  emptyText: string;
}) {
  return (
    <div className="flaggroup" data-testid={`flaggroup-${kind}`}>
      <div className="flaggroup__head">
        <span className={`flaggroup__count flaggroup__count--${kind}`} data-testid={`count-${kind}`}>
          {flags.length}
        </span>
        <div className="flaggroup__heading">
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
      </div>
      {flags.length === 0 ? (
        <p className="flaggroup__empty">{emptyText}</p>
      ) : (
        <ul className="flaglist">
          {flags.map((f) => (
            <li
              key={f.id}
              className={`flag flag--${kind}`}
              data-testid="flag"
              data-rule={f.rule}
              data-kind={f.kind}
            >
              <span className="flag__rule">{f.rule}</span>
              <div className="flag__body">
                <p className="flag__title">{f.title}</p>
                <p className="flag__detail">{f.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
