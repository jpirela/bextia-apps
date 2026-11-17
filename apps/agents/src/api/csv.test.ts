import { describe, expect, it } from "vitest";
import { CsvError, parseCsv, toCsv } from "./csv.ts";

describe("parseCsv", () => {
  it("comillas, comillas escapadas, saltos dentro de campo, CRLF y BOM", () => {
    const text = '﻿a,b,c\r\n1,"dos, tres","con ""comillas"""\r\n"multi\nlínea",,x\n';
    expect(parseCsv(text)).toEqual([["a", "b", "c"], ["1", "dos, tres", 'con "comillas"'], ["multi\nlínea", "", "x"]]);
  });
  it("ignora la última línea vacía y falla con comilla abierta", () => {
    expect(parseCsv("a\n\n")).toEqual([["a"]]);
    expect(() => parseCsv('a\n"abierta')).toThrow(CsvError);
  });
});

describe("toCsv", () => {
  it("escapa y neutraliza fórmulas, salvo teléfonos E.164", () => {
    expect(toCsv([["a", 'b"c', "d,e"], ["=1+1", "+34600111222", "+34600", "-x", "@SUM", 3, null]]))
      .toBe('a,"b""c","d,e"\r\n\'=1+1,+34600111222,\'+34600,\'-x,\'@SUM,3,\r\n');
  });
});
