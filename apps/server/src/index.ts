#!/usr/bin/env node
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  const app = createApp(config);
  if (config.jwtSecretGenerated) app.logger.warn("JWT_SECRET not set; using an ephemeral secret (tokens reset on restart)");
  if (app.users.count() === 0) app.logger.warn("no users exist yet; run `npm run cli -- seed` or `create-user`");
  await app.start();
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.logger.info("shutting down", { signal });
    app.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        app.logger.error("shutdown failed", { error: String(err) });
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
