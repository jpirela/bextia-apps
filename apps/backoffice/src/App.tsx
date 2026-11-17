// src/App.tsx
import { useEffect, useState } from "react";
import { Spinner } from "@fluentui/react-components";
import { session } from "./lib/client";
import type { Session } from "./lib/session";
import { Login } from "./pages/Login";
import { Shell } from "./Shell";
import { Dashboard } from "./pages/Dashboard";
import { Leads } from "./pages/Leads";
import { Incidents } from "./pages/Incidents";
import { Config } from "./pages/Config";
import { Import } from "./pages/Import";
import { Simulator } from "./pages/Simulator";
import { parseDeepLink } from "./lib/deeplink";

export function App() {
  const [current, setCurrent] = useState<Session | null | undefined>(undefined);
  // La ruta del enlace se lee una vez y se conserva hasta que el Shell la consume (tras el login).
  const [link] = useState(() => parseDeepLink(window.location.pathname));
  useEffect(() => {
    const off = session.subscribe(setCurrent);
    // restore es idempotente y unifica refresh concurrentes (StrictMode monta el efecto dos veces).
    session.restore().then(setCurrent, () => setCurrent(null));
    return off;
  }, []);
  if (current === undefined) return <Spinner label="Cargando" />;
  if (!current) return <Login />;
  return (
    <Shell key={current.role} role={current.role} email={current.email ?? ""} link={link} pages={{
      dashboard: () => <Dashboard />, leads: (id) => <Leads initialId={id} />, incidents: (id) => <Incidents initialId={id} />,
      config: () => <Config />, import: () => <Import />, simulator: () => <Simulator />,
    }} />
  );
}

