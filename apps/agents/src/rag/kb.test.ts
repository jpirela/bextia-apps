import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/test-db.ts";
import type { Db } from "../db/index.ts";
import { buildSearchQuery, createStaticKb } from "./kb.ts";
import { EMBEDDING_DIMS } from "./embedder.ts";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()));
afterEach(async () => close());

describe("kb", () => {
  it("la búsqueda ordena por distancia coseno pgvector y filtra idioma", () => {
    const vec = Array.from({ length: EMBEDDING_DIMS }, () => 0.01);
    const { sql, params } = buildSearchQuery(db, vec, { k: 3, idioma: "es" }).toSQL();
    expect(sql).toContain("<=>");
    expect(sql).toContain("::vector");
    expect(sql).toMatch(/limit \$\d+/i);
    expect(params).toContain("es");
  });
  it("createStaticKb devuelve los primeros k aciertos", async () => {
    const kb = createStaticKb([
      { id: "1", titulo: "Equipaje", contenido: "23 kg", similarity: 0.9 },
      { id: "2", titulo: "Visados", contenido: "Depende", similarity: 0.8 },
    ]);
    expect(await kb.search("equipaje", { k: 1 })).toHaveLength(1);
  });
});
