// src/lib/roles.ts
export type Role = "admin" | "comercial" | "operador";
const ROLES: Role[] = ["admin", "comercial", "operador"];

// El rol lo decide la API (app_metadata en Supabase); aquí solo se valida la forma.
export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as string[]).includes(v);

export const NAV: { key: string; label: string; roles: Role[] }[] = [
  { key: "dashboard", label: "Indicadores", roles: ["admin"] },
  { key: "leads", label: "Leads", roles: ["admin", "comercial"] },
  { key: "incidents", label: "Incidencias", roles: ["admin", "operador"] },
  { key: "config", label: "Configuración", roles: ["admin"] },
  { key: "import", label: "Importar reservas", roles: ["admin"] },
  { key: "simulator", label: "Simulador", roles: ["admin", "operador"] },
];

export const navFor = (role: Role) => NAV.filter((n) => n.roles.includes(role));
