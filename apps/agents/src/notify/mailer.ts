import nodemailer, { type Transporter } from "nodemailer";

export interface Mail { to: string; subject: string; text: string; html?: string }
export interface Mailer { send(mail: Mail): Promise<{ messageId: string }> }
// Mismas credenciales que el SMTP personalizado configurado en Supabase (Resend/Brevo).
export interface SmtpConfig { host: string; port: number; user: string; pass: string }

export function createSmtpTransport(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: { user: cfg.user, pass: cfg.pass },
  });
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createMailer(
  transport: Pick<Transporter, "sendMail">,
  opts: { from: string; attempts?: number; sleep?: (ms: number) => Promise<void> },
): Mailer {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  return {
    async send(mail) {
      let lastError: unknown;
      for (let i = 0; i < attempts; i++) {
        try {
          const info = await transport.sendMail({ from: opts.from, ...mail });
          return { messageId: String(info.messageId) };
        } catch (err) {
          lastError = err;
          if (i < attempts - 1) await sleep(500 * 2 ** i);
        }
      }
      throw lastError;
    },
  };
}
