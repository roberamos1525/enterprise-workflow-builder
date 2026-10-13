import { describe, expect, it } from "vitest";
import {
  effectiveWorkflowRole,
  hashPassword,
  matchesAssignee,
  RateLimiter,
  safeEqual,
  signToken,
  verifyPassword,
  verifyToken,
  webhookSignature,
  type AuthUser,
} from "./auth.js";
import { ConfigError, loadConfig } from "./config.js";
import { toErrorResponse, AppError } from "./errors.js";
import { EngineError } from "@ewb/engine";
import { z } from "zod";

const SECRET = "x".repeat(40);
const user = (role: AuthUser["role"], email = `${role}@example.com`): AuthUser => ({ id: role, email, name: role, role });

describe("JWT", () => {
  const now = Date.UTC(2026, 0, 1);

  it("round-trips claims and enforces expiry", () => {
    const token = signToken({ sub: "u1", role: "editor", email: "e@x" }, SECRET, 60, now);
    expect(verifyToken(token, SECRET, now + 59_000)).toMatchObject({ sub: "u1", role: "editor", exp: now / 1000 + 60 });
    expect(() => verifyToken(token, SECRET, now + 60_000)).toThrow(/expired/);
  });

  it("rejects tampering, wrong secrets and malformed tokens", () => {
    const token = signToken({ sub: "u1", role: "viewer", email: "v@x" }, SECRET, 60, now);
    const [h, p, s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "u1", role: "admin", email: "v@x", iat: 0, exp: 9e9 })).toString("base64url");
    expect(() => verifyToken(`${h}.${forged}.${s}`, SECRET, now)).toThrow(/signature/);
    expect(() => verifyToken(token, "y".repeat(40), now)).toThrow(/signature/);
    expect(() => verifyToken("a.b", SECRET, now)).toThrow(/malformed/);
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    expect(() => verifyToken(`${none}.${p}.`, SECRET, now)).toThrow(/header/);
  });
});

describe("passwords", () => {
  it("hashes with a random salt and verifies in constant time", () => {
    const a = hashPassword("correct horse");
    const b = hashPassword("correct horse");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse", a)).toBe(true);
    expect(verifyPassword("wrong horse", a)).toBe(false);
    expect(verifyPassword("x", "bcrypt$garbage")).toBe(false);
  });
});

describe("permissions", () => {
  it("caps ACL roles by the global role and lets admins through", () => {
    expect(effectiveWorkflowRole(user("admin"), undefined)).toBe("admin");
    expect(effectiveWorkflowRole(user("editor"), undefined)).toBeUndefined();
    expect(effectiveWorkflowRole(user("viewer"), "editor")).toBe("viewer");
    expect(effectiveWorkflowRole(user("editor"), "operator")).toBe("operator");
    expect(effectiveWorkflowRole(user("operator"), "operator")).toBe("operator");
  });

  it("matches assignees by email (case-insensitive) or role", () => {
    expect(matchesAssignee(user("operator", "Op@Example.com"), ["op@example.com"])).toBe(true);
    expect(matchesAssignee(user("operator"), ["role:operator"])).toBe(true);
    expect(matchesAssignee(user("viewer"), ["role:operator", "someone@x"])).toBe(false);
  });
});

describe("webhook signatures and rate limiting", () => {
  it("signs timestamp + body", () => {
    expect(webhookSignature("s", "1", "{}")).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(webhookSignature("s", "1", "{}")).not.toBe(webhookSignature("s", "2", "{}"));
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("limits per key within a fixed window", () => {
    let t = 0;
    const limiter = new RateLimiter(2, 60_000, () => t);
    expect([limiter.hit("a"), limiter.hit("a"), limiter.hit("b")]).toEqual([0, 0, 0]);
    expect(limiter.hit("a")).toBe(60);
    t = 30_000;
    expect(limiter.hit("a")).toBe(30);
    t = 60_000;
    expect(limiter.hit("a")).toBe(0);
  });
});

describe("config", () => {
  it("maps environment variables with defaults", () => {
    const config = loadConfig({ PORT: "5000", HTTP_ALLOW_LIST: "api.test, 10.0.0.0/8", HTTP_ALLOW_PRIVATE: "true", JWT_SECRET: SECRET });
    expect(config).toMatchObject({ port: 5000, httpAllowList: ["api.test", "10.0.0.0/8"], httpAllowPrivate: true, jwtSecretGenerated: false, bodyLimitBytes: 1024 * 1024 });
  });

  it("generates an ephemeral secret in development but requires one in production", () => {
    expect(loadConfig({}).jwtSecretGenerated).toBe(true);
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/JWT_SECRET is required/);
    expect(() => loadConfig({ JWT_SECRET: "short" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "99999" })).toThrow(/port/);
    expect(() => loadConfig({ EWB_CONFIG: "/definitely/missing.json" })).toThrow(/not found/);
  });
});

describe("error envelopes", () => {
  it("maps app, validation, engine and unknown errors", () => {
    expect(toErrorResponse(new AppError(409, "CONFLICT", "nope"), "r1")).toEqual({ status: 409, body: { error: { code: "CONFLICT", message: "nope", requestId: "r1" } } });
    const zod = z.object({ a: z.number() }).safeParse({ a: "x" });
    expect(toErrorResponse(zod.error).body.error.details).toEqual([{ path: "a", message: expect.any(String) }]);
    expect(toErrorResponse(new EngineError("NOT_WAITING", "x")).status).toBe(409);
    expect(toErrorResponse(new Error("secret internals"))).toEqual({ status: 500, body: { error: { code: "INTERNAL", message: "internal server error" } } });
  });
});

describe("config file", () => {
  it("loads camelCase keys from EWB_CONFIG with environment variables taking precedence", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "ewb-cfg-")), "config.json");
    writeFileSync(file, JSON.stringify({ port: 4555, httpAllowList: ["a.test"], logLevel: "debug" }));
    expect(loadConfig({ EWB_CONFIG: file })).toMatchObject({ port: 4555, httpAllowList: ["a.test"], logLevel: "debug" });
    expect(loadConfig({ EWB_CONFIG: file, PORT: "4666" }).port).toBe(4666);
    writeFileSync(file, "{ not json");
    expect(() => loadConfig({ EWB_CONFIG: file })).toThrow(/not valid JSON/);
  });
});
