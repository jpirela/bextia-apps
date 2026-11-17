import { describe, expect, it } from "vitest";
import { isRole, navFor } from "./roles";

describe("roles", () => {
  it("isRole acepta solo los tres roles", () => {
    expect(isRole("operador")).toBe(true);
    expect(isRole("root")).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(isRole({ role: "admin" })).toBe(false);
  });
  it("navegación por rol", () => {
    expect(navFor("comercial").map((n) => n.key)).toEqual(["leads"]);
    expect(navFor("operador").map((n) => n.key)).toEqual(["incidents", "simulator"]);
    expect(navFor("admin").map((n) => n.key)).toEqual(["dashboard", "leads", "incidents", "config", "import", "simulator"]);
  });
});
