# Security

## Reporting

This is a portfolio project without a production deployment. If you find a vulnerability, open a private report with the
repository owner rather than a public issue.

## Security model

- **Authentication**: HS256 JWTs signed with `JWT_SECRET` (required in production, ≥ 32 characters). Tokens expire after
  `JWT_TTL_SECONDS` (default 8 h). Passwords are hashed with scrypt and compared in constant time. Logins are rate limited
  per IP.
- **Authorisation**: global roles (admin/editor/operator/viewer) combined with per-workflow ACLs. The effective role is
  the lower of the two. Workflows without access look like 404s.
- **Webhooks**: a per-workflow 192-bit secret; either a constant-time token comparison or an HMAC-SHA256 signature over
  `timestamp.body` with a ±5 minute replay window. Idempotency keys and per-workflow, per-IP rate limits apply. Secrets
  can be rotated and are only shown to editors.
- **SSRF protection** for the HTTP action and webhook notifications:
  - Only `http` and `https` URLs are allowed, and credentials in URLs are rejected.
  - DNS is resolved before connecting. Loopback, RFC 1918, link-local (including cloud metadata `169.254.169.254`),
    CGNAT, multicast, reserved and documentation ranges are blocked, as are IPv6 ULA/link-local and IPv4-mapped forms.
  - The vetted IP is pinned for the socket (DNS rebinding is ineffective).
  - Redirects are re-checked (at most 3), and responses are capped at `HTTP_MAX_RESPONSE_BYTES`.
  - The overrides are `HTTP_ALLOW_LIST` (hosts or CIDRs) and `HTTP_ALLOW_PRIVATE=true` (development only).
- **Expression sandbox**: workflow expressions are parsed and interpreted by our own evaluator.
  - There is no `eval` or `new Function` (ESLint enforces `no-eval` and `no-new-func`).
  - Prototype-related names are rejected, only own properties of plain data are readable, and there are no method calls.
  - Evaluation-step, string, array, nesting and source-length limits stop denial-of-service expressions.
- **HTTP hardening**: request body limit (413), required JSON content type (415), `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a CSP for the SPA, and `Cache-Control: no-store` on API
  responses. 500 responses never contain internal error messages.
- **Secrets**: configuration only (`.env` is git-ignored; `.env.example` holds placeholders). Demo seed passwords are for
  local use only.

## Known gaps

There is no token revocation list or refresh-token rotation, no MFA or SSO, and no audit log of administrative changes
beyond structured logs. See README → Limitations.
