export function formatDate(iso: string | null, tz = "Europe/Madrid"): string {
  if (!iso) return "—";
  const p = Object.fromEntries(new Intl.DateTimeFormat("es-ES", { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

export function slaLabel(slaIso: string | null, now: Date): { text: string; intent: "danger" | "warning" | "success" | "subtle" } {
  if (!slaIso) return { text: "sin SLA", intent: "subtle" };
  const min = Math.round((new Date(slaIso).getTime() - now.getTime()) / 60_000);
  if (min < 0) return { text: `vencido hace ${-min} min`, intent: "danger" };
  return { text: `vence en ${min} min`, intent: min < 15 ? "warning" : "success" };
}

export const LEAD_STATES = ["nuevo", "respondido", "cualificando", "cualificado", "asignado", "entregado"] as const; // los 6 valores reales de LeadState
const LEAD: Record<string, string> = { nuevo: "Nuevo", respondido: "Respondido", cualificando: "Cualificando", cualificado: "Cualificado", asignado: "Asignado", entregado: "Entregado" };
export const INCIDENT_TYPES = ["traslado_no_presentado", "consulta", "emergencia", "otra"] as const;
const INC: Record<string, string> = { traslado_no_presentado: "Traslado no presentado", consulta: "Consulta", emergencia: "Emergencia", otra: "Otra" };
export const leadStateLabel = (s: string) => LEAD[s] ?? s;
export const incidentTypeLabel = (t: string) => INC[t] ?? t;
