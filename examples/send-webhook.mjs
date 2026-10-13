// Sends an HMAC-signed webhook to a published workflow.
//
//   node examples/send-webhook.mjs <workflowId> <secret> '{"orderId":"PO-1","amount":50}'
//
// The signature is HMAC-SHA256(secret, `${timestamp}.${body}`), hex encoded and
// prefixed with "sha256=". Timestamps older than 5 minutes are rejected.
import { createHmac, randomUUID } from "node:crypto";

const [workflowId, secret, body = "{}"] = process.argv.slice(2);
if (!workflowId || !secret) {
  console.error("usage: node examples/send-webhook.mjs <workflowId> <secret> [json-body]");
  process.exit(1);
}
const base = process.env.BASE ?? "http://127.0.0.1:4000";
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

const res = await fetch(`${base}/api/hooks/${workflowId}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-ewb-timestamp": timestamp,
    "x-ewb-signature": signature,
    "idempotency-key": process.env.IDEMPOTENCY_KEY ?? randomUUID(),
  },
  body,
});
console.log(res.status, await res.text());
