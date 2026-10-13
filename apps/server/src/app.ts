import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createHandlers, CronScheduler, SystemClock, WorkflowEngine, type Clock, type HttpClient, type RunEvent, type RunRecord } from "@ewb/engine";
import type { AppConfig } from "./config.js";
import { Database } from "./db/database.js";
import { SqliteRunStore } from "./db/run-store.js";
import { Router } from "./http.js";
import { createLogger, Metrics, type Logger } from "./observability.js";
import { registerRoutes } from "./routes.js";
import { SafeHttpClient } from "./net/safe-http.js";
import { ApprovalService, LiveHub, NotificationService } from "./services/collaboration.js";
import { RunService } from "./services/runs.js";
import { UserService } from "./services/users.js";
import { WorkflowService } from "./services/workflows.js";

export interface AppOptions {
  clock?: Clock;
  httpClient?: HttpClient;
  logger?: Logger;
}

export interface App {
  config: AppConfig;
  db: Database;
  engine: WorkflowEngine;
  scheduler: CronScheduler;
  users: UserService;
  workflows: WorkflowService;
  runs: RunService;
  approvals: ApprovalService;
  notifications: NotificationService;
  hub: LiveHub;
  metrics: Metrics;
  logger: Logger;
  server: Server;
  /** Runs migrations, recovers interrupted runs, starts the scheduler and the HTTP listener. */
  start(): Promise<{ port: number }>;
  /** Stops accepting work; persisted runs are resumed by the next start. */
  stop(): Promise<void>;
}

const TERMINAL_EVENTS = new Set(["run.succeeded", "run.failed", "run.cancelled"]);

export function createApp(config: AppConfig, options: AppOptions = {}): App {
  const clock = options.clock ?? new SystemClock();
  const now = () => clock.now();
  const logger = options.logger ?? createLogger(config.logLevel);
  const metrics = new Metrics();
  const db = new Database(config.databasePath);
  db.migrate();
  const store = new SqliteRunStore(db);
  const http =
    options.httpClient ??
    new SafeHttpClient({ allowList: config.httpAllowList, allowPrivate: config.httpAllowPrivate, maxResponseBytes: config.httpMaxResponseBytes });
  const hub = new LiveHub();
  const users = new UserService(db, now);
  const workflows = new WorkflowService(db, now);
  const notifications = new NotificationService(db, users, http, hub, now);
  const approvals = new ApprovalService(db, users, workflows, notifications, now, logger);
  const runs = new RunService(db, store, workflows, metrics, logger, now);

  const onEvent = (event: RunEvent, run: RunRecord): void => {
    hub.publishRun(event, run);
    if (TERMINAL_EVENTS.has(event.type)) {
      metrics.runsFinished.inc({ status: event.type.slice(4) });
      logger.info("run finished", { runId: run.id, workflowId: run.workflowId, status: event.type.slice(4) });
    }
    if (event.type === "step.succeeded" || event.type === "step.failed") {
      const step = store.getStep(event.runId, event.nodeId ?? "");
      metrics.stepsFinished.inc({ type: step?.nodeType ?? "unknown", status: event.type.slice(5) });
    }
    if (event.type === "run.failed" && run.parentRunId === null) {
      const owner = db.get<{ created_by: string | null; name: string }>("SELECT created_by, name FROM workflows WHERE id = ?", run.workflowId);
      const recipients = [run.createdBy, owner?.created_by].filter((v): v is string => typeof v === "string");
      notifications.notifyUsers(recipients, "run_failed", `Run failed: ${owner?.name ?? run.workflowId}`, String(event.data?.["error"] ?? "unknown error"), `/runs/${run.id}`);
    }
  };

  const engine = new WorkflowEngine({
    store,
    clock,
    definitions: workflows,
    handlers: createHandlers({ http, notifier: notifications, approvals }),
    idGenerator: randomUUID,
    onEvent,
    logger,
    defaultTimeoutMs: config.stepTimeoutMs,
  });
  approvals.attachEngine(engine);
  runs.engine = engine;

  const scheduler = new CronScheduler({
    clock,
    store: runs,
    misfirePolicy: config.schedulerMisfire,
    onFire: (entry, scheduledFor) => runs.fireSchedule(entry, scheduledFor),
    onError: (err, entry) => logger.error("scheduled run failed", { workflowId: entry.workflowId, error: (err as Error).message }),
  });
  workflows.onPublished = () => scheduler.refresh();

  let ready = false;
  const router = new Router({
    bodyLimit: config.bodyLimitBytes,
    jwtSecret: config.jwtSecret,
    loadUser: (id) => {
      const user = users.find(id);
      return user && !user.disabled ? user : undefined;
    },
    logger,
    metrics,
    webDist: config.webDist,
    now,
  });
  registerRoutes(router, { config, users, workflows, runs, approvals, notifications, hub, metrics, now, ready: () => ready });
  const server = createServer((req, res) => void router.handle(req, res));
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  return {
    config, db, engine, scheduler, users, workflows, runs, approvals, notifications, hub, metrics, logger, server,
    async start() {
      const recovered = engine.recover();
      if (recovered.runs > 0) logger.info("recovered interrupted runs", recovered);
      scheduler.start();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => resolve());
      });
      ready = true;
      const port = (server.address() as AddressInfo).port;
      logger.info("server listening", { host: config.host, port, env: config.env });
      return { port };
    },
    async stop() {
      ready = false;
      scheduler.stop();
      engine.shutdown();
      hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}
