# Execution engine

The engine lives in `packages/engine/src/runtime/engine.ts`. It is pure TypeScript and gets persistence, definitions,
time and side effects from the host through interfaces.

## Records

- **Run** — `id`, `workflowId`, `version` (pinned), `status` (`running|waiting|succeeded|failed|cancelled`), `trigger`,
  `input`, `vars`, `output`, `error`, parent pointers (sub-workflows), `depth`, timestamps and `deadlineAt`.
- **Step** — one per node and run: `status` (`running|waiting|succeeded|failed|skipped|cancelled`), `attempt`, the output
  `port` it finished through, `input`, `output`, `error`, handler `state` (for example an approval id or child run id),
  `wakeAt` + `wakeReason` (`retry|resume`), and `pendingEvent` (an accepted signal that has not been processed yet).
- **Event** — an append-only timeline (`run.started`, `step.started`, `step.retry_scheduled`, `step.waiting`,
  `step.resumed`, `step.skipped`, `step.failed`, `run.recovered`, …), used for the UI timeline and SSE.

All store methods are synchronous. With `node:sqlite` this means a state transition (for example "step succeeded + vars
merged + event appended") is written in one transaction before the next piece of work is scheduled.

## Scheduling algorithm (`advance`)

For each node in topological order that has no step yet:

1. Classify each incoming edge:
   - *pending*: the source has not finished.
   - *active*: the source finished through this edge's port (`succeeded`, or `failed` with the `error` port).
   - *dead*: anything else.
2. `all` semantics (all regular nodes, and joins in `all` mode): wait while any edge is pending. When none is pending,
   start the node if at least one edge is active, otherwise mark it `skipped`.
3. `any` join: start on the first active edge, and skip when all edges are dead.
4. Input: a single active predecessor passes its output directly. Several predecessors, or any join, produce an object
   keyed by predecessor node id.

Skipping propagates naturally down untaken branches, so a join after a branch never waits forever. When no step is
running or waiting, the run succeeds with its variables as output (or the output of an `End` node).

## Step execution

`dispatch()` builds a context with the expression scope and an `AbortSignal`, then calls the handler's `execute` (or its
`resume` for timers and signals). The per-attempt timeout (`node.timeoutMs`, or `STEP_TIMEOUT_MS`) is armed on the
injectable clock **when execution begins**. On expiry it aborts the signal and fails the attempt with `TIMEOUT`.

Outcomes:

| Outcome | Effect |
| --- | --- |
| `complete { port, output, vars }` | step `succeeded`; vars merged into the run; `advance()` |
| `wait { wakeAt?, state }` | step `waiting`; a timer is armed if `wakeAt` is set; reserved child runs start now |
| `end { status }` | step `succeeded`; the run ends, and other active steps are cancelled |
| throws `StepError` / other error | see below |

On failure:

1. If the error is retryable (`StepError.retryable`, network errors, 5xx/429, timeouts), the node type is retryable and
   attempts remain, the step waits with `wakeReason=retry` until
   `min(initialDelayMs × multiplier^(attempt-1), maxDelayMs)`.
2. Otherwise, if the node has an edge from its `error` port, the step is `failed` with `port=error` and its output is
   `{ error, attempts, input }`. Execution continues down the error path.
3. Otherwise the run fails, and running or waiting steps are cancelled. Their abort signals fire and handler `cancel()`
   hooks run, so approvals are closed. Child runs are cancelled too.

Expression errors, SSRF blocks and invalid configuration are not retryable.

## Waiting steps and signals

- **Delay** returns `wait { wakeAt }`. The timer resumes it with `{ kind: "timer" }`.
- **Approval** calls `ApprovalHost.create()`, which is idempotent per `(run, node)`, and waits until `now + timeoutMs`.
  - A decision arrives as `engine.signal(runId, nodeId, { decision, by, comment })` and completes through the
    `approved` or `rejected` port.
  - When the timer fires for the first time and `escalateTo` is set, the approval is escalated and waits until
    `escalationTimeoutMs`.
  - On the next expiry the step completes through `timeout`.
- **Sub-workflow** reserves a child run id through `ctx.startChildRun()` and returns `wait { state: { childRunId,
  workflowId, input } }`. The child run is created only after the parent's waiting state is persisted. When the child
  finishes, the engine signals the parent step. Nesting depth is limited (`maxDepth`, default 5), and a workflow cannot
  call itself.

`signal()` first persists `status=running, pendingEvent=<event>` and then dispatches `resume`, so an accepted decision is
not lost if the process dies before the handler finishes.

## Crash recovery (`recover()`)

When it is called on startup, `recover()` handles each run in `running` or `waiting` status:

1. It reloads the pinned definition. If the definition is missing, the run fails with `DEFINITION_MISSING`.
2. It re-arms the run deadline.
3. Steps in `running` state are dispatched again: `resume(pendingEvent)` if an event was pending, otherwise `execute`
   with the same attempt number. **Delivery is at least once.**
4. Steps in `waiting` state get their wake timer re-armed. A timer whose time has passed fires immediately.
5. Waiting sub-workflow steps are reconciled: a child that was reserved but never created is started, and a child that
   already finished signals the parent.
6. It calls `advance()` to create any successor steps that were not persisted before the crash.

Completions that arrive after `shutdown()` are discarded, so an engine that is stopping never writes state.
`tests/integration/durable-engine.test.ts` proves the model end to end: for k = 1…30 the engine is stopped right after
the k-th persisted event, a new engine is built on a fresh SQLite connection to the same file, and the final run output
must equal the uninterrupted baseline.

## Run deadline

`settings.maxRunDurationMs` sets `deadlineAt` at start. A clock timer fails the run with `RUN_TIMEOUT` if it is still
active at that time, and recovery re-arms the timer.

## Limits

- Step output is limited to 256 KiB of JSON (`OUTPUT_TOO_LARGE`).
- Definitions are limited to 200 nodes and 400 edges, and 64 KiB of config per node.
- The retry policy allows at most 10 attempts and delays of at most 24 h.
