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
  return (
    <Shell role={current.role} email={current.email ?? ""} pages={{
      dashboard: () => <Dashboard />, leads: () => <Leads />, incidents: () => <Incidents />,
      config: () => <Config />, import: () => <Import />, simulator: () => <Simulator />,
    }} />
  );
}

