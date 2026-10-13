import type { Expr, LambdaNode } from "./ast.js";
import { BUILTINS } from "./builtins.js";
import { ExpressionError } from "./errors.js";

/** A JSON-compatible value as seen by expressions. */
export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };

/** Runtime-only callable produced by an arrow lambda; never escapes an evaluation. */
export class LambdaValue {
  constructor(
    readonly node: LambdaNode,
    readonly scope: Scope,
  ) {}
}

export type RuntimeValue = Value | LambdaValue;

export interface EvalLimits {
  /** Maximum number of AST node evaluations (including lambda bodies). */
  maxSteps: number;
  maxStringLength: number;
  maxArrayLength: number;
}

export interface EvalOptions extends Partial<EvalLimits> {
  /** Clock used by `now()`; injectable for deterministic tests. */
  now?: () => number;
}

export const DEFAULT_LIMITS: EvalLimits = { maxSteps: 20_000, maxStringLength: 100_000, maxArrayLength: 10_000 };

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

export class Scope {
  constructor(
    private readonly vars: ReadonlyMap<string, RuntimeValue>,
    private readonly parent?: Scope,
  ) {}

  lookup(name: string): RuntimeValue | undefined {
    if (this.vars.has(name)) return this.vars.get(name);
    return this.parent?.lookup(name);
  }

  child(vars: Map<string, RuntimeValue>): Scope {
    return new Scope(vars, this);
  }
}

export function isPlainObject(value: unknown): value is { [key: string]: Value } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function typeName(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof LambdaValue) return "lambda";
  return typeof value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

export function truthy(value: RuntimeValue): boolean {
  if (value === null || value === false || value === 0 || value === "") return false;
  return !(typeof value === "number" && Number.isNaN(value));
}

/** Converts host data (from JSON payloads) into expression values, rejecting exotic objects. */
export function toValue(input: unknown, depth = 0): Value {
  if (depth > 64) throw new ExpressionError("value nesting too deep", "E_SIZE_LIMIT", 0);
  if (input === undefined || input === null) return null;
  if (typeof input === "boolean" || typeof input === "string") return input;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  if (Array.isArray(input)) return input.map((v) => toValue(v, depth + 1));
  if (input instanceof Date) return input.toISOString();
  if (isPlainObject(input)) {
    const out: { [key: string]: Value } = Object.create(null) as { [key: string]: Value };
    for (const [k, v] of Object.entries(input)) {
      if (!FORBIDDEN.has(k)) out[k] = toValue(v, depth + 1);
    }
    return out;
  }
  return null;
}

export class Evaluator {
  private steps = 0;
  readonly limits: EvalLimits;
  readonly now: () => number;

  constructor(options: EvalOptions = {}) {
    this.limits = {
      maxSteps: options.maxSteps ?? DEFAULT_LIMITS.maxSteps,
      maxStringLength: options.maxStringLength ?? DEFAULT_LIMITS.maxStringLength,
      maxArrayLength: options.maxArrayLength ?? DEFAULT_LIMITS.maxArrayLength,
    };
    this.now = options.now ?? Date.now;
  }

  get stepCount(): number {
    return this.steps;
  }

  tick(pos: number, cost = 1): void {
    this.steps += cost;
    if (this.steps > this.limits.maxSteps) {
      throw new ExpressionError(`evaluation exceeded ${this.limits.maxSteps} steps`, "E_STEP_LIMIT", pos);
    }
  }

  checkString(value: string, pos: number): string {
    if (value.length > this.limits.maxStringLength) {
      throw new ExpressionError(`string exceeds ${this.limits.maxStringLength} characters`, "E_SIZE_LIMIT", pos);
    }
    return value;
  }

  checkArray<T>(value: T[], pos: number): T[] {
    if (value.length > this.limits.maxArrayLength) {
      throw new ExpressionError(`array exceeds ${this.limits.maxArrayLength} items`, "E_SIZE_LIMIT", pos);
    }
    return value;
  }

  evaluate(node: Expr, scope: Scope): RuntimeValue {
    this.tick(node.pos);
    switch (node.type) {
      case "Literal":
        return node.value;
      case "Identifier": {
        const value = scope.lookup(node.name);
        if (value === undefined) {
          throw new ExpressionError(`unknown identifier '${node.name}'`, "E_REFERENCE", node.pos);
        }
        return value;
      }
      case "Member":
        return this.evalMember(node.object, node.property, node.optional, node.pos, scope);
      case "Call":
        return this.evalCall(node.callee, node.args, node.pos, scope);
      case "Unary": {
        const arg = this.evaluate(node.argument, scope);
        if (node.operator === "!") return !truthy(arg);
        const n = this.expectNumber(arg, node.operator, node.pos);
        return node.operator === "-" ? -n : n;
      }
      case "Binary":
        return this.evalBinary(node.operator, node.left, node.right, node.pos, scope);
      case "Conditional":
        return truthy(this.evaluate(node.test, scope))
          ? this.evaluate(node.consequent, scope)
          : this.evaluate(node.alternate, scope);
      case "Array": {
        const items = node.elements.map((e) => this.plain(this.evaluate(e, scope), e.pos));
        return this.checkArray(items, node.pos);
      }
      case "Object": {
        const out: { [key: string]: Value } = Object.create(null) as { [key: string]: Value };
        for (const entry of node.entries) out[entry.key] = this.plain(this.evaluate(entry.value, scope), node.pos);
        return out;
      }
      case "Lambda":
        return new LambdaValue(node, scope);
    }
  }

  /** Invokes a lambda with positional arguments. */
  call(fn: RuntimeValue, args: Value[], pos: number): Value {
    if (!(fn instanceof LambdaValue)) {
      throw new ExpressionError(`expected a lambda but got ${typeName(fn)}`, "E_TYPE", pos);
    }
    const vars = new Map<string, RuntimeValue>();
    fn.node.params.forEach((p, i) => vars.set(p, args[i] ?? null));
    return this.plain(this.evaluate(fn.node.body, fn.scope.child(vars)), fn.node.pos);
  }

  plain(value: RuntimeValue, pos: number): Value {
    if (value instanceof LambdaValue) {
      throw new ExpressionError("lambdas can only be passed to functions", "E_TYPE", pos);
    }
    return value;
  }

  expectNumber(value: RuntimeValue, op: string, pos: number): number {
    if (typeof value !== "number") {
      throw new ExpressionError(`operator '${op}' expects a number but got ${typeName(value)}`, "E_TYPE", pos);
    }
    return value;
  }

  private evalMember(objectNode: Expr, property: string | Expr, optional: boolean, pos: number, scope: Scope): Value {
    const object = this.plain(this.evaluate(objectNode, scope), pos);
    if (object === null) {
      if (optional) return null;
      const label = typeof property === "string" ? `'${property}'` : "index";
      throw new ExpressionError(`cannot read ${label} of null`, "E_TYPE", pos);
    }
    const key = typeof property === "string" ? property : this.plain(this.evaluate(property, scope), pos);
    return readProperty(object, key, pos);
  }

  private evalCall(callee: string, args: Expr[], pos: number, scope: Scope): Value {
    const builtin = Object.hasOwn(BUILTINS, callee) ? BUILTINS[callee] : undefined;
    if (!builtin) throw new ExpressionError(`unknown function '${callee}'`, "E_CALL", pos);
    if (args.length < builtin.minArgs || args.length > builtin.maxArgs) {
      const range = builtin.minArgs === builtin.maxArgs ? `${builtin.minArgs}` : `${builtin.minArgs}-${builtin.maxArgs}`;
      throw new ExpressionError(`${callee}() expects ${range} arguments, got ${args.length}`, "E_CALL", pos);
    }
    const values = args.map((a) => this.evaluate(a, scope));
    const result = builtin.fn(values, { evaluator: this, pos, name: callee });
    if (typeof result === "string") this.checkString(result, pos);
    if (Array.isArray(result)) this.checkArray(result, pos);
    return result;
  }

  private evalBinary(op: string, leftNode: Expr, rightNode: Expr, pos: number, scope: Scope): Value {
    if (op === "&&" || op === "||" || op === "??") {
      const left = this.plain(this.evaluate(leftNode, scope), pos);
      if (op === "&&") return truthy(left) ? this.plain(this.evaluate(rightNode, scope), pos) : left;
      if (op === "||") return truthy(left) ? left : this.plain(this.evaluate(rightNode, scope), pos);
      return left !== null ? left : this.plain(this.evaluate(rightNode, scope), pos);
    }
    const left = this.plain(this.evaluate(leftNode, scope), pos);
    const right = this.plain(this.evaluate(rightNode, scope), pos);
    switch (op) {
      case "==":
        return deepEqual(left, right);
      case "!=":
        return !deepEqual(left, right);
      case "+":
        return this.add(left, right, pos);
      case "-":
        return this.expectNumber(left, op, pos) - this.expectNumber(right, op, pos);
      case "*":
        return this.finite(this.expectNumber(left, op, pos) * this.expectNumber(right, op, pos), pos);
      case "/":
      case "%": {
        const a = this.expectNumber(left, op, pos);
        const b = this.expectNumber(right, op, pos);
        if (b === 0) throw new ExpressionError("division by zero", "E_TYPE", pos);
        return op === "/" ? a / b : a % b;
      }
      case "<":
      case "<=":
      case ">":
      case ">=":
        return compare(op, left, right, pos);
      case "in":
        return this.contains(right, left, pos);
      default:
        throw new ExpressionError(`unsupported operator '${op}'`, "E_SYNTAX", pos);
    }
  }

  private finite(n: number, pos: number): number {
    if (!Number.isFinite(n)) throw new ExpressionError("numeric overflow", "E_TYPE", pos);
    return n;
  }

  private add(left: Value, right: Value, pos: number): Value {
    if (typeof left === "number" && typeof right === "number") return this.finite(left + right, pos);
    if (typeof left === "string" || typeof right === "string") {
      if (isComposite(left) || isComposite(right)) {
        throw new ExpressionError("cannot concatenate a string with an array or object", "E_TYPE", pos);
      }
      return this.checkString(stringify(left) + stringify(right), pos);
    }
    if (Array.isArray(left) && Array.isArray(right)) return this.checkArray([...left, ...right], pos);
    throw new ExpressionError(`cannot add ${typeName(left)} and ${typeName(right)}`, "E_TYPE", pos);
  }

  contains(container: Value, item: Value, pos: number): boolean {
    if (Array.isArray(container)) {
      this.tick(pos, container.length);
      return container.some((v) => deepEqual(v, item));
    }
    if (typeof container === "string") {
      if (typeof item !== "string") throw new ExpressionError("'in' on a string expects a string", "E_TYPE", pos);
      return container.includes(item);
    }
    if (isPlainObject(container)) {
      if (typeof item !== "string") throw new ExpressionError("'in' on an object expects a string key", "E_TYPE", pos);
      return Object.hasOwn(container, item);
    }
    throw new ExpressionError(`'in' is not supported on ${typeName(container)}`, "E_TYPE", pos);
  }
}

function isComposite(value: Value): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

export function stringify(value: Value): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function compare(op: string, left: Value, right: Value, pos: number): boolean {
  const comparable =
    (typeof left === "number" && typeof right === "number") || (typeof left === "string" && typeof right === "string");
  if (!comparable) {
    throw new ExpressionError(`cannot compare ${typeName(left)} with ${typeName(right)}`, "E_TYPE", pos);
  }
  const a = left as number | string;
  const b = right as number | string;
  if (op === "<") return a < b;
  if (op === "<=") return a <= b;
  if (op === ">") return a > b;
  return a >= b;
}

/** Sandboxed property read: own data properties of plain objects/arrays/strings only. */
export function readProperty(object: Value, key: Value, pos: number): Value {
  if (typeof key === "string" && FORBIDDEN.has(key)) {
    throw new ExpressionError(`access to '${key}' is not allowed`, "E_FORBIDDEN", pos);
  }
  if (Array.isArray(object) || typeof object === "string") {
    if (key === "length") return object.length;
    if (typeof key !== "number" || !Number.isInteger(key)) {
      throw new ExpressionError(`${typeName(object)} index must be an integer`, "E_TYPE", pos);
    }
    const index = key < 0 ? object.length + key : key;
    if (typeof object === "string") return object.charAt(index) || null;
    return object[index] ?? null;
  }
  if (isPlainObject(object)) {
    if (typeof key !== "string" && typeof key !== "number") {
      throw new ExpressionError("object key must be a string", "E_TYPE", pos);
    }
    const k = String(key);
    return Object.hasOwn(object, k) ? (object[k] ?? null) : null;
  }
  throw new ExpressionError(`cannot read properties of ${typeName(object)}`, "E_TYPE", pos);
}
