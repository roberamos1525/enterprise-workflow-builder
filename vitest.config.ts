import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const engineSrc = fileURLToPath(new URL("./packages/engine/src/index.ts", import.meta.url));
const alias = { "@ewb/engine": engineSrc };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: "engine", include: ["packages/engine/src/**/*.test.ts"], environment: "node" },
      },
      {
        resolve: { alias },
        test: { name: "server", include: ["apps/server/src/**/*.test.ts"], environment: "node" },
      },
      {
        resolve: { alias },
        test: { name: "web", include: ["apps/web/src/**/*.test.{ts,tsx}"], environment: "node" },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
    ],
  },
});
