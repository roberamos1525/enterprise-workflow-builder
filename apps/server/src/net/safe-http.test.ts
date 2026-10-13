import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EgressPolicy, inCidr, isPrivateAddress, parseCidr, SafeHttpClient, type Resolver } from "./safe-http.js";

describe("CIDR math", () => {
  it("matches IPv4 and IPv6 prefixes", () => {
    expect(inCidr("10.1.2.3", parseCidr("10.0.0.0/8"))).toBe(true);
    expect(inCidr("11.0.0.1", parseCidr("10.0.0.0/8"))).toBe(false);
    expect(inCidr("172.31.255.255", parseCidr("172.16.0.0/12"))).toBe(true);
    expect(inCidr("172.32.0.0", parseCidr("172.16.0.0/12"))).toBe(false);
    expect(inCidr("fe80::1", parseCidr("fe80::/10"))).toBe(true);
    expect(inCidr("2001:db8::5", parseCidr("2001:db8::/32"))).toBe(true);
    expect(inCidr("10.0.0.1", parseCidr("::/0"))).toBe(false);
    expect(inCidr("0.0.0.0", parseCidr("0.0.0.0/0"))).toBe(true);
    expect(() => parseCidr("10.0.0.0/33")).toThrow(/prefix/);
    expect(() => parseCidr("nope/8")).toThrow(/invalid CIDR/);
  });

  it.each([
    ["127.0.0.1", true], ["10.0.0.5", true], ["192.168.1.1", true], ["169.254.169.254", true], ["100.64.0.1", true],
    ["0.0.0.0", true], ["224.0.0.1", true], ["::1", true], ["::", true], ["fd00::1", true], ["fe80::abcd", true],
    ["::ffff:127.0.0.1", true], ["::ffff:7f00:1", true], ["::ffff:8.8.8.8", false], ["8.8.8.8", false],
    ["93.184.216.34", false], ["2606:4700::1111", false],
  ])("isPrivateAddress(%s) = %s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe("EgressPolicy", () => {
  it("blocks private destinations unless allow-listed by host pattern or CIDR", () => {
    const policy = new EgressPolicy({ allowList: ["internal.test", "*.corp.test", "10.1.0.0/16"], allowPrivate: false });
    expect(() => policy.check("x.test", ["10.0.0.1"])).toThrow(/blocked address/);
    expect(() => policy.check("x.test", ["8.8.8.8", "127.0.0.1"])).toThrow(/127\.0\.0\.1/);
    expect(() => policy.check("internal.test", ["10.0.0.1"])).not.toThrow();
    expect(() => policy.check("api.corp.test", ["192.168.0.1"])).not.toThrow();
    expect(() => policy.check("corp.test.evil", ["192.168.0.1"])).toThrow();
    expect(() => policy.check("x.test", ["10.1.2.3"])).not.toThrow();
    expect(() => new EgressPolicy({ allowList: [], allowPrivate: true }).check("x", ["127.0.0.1"])).not.toThrow();
  });
});

describe("SafeHttpClient", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect-private") {
        res.writeHead(302, { location: "http://10.0.0.9/secret" });
        res.end();
      } else if (req.url === "/redirect-local") {
        res.writeHead(303, { location: `/echo` });
        res.end();
      } else if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(5000));
      } else {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ method: req.method, body, host: req.headers.host, custom: req.headers["x-custom"] ?? null }));
        });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const signal = () => new AbortController().signal;
  const fakeDns: Resolver = async (host) => {
    if (host === "local.test") return [{ address: "127.0.0.1", family: 4 }];
    if (host === "rebind.test") return [{ address: "10.0.0.5", family: 4 }];
    throw new Error(`ENOTFOUND ${host}`);
  };

  it("blocks loopback by default, including via DNS", async () => {
    const client = new SafeHttpClient({ allowList: [], allowPrivate: false, maxResponseBytes: 10_000, resolver: fakeDns });
    await expect(client.request({ method: "GET", url: `http://127.0.0.1:${port}/`, headers: {}, signal: signal() })).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    await expect(client.request({ method: "GET", url: `http://[::1]:${port}/`, headers: {}, signal: signal() })).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    await expect(client.request({ method: "GET", url: "http://rebind.test/", headers: {}, signal: signal() })).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
  });

  it("rejects non-http schemes and embedded credentials", async () => {
    const client = new SafeHttpClient({ allowList: [], allowPrivate: false, maxResponseBytes: 10_000 });
    await expect(client.request({ method: "GET", url: "file:///etc/passwd", headers: {}, signal: signal() })).rejects.toMatchObject({ code: "INVALID_URL" });
    await expect(client.request({ method: "GET", url: "http://u:p@example.com", headers: {}, signal: signal() })).rejects.toMatchObject({ code: "INVALID_URL" });
    await expect(client.request({ method: "GET", url: "not a url", headers: {}, signal: signal() })).rejects.toMatchObject({ code: "INVALID_URL" });
  });

  it("performs allow-listed requests with the pinned address and strips hop headers", async () => {
    const client = new SafeHttpClient({ allowList: ["local.test"], allowPrivate: false, maxResponseBytes: 10_000, resolver: fakeDns });
    const res = await client.request({ method: "POST", url: `http://local.test:${port}/echo`, headers: { "x-custom": "1", host: "evil" }, body: "hi", signal: signal() });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ method: "POST", body: "hi", host: `local.test:${port}`, custom: "1" });
  });

  it("re-validates redirect targets and converts 303 to GET", async () => {
    const client = new SafeHttpClient({ allowList: ["127.0.0.1/32"], allowPrivate: false, maxResponseBytes: 10_000 });
    await expect(client.request({ method: "GET", url: `http://127.0.0.1:${port}/redirect-private`, headers: {}, signal: signal() })).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    const res = await client.request({ method: "POST", url: `http://127.0.0.1:${port}/redirect-local`, headers: {}, body: "x", signal: signal() });
    expect(JSON.parse(res.body)).toMatchObject({ method: "GET", body: "" });
  });

  it("caps response size and honours abort signals", async () => {
    const client = new SafeHttpClient({ allowList: ["127.0.0.1"], allowPrivate: false, maxResponseBytes: 1000 });
    await expect(client.request({ method: "GET", url: `http://127.0.0.1:${port}/big`, headers: {}, signal: signal() })).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(client.request({ method: "GET", url: `http://127.0.0.1:${port}/echo`, headers: {}, signal: controller.signal })).rejects.toThrow();
  });
});
