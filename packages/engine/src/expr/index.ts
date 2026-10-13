import type { Expr } from "./ast.js";
import { ExpressionError } from "./errors.js";
import { Evaluator, Scope, stringify, toValue, type EvalOptions, type RuntimeValue, type Value } from "./evaluator.js";
import { parseExpression } from "./parser.js";

export { ExpressionError, type ExpressionErrorCode } from "./errors.js";
export { listBuiltins } from "./builtins.js";
export { deepEqual, toValue, truthy, type EvalOptions, type Value } from "./evaluator.js";
export type { Expr } from "./ast.js";

export interface CompiledExpression {
  readonly source: string;
  readonly ast: Expr;
  evaluate(variables: Record<string, unknown>, options?: EvalOptions): Value;
}

const CACHE_LIMIT = 500;
const cache = new Map<string, CompiledExpression>();

function buildScope(variables: Record<string, unknown>): Scope {
  const vars = new Map<string, RuntimeValue>();
  for (const [k, v] of Object.entries(variables)) vars.set(k, toValue(v));
  return new Scope(vars);
}

/** Parses (with an LRU cache) and returns a reusable compiled expression. */
export function compileExpression(source: string): CompiledExpression {
  const hit = cache.get(source);
  if (hit) {
    cache.delete(source);
    cache.set(source, hit);
    return hit;
  }
  const ast = parseExpression(source);
  const compiled: CompiledExpression = {
    source,
    ast,
    evaluate(variables, options) {
      const evaluator = new Evaluator(options);
      return evaluator.plain(evaluator.evaluate(ast, buildScope(variables)), ast.pos);
    },
  };
  cache.set(source, compiled);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return compiled;
}

export function evaluateExpression(source: string, variables: Record<string, unknown>, options?: EvalOptions): Value {
  return compileExpression(source).evaluate(variables, options);
}

export interface ExpressionCheck {
  ok: boolean;
  error?: { message: string; code: string; position: number };
}

export function checkExpression(source: string): ExpressionCheck {
  try {
    compileExpression(source);
    return { ok: true };
  } catch (err) {
    if (err instanceof ExpressionError) {
      return { ok: false, error: { message: err.message, code: err.code, position: err.position } };
    }
    throw err;
  }
}

/**
 * Collects `root.member` paths read by an expression, e.g. `steps.fetch` for
 * `steps.fetch.output.status`. Lambda parameters are excluded.
 */
export function collectReferences(ast: Expr): { root: string; member?: string }[] {
  const out: { root: string; member?: string }[] = [];
  const visit = (node: Expr, bound: Set<string>): void => {
    switch (node.type) {
      case "Identifier":
        if (!bound.has(node.name)) out.push({ root: node.name });
        return;
      case "Member":
        if (node.object.type === "Identifier" && typeof node.property === "string" && !bound.has(node.object.name)) {
          out.push({ root: node.object.name, member: node.property });
          return;
        }
        visit(node.object, bound);
        if (typeof node.property !== "string") visit(node.property, bound);
        return;
      case "Call":
        node.args.forEach((a) => visit(a, bound));
        return;
      case "Unary":
        visit(node.argument, bound);
        return;
      case "Binary":
        visit(node.left, bound);
        visit(node.right, bound);
        return;
      case "Conditional":
        visit(node.test, bound);
        visit(node.consequent, bound);
        visit(node.alternate, bound);
        return;
      case "Array":
        node.elements.forEach((e) => visit(e, bound));
        return;
      case "Object":
        node.entries.forEach((e) => visit(e.value, bound));
        return;
      case "Lambda":
        visit(node.body, new Set([...bound, ...node.params]));
        return;
      case "Literal":
        return;
    }
  };
  visit(ast, new Set());
  return out;
}

// ---- templates -----------------------------------------------------------

export type TemplatePart = { kind: "text"; value: string } | { kind: "expr"; expr: CompiledExpression; offset: number };

/** Splits `Hello {{ trigger.name }}!` into text and expression parts. */
export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{{", i);
    if (open === -1) {
      parts.push({ kind: "text", value: template.slice(i) });
      break;
    }
    if (open > i) parts.push({ kind: "text", value: template.slice(i, open) });
    const close = findClose(template, open + 2);
    if (close === -1) throw new ExpressionError("unterminated '{{' in template", "E_SYNTAX", open);
    const source = template.slice(open + 2, close);
    try {
      parts.push({ kind: "expr", expr: compileExpression(source.trim()), offset: open + 2 });
    } catch (err) {
      if (err instanceof ExpressionError) {
        throw new ExpressionError(err.message, err.code, open + 2 + err.position);
      }
      throw err;
    }
    i = close + 2;
  }
  return parts;
}

function findClose(template: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < template.length; i++) {
    const ch = template.charAt(i);
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "}" && template.charAt(i + 1) === "}") {
      // Prefer the last '}' of a run so `{{ {a: 1}}}` closes after the object literal.
      let end = i;
      while (template.charAt(end + 2) === "}") end++;
      return end;
    }
  }
  return -1;
}

/**
 * Renders a template. A template consisting of exactly one `{{ expr }}` returns
 * the raw value (so numbers/objects keep their type); otherwise parts are
 * stringified and concatenated.
 */
export function renderTemplate(template: string, variables: Record<string, unknown>, options?: EvalOptions): Value {
  const parts = parseTemplate(template);
  const only = parts[0];
  if (parts.length === 1 && only?.kind === "expr") return only.expr.evaluate(variables, options);
  return parts.map((p) => (p.kind === "text" ? p.value : stringify(p.expr.evaluate(variables, options)))).join("");
}

/** Recursively renders templates inside strings of a JSON-like structure. */
export function renderDeep(value: unknown, variables: Record<string, unknown>, options?: EvalOptions): Value {
  if (typeof value === "string") return value.includes("{{") ? renderTemplate(value, variables, options) : value;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, variables, options));
  if (value !== null && typeof value === "object") {
    const out: Record<string, Value> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, variables, options);
    return toValue(out);
  }
  return toValue(value);
}

export function checkTemplate(template: string): ExpressionCheck {
  try {
    parseTemplate(template);
    return { ok: true };
  } catch (err) {
    if (err instanceof ExpressionError) {
      return { ok: false, error: { message: err.message, code: err.code, position: err.position } };
    }
    throw err;
  }
}
