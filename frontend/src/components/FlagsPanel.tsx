import type { Flag, ScoreInfo } from "../types";
import { useI18n } from "../lib/i18n";
import { flagText } from "../lib/flagText";

interface Props {
  flags: Flag[];
  score: ScoreInfo | null;
  validating: boolean;
}

export default function FlagsPanel({ flags, score, validating }: Props) {
  const { t } = useI18n();
  const hard = flags.filter((f) => f.kind === "hard");
  const soft = flags.filter((f) => f.kind === "soft");

  return (
    <aside className="flags" data-testid="flags-panel">
      <div className="flags__head">
        <h2 className="flags__title">{t("reviewTitle")}</h2>
        {validating && <span className="flags__busy" data-testid="validating">{t("rechecking")}</span>}
      </div>

      {score && (
        <div
          className={`scoreline ${score.feasible ? "scoreline--ok" : "scoreline--bad"}`}
          data-testid="score-detail"
        >
          {score.feasible ? t("noHardViolations") : t("hardViolations", { n: hard.length })} ·{" "}
          {t("compromises", { n: soft.length })}
        </div>
      )}

      <FlagGroup
        kind="hard"
        title={t("infeasibilities")}
        subtitle={t("infeasibilitiesSub")}
        flags={hard}
        emptyText={t("infeasibilitiesEmpty")}
      />
      <FlagGroup
        kind="soft"
        title={t("compromisesTitle")}
        subtitle={t("compromisesSub")}
        flags={soft}
        emptyText={t("compromisesEmpty")}
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
  const { lang } = useI18n();
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
          {flags.map((f) => {
            // Hebrew composes from the flag's machine-readable form; configured names
            // (roles/projects/people/shift types) stay exactly as entered.
            const text = flagText(f, lang);
            return (
              <li
                key={f.id}
                className={`flag flag--${kind}`}
                data-testid="flag"
                data-rule={f.rule}
                data-kind={f.kind}
              >
                <span className="flag__rule">{f.rule}</span>
                <div className="flag__body">
                  <p className="flag__title">{text.title}</p>
                  <p className="flag__detail">{text.detail}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
