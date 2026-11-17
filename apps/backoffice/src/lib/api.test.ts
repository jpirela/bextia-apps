import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, postJson } from "./api";

const ok = (body: unknown, type = "application/json") => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": type } });
const unauthorized = () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
const headersOf = (f: ReturnType<typeof vi.fn>, i: number) => new Headers((f.mock.calls[i] as unknown as [string, RequestInit])[1].headers);

describe("createApiClient", () => {
  it("adjunta el bearer, arma la query y omite undefined", async () => {
    const f = vi.fn(async () => ok({ data: [] }));
    const api = createApiClient({ baseUrl: "https://api.test/", getToken: async () => "tk", fetch: f as never });
    await api.get("/api/leads", { estado: "nuevo", desde: undefined });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/api/leads?estado=nuevo");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tk");
  });
  it("errores como ApiError con status y cuerpo", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } }));
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "tk", fetch: f as never });
    await expect(api.send("PATCH", "/api/leads/x", { estado: "x" })).rejects.toMatchObject({ status: 403, body: { error: "forbidden" } });
    await expect(api.get("/api/me")).rejects.toBeInstanceOf(ApiError);
  });
  it("sin sesión no llama a la red", async () => {
    const f = vi.fn();
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => null, fetch: f as never });
    await expect(api.get("/api/me")).rejects.toMatchObject({ status: 401 });
    expect(f).not.toHaveBeenCalled();
  });
  it("send con text/csv manda el cuerpo tal cual", async () => {
    const f = vi.fn(async () => ok({ creadas: 1 }));
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "tk", fetch: f as never });
    await api.send("POST", "/api/import/bookings", "a,b\n1,2", "text/csv");
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe("a,b\n1,2");
    expect(new Headers(init.headers).get("content-type")).toBe("text/csv");
  });
});

describe("reintento ante 401", () => {
  it("refresca una vez y reintenta con el token nuevo y el mismo cuerpo", async () => {
    const f = vi.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok({ id: 1 }));
    const onUnauthorized = vi.fn(async () => "tk2");
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "tk1", onUnauthorized, fetch: f as never });
    expect(await api.send("PATCH", "/api/leads/x", { estado: "contactado" })).toEqual({ id: 1 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(headersOf(f, 0).get("authorization")).toBe("Bearer tk1");
    expect(headersOf(f, 1).get("authorization")).toBe("Bearer tk2");
    const bodies = f.mock.calls.map((c) => (c as unknown as [string, RequestInit])[1].body);
    expect(bodies[1]).toBe(bodies[0]);
  });
  it("un solo reintento: si vuelve 401, ApiError 401", async () => {
    const f = vi.fn(async () => unauthorized());
    const onUnauthorized = vi.fn(async () => "tk2");
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "tk1", onUnauthorized, fetch: f as never });
    await expect(api.get("/api/me")).rejects.toMatchObject({ status: 401 });
    expect(f).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
  it("si el refresh no da token, no reintenta", async () => {
    const f = vi.fn(async () => unauthorized());
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "tk1", onUnauthorized: async () => null, fetch: f as never });
    await expect(api.get("/api/me")).rejects.toMatchObject({ status: 401 });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("un 403 no dispara refresh", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } }));
    const onUnauthorized = vi.fn(async () => "tk2");
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "tk1", onUnauthorized, fetch: f as never });
    await expect(api.get("/api/config")).rejects.toMatchObject({ status: 403 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("postJson", () => {
  it("sin bearer salvo que se pase; 204 → null; error → ApiError", async () => {
    const f = vi.fn().mockResolvedValueOnce(ok({ a: 1 })).mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(unauthorized());
    const cfg = { baseUrl: "https://api.test/", fetch: f as never };
    expect(await postJson(cfg, "/api/auth/login", { email: "a@b.co", password: "x" })).toEqual({ a: 1 });
    expect(headersOf(f, 0).get("authorization")).toBeNull();
    expect(headersOf(f, 0).get("content-type")).toBe("application/json");
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://api.test/api/auth/login");
    expect(await postJson(cfg, "/api/auth/logout", undefined, "tk")).toBeNull();
    expect(headersOf(f, 1).get("authorization")).toBe("Bearer tk");
    await expect(postJson(cfg, "/api/auth/login", {})).rejects.toMatchObject({ status: 401, body: { error: "unauthorized" } });
  });
});

describe("respuestas sin cuerpo", () => {
  it("204 y cuerpo vacío devuelven null sin lanzar", async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response("", { status: 200 }));
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "tk", fetch: f as never });
    expect(await api.send("DELETE", "/api/x/1")).toBeNull();
    expect(await api.get("/api/y")).toBeNull();
  });
});
