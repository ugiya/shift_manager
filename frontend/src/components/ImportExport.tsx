import { useRef, useState } from "react";
import { exportDoc, importDoc, type ImportMode } from "../api";
import type { RequirementsDoc } from "../types";
import { useI18n, type MsgKey } from "../lib/i18n";

// Phase 5: import / export toolbar. JSON is lossless (whole document); CSV is a lossy
// employee roster (references by name, carry-over dropped) — labelled as such in the UI.
// Values are stable API modes; labels translate at render time.
const MODES: { value: ImportMode; labelKey: MsgKey }[] = [
  { value: "replace", labelKey: "modeReplace" },
  { value: "upsert_by_id", labelKey: "modeMergeId" },
  { value: "upsert_by_name", labelKey: "modeMergeName" },
  { value: "replace_autocreate_refs", labelKey: "modeReplaceRefs" },
];

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ImportExport({ req, onChange }: {
  req: RequirementsDoc; onChange: (r: RequirementsDoc) => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<ImportMode>("replace");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function doExport(format: "json" | "csv") {
    setMsg(null);
    setBusy(true);
    try {
      const r = await exportDoc(req, format);
      if (r.errors.length) { setMsg(r.errors.join("; ")); return; }
      download(r.filename, r.content, format === "json" ? "application/json" : "text/csv");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onFile(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    const format: "json" | "csv" = file.name.toLowerCase().endsWith(".csv") ? "csv" : "json";
    setMsg(null);
    setBusy(true);
    try {
      const content = await file.text();
      const r = await importDoc(req, format, mode, content);
      if (!r.requirements) {
        // Parse error — nothing adopted, the document is unchanged.
        setMsg(t("importFailed", { msg: r.errors.join("; ") || t("unknownError") }));
      } else {
        // The merged document is adopted even with validation errors so the user can fix
        // them in the editor — but say so plainly rather than reporting plain success.
        onChange(r.requirements);
        if (r.errors.length) {
          setMsg(t("importedWithErrors", { format: format.toUpperCase(), n: r.errors.length }));
        } else {
          setMsg(r.warnings.length
            ? t("importedOkWarn", { format: format.toUpperCase(), n: r.warnings.length })
            : t("importedOk", { format: format.toUpperCase() }));
        }
      }
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="iobar" data-testid="io-bar">
      <span className="iobar__label">{t("ioLabel")}</span>
      <button className="btn btn--sm" data-testid="export-json" disabled={busy}
        onClick={() => doExport("json")}>{t("exportJson")}</button>
      <button className="btn btn--sm" data-testid="export-csv" disabled={busy}
        onClick={() => doExport("csv")} title={t("exportCsvTitle")}>
        {t("exportCsv")} <span className="iobar__lossy">{t("lossyRoster")}</span>
      </button>
      <span className="iobar__sep" aria-hidden />
      <label className="iobar__mode">{t("ioMode")}
        <select className="in" data-testid="import-mode" value={mode}
          onChange={(e) => setMode(e.target.value as ImportMode)}>
          {MODES.map((m) => <option key={m.value} value={m.value}>{t(m.labelKey)}</option>)}
        </select>
      </label>
      <label className={`btn btn--sm${busy ? " is-disabled" : ""}`} data-testid="import-label">
        {t("importFile")}
        <input ref={fileRef} type="file" accept=".json,.csv" data-testid="import-file"
          hidden disabled={busy} onChange={onFile} />
      </label>
      {msg && <span className="iobar__msg" data-testid="io-msg" role="status">{msg}</span>}
    </div>
  );
}
