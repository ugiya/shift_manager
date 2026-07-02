import { useState } from "react";
import type { Assignments, Dataset, Flag, ScoreInfo } from "../types";
import { useI18n } from "../lib/i18n";
import FlagsPanel from "./FlagsPanel";
import WorkloadPanel from "./WorkloadPanel";

// The right-hand sidebar: Review (flags — the default, so the existing review flow and
// its tests are untouched) or Workload (per-employee totals & fairness standing).

type Tab = "review" | "workload";

export default function SidePanel({ flags, score, validating, ds, assignments }: {
  flags: Flag[]; score: ScoreInfo | null; validating: boolean;
  ds: Dataset | null; assignments: Assignments;
}) {
  const [tab, setTab] = useState<Tab>("review");
  const { t } = useI18n();
  return (
    <aside className="sidepanel" data-testid="side-panel">
      <div className="sidepanel__tabs" role="tablist" aria-label="Schedule insights">
        <button role="tab" aria-selected={tab === "review"} data-testid="sidetab-review"
          className={`sidepanel__tab${tab === "review" ? " is-active" : ""}`}
          onClick={() => setTab("review")}>{t("tabReview")}</button>
        <button role="tab" aria-selected={tab === "workload"} data-testid="sidetab-workload"
          className={`sidepanel__tab${tab === "workload" ? " is-active" : ""}`}
          onClick={() => setTab("workload")}>{t("tabWorkload")}</button>
      </div>
      {tab === "review"
        ? <FlagsPanel flags={flags} score={score} validating={validating} />
        : <WorkloadPanel ds={ds} assignments={assignments} />}
    </aside>
  );
}
