export type KpiPayload = {
  rango: { desde: string; hasta: string };
  eventos: { tipo: string; agente: string | null; canal: string | null; valor: number | null; created_at: string }[];
  leads: { estado: string; score: number | null; mercado: string | null; created_at: string; entregado_at: string | null }[];
  incidencias: { tipologia: string; urgencia: string; estado: string; requiere_humano: boolean; created_at: string; cerrado_at: string | null }[];
};

export type KpiSummary = {
  leads: number; entregados: number; tasaEntrega: number | null; scoreMedio: number | null;
  incidencias: number; abiertas: number; escaladas: number;
  primeraRespuestaP50: number | null; resolucionMedianaMin: number | null;
  porDia: { dia: string; leads: number; incidencias: number }[];
  porTipologia: { tipologia: string; n: number }[];
  porCanal: { canal: string; n: number }[];
};

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const count = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return m;
};

export function summarize(p: KpiPayload): KpiSummary {
  const entregados = p.leads.filter((l) => l.estado === "entregado").length;
  const scores = p.leads.flatMap((l) => (l.score == null ? [] : [l.score]));
  const cerradas = p.incidencias.filter((i) => i.cerrado_at);
  const dias = new Map<string, { leads: number; incidencias: number }>();
  const bump = (iso: string, k: "leads" | "incidencias") => {
    const d = iso.slice(0, 10);
    const cur = dias.get(d) ?? { leads: 0, incidencias: 0 };
    cur[k]++; dias.set(d, cur);
  };
  p.leads.forEach((l) => bump(l.created_at, "leads"));
  p.incidencias.forEach((i) => bump(i.created_at, "incidencias"));
  return {
    leads: p.leads.length,
    entregados,
    tasaEntrega: p.leads.length ? entregados / p.leads.length : null,
    scoreMedio: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    incidencias: p.incidencias.length,
    abiertas: p.incidencias.filter((i) => i.estado !== "cerrado").length,
    escaladas: p.incidencias.filter((i) => i.requiere_humano || i.estado === "escalado").length,
    primeraRespuestaP50: median(p.eventos.filter((e) => e.tipo === "first_response" && e.valor != null).map((e) => e.valor!)),
    resolucionMedianaMin: median(cerradas.map((i) => (new Date(i.cerrado_at!).getTime() - new Date(i.created_at).getTime()) / 60_000)),
    porDia: [...dias].sort(([a], [b]) => a.localeCompare(b)).map(([dia, v]) => ({ dia, ...v })),
    porTipologia: [...count(p.incidencias, (i) => i.tipologia)].map(([tipologia, n]) => ({ tipologia, n })),
    porCanal: [...count(p.eventos, (e) => e.canal ?? "desconocido")].sort((a, b) => b[1] - a[1]).map(([canal, n]) => ({ canal, n })),
  };
}

// El selector de Lara da días inclusivos (YYYY-MM-DD); la API espera [desde, hasta) en UTC.
export function rangeQuery(r: { from: string; to: string }): { desde: string; hasta: string } {
  return { desde: r.from, hasta: new Date(new Date(`${r.to}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10) };
}
