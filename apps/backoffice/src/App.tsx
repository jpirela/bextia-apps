// src/App.tsx
import { useEffect, useState } from "react";
import { Spinner } from "@fluentui/react-components";
import { session } from "./lib/client";
import type { Session } from "./lib/session";
import { Login } from "./pages/Login";

export function App() {
  const [current, setCurrent] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    const off = session.subscribe(setCurrent);
    // restore es idempotente y unifica refresh concurrentes (StrictMode monta el efecto dos veces).
    session.restore().then(setCurrent, () => setCurrent(null));
    return off;
  }, []);
  if (current === undefined) return <Spinner label="Cargando" />;
  if (!current) return <Login />;
  return <div data-role={current.role}>Sesión iniciada como {current.role}</div>; // la Task 12 reemplaza esto por el Shell
}
