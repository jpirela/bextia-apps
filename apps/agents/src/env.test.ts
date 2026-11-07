import { describe, expect, it } from "vitest";
import { readEnv } from "./env.ts";

const base = { DATABASE_URL: "postgres://x", API_TOKEN: "t" };

describe("readEnv", () => {
  it("en producción exige CORS_ORIGINS", () => {
    expect(() => readEnv({ ...base, NODE_ENV: "production" })).toThrow("CORS_ORIGINS");
    expect(readEnv({ ...base, NODE_ENV: "production", CORS_ORIGINS: "https://a.com" }).corsOrigins).toEqual(["https://a.com"]);
  });

  it("exige DATABASE_URL y API_TOKEN", () => {
    expect(() => readEnv({})).toThrow("DATABASE_URL");
    expect(() => readEnv({ DATABASE_URL: "postgres://x" })).toThrow("API_TOKEN");
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
