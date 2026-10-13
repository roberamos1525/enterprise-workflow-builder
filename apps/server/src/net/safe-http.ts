import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { HttpClient, HttpRequest, HttpResponse } from "@ewb/engine";

export class SafeHttpError extends Error {
  constructor(
    readonly code: "SSRF_BLOCKED" | "INVALID_URL" | "RESPONSE_TOO_LARGE" | "TOO_MANY_REDIRECTS" | "NETWORK",
    message: string,
  ) {
    super(message);
    this.name = "SafeHttpError";
  }
}

// ------------------------------------------------------------------ IP math

interface Cidr {
  family: 4 | 6;
  base: bigint;
  bits: number;
}

function parseV4(ip: string): bigint {
  return ip.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

function parseV6(ip: string): bigint {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // Embedded IPv4 tail, e.g. ::ffff:127.0.0.1
  const v4Match = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4Match?.[1]) {
    const v4 = parseV4(v4Match[1]);
    text = `${text.slice(0, -v4Match[1].length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const groups = tail !== undefined ? [...headParts, ...Array<string>(missing).fill("0"), ...tailParts] : headParts;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || "0", 16)), 0n);
}

export function parseCidr(text: string): Cidr {
  const [addr = "", bitsText] = text.trim().split("/");
  const family = isIP(addr);
  if (family === 0) throw new Error(`invalid CIDR '${text}'`);
  const max = family === 4 ? 32 : 128;
  const bits = bitsText === undefined ? max : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`invalid prefix in '${text}'`);
  return { family: family as 4 | 6, base: family === 4 ? parseV4(addr) : parseV6(addr), bits };
}

export function inCidr(ip: string, cidr: Cidr): boolean {
  const family = isIP(ip);
  if (family !== cidr.family) return false;
  const value = family === 4 ? parseV4(ip) : parseV6(ip);
  const width = BigInt(family === 4 ? 32 : 128);
  const shift = width - BigInt(cidr.bits);
  return value >> shift === cidr.base >> shift;
}

const BLOCKED = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
  "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
  "::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8", "64:ff9b::/96", "2001:db8::/32",
].map(parseCidr);

/** Returns the IPv4 address embedded in an IPv4-mapped/compatible IPv6 address. */
function embeddedV4(ip: string): string | undefined {
  if (isIP(ip) !== 6) return undefined;
  const value = parseV6(ip);
  if (value >> 32n === 0xffffn || (value >> 32n === 0n && value > 1n)) {
    const v4 = Number(value & 0xffffffffn);
    return [v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join(".");
  }
  return undefined;
}

export function isPrivateAddress(ip: string): boolean {
  const mapped = embeddedV4(ip);
  if (mapped) return isPrivateAddress(mapped);
  return BLOCKED.some((c) => inCidr(ip, c));
}

// ------------------------------------------------------------------ policy

export interface EgressPolicyOptions {
  /** Hostnames (`api.test`, `*.corp.test`), IPs or CIDRs that bypass the private-range block. */
  allowList: string[];
  allowPrivate: boolean;
}

export class EgressPolicy {
  private readonly hosts: string[] = [];
  private readonly cidrs: Cidr[] = [];

  constructor(private readonly options: EgressPolicyOptions) {
    for (const entry of options.allowList) {
      const e = entry.trim().toLowerCase();
      if (isIP(e.split("/")[0] ?? "") !== 0) this.cidrs.push(parseCidr(e));
      else if (e) this.hosts.push(e);
    }
  }

  hostAllowed(hostname: string): boolean {
    const h = hostname.toLowerCase();
    return this.hosts.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p));
  }

  /** Throws SSRF_BLOCKED unless every resolved address is acceptable. */
  check(hostname: string, addresses: string[]): void {
    if (this.options.allowPrivate || this.hostAllowed(hostname)) return;
    for (const address of addresses) {
      if (this.cidrs.some((c) => inCidr(address, c))) continue;
      if (isPrivateAddress(address)) {
        throw new SafeHttpError("SSRF_BLOCKED", `destination ${hostname} resolves to a blocked address (${address})`);
      }
    }
  }
}

// ------------------------------------------------------------------ client

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface SafeHttpOptions extends EgressPolicyOptions {
  maxResponseBytes: number;
  maxRedirects?: number;
  resolver?: Resolver;
}

const STRIPPED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade", "proxy-authorization"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * HTTP client for workflow actions. Destinations are resolved up front and
 * vetted against the egress policy; the vetted address is then pinned for the
 * connection (so DNS rebinding cannot swap it) and every redirect hop is
 * re-validated.
 */
export class SafeHttpClient implements HttpClient {
  private readonly policy: EgressPolicy;
  private readonly resolver: Resolver;

  constructor(private readonly options: SafeHttpOptions) {
    this.policy = new EgressPolicy(options);
    this.resolver = options.resolver ?? ((host) => dnsLookup(host, { all: true, verbatim: true }));
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    let url = this.parseUrl(req.url);
    let method = req.method.toUpperCase();
    let body = req.body;
    for (let hop = 0; ; hop++) {
      const response = await this.send(url, method, req.headers, body, req.signal);
      const location = response.headers["location"];
      if (!REDIRECTS.has(response.status) || !location) return response;
      if (hop >= (this.options.maxRedirects ?? 3)) throw new SafeHttpError("TOO_MANY_REDIRECTS", "too many redirects");
      url = this.parseUrl(new URL(location, url).toString());
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
    }
  }

  private parseUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new SafeHttpError("INVALID_URL", `invalid URL '${raw}'`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new SafeHttpError("INVALID_URL", `unsupported protocol ${url.protocol}`);
    }
    if (url.username || url.password) throw new SafeHttpError("INVALID_URL", "credentials in URLs are not allowed");
    return url;
  }

  private async resolve(url: URL): Promise<{ address: string; family: number }> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const literal = isIP(hostname);
    const addresses = literal ? [{ address: hostname, family: literal }] : await this.resolver(hostname);
    if (addresses.length === 0) throw new SafeHttpError("NETWORK", `could not resolve ${hostname}`);
    this.policy.check(hostname, addresses.map((a) => a.address));
    return addresses[0] as { address: string; family: number };
  }

  private async send(url: URL, method: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal): Promise<HttpResponse> {
    const pinned = await this.resolve(url);
    const lookup: LookupFunction = (_host, options, callback) => {
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned]);
      } else callback(null, pinned.address, pinned.family);
    };
    const outgoing: Record<string, string> = { "user-agent": "enterprise-workflow-builder/0.1" };
    for (const [k, v] of Object.entries(headers)) if (!STRIPPED_HEADERS.has(k.toLowerCase())) outgoing[k.toLowerCase()] = v;
    if (body !== undefined) outgoing["content-length"] = String(Buffer.byteLength(body));
    const transport = url.protocol === "https:" ? https : http;
    const max = this.options.maxResponseBytes;

    return new Promise<HttpResponse>((resolve, reject) => {
      const request = transport.request(url, { method, headers: outgoing, lookup, signal }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > max) {
            res.destroy();
            reject(new SafeHttpError("RESPONSE_TOO_LARGE", `response exceeds ${max} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) flat[k] = Array.isArray(v) ? v.join(", ") : v;
          resolve({ status: res.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      });
      request.on("error", (err) => reject(signal.aborted ? (signal.reason as Error) : new SafeHttpError("NETWORK", err.message)));
      if (body !== undefined) request.write(body);
      request.end();
    });
  }
}
