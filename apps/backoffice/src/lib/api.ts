// src/lib/api.ts
export class ApiError extends Error {
  constructor(public status: number, public body: unknown) { super(`HTTP ${status}`); this.name = "ApiError"; }
}

export interface ApiClient {
  get<T>(path: string, query?: Record<string, string | undefined>): Promise<T>;
  send<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown, contentType?: string): Promise<T>;
  download(path: string, query?: Record<string, string | undefined>): Promise<Blob>;
}

const trimBase = (b: string) => b.replace(/\/+$/, "");

async function errorBody(res: Response): Promise<unknown> {
  return (res.headers.get("content-type") ?? "").includes("json") ? res.json().catch(() => null) : res.text().catch(() => "");
}

// POST sin sesión (login/refresh) o con un token explícito (logout).
export async function postJson<T>(cfg: { baseUrl: string; fetch?: typeof fetch }, path: string, body?: unknown, token?: string): Promise<T | null> {
  const f = cfg.fetch ?? fetch;
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await f(`${trimBase(cfg.baseUrl)}${path}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new ApiError(res.status, await errorBody(res));
  if (res.status === 204) return null;
  return (await res.json()) as T;
}

export function createApiClient(opts: {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  onUnauthorized?: () => Promise<string | null>;
  fetch?: typeof fetch;
}): ApiClient {
  const base = trimBase(opts.baseUrl);
  const f = opts.fetch ?? fetch;
  const url = (path: string, query?: Record<string, string | undefined>) => {
    const qs = new URLSearchParams(Object.entries(query ?? {}).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== ""));
    const s = qs.toString();
    return `${base}${path}${s ? `?${s}` : ""}`;
  };
  async function call(method: string, u: string, body?: BodyInit, contentType?: string): Promise<Response> {
    const token = await opts.getToken();
    if (!token) throw new ApiError(401, { error: "unauthorized" });
    const attempt = (tk: string) => {
      const headers = new Headers({ authorization: `Bearer ${tk}` });
      if (contentType) headers.set("content-type", contentType);
      return f(u, { method, headers, body });
    };
    let res = await attempt(token);
    // Un solo reintento: el access token pudo vencer entre getToken() y la respuesta.
    if (res.status === 401 && opts.onUnauthorized) {
      const fresh = await opts.onUnauthorized();
      if (fresh) res = await attempt(fresh);
    }
    if (!res.ok) throw new ApiError(res.status, await errorBody(res));
    return res;
  }
  return {
    get: async (path, query) => (await call("GET", url(path, query))).json(),
    send: async (method, path, body, contentType = "application/json") => {
      const payload = body === undefined ? undefined : contentType === "application/json" ? JSON.stringify(body) : (body as BodyInit);
      return (await call(method, url(path), payload, body === undefined ? undefined : contentType)).json();
    },
    download: async (path, query) => (await call("GET", url(path, query))).blob(),
  };
}
