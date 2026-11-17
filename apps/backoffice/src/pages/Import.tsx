import { useState } from "react";
import { Button, Field, MessageBar } from "@fluentui/react-components";
import { DataView } from "krypton-ecosystem/lara/fluent";
import { api } from "../lib/client";
import { ApiError } from "../lib/api";
import { MAX_IMPORT_BYTES, templateCsv } from "../lib/import-template";

type ImportResult = { creadas: number; actualizadas: number; errores: { fila: number; field: string; message: string }[] };
type Notice = { intent: "error" | "success"; text: string };

const errorText = (e: unknown): string => {
  if (e instanceof ApiError) {
    const msg = (e.body as { issues?: { message: string }[] } | null)?.issues?.[0]?.message;
    if (e.status === 413) return "El archivo supera el tope de 2 MB";
    return msg ?? `Error ${e.status}`;
  }
  return "Error de red";
};

export function Import() {
  const [result, setResult] = useState<ImportResult | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setResult(null);
    if (file.size > MAX_IMPORT_BYTES) { setNotice({ intent: "error", text: "El archivo supera el tope de 2 MB" }); return; }
    setBusy(true);
    try {
      const r = await api.send<ImportResult>("POST", "/api/import/bookings", await file.text(), "text/csv");
      setResult(r);
      setNotice(r ? { intent: "success", text: `${r.creadas} creadas, ${r.actualizadas} actualizadas` } : null);
    } catch (e) {
      setNotice({ intent: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const plantilla = () => {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([templateCsv()], { type: "text/csv" })), download: "plantilla-reservas.csv" });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {notice && <MessageBar intent={notice.intent}>{notice.text}</MessageBar>}
      <Field label="Archivo CSV de reservas (máx. 2 MB)">
        <input type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
      </Field>
      <div><Button onClick={plantilla}>Descargar plantilla</Button></div>
      {result && result.errores.length > 0 && (
        <DataView
          title="Filas con errores"
          rows={result.errores}
          getKey={(x) => `${x.fila}-${x.field}-${x.message}`}
          columns={[{ key: "fila", label: "Fila" }, { key: "field", label: "Campo" }, { key: "message", label: "Mensaje" }]}
        />
      )}
    </div>
  );
}
