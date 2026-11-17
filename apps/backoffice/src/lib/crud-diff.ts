export type Row = { id: string } & Record<string, unknown>;
export type ViewField = { field: string; label: string; control?: "text" | "number" | "email" | "select" | "textarea" | "switch"; options?: readonly string[]; required?: boolean; hint?: string; inTable?: boolean; numeric?: boolean };
export type Spec = {
  singular: string; gender?: "m" | "f"; fields: ViewField[];
  /** Campos array de texto: se editan como lista separada por comas. */
  arrays: string[];
  /** Campo objeto (horario semanal): se edita como JSON. */
  json: string[];
  /** Columnas que admiten null en la API: vacío = null al editar. */
  nullable: string[];
  empty: () => Record<string, unknown>;
};

// Fila de la API → fila de formulario (arrays y JSON como texto).
export const toForm = (spec: Spec, r: Row): Row => {
  const o: Row = { ...r };
  for (const k of spec.arrays) o[k] = Array.isArray(r[k]) ? (r[k] as string[]).join(", ") : "";
  for (const k of spec.json) o[k] = r[k] == null ? "" : JSON.stringify(r[k]);
  return o;
};

// Fila de formulario → cuerpo de la API.
export function toPayload(spec: Spec, r: Row, patch: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of spec.fields) {
    const k = f.field;
    let v = r[k];
    if (spec.arrays.includes(k)) v = String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    else if (spec.json.includes(k)) {
      const t = String(v ?? "").trim();
      if (t === "") v = null;
      else { try { v = JSON.parse(t); } catch { throw new Error(`${f.label}: JSON inválido`); } }
    } else if (v === "" || v === undefined) v = null;
    if (v === null && (!patch || !spec.nullable.includes(k))) continue; // null solo para vaciar una columna anulable al editar
    out[k] = v;
  }
  return out;
}

export type DiffOp = { op: "delete" | "post" | "patch"; row: Row } | { op: null; row: null };

// CrudManager es controlado: entrega la lista nueva; se compara con la anterior para saber qué llamar.
export function diffRows(prev: Row[], next: Row[]): DiffOp {
  const before = new Map(prev.map((r) => [r.id, r]));
  const nextIds = new Set(next.map((r) => r.id));
  const removed = prev.find((r) => !nextIds.has(r.id));
  if (removed) return { op: "delete", row: removed };
  const added = next.find((r) => !before.has(r.id));
  if (added) return { op: "post", row: added };
  const changed = next.find((r) => { const p = before.get(r.id); return p && JSON.stringify(p) !== JSON.stringify(r); });
  return changed ? { op: "patch", row: changed } : { op: null, row: null };
}
