import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { z } from "zod";
import { TokenError, verifyToken, type AuthUser } from "./auth.js";
import { AppError, toErrorResponse, tooLarge, unauthorized } from "./errors.js";
import type { Logger, Metrics } from "./observability.js";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  requestId: string;
  ip: string;
  user: AuthUser;
  rawBody(): Promise<string>;
  /** Parses the JSON body and validates it against a zod schema. */
  body<T extends z.ZodType>(schema: T): Promise<z.infer<T>>;
}

export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {}
}

export const reply = (status: number, body: unknown, headers?: Record<string, string>) => new Reply(status, body, headers);

type Handler = (ctx: RequestContext) => unknown;

interface Route {
  method: string;
  pattern: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
  auth: boolean;
}

export interface RouterOptions {
  bodyLimit: number;
  jwtSecret: string;
  loadUser: (id: string) => AuthUser | undefined;
  logger: Logger;
  metrics: Metrics;
  webDist?: string | undefined;
  now: () => number;
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

export function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit) {
      reject(tooLarge(limit));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(tooLarge(limit));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Small dependency-free router with auth, JSON bodies, error envelopes, metrics and SPA hosting. */
export class Router {
  private readonly routes: Route[] = [];

  constructor(private readonly options: RouterOptions) {}

  add(method: string, pattern: string, handler: Handler, opts: { auth?: boolean } = {}): void {
    const keys: string[] = [];
    const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:(\w+)/g, (_, key: string) => {
      keys.push(key);
      return "([^/]+)";
    });
    this.routes.push({ method, pattern, regex: new RegExp(`^${source}$`), keys, handler, auth: opts.auth ?? true });
  }

  get = (p: string, h: Handler, o?: { auth?: boolean }) => this.add("GET", p, h, o);
  post = (p: string, h: Handler, o?: { auth?: boolean }) => this.add("POST", p, h, o);
  put = (p: string, h: Handler, o?: { auth?: boolean }) => this.add("PUT", p, h, o);
  patch = (p: string, h: Handler, o?: { auth?: boolean }) => this.add("PATCH", p, h, o);
  delete = (p: string, h: Handler, o?: { auth?: boolean }) => this.add("DELETE", p, h, o);

  private authenticate(req: IncomingMessage): AuthUser {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    let claims;
    try {
      claims = verifyToken(header.slice(7), this.options.jwtSecret, this.options.now());
    } catch (err) {
      throw unauthorized(err instanceof TokenError ? err.message : "invalid token");
    }
    const user = this.options.loadUser(claims.sub);
    if (!user) throw unauthorized("account is disabled or no longer exists");
    return user;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const requestId = (req.headers["x-request-id"] as string | undefined)?.slice(0, 64) || randomUUID();
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    let routeLabel = "unmatched";
    res.setHeader("x-request-id", requestId);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      let matched: { route: Route; params: Record<string, string> } | undefined;
      let methodMismatch = false;
      for (const route of this.routes) {
        const m = route.regex.exec(url.pathname);
        if (!m) continue;
        if (route.method !== method) {
          methodMismatch = true;
          continue;
        }
        const params: Record<string, string> = {};
        route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? "")));
        matched = { route, params };
        break;
      }
      if (!matched) {
        if (method === "GET" && !url.pathname.startsWith("/api/") && this.serveStatic(url.pathname, res)) {
          routeLabel = "static";
          return;
        }
        throw methodMismatch ? new AppError(405, "METHOD_NOT_ALLOWED", `${method} not allowed`) : new AppError(404, "NOT_FOUND", "route not found");
      }
      routeLabel = matched.route.pattern;
      const user = matched.route.auth ? this.authenticate(req) : (undefined as unknown as AuthUser);
      let raw: Promise<string> | undefined;
      const rawBody = () => (raw ??= readBody(req, this.options.bodyLimit));
      const ctx: RequestContext = {
        req,
        res,
        params: matched.params,
        query: url.searchParams,
        requestId,
        ip: req.socket.remoteAddress ?? "unknown",
        user,
        rawBody,
        body: async (schema) => {
          const text = await rawBody();
          const type = req.headers["content-type"] ?? "";
          if (text !== "" && !type.includes("application/json")) {
            throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "expected application/json");
          }
          let parsed: unknown = {};
          if (text !== "") {
            try {
              parsed = JSON.parse(text);
            } catch {
              throw new AppError(400, "BAD_REQUEST", "malformed JSON body");
            }
          }
          return schema.parse(parsed);
        },
      };
      const result = await matched.route.handler(ctx);
      if (res.headersSent) return;
      if (result instanceof Reply) this.send(res, result.status, result.body, result.headers);
      else this.send(res, result === undefined ? 204 : 200, result);
    } catch (err) {
      const { status, body } = toErrorResponse(err, requestId);
      if (status >= 500) this.options.logger.error("request failed", { requestId, path: url.pathname, error: (err as Error).stack ?? String(err) });
      if (!res.headersSent) {
        const headers: Record<string, string> = {};
        const retry = (err as AppError).details as { retryAfterSeconds?: number } | undefined;
        if (status === 429 && retry?.retryAfterSeconds) headers["retry-after"] = String(retry.retryAfterSeconds);
        this.send(res, status, body, headers);
      } else res.end();
    } finally {
      const ms = performance.now() - started;
      this.options.metrics.httpRequests.inc({ method, route: routeLabel, status: String(res.statusCode) });
      this.options.metrics.httpDuration.observe(ms, { route: routeLabel });
      this.options.logger.debug("request", { requestId, method, path: url.pathname, status: res.statusCode, ms: Math.round(ms) });
    }
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const isText = typeof body === "string";
    const payload = status === 204 ? "" : isText ? body : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": headers["content-type"] ?? (isText ? "text/plain; charset=utf-8" : "application/json; charset=utf-8"),
      "cache-control": "no-store",
      ...headers,
    });
    res.end(payload);
  }

  /** Serves the built SPA with path-traversal protection and index.html fallback. */
  private serveStatic(pathname: string, res: ServerResponse): boolean {
    const root = this.options.webDist ? resolve(this.options.webDist) : undefined;
    if (!root || !existsSync(root)) return false;
    let file = resolve(join(root, normalize(decodeURIComponent(pathname))));
    if (file !== root && !file.startsWith(root + sep)) return false;
    if (!existsSync(file) || !statSync(file).isFile()) file = join(root, "index.html");
    if (!existsSync(file)) return false;
    const isHtml = extname(file) === ".html";
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
      ...(isHtml
        ? { "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" }
        : {}),
    });
    createReadStream(file).pipe(res);
    return true;
  }
}
