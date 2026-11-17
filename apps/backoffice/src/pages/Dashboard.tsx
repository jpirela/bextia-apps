import { useEffect, useMemo, useState } from "react";
import { Button, MessageBar } from "@fluentui/react-components";
import { Breakdown, DateRangePicker, Donut, KpiRow, Line, VBar, useDateRange } from "krypton-ecosystem/lara/fluent";
import { api } from "../lib/client";
import { ApiError } from "../lib/api";
import { rangeQuery, summarize, type KpiPayload, type KpiSummary } from "../lib/kpi";
import { incidentTypeLabel } from "../lib/format";

type Metric = { field: string; label: string; agg: "sum"; format?: "number" | "percent"; subtitle?: string };
const SIN_DATOS = "Sin datos";

export function Dashboard() {
  const { range, setRange, activePreset, applyPreset } = useDateRange("last30");
  const [s, setS] = useState<KpiSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const query = useMemo(() => rangeQuery(range), [range]);

  useEffect(() => {
    let cancelled = false;
    api.get<KpiPayload>("/api/kpi", query)
      .then((p) => { if (!cancelled) { setS(p ? summarize(p) : null); setLoadError(null); } })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof ApiError ? `No se pudieron cargar los indicadores (error ${e.status})` : "No se pudieron cargar los indicadores"); });
    return () => { cancelled = true; };
  }, [query]);

  const exportar = async () => {
    try {
      const blob = await api.download("/api/export/leads.csv", query);
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "leads.csv" });
      a.click();
      URL.revokeObjectURL(a.href);
      setNotice(null);
    } catch (e) {
      setNotice(e instanceof ApiError ? `No se pudo exportar (error ${e.status})` : "No se pudo exportar");
    }
  };

  // KpiRow agrega con MetricSpec sobre filas: una sola fila con los valores ya calculados.
  const kpis = useMemo(() => {
    if (!s) return null;
    const m = (field: string, label: string, v: number | null, format: "number" | "percent" = "number", sub?: string): [Metric, number] =>
      [{ field, label, agg: "sum", format, subtitle: v == null ? SIN_DATOS : sub }, v ?? 0];
    const items = [
      m("leads", "Leads", s.leads),
      m("tasa", "Tasa de entrega", s.tasaEntrega == null ? null : s.tasaEntrega * 100, "percent"),
      m("score", "Score medio", s.scoreMedio),
      m("p50", "1.ª respuesta (p50)", s.primeraRespuestaP50, "number", "segundos"),
      m("abiertas", "Incidencias abiertas", s.abiertas),
      m("escaladas", "Escaladas", s.escaladas),
      m("resolucion", "Resolución mediana", s.resolucionMedianaMin, "number", "minutos"),
    ];
    return { metrics: items.map(([x]) => x), rows: [Object.fromEntries(items.map(([x, v]) => [x.field, v]))] };
  }, [s]);

  return (
    <div style={{ display: "grid", gap: 24 }}>
      {loadError && <MessageBar intent="error">{loadError}</MessageBar>}
      {notice && <MessageBar intent="error">{notice}</MessageBar>}
      <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
        <DateRangePicker value={range} onChange={setRange} activePreset={activePreset} onPreset={applyPreset} />
        <Button onClick={() => void exportar()}>Exportar leads (CSV)</Button>
      </div>
      {s && kpis && (
        <>
          <KpiRow rows={kpis.rows} metrics={kpis.metrics} />
          <Line title="Leads por día" rows={s.porDia} dateField="dia" granularity="day" metric={{ field: "leads", label: "Leads", agg: "sum" }} />
          <Line title="Incidencias por día" rows={s.porDia} dateField="dia" granularity="day" metric={{ field: "incidencias", label: "Incidencias", agg: "sum" }} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 24 }}>
            <Donut title="Incidencias por tipología" rows={s.porTipologia.map((t) => ({ tipologia: incidentTypeLabel(t.tipologia), n: t.n }))} dimension="tipologia" metric={{ field: "n", label: "Incidencias", agg: "sum" }} />
            <VBar title="Interacciones por canal" rows={s.porCanal} dimension="canal" metric={{ field: "n", label: "Interacciones", agg: "sum" }} />
            <Breakdown title="Leads" rows={[{ estado: "Entregados", n: s.entregados }, { estado: "Sin entregar", n: s.leads - s.entregados }]} dimension="estado" metric={{ field: "n", label: "Leads", agg: "sum" }} />
          </div>
        </>
      )}
    </div>
  );
}
