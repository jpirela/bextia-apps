import { describe, expect, it } from "vitest";
import { readEnv } from "./env.ts";

const base = { DATABASE_URL: "postgres://x", SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon-test" };

describe("readEnv", () => {
  it("en producción exige CORS_ORIGINS", () => {
    expect(() => readEnv({ ...base, NODE_ENV: "production" })).toThrow("CORS_ORIGINS");
    expect(readEnv({ ...base, NODE_ENV: "production", CORS_ORIGINS: "https://a.com", ANTHROPIC_API_KEY: "k", WIDGET_TOKEN_SECRET: "x".repeat(32) }).corsOrigins).toEqual(["https://a.com"]);
  });

  it("exige DATABASE_URL; API_TOKEN ya no existe", () => {
    expect(() => readEnv({})).toThrow("DATABASE_URL");
    expect(readEnv(base)).not.toHaveProperty("apiToken");
  });

  it("SUPABASE_URL es obligatoria y https (JWKS del JWT y login)", () => {
    expect(() => readEnv({ ...base, SUPABASE_URL: undefined })).toThrow(/SUPABASE_URL/);
    expect(() => readEnv({ ...base, SUPABASE_URL: "http://x.supabase.co" })).toThrow(/SUPABASE_URL/);
    expect(() => readEnv({ ...base, SUPABASE_URL: "no es url" })).toThrow(/SUPABASE_URL/);
    expect(readEnv({ ...base, SUPABASE_URL: "https://x.supabase.co/" }).supabaseUrl).toBe("https://x.supabase.co");
  });

  it("SUPABASE_ANON_KEY es obligatoria (login del backoffice vía la API)", () => {
    expect(() => readEnv({ ...base, SUPABASE_ANON_KEY: undefined })).toThrow(/SUPABASE_ANON_KEY/);
    expect(() => readEnv({ ...base, SUPABASE_ANON_KEY: "  " })).toThrow(/SUPABASE_ANON_KEY/);
    expect(readEnv(base).supabaseAnonKey).toBe("anon-test");
  });

  it("IMPORT_TOKEN e IMPORT_EMAIL_SECRET son opcionales pero de al menos 32 caracteres", () => {
    expect(readEnv(base)).toMatchObject({ importToken: null, importEmailSecret: null });
    expect(() => readEnv({ ...base, IMPORT_TOKEN: "corto" })).toThrow(/IMPORT_TOKEN/);
    expect(() => readEnv({ ...base, IMPORT_EMAIL_SECRET: "corto" })).toThrow(/IMPORT_EMAIL_SECRET/);
    expect(readEnv({ ...base, IMPORT_TOKEN: "x".repeat(32) }).importToken).toBe("x".repeat(32));
  });

  it("embed usa SUPABASE_URL y solo se activa con EMBED_SECRET", () => {
    expect(readEnv(base).embed).toBeNull();
    expect(readEnv({ ...base, EMBED_SECRET: "e" }).embed).toEqual({ url: "https://x.supabase.co", secret: "e" });
  });

  it("aplica valores por defecto y deja canales opcionales apagados", () => {
    const env = readEnv(base);
    expect(env).toMatchObject({ port: 10000, defaultMarket: "ES", corsOrigins: [], simulatorEnabled: false });
    expect(env.whatsapp).toBeNull();
    expect(env.smtp).toBeNull();
  });

  it("activa WhatsApp y SMTP solo con todas sus variables", () => {
    const env = readEnv({
      ...base,
      WHATSAPP_APP_SECRET: "s", WHATSAPP_ACCESS_TOKEN: "a", WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_VERIFY_TOKEN: "v",
      SMTP_HOST: "smtp.resend.com", SMTP_PORT: "465", SMTP_USER: "resend", SMTP_PASS: "p", SMTP_FROM: "BEXTIA <no-reply@x.com>",
      CORS_ORIGINS: "https://a.com, https://b.com", SIMULATOR_ENABLED: "true",
    });
    expect(env.whatsapp).toEqual({ appSecret: "s", accessToken: "a", phoneNumberId: "1", verifyToken: "v" });
    expect(env.smtp).toEqual({ host: "smtp.resend.com", port: 465, user: "resend", pass: "p", from: "BEXTIA <no-reply@x.com>" });
    expect(env.corsOrigins).toEqual(["https://a.com", "https://b.com"]);
    expect(env.simulatorEnabled).toBe(true);
    expect(readEnv({ ...base, WHATSAPP_APP_SECRET: "s" }).whatsapp).toBeNull();
  });
});

describe("env agente 1", () => {
  it("ANTHROPIC_API_KEY obligatoria en producción", () => {
    expect(() => readEnv({ ...base, NODE_ENV: "production", CORS_ORIGINS: "https://bo.test" })).toThrow(/ANTHROPIC_API_KEY/);
  });
  it("opcionales en desarrollo y agrupados", () => {
    const e = readEnv({ ...base, SUPABASE_URL: "https://x.supabase.co", EMBED_SECRET: "s", LEADS_WEBHOOK_URL: "https://h" });
    expect(e.anthropicApiKey).toBeNull();
    expect(e.embed).toEqual({ url: "https://x.supabase.co", secret: "s" });
    expect(e.leadsWebhook).toBeNull(); // falta LEADS_WEBHOOK_SECRET
  });
  it("WIDGET_TOKEN_SECRET: obligatoria en producción y de al menos 32 caracteres", () => {
    const prod = { ...base, NODE_ENV: "production", CORS_ORIGINS: "https://a.com", ANTHROPIC_API_KEY: "k" };
    expect(() => readEnv(prod)).toThrow("WIDGET_TOKEN_SECRET");
    expect(() => readEnv({ ...prod, WIDGET_TOKEN_SECRET: "corto" })).toThrow("WIDGET_TOKEN_SECRET");
    expect(readEnv({ ...prod, WIDGET_TOKEN_SECRET: "x".repeat(32) }).widgetTokenSecret).toBe("x".repeat(32));
    expect(readEnv(base).widgetTokenSecret).toBeNull();
  });
  it("SCORING_RULES_JSON inválido falla al arrancar", () => {
    expect(() => readEnv({ ...base, SCORING_RULES_JSON: "{" })).toThrow(/SCORING_RULES_JSON/);
  });
});
