/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the app is opened on a tenant host (for example http://acme.erp.localhost:5173) and the API is
// reached through the same origin. The proxy forwards the Host header, because the backend picks the tenant from it.
const backend = process.env.ERP_BACKEND_URL ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: false },
    },
  },
  build: { sourcemap: true, target: "es2022" },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    testTimeout: 15000,
    css: false,
  },
});
