import { describe, expect, it } from "vitest";
import { diffRows, toPayload, type Row, type Spec } from "./crud-diff";

const spec: Spec = {
  singular: "x", arrays: ["tags"], json: ["horario"], nullable: ["zona", "horario"],
  fields: [
    { field: "nombre", label: "Nombre", required: true },
    { field: "tags", label: "Tags" },
    { field: "zona", label: "Zona" },
    { field: "horario", label: "Horario" },
    { field: "idioma", label: "Idioma" },
  ],
  empty: () => ({}),
};
const a: Row = { id: "1", nombre: "A", tags: "x, y", zona: "", horario: "", idioma: "es" };

describe("diffRows", () => {
  it("alta, edición, baja y sin cambios", () => {
    const b: Row = { id: "2", nombre: "B" };
    expect(diffRows([a], [b, a])).toEqual({ op: "post", row: b });
    expect(diffRows([a], [{ ...a, nombre: "Z" }])).toEqual({ op: "patch", row: { ...a, nombre: "Z" } });
    expect(diffRows([a, { id: "2", nombre: "B" }], [a])).toEqual({ op: "delete", row: { id: "2", nombre: "B" } });
    expect(diffRows([a], [{ ...a }])).toEqual({ op: null, row: null });
  });
});

describe("toPayload", () => {
  it("array separado por comas, vacío es []", () => {
    expect(toPayload(spec, a, false).tags).toEqual(["x", "y"]);
    expect(toPayload(spec, { ...a, tags: "" }, false).tags).toEqual([]);
  });
  it("JSON válido se parsea e inválido lanza", () => {
    expect(toPayload(spec, { ...a, horario: '{"mon":[["09:00","18:00"]]}' }, false).horario).toEqual({ mon: [["09:00", "18:00"]] });
    expect(() => toPayload(spec, { ...a, horario: "{x" }, false)).toThrow(/JSON inválido/);
  });
  it("null solo en PATCH y solo en columnas anulables", () => {
    const p = toPayload(spec, { ...a, idioma: "" }, true);
    expect(p).toMatchObject({ zona: null, horario: null });
    expect(p).not.toHaveProperty("idioma");
    const q = toPayload(spec, { ...a, idioma: "" }, false);
    expect(q).not.toHaveProperty("zona");
    expect(q).not.toHaveProperty("horario");
    expect(q).not.toHaveProperty("idioma");
  });
});
