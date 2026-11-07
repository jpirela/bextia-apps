import nodemailer from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import { createMailer } from "./mailer.ts";

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
