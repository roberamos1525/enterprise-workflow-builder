import { createHash, randomBytes } from "node:crypto";
import {
  diffDefinitions,
  isTriggerType,
  validateDefinition,
  type DefinitionDiff,
  type DefinitionProvider,
  type ValidationResult,
  type WorkflowDefinition,
} from "@ewb/engine";
import { effectiveWorkflowRole, roleAtLeast, type AuthUser, type Role, type WorkflowRole } from "../auth.js";
import { json, parseJson, type Database } from "../db/database.js";
import { badRequest, conflict, forbidden, notFound, validationFailed } from "../errors.js";

interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  draft: string;
  draft_revision: number;
  published_version: number | null;
  webhook_secret: string;
  archived: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  draftRevision: number;
  publishedVersion: number | null;
  triggerType: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  myRole: Role;
}

export interface WorkflowDetail extends WorkflowSummary {
  draft: WorkflowDefinition;
  validation: ValidationResult;
  webhook: { path: string; secret?: string };
}

export interface VersionInfo {
  version: number;
  checksum: string;
  notes: string;
  publishedBy: string | null;
  publishedAt: number;
}

export const EMPTY_DEFINITION: WorkflowDefinition = {
  schemaVersion: 1,
  nodes: [{ id: "trigger", type: "trigger.manual", name: "Manual trigger", position: { x: 80, y: 160 }, config: {} }],
  edges: [],
};

function checksum(def: WorkflowDefinition): string {
  return createHash("sha256").update(JSON.stringify(def)).digest("hex").slice(0, 16);
}

function triggerOf(def: WorkflowDefinition) {
  return def.nodes.find((n) => isTriggerType(n.type));
}

export class WorkflowService implements DefinitionProvider {
  private readonly versionCache = new Map<string, WorkflowDefinition>();
  /** Called after publish so schedules/triggers can be re-registered. */
  onPublished: (workflowId: string) => void = () => {};

  constructor(
    private readonly db: Database,
    private readonly now: () => number,
  ) {}

  // ---------------------------------------------------------------- access control

  aclRole(workflowId: string, userId: string): WorkflowRole | undefined {
    return this.db.get<{ role: WorkflowRole }>("SELECT role FROM workflow_acl WHERE workflow_id = ? AND user_id = ?", workflowId, userId)?.role;
  }

  roleFor(user: AuthUser, workflowId: string): Role | undefined {
    return effectiveWorkflowRole(user, this.aclRole(workflowId, user.id));
  }

  /** Loads a workflow the user can see with at least `min`; hides existence from users without access. */
  require(user: AuthUser, workflowId: string, min: Role): { row: WorkflowRow; role: Role } {
    const row = this.db.get<WorkflowRow>("SELECT * FROM workflows WHERE id = ? AND archived = 0", workflowId);
    const role = row ? this.roleFor(user, workflowId) : undefined;
    if (!row || !role) throw notFound("workflow");
    if (!roleAtLeast(role, min)) throw forbidden(`requires ${min} access to this workflow`);
    return { row, role };
  }

  /** Ids of workflows the user may view (undefined = all, for admins). */
  visibleIds(user: AuthUser): string[] | undefined {
    if (user.role === "admin") return undefined;
    return this.db.all<{ workflow_id: string }>("SELECT workflow_id FROM workflow_acl WHERE user_id = ?", user.id).map((r) => r.workflow_id);
  }

  // ---------------------------------------------------------------- CRUD

  create(user: AuthUser, input: { name: string; description?: string | undefined; definition?: unknown }): WorkflowDetail {
    if (!roleAtLeast(user.role, "editor")) throw forbidden("only editors can create workflows");
    const draft = input.definition === undefined ? EMPTY_DEFINITION : this.parseDraft(input.definition);
    const id = `wf_${randomBytes(6).toString("hex")}`;
    const now = this.now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO workflows (id, name, description, draft, webhook_secret, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.name, input.description ?? "", json(draft), randomBytes(24).toString("hex"), user.id, now, now,
      );
      this.db.run("INSERT INTO workflow_acl (workflow_id, user_id, role) VALUES (?, ?, 'editor')", id, user.id);
    });
    return this.detail(user, id);
  }

  list(user: AuthUser): WorkflowSummary[] {
    const ids = this.visibleIds(user);
    const rows = this.db.all<WorkflowRow>("SELECT * FROM workflows WHERE archived = 0 ORDER BY updated_at DESC");
    return rows.filter((r) => !ids || ids.includes(r.id)).map((r) => this.summary(r, this.roleFor(user, r.id) ?? "viewer"));
  }

  detail(user: AuthUser, id: string): WorkflowDetail {
    const { row, role } = this.require(user, id, "viewer");
    const draft = parseJson<WorkflowDefinition>(row.draft, EMPTY_DEFINITION);
    return {
      ...this.summary(row, role),
      draft,
      validation: validateDefinition(draft),
      webhook: { path: `/api/hooks/${row.id}`, ...(roleAtLeast(role, "editor") ? { secret: row.webhook_secret } : {}) },
    };
  }

  private summary(row: WorkflowRow, role: Role): WorkflowSummary {
    const draft = parseJson<WorkflowDefinition>(row.draft, EMPTY_DEFINITION);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      draftRevision: row.draft_revision,
      publishedVersion: row.published_version,
      triggerType: triggerOf(draft)?.type ?? null,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      myRole: role,
    };
  }

  private parseDraft(input: unknown): WorkflowDefinition {
    const result = validateDefinition(input);
    if (!result.definition) throw validationFailed("definition is malformed", result.issues);
    const structural = result.issues.filter((i) => i.code === "schema" || i.code === "limit");
    if (structural.length > 0) throw validationFailed("definition is malformed", structural);
    return result.definition;
  }

  /** Saves the draft with optimistic concurrency on `revision`. Drafts may be invalid (work in progress). */
  updateDraft(user: AuthUser, id: string, input: { revision: number; name?: string | undefined; description?: string | undefined; definition?: unknown }): WorkflowDetail {
    const { row } = this.require(user, id, "editor");
    if (row.draft_revision !== input.revision) {
      throw conflict("the draft was changed by someone else; reload and retry", { currentRevision: row.draft_revision });
    }
    const draft = input.definition === undefined ? undefined : this.parseDraft(input.definition);
    const result = this.db.run(
      `UPDATE workflows SET name = ?, description = ?, draft = ?, draft_revision = draft_revision + 1, updated_at = ?
       WHERE id = ? AND draft_revision = ?`,
      input.name ?? row.name, input.description ?? row.description, draft ? json(draft) : row.draft, this.now(), id, input.revision,
    );
    if (result.changes === 0) throw conflict("the draft was changed concurrently");
    return this.detail(user, id);
  }

  archive(user: AuthUser, id: string): void {
    this.require(user, id, "editor");
    this.db.transaction(() => {
      this.db.run("UPDATE workflows SET archived = 1, updated_at = ? WHERE id = ?", this.now(), id);
      this.db.run("UPDATE triggers SET enabled = 0 WHERE workflow_id = ?", id);
    });
    this.onPublished(id);
  }

  rotateSecret(user: AuthUser, id: string): string {
    this.require(user, id, "editor");
    const secret = randomBytes(24).toString("hex");
    this.db.run("UPDATE workflows SET webhook_secret = ? WHERE id = ?", secret, id);
    return secret;
  }

  webhookSecret(id: string): string | undefined {
    return this.db.get<{ webhook_secret: string }>("SELECT webhook_secret FROM workflows WHERE id = ? AND archived = 0", id)?.webhook_secret;
  }

  // ---------------------------------------------------------------- versions

  publish(user: AuthUser, id: string, notes = ""): VersionInfo & { validation: ValidationResult } {
    const { row } = this.require(user, id, "editor");
    const draft = parseJson<WorkflowDefinition>(row.draft, EMPTY_DEFINITION);
    const validation = validateDefinition(draft);
    if (!validation.valid) throw validationFailed("the draft has validation errors", validation.issues.filter((i) => i.severity === "error"));
    for (const node of draft.nodes) {
      const target = node.type === "action.subworkflow" ? node.config["workflowId"] : undefined;
      if (typeof target === "string" && !this.db.get("SELECT 1 FROM workflows WHERE id = ? AND archived = 0", target)) {
        throw validationFailed(`sub-workflow node '${node.id}' references unknown workflow ${target}`);
      }
    }
    const latest = this.db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM workflow_versions WHERE workflow_id = ?", id)?.v ?? 0;
    const previous = latest > 0 ? this.getVersion(id, latest) : undefined;
    if (previous && diffDefinitions(previous, draft).identical) throw conflict(`draft is identical to version ${latest}`);
    const version = latest + 1;
    const now = this.now();
    const trigger = triggerOf(draft);
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO workflow_versions (workflow_id, version, definition, checksum, notes, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id, version, json(draft), checksum(draft), notes, user.id, now,
      );
      this.db.run("UPDATE workflows SET published_version = ?, updated_at = ? WHERE id = ?", version, now, id);
      const cron = trigger?.type === "trigger.schedule" ? String(trigger.config["cron"]) : null;
      const eventType = trigger?.type === "trigger.event" ? String(trigger.config["eventType"]) : null;
      this.db.run(
        `INSERT INTO triggers (workflow_id, version, type, event_type, cron, enabled, next_fire_at) VALUES (?, ?, ?, ?, ?, 1, NULL)
         ON CONFLICT (workflow_id) DO UPDATE SET version = excluded.version, type = excluded.type, event_type = excluded.event_type,
           cron = excluded.cron, enabled = 1,
           next_fire_at = CASE WHEN triggers.cron IS excluded.cron THEN triggers.next_fire_at ELSE NULL END`,
        id, version, trigger?.type ?? "none", eventType, cron,
      );
    });
    this.onPublished(id);
    return { ...this.versionInfo(id, version), validation };
  }

  versions(user: AuthUser, id: string): VersionInfo[] {
    this.require(user, id, "viewer");
    return this.db
      .all<{ version: number }>("SELECT version FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC", id)
      .map((r) => this.versionInfo(id, r.version));
  }

  versionDetail(user: AuthUser, id: string, version: number): VersionInfo & { definition: WorkflowDefinition } {
    this.require(user, id, "viewer");
    const definition = this.getVersion(id, version);
    if (!definition) throw notFound("version");
    return { ...this.versionInfo(id, version), definition };
  }

  private versionInfo(id: string, version: number): VersionInfo {
    const row = this.db.get<{ version: number; checksum: string; notes: string; published_by: string | null; published_at: number }>(
      "SELECT version, checksum, notes, published_by, published_at FROM workflow_versions WHERE workflow_id = ? AND version = ?",
      id, version,
    );
    if (!row) throw notFound("version");
    return { version: row.version, checksum: row.checksum, notes: row.notes, publishedBy: row.published_by, publishedAt: row.published_at };
  }

  /** Diff between two refs: a version number or "draft". */
  diff(user: AuthUser, id: string, from: string, to: string): DefinitionDiff {
    const { row } = this.require(user, id, "viewer");
    const load = (ref: string): WorkflowDefinition => {
      if (ref === "draft") return parseJson<WorkflowDefinition>(row.draft, EMPTY_DEFINITION);
      const v = Number(ref);
      if (!Number.isInteger(v) || v < 1) throw badRequest(`invalid version reference '${ref}'`);
      const def = this.getVersion(id, v);
      if (!def) throw notFound(`version ${v}`);
      return def;
    };
    return diffDefinitions(load(from), load(to));
  }

  // ---------------------------------------------------------------- ACL

  acl(user: AuthUser, id: string): { userId: string; email: string; name: string; role: WorkflowRole }[] {
    this.require(user, id, "viewer");
    return this.db.all<{ userId: string; email: string; name: string; role: WorkflowRole }>(
      `SELECT a.user_id AS userId, u.email, u.name, a.role FROM workflow_acl a JOIN users u ON u.id = a.user_id
       WHERE a.workflow_id = ? ORDER BY u.email`,
      id,
    );
  }

  setAcl(user: AuthUser, id: string, entries: { userId: string; role: WorkflowRole }[]): ReturnType<WorkflowService["acl"]> {
    this.require(user, id, "editor");
    if (!entries.some((e) => e.role === "editor") && user.role !== "admin") {
      throw badRequest("at least one editor must remain on the workflow");
    }
    this.db.transaction(() => {
      this.db.run("DELETE FROM workflow_acl WHERE workflow_id = ?", id);
      for (const e of entries) {
        if (!this.db.get("SELECT 1 FROM users WHERE id = ?", e.userId)) throw badRequest(`unknown user ${e.userId}`);
        this.db.run("INSERT INTO workflow_acl (workflow_id, user_id, role) VALUES (?, ?, ?)", id, e.userId, e.role);
      }
    });
    return this.acl(user, id);
  }

  // ---------------------------------------------------------------- DefinitionProvider

  getVersion(workflowId: string, version: number): WorkflowDefinition | undefined {
    const key = `${workflowId}@${version}`;
    const cached = this.versionCache.get(key);
    if (cached) return cached;
    const row = this.db.get<{ definition: string }>(
      "SELECT definition FROM workflow_versions WHERE workflow_id = ? AND version = ?", workflowId, version,
    );
    if (!row) return undefined;
    const def = parseJson<WorkflowDefinition>(row.definition, EMPTY_DEFINITION);
    this.versionCache.set(key, def); // versions are immutable, so caching is safe
    return def;
  }

  getPublished(workflowId: string): { version: number; definition: WorkflowDefinition } | undefined {
    const row = this.db.get<{ published_version: number | null }>(
      "SELECT published_version FROM workflows WHERE id = ? AND archived = 0", workflowId,
    );
    if (!row?.published_version) return undefined;
    const definition = this.getVersion(workflowId, row.published_version);
    return definition ? { version: row.published_version, definition } : undefined;
  }
}
