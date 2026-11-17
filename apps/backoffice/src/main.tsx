import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LaraProvider } from "krypton-ecosystem/lara/fluent";
import { App } from "./App";
import { themeCatalog } from "./theme";

// LaraProvider ya envuelve a FluentProvider con el tema del catálogo.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LaraProvider catalog={themeCatalog}>
      <App />
    </LaraProvider>
  </StrictMode>,
);
