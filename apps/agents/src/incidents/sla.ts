import { and, eq, inArray, isNotNull, lt, lte } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { incident } from "../db/schema.ts";
import { escalateIncidentResult } from "./escalate.ts";
import { ESCALATED_REPLY } from "./prompts.ts";
import { sendTraveler, targetFromIncident } from "./reply.ts";
import { runProtocol, type RunnerDeps } from "./runner.ts";
import { claimWait, recordKpi, restoreWait } from "./store.ts";

// Barrido de esperas vencidas: cada incidencia se reclama con claimWait (atómico) antes de avanzar,
// de modo que dos barridos simultáneos (o la respuesta del proveedor) nunca duplican efectos.
export async function runDueTimers(deps: RunnerDeps): Promise<{ ran: number; failed: number }> {
  const now = deps.now();
  const due = await deps.db.select().from(incident)
    .where(and(eq(incident.estado, "protocolo"), isNotNull(incident.proximo_paso_at), lte(incident.proximo_paso_at, now)));
  let ran = 0;
  let failed = 0;
  for (const inc of due) {
    let claimed = false;
    try {
      if (!(await claimWait(deps.db, inc.id, now))) continue; // la respuesta del proveedor o otro barrido llegó antes
      claimed = true;
      await runProtocol(deps, { ...inc, proximo_paso_at: null }, { tipo: "vencimiento" });
      ran++;
    } catch (err) {
      failed++;
      console.error("incidencias: temporizador fallido", (err as Error).name);
      // Si el avance falló sin cambiar el protocolo, se devuelve la espera para que el próximo barrido reintente.
      if (claimed) {
        try { await restoreWait(deps.db, inc); } catch (e) { console.error("incidencias: no se pudo restaurar la espera", (e as Error).name); }
      }
    }
  }
  return { ran, failed };
}

// Escala primero (transición atómica) y solo la llamada ganadora registra el KPI y avisa al viajero.
export async function escalateOverdue(deps: RunnerDeps): Promise<number> {
  const now = deps.now();
  const rows = await deps.db.select().from(incident).where(and(
    inArray(incident.estado, ["clasificando", "protocolo"]), lt(incident.sla_vence, now), eq(incident.requiere_humano, false),
  ));
  let n = 0;
  for (const inc of rows) {
    try {
      const { row, escalated } = await escalateIncidentResult(deps, inc, "sla");
      if (!escalated) continue;
      n++;
      try {
        const t = await targetFromIncident(deps.db, inc);
        if (t) await sendTraveler(deps, t, row.id, ESCALATED_REPLY);
      } catch (err) {
        console.error("incidencias: aviso por SLA fallido", (err as Error).name);
      }
      try {
        await recordKpi(deps.db, "sla_incumplido", { ref_id: inc.id, datos: { urgencia: inc.urgencia } });
      } catch (err) {
        console.error("incidencias: KPI de SLA fallido", (err as Error).name);
      }
    } catch (err) {
      console.error("incidencias: escalado por SLA fallido", (err as Error).name);
    }
  }
  return n;
}

// Cierre en bloque: todas las transiciones de estos cuatro estados a "cerrado" están permitidas.
export async function closeStale(db: Db, now: Date): Promise<number> {
  const closed = await db.update(incident)
    .set({ estado: "cerrado", cerrado_at: now, proximo_paso_at: null })
    .where(and(
      inArray(incident.estado, ["identificando", "bienvenida", "conversacional", "seguimiento"]),
      isNotNull(incident.proximo_paso_at), lte(incident.proximo_paso_at, now),
    ))
    .returning({ id: incident.id });
  for (const { id } of closed) {
    try {
      await recordKpi(db, "incidencia_cerrada_inactividad", { ref_id: id });
    } catch (err) {
      console.error("incidencias: KPI de cierre fallido", (err as Error).name);
    }
  }
  return closed.length;
}
