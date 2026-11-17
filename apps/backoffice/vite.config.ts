import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  resolve: {
    alias: {
      "lara/fluent": "krypton-ecosystem/lara/fluent",
      lara: "krypton-ecosystem/lara",
    },
  },
  plugins: [react()],
});
