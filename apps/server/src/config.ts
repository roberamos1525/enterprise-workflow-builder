import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const bool = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

const list = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean));

const ConfigSchema = z.object({
  env: z.enum(["development", "production", "test"]).default("development"),
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().min(0).max(65535).default(4000),
  databasePath: z.string().default("var/ewb.db"),
  jwtSecret: z.string().min(32, "JWT_SECRET must be at least 32 characters").optional(),
  jwtTtlSeconds: z.coerce.number().int().min(60).max(7 * 24 * 3600).default(8 * 3600),
  bodyLimitBytes: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(1024 * 1024),
  logLevel: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  webDist: z.string().optional(),
  publicBaseUrl: z.string().url().optional(),
  /** Hostnames (`api.example.com`, `*.corp.test`) or CIDRs the HTTP action may reach even if private. */
  httpAllowList: list.default([]),
  httpAllowPrivate: bool.default(false),
  httpMaxResponseBytes: z.coerce.number().int().min(1024).max(20 * 1024 * 1024).default(1024 * 1024),
  stepTimeoutMs: z.coerce.number().int().min(1000).max(3600_000).default(5 * 60_000),
  schedulerMisfire: z.enum(["skip", "fire_once"]).default("fire_once"),
  loginRateLimitPerMinute: z.coerce.number().int().min(1).max(1000).default(10),
  webhookRateLimitPerMinute: z.coerce.number().int().min(1).max(100_000).default(120),
});

export type AppConfig = Omit<z.infer<typeof ConfigSchema>, "jwtSecret"> & { jwtSecret: string; jwtSecretGenerated: boolean };

const ENV_MAP: Record<string, keyof z.input<typeof ConfigSchema>> = {
  NODE_ENV: "env",
  HOST: "host",
  PORT: "port",
  DATABASE_PATH: "databasePath",
  JWT_SECRET: "jwtSecret",
  JWT_TTL_SECONDS: "jwtTtlSeconds",
  BODY_LIMIT_BYTES: "bodyLimitBytes",
  LOG_LEVEL: "logLevel",
  WEB_DIST: "webDist",
  PUBLIC_BASE_URL: "publicBaseUrl",
  HTTP_ALLOW_LIST: "httpAllowList",
  HTTP_ALLOW_PRIVATE: "httpAllowPrivate",
  HTTP_MAX_RESPONSE_BYTES: "httpMaxResponseBytes",
  STEP_TIMEOUT_MS: "stepTimeoutMs",
  SCHEDULER_MISFIRE: "schedulerMisfire",
  LOGIN_RATE_LIMIT_PER_MINUTE: "loginRateLimitPerMinute",
  WEBHOOK_RATE_LIMIT_PER_MINUTE: "webhookRateLimitPerMinute",
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Configuration precedence: explicit overrides > environment variables >
 * JSON config file (EWB_CONFIG) > defaults.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<z.input<typeof ConfigSchema>> = {}): AppConfig {
  let fileValues: Record<string, unknown> = {};
  const file = env["EWB_CONFIG"];
  if (file) {
    if (!existsSync(file)) throw new ConfigError(`config file not found: ${file}`);
    try {
      fileValues = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(`config file ${file} is not valid JSON: ${(err as Error).message}`);
    }
  }
  const fromEnv: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(ENV_MAP)) {
    const value = env[name];
    if (value !== undefined && value !== "") fromEnv[key] = value;
  }
  const parsed = ConfigSchema.safeParse({ ...fileValues, ...fromEnv, ...overrides });
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`invalid configuration: ${details}`);
  }
  const config = parsed.data;
  if (!config.jwtSecret && config.env === "production") {
    throw new ConfigError("JWT_SECRET is required in production");
  }
  return {
    ...config,
    jwtSecret: config.jwtSecret ?? randomBytes(32).toString("hex"),
    jwtSecretGenerated: !config.jwtSecret,
  };
}
