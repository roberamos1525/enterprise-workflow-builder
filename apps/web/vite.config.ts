import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.API_URL ?? "http://127.0.0.1:4000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@ewb/engine": fileURLToPath(new URL("../../packages/engine/src/index.ts", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: { "/api": apiTarget },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 700,
  },
});
