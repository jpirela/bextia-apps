import { createHmac, timingSafeEqual } from "node:crypto";

export class SignatureError extends Error {
  constructor(message = "firma inválida") { super(message); this.name = "SignatureError"; }
}

export class InvalidPayloadError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidPayloadError"; }
}

export class MissingContactError extends InvalidPayloadError {
  constructor() { super("Mensaje sin identificador de contacto"); this.name = "MissingContactError"; }
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function hmacSha256Hex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}
