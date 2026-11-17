import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { contact, conversation, kpi_event, lead, message, sales_agent } from "../db/schema.ts";
import type { Mail, Mailer } from "../notify/mailer.ts";
import { hmacSha256Hex } from "../channels/errors.ts";
import { agentAvailable, deliverDue, deliverLead, workdayStarted } from "./delivery.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

function mailer(fail = false): Mailer & { sent: Mail[] } {
  const sent: Mail[] = [];
  return { sent, async send(m) { if (fail) throw new Error("smtp"); sent.push(m); return { messageId: `id-${sent.length}` }; } };
}

async function seed(n = 2) {
  const [ag] = await db.insert(sales_agent).values({ nombre: "Beto", email: "beto@bextia.test", zona_horaria: "Europe/Madrid" }).returning();
  const [c] = await db.insert(contact).values({ nombre: "Luz", email: "luz@example.com", telefono: "+34600111222" }).returning();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const [l] = await db.insert(lead).values({
      contact_id: c.id, estado: "asignado", sales_agent_id: ag.id, destino: `Destino ${i}`, score: 70, resumen_ia: `Resumen ${i}`,
      created_at: new Date("2026-11-09T22:00:00Z"),
    }).returning();
    ids.push(l.id);
  }
  return { ag, ids };
}

describe("workdayStarted", () => {
  it("lunes 08:30 Madrid sí; 07:30 no; sábado no", () => {
    expect(workdayStarted("Europe/Madrid", new Date("2026-11-09T07:30:00Z"))).toBe(true);
    expect(workdayStarted("Europe/Madrid", new Date("2026-11-09T06:30:00Z"))).toBe(false);
    expect(workdayStarted("Europe/Madrid", new Date("2026-11-14T09:00:00Z"))).toBe(false);
    expect(workdayStarted(null, new Date("2026-11-10T08:00:00Z"))).toBe(true);
  });

  it("respeta el fin de jornada: martes 21:00 Madrid no; 18:30 sí", () => {
    expect(workdayStarted("Europe/Madrid", new Date("2026-11-10T20:00:00Z"))).toBe(false);
    expect(workdayStarted("Europe/Madrid", new Date("2026-11-10T17:30:00Z"))).toBe(true);
  });
});

describe("deliverDue", () => {
  it("antes de la jornada no entrega", async () => {
    await seed();
    const m = mailer();
    expect(await deliverDue({ db, mailer: m, now: () => new Date("2026-11-10T05:00:00Z") })).toEqual({ delivered: 0, failed: 0 });
    expect(m.sent).toHaveLength(0);
  });

  it("al inicio de la jornada envía un resumen por comercial y marca entregado", async () => {
    const { ids } = await seed(2);
    const m = mailer();
    const now = new Date("2026-11-10T07:15:00Z");
    expect(await deliverDue({ db, mailer: m, now: () => now, backofficeUrl: "https://bo.test" })).toEqual({ delivered: 2, failed: 0 });
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]).toMatchObject({ to: "beto@bextia.test", subject: "BEXTIA · 2 leads nuevos" });
    expect(m.sent[0].text).toContain("Resumen 0");
    expect(m.sent[0].text).toContain(`https://bo.test/leads/${ids[1]}`);
    const rows = await db.select().from(lead);
    expect(rows.every((r) => r.estado === "entregado" && r.entregado_at?.getTime() === now.getTime())).toBe(true);
    expect(await db.select().from(kpi_event).where(eq(kpi_event.tipo, "lead_entregado"))).toHaveLength(2);
    expect(await deliverDue({ db, mailer: m, now: () => now })).toEqual({ delivered: 0, failed: 0 });
  });

  it("si el email falla, los leads siguen asignados", async () => {
    await seed(1);
    expect(await deliverDue({ db, mailer: mailer(true), now: () => new Date("2026-11-10T07:15:00Z") })).toEqual({ delivered: 0, failed: 1 });
    expect((await db.select().from(lead))[0].estado).toBe("asignado");
  });

  it("sin mailer no entrega (queda en la bandeja del backoffice)", async () => {
    await seed(1);
    expect(await deliverDue({ db, mailer: null, now: () => new Date("2026-11-10T07:15:00Z") })).toEqual({ delivered: 0, failed: 0 });
  });
});

describe("deliverDue: promoción de leads incompletos fuera de horario", () => {
  async function seedIncomplete(lastMsgAt: Date) {
    await db.insert(sales_agent).values({ nombre: "Beto", email: "beto@bextia.test", zona_horaria: "Europe/Madrid" });
    const [c] = await db.insert(contact).values({ email: "luz@example.com" }).returning();
    const [conv] = await db.insert(conversation).values({ contact_id: c.id, canal: "email" }).returning();
    await db.insert(message).values({ conversation_id: conv.id, canal: "email", direccion: "in", contenido: "Hola", external_id: "m1", created_at: lastMsgAt });
    const [l] = await db.insert(lead).values({
      contact_id: c.id, conversation_id: conv.id, estado: "respondido", fuera_de_horario: true, destino: "Japón",
      created_at: new Date("2026-11-09T22:00:00Z"),
    }).returning();
    return l;
  }

  it("lead incompleto inactivo se asigna, se marca revisar y se entrega al inicio de jornada", async () => {
    const l = await seedIncomplete(new Date("2026-11-09T22:00:00Z"));
    const m = mailer();
    expect(await deliverDue({ db, mailer: m, now: () => new Date("2026-11-10T07:05:00Z") })).toEqual({ delivered: 1, failed: 0 });
    const [row] = await db.select().from(lead).where(eq(lead.id, l.id));
    expect(row.estado).toBe("entregado");
    expect(row.requiere_humano).toBe(true);
    expect(m.sent[0].text).toContain("revisar");
  });

  it("un lead con actividad reciente (30 min) no se promueve", async () => {
    const now = new Date("2026-11-10T07:05:00Z");
    const l = await seedIncomplete(new Date(now.getTime() - 30 * 60_000));
    const m = mailer();
    expect(await deliverDue({ db, mailer: m, now: () => now })).toEqual({ delivered: 0, failed: 0 });
    const [row] = await db.select().from(lead).where(eq(lead.id, l.id));
    expect(row.estado).toBe("respondido");
  });
});

describe("deliverLead + webhook", () => {
  it("entrega inmediata y webhook firmado", async () => {
    const { ids } = await seed(1);
    const fetchMock = vi.fn(async () => new Response("ok"));
    const m = mailer();
    const ok = await deliverLead({ db, mailer: m, webhook: { url: "https://hook.test/leads", secret: "whs", fetch: fetchMock as unknown as typeof fetch } }, ids[0]);
    expect(ok).toBe(true);
    expect(m.sent[0].subject).toBe("BEXTIA · Nuevo lead: Destino 0 (score 70)");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hook.test/leads");
    const body = init.body as string;
    expect((init.headers as Record<string, string>)["x-bextia-signature"]).toBe(`sha256=${hmacSha256Hex("whs", body)}`);
    expect(JSON.parse(body)).toMatchObject({ event: "lead.entregado", lead: { id: ids[0], destino: "Destino 0", sales_agent_email: "beto@bextia.test" } });
  });

  it("un webhook caído no impide la entrega", async () => {
    const { ids } = await seed(1);
    const ok = await deliverLead({ db, mailer: mailer(), webhook: { url: "https://hook.test", secret: "s", fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch } }, ids[0]);
    expect(ok).toBe(true);
    expect(await db.select().from(kpi_event).where(eq(kpi_event.tipo, "webhook_fallido"))).toHaveLength(1);
  });
});

describe("agentAvailable (P19)", () => {
  const horario = { mon: [["09:00", "13:00"]], tue: [["09:00", "13:00"]] } as never;
  it("con horario propio: solo dentro de su franja y fuera de sus festivos", () => {
    const a = { zona_horaria: "America/Mexico_City", horario, festivos: ["2026-11-10"] };
    expect(agentAvailable(a, new Date("2026-11-09T16:00:00Z"))).toBe(true);   // lun 10:00 CDMX (mon)
    expect(agentAvailable(a, new Date("2026-11-09T20:00:00Z"))).toBe(false);  // lun 14:00 CDMX
    expect(agentAvailable(a, new Date("2026-11-10T16:00:00Z"))).toBe(false);  // mar (tue) festivo
  });
  it("sin horario: conserva la jornada por omisión del sp2", () => {
    const a = { zona_horaria: "Europe/Madrid", horario: null, festivos: [] };
    expect(agentAvailable(a, new Date("2026-11-09T09:30:00Z"))).toBe(true);   // 10:30 Madrid
    expect(agentAvailable(a, new Date("2026-11-09T05:00:00Z"))).toBe(false);  // 06:00 Madrid
  });
});