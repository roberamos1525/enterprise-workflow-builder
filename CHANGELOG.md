# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog; versions follow SemVer.

## [0.1.0] - 2026-10-12

### Added
- `@ewb/engine`:
  - workflow model with typed ports and a 14-type node catalog;
  - schema, graph and config validation, and version diff;
  - sandboxed expression language with ~50 builtins and templates;
  - 5-field cron parser and persistent scheduler;
  - durable execution engine with branches, parallel joins, retries/backoff, timeouts, delays, approvals with
    escalation, sub-workflows, error ports and crash recovery.
- `@ewb/server`:
  - node:sqlite persistence with migrations;
  - JWT auth, roles and per-workflow ACLs;
  - drafts, immutable versions and diffs;
  - manual, webhook (token/HMAC, idempotency), schedule and event triggers;
  - approvals and in-app/webhook notifications;
  - SSRF-safe HTTP client;
  - SSE live updates, Prometheus metrics and a CLI.
- `@ewb/web`:
  - SVG canvas editor (drag, connect, pan/zoom, delete, undo/redo, config panel with validation, save/publish/run with
    live status);
  - pages for versions/diff, sharing, runs and run timelines, the dashboard, approvals, users and notifications.
- 291 tests (engine 161, server 66, web 28, integration 36), examples, Docker/compose files (not built locally) and a CI workflow.
