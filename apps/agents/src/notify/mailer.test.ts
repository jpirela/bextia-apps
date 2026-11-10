import nodemailer from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import { createMailer, isTransientSmtpError } from "./mailer.ts";

describe("createMailer", () => {
  it("envía con el remitente configurado", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const mailer = createMailer(transport, { from: "BEXTIA <no-reply@bextia.test>" });
    const res = await mailer.send({ to: "comercial@bextia.test", subject: "Nuevo lead", text: "Japón, 2 viajeros" });
    expect(res.messageId).toBeTruthy();
  });

  it("reintenta con backoff y termina enviando", async () => {
    const sendMail = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue({ messageId: "<ok@test>" });
    const sleep = vi.fn(async () => {});
    const mailer = createMailer({ sendMail } as never, { from: "a@b.test", attempts: 3, sleep });
    await expect(mailer.send({ to: "x@y.test", subject: "s", text: "t" })).resolves.toEqual({ messageId: "<ok@test>" });
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
  });

  it("lanza el último error tras agotar los intentos", async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error("auth failed"));
    const mailer = createMailer({ sendMail } as never, { from: "a@b.test", attempts: 2, sleep: async () => {} });
    await expect(mailer.send({ to: "x@y.test", subject: "s", text: "t" })).rejects.toThrow("auth failed");
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
});

describe("reintentos solo para errores transitorios (P11)", () => {
  it.each([
    [{ responseCode: 421 }, true], [{ responseCode: 451 }, true], [{ code: "ECONNECTION" }, true], [{ code: "ETIMEDOUT" }, true],
    [{ responseCode: 535 }, false], [{ responseCode: 550 }, false], [{ code: "EAUTH" }, false], [{ code: "EENVELOPE" }, false],
  ])("%j → transitorio=%s", (err, expected) => {
    expect(isTransientSmtpError(Object.assign(new Error("x"), err))).toBe(expected);
  });
  it("no reintenta un 535", async () => {
    const sendMail = vi.fn(async () => { throw Object.assign(new Error("auth"), { responseCode: 535 }); });
    const m = createMailer({ sendMail } as never, { from: "a@b.co", sleep: async () => {} });
    await expect(m.send({ to: "x@y.co", subject: "s", text: "t" })).rejects.toThrow("auth");
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
