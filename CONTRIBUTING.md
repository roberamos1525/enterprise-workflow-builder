# Contributing

## Setup

```bash
npm install
npm run build
npm test
```

## Workflow

1. Keep `packages/engine` free of I/O and Node-only APIs. New side effects go behind an interface (`RunStore`, `Clock`,
   `HttpClient`, `Notifier`, `ApprovalHost`) that is implemented in `apps/server`.
2. Every behaviour change needs tests:
   - engine logic: `packages/engine/src/**/*.test.ts` (use `__tests__/harness.ts` and `ManualClock`);
   - server pieces: `apps/server/src/**/*.test.ts`;
   - HTTP-level behaviour: `tests/integration/*.test.ts` (use `startTestApp()` from `tests/helpers.ts`).
3. **No sleeps in tests.** Drive time with `ManualClock.advance()`, await work with `engine.idle()`, and wait on real
   events (deferred promises, stream data) instead of polling timers.
4. Before pushing: `npm run typecheck && npm run lint && npm test && npm run build`.

## Conventions

- Strict TypeScript (`noUncheckedIndexedAccess`), ESM with `.js` import suffixes, `import type` for types.
- Validate every external input (zod in routes, `validateDefinition` for workflow definitions).
- Throw typed errors (`AppError` helpers, `StepError`, `EngineError`); never leak internals in 500 responses.
- Database changes go through a new entry in `apps/server/src/db/migrations.ts`. Never edit a shipped migration.
- New node types: add a `NodeTypeSpec` to `packages/engine/src/model/catalog.ts`, a handler in `runtime/handlers.ts`,
  validation tests, and an engine test that executes it.

## Commit messages

Use imperative, scoped subjects, for example `engine: propagate skips through any-joins`.
