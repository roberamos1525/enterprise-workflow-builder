import type { DataType, NodeTypeSpec, PortSpec, ValidationIssue } from "./types.js";

const IN: PortSpec = { name: "in", label: "In", dataType: "any", accepts: ["any", "object", "http", "decision", "error"] };
const out = (name: string, label: string, dataType: DataType): PortSpec => ({ name, label, dataType });
const ERROR_OUT = out("error", "Error", "error");
const REQUIRED_FIELDS = {
  key: "requiredFields",
  label: "Required payload fields",
  kind: "stringList",
  help: "Top-level keys the trigger payload must contain.",
} as const;

const issue = (field: string, message: string): ValidationIssue => ({
  severity: "error",
  code: "invalid_config",
  field,
  message,
});

export const NODE_TYPES: readonly NodeTypeSpec[] = [
  {
    type: "trigger.manual",
    category: "trigger",
    label: "Manual trigger",
    description: "Started by a user from the UI or API with an optional JSON input.",
    inputs: [],
    outputs: [out("out", "Out", "object")],
    fields: [REQUIRED_FIELDS],
    retryable: false,
  },
  {
    type: "trigger.webhook",
    category: "trigger",
    label: "Webhook trigger",
    description: "Started by an HTTP POST to the workflow hook URL, authenticated with a shared secret or HMAC.",
    inputs: [],
    outputs: [out("out", "Out", "object")],
    fields: [REQUIRED_FIELDS],
    retryable: false,
  },
  {
    type: "trigger.schedule",
    category: "trigger",
    label: "Schedule trigger",
    description: "Started on a cron schedule (5 fields, UTC).",
    inputs: [],
    outputs: [out("out", "Out", "object")],
    fields: [
      { key: "cron", label: "Cron expression", kind: "cron", required: true, default: "0 * * * *" },
      { key: "payload", label: "Static payload", kind: "json", default: {} },
    ],
    retryable: false,
  },
  {
    type: "trigger.event",
    category: "trigger",
    label: "Event trigger",
    description: "Started when an event of the given type is published to the event bus.",
    inputs: [],
    outputs: [out("out", "Out", "object")],
    fields: [
      { key: "eventType", label: "Event type", kind: "string", required: true, maxLength: 120 },
      { key: "filter", label: "Filter", kind: "expression", help: "Optional condition over `event`." },
    ],
    retryable: false,
  },
  {
    type: "action.http",
    category: "action",
    label: "HTTP request",
    description: "Calls an external HTTP endpoint (private networks are blocked by default).",
    inputs: [IN],
    outputs: [out("success", "Success", "http"), ERROR_OUT],
    fields: [
      { key: "method", label: "Method", kind: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET" },
      { key: "url", label: "URL", kind: "template", required: true, maxLength: 2048 },
      { key: "headers", label: "Headers", kind: "keyValue", default: {} },
      { key: "body", label: "Body", kind: "template", help: "Template; a single {{ expr }} sends JSON." },
      { key: "failOnHttpError", label: "Fail on 4xx/5xx", kind: "boolean", default: true },
    ],
    retryable: true,
  },
  {
    type: "action.transform",
    category: "action",
    label: "Transform",
    description: "Computes a new value with the expression language.",
    inputs: [IN],
    outputs: [out("out", "Out", "any"), ERROR_OUT],
    fields: [{ key: "expression", label: "Expression", kind: "expression", required: true }],
    retryable: false,
  },
  {
    type: "action.delay",
    category: "action",
    label: "Delay",
    description: "Pauses this branch for a duration or until a timestamp. Survives restarts.",
    inputs: [IN],
    outputs: [out("out", "Out", "any")],
    fields: [
      { key: "mode", label: "Mode", kind: "select", options: ["duration", "until"], default: "duration" },
      {
        key: "durationMs",
        label: "Duration (ms)",
        kind: "number",
        min: 0,
        max: 30 * 24 * 3600_000,
        default: 60_000,
        when: { key: "mode", equals: ["duration", undefined] },
        required: true,
      },
      {
        key: "until",
        label: "Until (epoch ms expression)",
        kind: "expression",
        when: { key: "mode", equals: ["until"] },
        required: true,
      },
    ],
    retryable: false,
  },
  {
    type: "action.setVariable",
    category: "action",
    label: "Set variable",
    description: "Stores a value in the run variables (`vars.<name>`).",
    inputs: [IN],
    outputs: [out("out", "Out", "any"), ERROR_OUT],
    fields: [
      { key: "name", label: "Variable name", kind: "string", required: true, maxLength: 64 },
      { key: "expression", label: "Value", kind: "expression", required: true },
    ],
    retryable: false,
    validate(config) {
      const name = config["name"];
      if (typeof name === "string" && name !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return [issue("name", "variable name must be an identifier (letters, digits, underscore)")];
      }
      return [];
    },
  },
  {
    type: "action.notify",
    category: "action",
    label: "Notification",
    description: "Sends an in-app notification to users/roles or POSTs to a notification webhook.",
    inputs: [IN],
    outputs: [out("out", "Out", "object"), ERROR_OUT],
    fields: [
      { key: "channel", label: "Channel", kind: "select", options: ["inApp", "webhook"], default: "inApp" },
      {
        key: "recipients",
        label: "Recipients",
        kind: "stringList",
        help: "User emails or role:<role>.",
        when: { key: "channel", equals: ["inApp", undefined] },
        required: true,
      },
      { key: "url", label: "Webhook URL", kind: "url", when: { key: "channel", equals: ["webhook"] }, required: true },
      { key: "title", label: "Title", kind: "template", required: true, maxLength: 200 },
      { key: "message", label: "Message", kind: "template", required: true, maxLength: 4000 },
    ],
    retryable: true,
  },
  {
    type: "action.approval",
    category: "action",
    label: "Approval",
    description: "Waits for an assignee to approve or reject; supports timeout and escalation.",
    inputs: [IN],
    outputs: [out("approved", "Approved", "decision"), out("rejected", "Rejected", "decision"), out("timeout", "Timed out", "decision")],
    fields: [
      { key: "title", label: "Title", kind: "template", required: true, maxLength: 200 },
      { key: "description", label: "Description", kind: "template", maxLength: 4000 },
      { key: "assignees", label: "Assignees", kind: "stringList", required: true, help: "User emails or role:<role>." },
      { key: "timeoutMs", label: "Timeout (ms)", kind: "number", min: 1000, max: 90 * 24 * 3600_000 },
      { key: "escalateTo", label: "Escalate to", kind: "stringList", help: "Added as assignees when the timeout passes." },
      { key: "escalationTimeoutMs", label: "Escalation timeout (ms)", kind: "number", min: 1000, max: 90 * 24 * 3600_000 },
    ],
    retryable: false,
    validate(config) {
      const issues: ValidationIssue[] = [];
      const escalate = config["escalateTo"];
      if (Array.isArray(escalate) && escalate.length > 0 && config["timeoutMs"] === undefined) {
        issues.push(issue("timeoutMs", "escalation requires a timeout"));
      }
      return issues;
    },
  },
  {
    type: "action.subworkflow",
    category: "action",
    label: "Sub-workflow",
    description: "Runs the published version of another workflow and waits for its result.",
    inputs: [IN],
    outputs: [out("out", "Out", "object"), ERROR_OUT],
    fields: [
      { key: "workflowId", label: "Workflow ID", kind: "string", required: true, maxLength: 64 },
      { key: "input", label: "Input", kind: "expression", help: "Defaults to this node's input." },
    ],
    retryable: false,
  },
  {
    type: "flow.branch",
    category: "flow",
    label: "Branch",
    description: "Routes to `true` or `false` depending on a condition.",
    inputs: [IN],
    outputs: [out("true", "True", "any"), out("false", "False", "any")],
    fields: [{ key: "condition", label: "Condition", kind: "expression", required: true }],
    retryable: false,
  },
  {
    type: "flow.join",
    category: "flow",
    label: "Join",
    description: "Waits for incoming branches and merges their outputs keyed by node id.",
    inputs: [{ name: "in", label: "In", dataType: "any", accepts: ["any", "object", "http", "decision"] }],
    outputs: [out("out", "Out", "object")],
    fields: [{ key: "mode", label: "Mode", kind: "select", options: ["all", "any"], default: "all" }],
    retryable: false,
  },
  {
    type: "flow.end",
    category: "flow",
    label: "End",
    description: "Ends the run immediately with the given status, cancelling other branches.",
    inputs: [IN],
    outputs: [],
    fields: [
      { key: "status", label: "Status", kind: "select", options: ["succeeded", "failed"], default: "succeeded" },
      { key: "output", label: "Run output", kind: "expression" },
      { key: "message", label: "Failure message", kind: "template", when: { key: "status", equals: ["failed"] } },
    ],
    retryable: false,
  },
];

const BY_TYPE = new Map(NODE_TYPES.map((spec) => [spec.type, spec]));

export function getNodeType(type: string): NodeTypeSpec | undefined {
  return BY_TYPE.get(type);
}

export function portCompatible(from: DataType, accepts: readonly DataType[] | undefined): boolean {
  if (!accepts) return true;
  return accepts.includes(from);
}

/** Builds a config object populated with each field's default value. */
export function defaultConfig(type: string): Record<string, unknown> {
  const spec = getNodeType(type);
  const config: Record<string, unknown> = {};
  for (const field of spec?.fields ?? []) {
    if (field.default !== undefined) config[field.key] = JSON.parse(JSON.stringify(field.default)) as unknown;
  }
  return config;
}
