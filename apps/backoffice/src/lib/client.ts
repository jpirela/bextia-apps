// src/lib/client.ts
import { createApiClient } from "./api";
import { createSession } from "./session";

const baseUrl = import.meta.env.VITE_API_URL;

export const session = createSession({ baseUrl });
export const api = createApiClient({
  baseUrl,
  getToken: () => session.getToken(),
  onUnauthorized: () => session.refresh(),
});
