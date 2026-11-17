import { useCallback, useEffect, useState } from "react";
import { Button, Input, MessageBar, Tab, TabList } from "@fluentui/react-components";
import { CrudManager, DataView } from "krypton-ecosystem/lara/fluent";
import { api } from "../lib/client";
import { ApiError } from "../lib/api";
import { diffRows, toForm, toPayload, type Row, type Spec } from "../lib/crud-diff";

const HORARIO_HINT = 'JSON con claves mon…sun, p. ej. {"mon":[["09:00","18:00"]]}';
const LIST_HINT = "Separados por comas";

// Mismos nombres y límites que los descriptores de la API (Task 6); la API vuelve a validar.
const SPECS: Record<string, Spec> = {
  sales_agent: {
    singular: "comercial", arrays: ["destinos", "idiomas", "mercados", "tipos_lead", "festivos"], json: ["horario"], nullable: ["zona_horaria", "horario"],
    fields: [
      { field: "nombre", label: "Nombre", required: true },
      { field: "email", label: "Email", control: "email", required: true },
      { field: "destinos", label: "Destinos", hint: LIST_HINT },
      { field: "idiomas", label: "Idiomas", hint: LIST_HINT },
      { field: "mercados", label: "Mercados", hint: LIST_HINT },
      { field: "tipos_lead", label: "Tipos de lead", hint: LIST_HINT },
      { field: "zona_horaria", label: "Zona horaria", hint: "IANA, p. ej. Europe/Madrid (obligatoria si hay horario)" },
      { field: "horario", label: "Horario", control: "textarea", hint: HORARIO_HINT, inTable: false },
      { field: "festivos", label: "Festivos", hint: "YYYY-MM-DD separadas por comas", inTable: false },
      { field: "activo", label: "Activo", control: "switch" },
    ],
    empty: () => ({ nombre: "", email: "", destinos: [], idiomas: [], mercados: [], tipos_lead: [], zona_horaria: null, horario: null, festivos: [], activo: true }),
  },
  business_hours: {
    singular: "horario", arrays: ["festivos"], json: ["horario"], nullable: [],
    fields: [
      { field: "mercado", label: "Mercado", required: true, hint: "2 a 10 caracteres" },
      { field: "zona_horaria", label: "Zona horaria", required: true, hint: "IANA, p. ej. Europe/Madrid" },
      { field: "horario", label: "Horario", control: "textarea", required: true, hint: HORARIO_HINT, inTable: false },
      { field: "festivos", label: "Festivos", hint: "YYYY-MM-DD separadas por comas", inTable: false },
    ],
    empty: () => ({ mercado: "", zona_horaria: "", horario: null, festivos: [] }),
  },
  on_call: {
    singular: "guardia", gender: "f", arrays: [], json: [], nullable: ["telefono"],
    fields: [
      { field: "nombre", label: "Nombre", required: true },
      { field: "email", label: "Email", control: "email", required: true },
      { field: "telefono", label: "Teléfono", hint: "Formato +34600000000" },
      { field: "prioridad", label: "Prioridad", required: true, control: "number", numeric: true, hint: "1 a 99" },
      { field: "activo", label: "Activo", control: "switch" },
    ],
    empty: () => ({ nombre: "", email: "", telefono: null, prioridad: 1, activo: true }),
  },
  kb_article: {
    singular: "artículo", arrays: ["etiquetas"], json: [], nullable: [],
    fields: [
      { field: "titulo", label: "Título", required: true, hint: "Hasta 200 caracteres" },
      { field: "contenido", label: "Contenido", control: "textarea", required: true, hint: "Hasta 20 000 caracteres", inTable: false },
      { field: "idioma", label: "Idioma", required: true, control: "select", options: ["es", "en", "pt", "fr", "it", "de"] },
      { field: "etiquetas", label: "Etiquetas", hint: LIST_HINT },
    ],
    empty: () => ({ titulo: "", contenido: "", idioma: "es", etiquetas: [] }),
  },
};

const TABS = [
  { key: "sales_agent", label: "Comerciales" }, { key: "business_hours", label: "Horarios" }, { key: "on_call", label: "Guardia" },
  { key: "kb_article", label: "Base de conocimiento" }, { key: "protocol", label: "Protocolos" },
];

const issuesText = (body: unknown): string =>
  ((body as { issues?: { message: string }[] } | null)?.issues ?? []).map((i) => i.message).join("; ") || "Datos inválidos";
const failText = (e: unknown): string =>
  e instanceof ApiError ? (e.status === 400 ? issuesText(e.body) : e.status === 409 ? "Ya existe un registro con esos datos" : `Error ${e.status}`) : e instanceof Error ? e.message : "Error de red";

function CrudTab({ resource }: { resource: string }) {
  const spec = SPECS[resource];
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => api.get<{ data: Row[] }>(`/api/config/${resource}`)
    .then((r) => { // El DELETE de la API solo desactiva (sales_agent, on_call): las filas inactivas no se listan.
      setRows((r?.data ?? []).filter((x) => x.activo !== false).map((x) => toForm(spec, x))); setLoadError(null); })
    .catch((e) => setLoadError(e instanceof ApiError ? `Error ${e.status}` : "Error de red"))
    .finally(() => setLoading(false)), [resource, spec]);
  useEffect(() => { void load(); }, [load]);

  const onChange = async (next: Row[]) => {
    try {
      const d = diffRows(rows, next);
      if (d.op === "delete") await api.send("DELETE", `/api/config/${resource}/${d.row.id}`);
      else if (d.op === "post") await api.send("POST", `/api/config/${resource}`, toPayload(spec, d.row, false));
      else if (d.op === "patch") await api.send("PATCH", `/api/config/${resource}/${d.row.id}`, toPayload(spec, d.row, true));
      else return;
      setNotice(null);
    } catch (e) {
      setNotice(failText(e));
    }
    await load();
  };
  return (
    <>
      {loadError && <MessageBar intent="error">{loadError}</MessageBar>}
      {notice && <MessageBar intent="error">{notice}</MessageBar>}
      <CrudManager<Row>
        view={{ resource, singular: spec.singular, gender: spec.gender, fields: spec.fields, defaultSort: spec.fields[0].field }}
        rows={rows}
        loading={loading}
        onChange={(n) => { void onChange(n); }}
        makeEmpty={() => ({ ...toForm(spec, { id: "", ...spec.empty() }), id: `nuevo-${crypto.randomUUID()}` })}
      />
    </>
  );
}

type Protocol = { id: string; codigo: string; nombre: string; version: number; activo: boolean; tope_autorizado: string | null };

function TopeCell({ p, onSaved, onError }: { p: Protocol; onSaved: () => void; onError: (m: string) => void }) {
  const [v, setV] = useState(p.tope_autorizado ?? "");
  const save = async () => {
    try {
      await api.send("PATCH", `/api/config/protocol/${p.id}`, { tope_autorizado: v.trim() === "" ? null : Number(v) });
      onSaved();
    } catch (e) { onError(failText(e)); }
  };
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <Input type="number" min={0} value={v} onChange={(_, d) => setV(d.value)} />
      <Button size="small" disabled={v === (p.tope_autorizado ?? "")} onClick={() => void save()}>Guardar</Button>
    </div>
  );
}

function Protocols() {
  const [rows, setRows] = useState<Protocol[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => api.get<{ data: Protocol[] }>("/api/config/protocol")
    .then((r) => { setRows(r?.data ?? []); setLoadError(null); })
    .catch((e) => setLoadError(e instanceof ApiError ? `Error ${e.status}` : "Error de red")), []);
  useEffect(() => { void load(); }, [load]);
  return (
    <>
      {loadError && <MessageBar intent="error">{loadError}</MessageBar>}
      {notice && <MessageBar intent="error">{notice}</MessageBar>}
      <DataView<Protocol>
        rows={rows}
        getKey={(p) => p.id}
        columns={[
          { key: "codigo", label: "Código", sortable: true },
          { key: "nombre", label: "Nombre" },
          { key: "version", label: "Versión" },
          { key: "activo", label: "Activo", render: (p) => (p.activo ? "Sí" : "No") },
          { key: "tope_autorizado", label: "Tope autorizado", render: (p) => <TopeCell key={`${p.id}-${p.tope_autorizado}`} p={p} onSaved={() => { setNotice(null); void load(); }} onError={setNotice} /> },
        ]}
      />
    </>
  );
}

export function Config() {
  const [tab, setTab] = useState("sales_agent");
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(String(d.value))}>
        {TABS.map((t) => <Tab key={t.key} value={t.key}>{t.label}</Tab>)}
      </TabList>
      {tab === "protocol" ? <Protocols /> : <CrudTab key={tab} resource={tab} />}
    </div>
  );
}
