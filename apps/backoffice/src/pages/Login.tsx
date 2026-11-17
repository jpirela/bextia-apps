// src/pages/Login.tsx
import { useState } from "react";
import { Button, Field, Input, MessageBar, Title2 } from "@fluentui/react-components";
import { session } from "../lib/client";
import { loginErrorMessage } from "../lib/session";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      // POST /api/auth/login vía postJson de api.ts; App reacciona por la suscripción a la sesión.
      await session.login(email.trim(), password);
    } catch (err) {
      setPassword("");
      setError(loginErrorMessage(err)); // genérico: no revela si el email existe
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} style={{ maxWidth: 360, margin: "15vh auto", display: "grid", gap: 16 }}>
      <Title2>BEXTIA · Backoffice</Title2>
      {error && <MessageBar intent="error">{error}</MessageBar>}
      <Field label="Email" required><Input type="email" autoComplete="username" value={email} onChange={(_, d) => setEmail(d.value)} /></Field>
      <Field label="Contraseña" required><Input type="password" autoComplete="current-password" value={password} onChange={(_, d) => setPassword(d.value)} /></Field>
      <Button appearance="primary" type="submit" disabled={busy}>Entrar</Button>
    </form>
  );
}
