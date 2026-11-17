import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Dropdown, Field, Input, MessageBar, Option, Switch, Text, Textarea } from "@fluentui/react-components";
import { Inbox } from "krypton-ecosystem/lara/fluent";
import { api } from "../lib/client";
import { ApiError } from "../lib/api";
import { INCIDENT_TYPES, formatDate, incidentTypeLabel, slaLabel } from "../lib/format";

type Incident = {
  id: string; tipologia: string; urgencia: string; estado: string; requiere_humano: boolean; resumen_ia: string | null;
  sla_vence: string | null; created_at: string; reserva: { codigo: string; destino: string | null; viajero_nombre: string | null };
};
type IncidentDetail = Incident & {
  acciones: { tipo: string; monto: string | null; detalle: { reembolso?: boolean } | null; created_at: string }[];
  conversacion: { direccion: string; contenido: string; created_at: string }[];
};
type Notice = { intent: "error" | "info"; text: string };

const FOLDERS = [{ id: "abiertas", label: "Abiertas" }, { id: "cerradas", label: "Cerradas" }];
const folderOf = (i: Incident) => (i.estado === "cerrado" ? "cerradas" : "abiertas");

export function Incidents() {
  const [humano, setHumano] = useState(false);
  const [tipologia, setTipologia] = useState<string | undefined>();
  const [items, setItems] = useState<Incident[]>([]);
  const [sel, setSel] = useState<IncidentDetail | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nota, setNota] = useState("");
  const [monto, setMonto] = useState("");
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(() => api.get<{ data: Incident[] }>("/api/incidents", { requiere_humano: humano ? "true" : undefined, tipologia })
    .then((r) => { setItems(r?.data ?? []); setNow(new Date()); setLoadError(null); })
    .catch((e) => setLoadError(e instanceof ApiError ? `Error ${e.status}` : "Error de red")), [humano, tipologia]);
  useEffect(() => {
    void load();
    const h = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(h);
  }, [load]);

  const wanted = useRef<string | null>(null);
  // Conserva el orden del servidor (requiere_humano, sla_vence asc): useMail reordena por dateOf descendente.
  const rank = useMemo(() => new Map(items.map((x, k) => [x.id, k])), [items]);
  const open = (id: string) => { wanted.current = id; return api.get<IncidentDetail>(`/api/incidents/${id}`).then((d) => { if (wanted.current === id) setSel(d); }).catch(() => setNotice({ intent: "error", text: "No se pudo abrir la incidencia" })); };
  // Igual que la API: última autorización menos lo ya reembolsado.
  const auts = sel?.acciones.filter((a) => a.tipo === "autorizacion") ?? [];
  const lastAut = auts.length ? auts[auts.length - 1] : undefined;
  const reembolsado = (sel?.acciones ?? []).filter((a) => a.tipo === "resultado" && a.detalle?.reembolso === true).reduce((t, a) => t + Math.round(Number(a.monto ?? 0) * 100), 0);
  const maxAut = lastAut ? Math.max(0, Math.round(Number(lastAut.monto ?? 0) * 100) - reembolsado) / 100 : 0;
  const puedeReembolso = !!lastAut;

  const act = async (accion: "tomar" | "cerrar" | "reembolso", extra: { monto?: number } = {}) => {
    if (!sel) return;
    try {
      await api.send("PATCH", `/api/incidents/${sel.id}`, { accion, nota: nota || undefined, ...extra });
      setNota(""); setMonto(""); setNotice(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.body as { error?: string } | null)?.error === "closed") {
        setNotice({ intent: "info", text: "La incidencia ya estaba cerrada" });
      } else {
        setNotice({ intent: "error", text: e instanceof ApiError && e.status === 409 ? "La acción no es posible en el estado actual"
          : e instanceof ApiError && e.status === 400 ? ((e.body as { issues?: { message: string }[] } | null)?.issues?.[0]?.message ?? "Monto fuera de lo autorizado") : "Error" });
      }
    }
    if (wanted.current === sel.id) await open(sel.id);
    void load();
  };

  return (
    <>
      {loadError && <MessageBar intent="error">{loadError}</MessageBar>}
      {notice && <MessageBar intent={notice.intent}>{notice.text}</MessageBar>}
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <Switch label="Solo requieren humano" checked={humano} onChange={(_, d) => setHumano(d.checked)} />
        <Dropdown placeholder="Todas las tipologías" onOptionSelect={(_, d) => setTipologia(d.optionValue || undefined)}>
          <Option value="">Todas</Option>
          {INCIDENT_TYPES.map((t) => <Option key={t} value={t}>{incidentTypeLabel(t)}</Option>)}
        </Dropdown>
      </div>
      <Inbox<Incident>
        folders={FOLDERS}
        mails={items}
        idOf={(i) => i.id}
        folderOf={folderOf}
        dateOf={(i) => new Date(items.length - (rank.get(i.id) ?? 0))}
        textOf={(i) => `${i.reserva.codigo} ${i.reserva.viajero_nombre ?? ""} ${i.resumen_ia ?? ""}`}
        isUnread={(i) => i.requiere_humano && i.estado !== "cerrado"}
        searchPlaceholder="Buscar incidencia…"
        onSelect={(i) => { setSel(null); setNotice(null); void open(i.id); }}
        renderItem={(i) => {
          const sla = slaLabel(i.sla_vence, now);
          return (
            <div style={{ display: "grid", gap: 2 }}>
              <Text weight="semibold">{incidentTypeLabel(i.tipologia)} · {i.reserva.codigo}</Text>
              <Text size={200}>{i.resumen_ia ?? ""}</Text>
              <Text size={200}>{formatDate(i.created_at)} <Badge size="small" color={sla.intent}>{sla.text}</Badge></Text>
            </div>
          );
        }}
        renderDetail={(i) => {
          if (!sel || sel.id !== i.id) return <Text>Cargando…</Text>;
          const cerrada = sel.estado === "cerrado";
          return (
            <div style={{ display: "grid", gap: 12 }}>
              <Text weight="semibold">{sel.reserva.codigo} · {sel.reserva.destino ?? "—"} · {sel.reserva.viajero_nombre ?? "—"}</Text>
              <div>{sel.acciones.map((a, k) => (
                <Text key={k} block size={200}>{a.tipo}{a.monto ? ` · ${a.monto}` : ""} · {formatDate(a.created_at)}</Text>
              ))}</div>
              <Textarea readOnly rows={10} value={sel.conversacion.map((m) => `${m.direccion === "in" ? "Viajero" : "Agente"}: ${m.contenido}`).join("\n")} />
              <Field label="Nota (opcional)"><Textarea maxLength={500} value={nota} onChange={(_, d) => setNota(d.value)} /></Field>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
                <Button appearance="primary" disabled={cerrada} onClick={() => void act("tomar")}>Tomar</Button>
                <Button disabled={cerrada} onClick={() => void act("cerrar")}>Cerrar</Button>
                {puedeReembolso && (
                  <>
                    <Field label={`Monto (máx. ${maxAut})`}><Input type="number" min={0} max={maxAut} value={monto} onChange={(_, d) => setMonto(d.value)} /></Field>
                    <Button disabled={cerrada || !(Number(monto) > 0)} onClick={() => void act("reembolso", { monto: Number(monto) })}>Reembolsar</Button>
                  </>
                )}
              </div>
            </div>
          );
        }}
      />
    </>
  );
}

