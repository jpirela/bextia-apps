import { useCallback, useEffect, useState } from "react";
import { Badge, MessageBar, Text, Textarea } from "@fluentui/react-components";
import { Inbox } from "krypton-ecosystem/lara/fluent";
import { api } from "../lib/client";
import { ApiError } from "../lib/api";
import { LEAD_STATES, formatDate, leadStateLabel } from "../lib/format";

type Lead = { id: string; destino: string | null; estado: string; score: number | null; urgencia: string | null; resumen_ia: string | null; created_at: string; contacto: { nombre: string | null } };
type LeadDetail = Lead & { conversacion: { direccion: string; contenido: string; created_at: string }[] };

const FOLDERS = LEAD_STATES.map((s) => ({ id: s, label: leadStateLabel(s) }));

// Bandeja de solo lectura: el estado de un lead lo mueve el agente (o el admin vía API).
export function Leads() {
  const [items, setItems] = useState<Lead[]>([]);
  const [sel, setSel] = useState<LeadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.get<{ data: Lead[] }>("/api/leads")
    .then((r) => { setItems(r?.data ?? []); setError(null); })
    .catch((e) => setError(e instanceof ApiError ? `Error ${e.status}` : "Error de red")), []);
  useEffect(() => { void load(); }, [load]);
  const open = (l: Lead) => api.get<LeadDetail>(`/api/leads/${l.id}`).then(setSel).catch(() => setError("No se pudo abrir el lead"));
  return (
    <>
      {error && <MessageBar intent="error">{error}</MessageBar>}
      <Inbox<Lead>
        folders={FOLDERS}
        mails={items}
        idOf={(l) => l.id}
        folderOf={(l) => l.estado}
        dateOf={(l) => l.created_at}
        textOf={(l) => `${l.contacto.nombre ?? ""} ${l.destino ?? ""} ${l.resumen_ia ?? ""}`}
        isUnread={() => false}
        initialFolder="nuevo"
        searchPlaceholder="Buscar lead…"
        onSelect={(l) => { setSel(null); void open(l); }}
        renderItem={(l) => (
          <div style={{ display: "grid", gap: 2 }}>
            <Text weight="semibold">{l.contacto.nombre ?? "Sin nombre"} · {l.destino ?? "—"}</Text>
            <Text size={200}>{l.resumen_ia ?? ""}</Text>
            <Text size={200}>{formatDate(l.created_at)} <Badge size="small">{leadStateLabel(l.estado)}{l.score != null ? ` · ${l.score}` : ""}</Badge></Text>
          </div>
        )}
        renderDetail={(l) => (sel && sel.id === l.id
          ? <Textarea readOnly resize="vertical" style={{ width: "100%" }} rows={14}
              value={sel.conversacion.map((m) => `${m.direccion === "in" ? "Viajero" : "Agente"}: ${m.contenido}`).join("\n")} />
          : <Text>Cargando…</Text>)}
      />
    </>
  );
}
