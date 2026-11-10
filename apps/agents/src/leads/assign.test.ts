import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { contact, lead, sales_agent } from "../db/schema.ts";
import { assignSalesAgent } from "./assign.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

const agent = (nombre: string, over: Partial<typeof sales_agent.$inferInsert> = {}) =>
  db
    .insert(sales_agent)
    .values({ nombre, email: `${nombre.toLowerCase()}@bextia.test`, ...over })
    .returning()
    .then((r) => r[0]);

describe("assignSalesAgent", () => {
  it("prefiere al especialista en el destino (sin tildes ni mayúsculas)", async () => {
    await agent("Ana", { destinos: ["Perú"] });
    await agent("Beto", { destinos: ["japon"] });
    const a = await assignSalesAgent(db, { destino: "Japón y Corea", idioma: "es", mercado: "ES", tipo: null });
    expect(a?.nombre).toBe("Beto");
  });

  it("excluye a quien no habla el idioma del lead", async () => {
    await agent("Ana", { destinos: ["japon"], idiomas: ["en"] });
    await agent("Beto", { idiomas: ["es", "en"] });
    const a = await assignSalesAgent(db, { destino: "Japón", idioma: "es", mercado: null, tipo: null });
    expect(a?.nombre).toBe("Beto");
  });

  it("excluye inactivos y devuelve null si nadie es elegible", async () => {
    await agent("Ana", { activo: false });
    await agent("Beto", { mercados: ["MX"] });
    expect(await assignSalesAgent(db, { destino: null, idioma: null, mercado: "ES", tipo: null })).toBeNull();
  });

  it("desempata por menor carga de leads asignados", async () => {
    const ana = await agent("Ana");
    await agent("Beto");
    const [c] = await db.insert(contact).values({ email: "x@example.com" }).returning();
    await db.insert(lead).values({ contact_id: c.id, estado: "asignado", sales_agent_id: ana.id });
    const a = await assignSalesAgent(db, { destino: null, idioma: null, mercado: null, tipo: null });
    expect(a?.nombre).toBe("Beto");
  });

  it("suma el tipo de lead", async () => {
    await agent("Ana");
    await agent("Beto", { tipos_lead: ["luna_de_miel"] });
    const a = await assignSalesAgent(db, { destino: null, idioma: null, mercado: null, tipo: "luna_de_miel" });
    expect(a?.nombre).toBe("Beto");
  });
});
