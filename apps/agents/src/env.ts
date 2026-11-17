import { DEFAULT_SCORING, parseScoringRules, type ScoringRules } from "./leads/scoring.ts";

type Source = Record<string, string | undefined>;

export interface Env {
  databaseUrl: string;
  supabaseUrl: string;      // JWKS del JWT y Supabase Auth REST (login del backoffice)
  supabaseAnonKey: string;  // clave publicable: solo la usa la API
  port: number;
  defaultMarket: string;
  corsOrigins: string[];
  simulatorEnabled: boolean;
  emailWebhookSecret: string | null;
  formWebhookSecret: string | null;
  whatsapp: { appSecret: string; accessToken: string; phoneNumberId: string; verifyToken: string } | null;
  smtp: { host: string; port: number; user: string; pass: string; from: string } | null;
  anthropicApiKey: string | null;
  embed: { url: string; secret: string } | null;
  leadsWebhook: { url: string; secret: string } | null;
  backofficeUrl: string | null;
  scoringRules: ScoringRules;
  widgetTokenSecret: string | null;
  importToken: string | null;       // POST /api/import/bookings; vacío desactiva la ruta
  importEmailSecret: string | null; // POST /api/import/email; vacío desactiva la ruta
}

function required(src: Source, key: string): string {
  const v = src[key]?.trim();
  if (!v) throw new Error(`Falta la variable de entorno ${key}`);
  return v;
}

// El JWKS y las credenciales del login viajan por esta URL: solo https.
function httpsUrl(src: Source, key: string): string {
  const v = required(src, key);
  let u: URL;
  try { u = new URL(v); } catch { throw new Error(`${key} no es una URL válida`); }
  if (u.protocol !== "https:") throw new Error(`${key} debe ser https`);
  return v.replace(/\/+$/, "");
}

function allOrNull<K extends string>(src: Source, keys: readonly K[]): Record<K, string> | null {
  const values = keys.map((k) => src[k]?.trim());
  if (values.some((v) => !v)) return null;
  return Object.fromEntries(keys.map((k, i) => [k, values[i] as string])) as Record<K, string>;
}

function widgetSecret(src: Source, prod: boolean): string | null {
  const v = src.WIDGET_TOKEN_SECRET?.trim() || null;
  if (prod && !v) throw new Error("Falta la variable de entorno WIDGET_TOKEN_SECRET (mínimo 32 caracteres)");
  if (v && v.length < 32) throw new Error("WIDGET_TOKEN_SECRET debe tener al menos 32 caracteres");
  return v;
}

function optionalSecret(src: Source, key: string, min: number): string | null {
  const v = src[key]?.trim() || null;
  if (v && v.length < min) throw new Error(`${key} debe tener al menos ${min} caracteres`);
  return v;
}

export function readEnv(src: Source): Env {
  const wa = allOrNull(src, ["WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN"] as const);
  const smtp = allOrNull(src, ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const);
  const databaseUrl = required(src, "DATABASE_URL");
  const supabaseUrl = httpsUrl(src, "SUPABASE_URL");
  const embedSecret = src.EMBED_SECRET?.trim() || null;
  const hook = allOrNull(src, ["LEADS_WEBHOOK_URL", "LEADS_WEBHOOK_SECRET"] as const);
  const prod = src.NODE_ENV === "production";
  return {
    databaseUrl,
    supabaseUrl,
    supabaseAnonKey: required(src, "SUPABASE_ANON_KEY"),
    port: Number(src.PORT ?? 10000),
    defaultMarket: src.DEFAULT_MARKET?.trim() || "ES",
    corsOrigins: (prod ? required(src, "CORS_ORIGINS") : src.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    simulatorEnabled: src.SIMULATOR_ENABLED === "true",
    emailWebhookSecret: src.EMAIL_WEBHOOK_SECRET?.trim() || null,
    formWebhookSecret: src.FORM_WEBHOOK_SECRET?.trim() || null,
    whatsapp: wa && {
      appSecret: wa.WHATSAPP_APP_SECRET, accessToken: wa.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: wa.WHATSAPP_PHONE_NUMBER_ID, verifyToken: wa.WHATSAPP_VERIFY_TOKEN,
    },
    smtp: smtp && {
      host: smtp.SMTP_HOST, port: Number(smtp.SMTP_PORT), user: smtp.SMTP_USER, pass: smtp.SMTP_PASS, from: smtp.SMTP_FROM,
    },
    anthropicApiKey: prod ? required(src, "ANTHROPIC_API_KEY") : src.ANTHROPIC_API_KEY?.trim() || null,
    widgetTokenSecret: widgetSecret(src, prod),
    importToken: optionalSecret(src, "IMPORT_TOKEN", 32),
    importEmailSecret: optionalSecret(src, "IMPORT_EMAIL_SECRET", 32),
    embed: embedSecret ? { url: supabaseUrl, secret: embedSecret } : null,
    leadsWebhook: hook && { url: hook.LEADS_WEBHOOK_URL, secret: hook.LEADS_WEBHOOK_SECRET },
    backofficeUrl: src.BACKOFFICE_URL?.trim() || null,
    scoringRules: src.SCORING_RULES_JSON?.trim() ? parseScoringRules(src.SCORING_RULES_JSON) : DEFAULT_SCORING,
  };
}
