import { useEffect, useState } from "react";
import { Button, Field, Input, MessageBar, Textarea } from "@fluentui/react-components";
import { DataView } from "krypton-ecosystem/lara/fluent";
import { api, session } from "../lib/client";
import { ApiError } from "../lib/api";

type OutboxItem = { channel: string; to: { email?: string; phone?: string }; text: string };
type Notice = { intent: "error" | "success" | "info"; text: string };

export function Simulator() {
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", text: "" });
  // La API (ruling P12) deja inyectar mensajes solo al admin; el operador solo lee la bandeja.
  const canSend = session.current()?.role === "admin";

  useEffect(() => {
    let stopped = false;
    const tick = () => api.get<OutboxItem[]>("/api/sim/outbox")
      .then((r) => { if (!stopped) { setOutbox(r ?? []); setLoadError(null); } })
      .catch((e) => {
        if (stopped) return;
        if (e instanceof ApiError && e.status === 404) { setDisabled(true); stopped = true; return; }
        setLoadError(e instanceof ApiError ? `Error ${e.status}` : "Error de red");
      });
    void tick();
    const h = setInterval(() => { void tick(); }, 3000);
    return () => { stopped = true; clearInterval(h); };
  }, []);

  const set = (k: keyof typeof form) => (_: unknown, d: { value: string }) => setForm((f) => ({ ...f, [k]: d.value }));
  const valid = form.text.trim() !== "" && (form.email.trim() !== "" || form.phone.trim() !== "");

  const send = async () => {
    const body: Record<string, string> = { messageId: crypto.randomUUID(), text: form.text };
    for (const k of ["name", "email", "phone"] as const) if (form[k].trim()) body[k] = form[k].trim();
    try {
      await api.send("POST", "/api/sim/send", body);
      setNotice({ intent: "success", text: "Mensaje enviado" });
      setForm((f) => ({ ...f, text: "" }));
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 400 ? "Datos inválidos: revisa el email o el teléfono"
        : e instanceof ApiError && e.status === 403 ? "No tienes permiso para enviar mensajes"
        : e instanceof ApiError && e.status === 404 ? "El simulador está desactivado en este entorno"
        : e instanceof ApiError ? `Error ${e.status}` : "Error de red";
      setNotice({ intent: "error", text: msg });
    }
  };

  if (disabled) return <MessageBar intent="info">El simulador está desactivado en este entorno</MessageBar>;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {loadError && <MessageBar intent="error">{loadError}</MessageBar>}
      {notice && <MessageBar intent={notice.intent}>{notice.text}</MessageBar>}
      {canSend && (
        <div style={{ display: "grid", gap: 8, maxWidth: 520 }}>
          <Field label="Nombre"><Input value={form.name} onChange={set("name")} /></Field>
          <Field label="Email"><Input type="email" value={form.email} onChange={set("email")} /></Field>
          <Field label="Teléfono" hint="Email o teléfono: al menos uno"><Input value={form.phone} onChange={set("phone")} /></Field>
          <Field label="Mensaje" required><Textarea value={form.text} onChange={set("text")} /></Field>
          <div><Button appearance="primary" disabled={!valid} onClick={() => void send()}>Enviar</Button></div>
        </div>
      )}
      <DataView
        title="Bandeja de salida"
        rows={outbox.map((o, i) => ({ ...o, id: String(i) }))}
        getKey={(o) => o.id}
        columns={[
          { key: "channel", label: "Canal" },
          { key: "to", label: "Destino", render: (o) => o.to.email ?? o.to.phone ?? "—" },
          { key: "text", label: "Texto" },
        ]}
      />
    </div>
  );
}
