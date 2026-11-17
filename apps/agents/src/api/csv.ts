export class CsvError extends Error {
  constructor(public line: number) { super(`comilla sin cerrar desde la línea ${line}`); this.name = "CsvError"; }
}

export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let quoteStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") { quoted = true; quoteStart = line; }
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = ""; line++;
    } else field += ch;
  }
  if (quoted) throw new CsvError(quoteStart);
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  // Líneas totalmente vacías al final (p. ej. "a\n\n") no son filas.
  while (rows.length && rows.at(-1)!.length === 1 && rows.at(-1)![0] === "") rows.pop();
  return rows;
}

const FORMULA = /^[=+\-@\t\r]/;
const PHONE = /^\+\d{6,15}$/; // los teléfonos E.164 no son fórmulas: no se prefijan (M5)

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (typeof v === "string" && FORMULA.test(s) && !PHONE.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (rows: unknown[][]): string => rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
