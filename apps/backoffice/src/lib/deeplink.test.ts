import { describe, expect, it } from "vitest";
import { parseDeepLink } from "./deeplink";

const ID = "3f2b8c1e-0a4d-4c55-9a53-1f2e3d4c5b6a";

describe("parseDeepLink", () => {
  it("reconoce leads e incidencias", () => {
    expect(parseDeepLink(`/leads/${ID}`)).toEqual({ page: "leads", id: ID });
    expect(parseDeepLink(`/incidencias/${ID}/`)).toEqual({ page: "incidents", id: ID });
  });
  it("ignora rutas ajenas o mal formadas", () => {
    for (const p of ["/", "", "/leads", "/leads/", `/otra/${ID}`, `/leads/${ID}/extra`, "/leads/a%20b", "/leads/%E0%A4%A", "/leads/<x>"]) {
      expect(parseDeepLink(p)).toBeNull();
    }
  });
});
