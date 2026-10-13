import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const ROLES = ["viewer", "operator", "editor", "admin"] as const;
export type Role = (typeof ROLES)[number];
export type WorkflowRole = Exclude<Role, "admin">;

const RANK: Record<Role, number> = { viewer: 1, operator: 2, editor: 3, admin: 4 };

export function roleAtLeast(role: Role, required: Role): boolean {
  return RANK[role] >= RANK[required];
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/**
 * Effective permission on a workflow: admins can do everything; others get
 * the lower of their global role and their ACL entry (no entry = no access).
 */
export function effectiveWorkflowRole(user: AuthUser, aclRole: WorkflowRole | undefined): Role | undefined {
  if (user.role === "admin") return "admin";
  if (!aclRole) return undefined;
  return RANK[aclRole] <= RANK[user.role] ? aclRole : user.role;
}

/** Whether an assignee spec (`email` or `role:<role>`) designates the user. */
export function matchesAssignee(user: AuthUser, assignees: readonly string[]): boolean {
  return assignees.some((a) => {
    const spec = a.trim().toLowerCase();
    if (spec.startsWith("role:")) return spec.slice(5) === user.role;
    return spec === user.email.toLowerCase();
  });
}

// ------------------------------------------------------------------ passwords

const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 32 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, saltText, hashText] = stored.split("$");
  if (scheme !== "scrypt" || !n || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const actual = scryptSync(password, Buffer.from(saltText, "base64url"), expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ------------------------------------------------------------------ JWT (HS256)

export interface TokenClaims {
  sub: string;
  role: Role;
  email: string;
  iat: number;
  exp: number;
}

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");
const HEADER = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));

export function signToken(claims: Omit<TokenClaims, "iat" | "exp">, secret: string, ttlSeconds: number, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const payload = b64(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds }));
  const signature = createHmac("sha256", secret).update(`${HEADER}.${payload}`).digest("base64url");
  return `${HEADER}.${payload}.${signature}`;
}

export function verifyToken(token: string, secret: string, nowMs = Date.now()): TokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("malformed token");
  const [header, payload, signature] = parts as [string, string, string];
  if (header !== HEADER) throw new TokenError("unsupported token header");
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new TokenError("invalid signature");
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
  } catch {
    throw new TokenError("malformed payload");
  }
  if (typeof claims.sub !== "string" || typeof claims.exp !== "number" || !ROLES.includes(claims.role)) {
    throw new TokenError("invalid claims");
  }
  if (claims.exp * 1000 <= nowMs) throw new TokenError("token expired");
  return claims;
}

// ------------------------------------------------------------------ webhook signatures

export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Fixed-window rate limiter keyed by caller (IP, workflow...). */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns 0 when allowed, otherwise seconds until the window resets. */
  hit(key: string): number {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 10_000) this.prune(now);
    }
    w.count++;
    return w.count > this.limit ? Math.ceil((w.start + this.windowMs - now) / 1000) : 0;
  }

  private prune(now: number): void {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}
