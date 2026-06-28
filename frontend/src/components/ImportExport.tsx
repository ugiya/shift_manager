import { useRef, useState } from "react";
import { exportDoc, importDoc, type ImportMode } from "../api";
import type { RequirementsDoc } from "../types";

// Phase 5: import / export toolbar. JSON is lossless (whole document); CSV is a lossy
// employee roster (references by name, carry-over dropped) — labelled as such in the UI.
const MODES: { value: ImportMode; label: string }[] = [
  { value: "replace", label: "Replace all" },
  { value: "upsert_by_id", label: "Merge by id" },
  { value: "upsert_by_name", label: "Merge by name" },
  { value: "replace_autocreate_refs", label: "Replace + create missing refs" },
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
        setMsg(`Import failed: ${r.errors.join("; ") || "unknown error"}`);
      } else {
        // The merged document is adopted even with validation errors so the user can fix
        // them in the editor — but say so plainly rather than reporting plain success.
        onChange(r.requirements);
        if (r.errors.length) {
          setMsg(`Imported ${format.toUpperCase()} with ${r.errors.length} error(s) — open Requirements to fix.`);
        } else {
          const warn = r.warnings.length ? ` · ${r.warnings.length} warning(s)` : "";
          setMsg(`Imported ${format.toUpperCase()}${warn}.`);
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
      <span className="iobar__label">Import / export:</span>
      <button className="btn btn--sm" data-testid="export-json" disabled={busy}
        onClick={() => doExport("json")}>Export JSON</button>
      <button className="btn btn--sm" data-testid="export-csv" disabled={busy}
        onClick={() => doExport("csv")} title="Employee roster only — carry-over is not exported">
        Export CSV <span className="iobar__lossy">(lossy roster)</span>
      </button>
      <span className="iobar__sep" aria-hidden />
      <label className="iobar__mode">mode
        <select className="in" data-testid="import-mode" value={mode}
          onChange={(e) => setMode(e.target.value as ImportMode)}>
          {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>
      <label className={`btn btn--sm${busy ? " is-disabled" : ""}`} data-testid="import-label">
        Import file…
        <input ref={fileRef} type="file" accept=".json,.csv" data-testid="import-file"
          hidden disabled={busy} onChange={onFile} />
      </label>
      {msg && <span className="iobar__msg" data-testid="io-msg" role="status">{msg}</span>}
    </div>
  );
}
