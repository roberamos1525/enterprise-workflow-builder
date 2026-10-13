import { ExpressionError } from "./errors.js";
import {
  deepEqual,
  isPlainObject,
  readProperty,
  stringify,
  toValue,
  truthy,
  typeName,
  type Evaluator,
  type RuntimeValue,
  type Value,
} from "./evaluator.js";

export interface CallContext {
  evaluator: Evaluator;
  pos: number;
  name: string;
}

export interface Builtin {
  minArgs: number;
  maxArgs: number;
  description: string;
  fn: (args: RuntimeValue[], ctx: CallContext) => Value;
}

type Obj = { [key: string]: Value };

function fail(ctx: CallContext, message: string): never {
  throw new ExpressionError(`${ctx.name}(): ${message}`, "E_TYPE", ctx.pos);
}

function str(ctx: CallContext, v: RuntimeValue | undefined, label = "argument"): string {
  if (typeof v !== "string") fail(ctx, `${label} must be a string, got ${typeName(v)}`);
  return v;
}

function num(ctx: CallContext, v: RuntimeValue | undefined, label = "argument"): number {
  if (typeof v !== "number") fail(ctx, `${label} must be a number, got ${typeName(v)}`);
  return v;
}

function int(ctx: CallContext, v: RuntimeValue | undefined, label = "argument"): number {
  const n = num(ctx, v, label);
  if (!Number.isInteger(n)) fail(ctx, `${label} must be an integer`);
  return n;
}

function arr(ctx: CallContext, v: RuntimeValue | undefined, label = "argument"): Value[] {
  if (!Array.isArray(v)) fail(ctx, `${label} must be an array, got ${typeName(v)}`);
  return v;
}

function obj(ctx: CallContext, v: RuntimeValue | undefined, label = "argument"): Obj {
  if (!isPlainObject(v)) fail(ctx, `${label} must be an object, got ${typeName(v)}`);
  return v;
}

function plain(ctx: CallContext, v: RuntimeValue | undefined): Value {
  return ctx.evaluator.plain(v ?? null, ctx.pos);
}

function newObject(): Obj {
  return Object.create(null) as Obj;
}

/** Applies `fn` to every item, charging one evaluation step per item. */
function mapItems(ctx: CallContext, items: Value[], fn: RuntimeValue | undefined): Value[] {
  return items.map((item, index) => {
    ctx.evaluator.tick(ctx.pos);
    return ctx.evaluator.call(fn ?? null, [item, index], ctx.pos);
  });
}

function sortKey(ctx: CallContext, a: Value, b: Value): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (a === null && b === null) return 0;
  return fail(ctx, `cannot order ${typeName(a)} and ${typeName(b)}`);
}

function aggregate(ctx: CallContext, args: RuntimeValue[]): number[] {
  const values = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  return values.map((v) => num(ctx, v, "value"));
}

const b = (minArgs: number, maxArgs: number, description: string, fn: Builtin["fn"]): Builtin => ({
  minArgs,
  maxArgs,
  description,
  fn,
});

export const BUILTINS: Readonly<Record<string, Builtin>> = Object.freeze({
  // ---- type helpers -------------------------------------------------------
  type: b(1, 1, "type name of a value", (a, c) => typeName(plain(c, a[0]))),
  isNull: b(1, 1, "true when the value is null", (a) => a[0] === null),
  coalesce: b(1, 16, "first non-null argument", (a, c) => plain(c, a.find((v) => v !== null) ?? null)),
  string: b(1, 1, "convert to string", (a, c) => stringify(plain(c, a[0]))),
  number: b(1, 1, "convert to number", (a, c) => {
    const v = plain(c, a[0]);
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return fail(c, `cannot convert ${JSON.stringify(v)} to a number`);
  }),
  boolean: b(1, 1, "truthiness of a value", (a) => truthy(a[0] ?? null)),
  // ---- strings --------------------------------------------------------------
  len: b(1, 1, "length of a string, array or object", (a, c) => {
    const v = plain(c, a[0]);
    if (typeof v === "string" || Array.isArray(v)) return v.length;
    if (isPlainObject(v)) return Object.keys(v).length;
    return fail(c, `cannot take length of ${typeName(v)}`);
  }),
  upper: b(1, 1, "upper-case a string", (a, c) => str(c, a[0]).toUpperCase()),
  lower: b(1, 1, "lower-case a string", (a, c) => str(c, a[0]).toLowerCase()),
  trim: b(1, 1, "strip surrounding whitespace", (a, c) => str(c, a[0]).trim()),
  startsWith: b(2, 2, "string prefix test", (a, c) => str(c, a[0]).startsWith(str(c, a[1]))),
  endsWith: b(2, 2, "string suffix test", (a, c) => str(c, a[0]).endsWith(str(c, a[1]))),
  contains: b(2, 2, "substring / element / key test", (a, c) => c.evaluator.contains(plain(c, a[0]), plain(c, a[1]), c.pos)),
  split: b(2, 2, "split a string by a separator", (a, c) => {
    const parts = str(c, a[0]).split(str(c, a[1], "separator"));
    return c.evaluator.checkArray(parts, c.pos);
  }),
  join: b(1, 2, "join array items with a separator", (a, c) =>
    arr(c, a[0])
      .map((v) => stringify(v))
      .join(a[1] === undefined ? "," : str(c, a[1], "separator")),
  ),
  replace: b(3, 3, "replace all literal occurrences", (a, c) => {
    const search = str(c, a[1], "search");
    if (search === "") fail(c, "search string must not be empty");
    return c.evaluator.checkString(str(c, a[0]).split(search).join(str(c, a[2], "replacement")), c.pos);
  }),
  padStart: b(2, 3, "left-pad a string", (a, c) => {
    const width = int(c, a[1], "width");
    if (width > c.evaluator.limits.maxStringLength) fail(c, "width too large");
    return str(c, a[0]).padStart(width, a[2] === undefined ? " " : str(c, a[2], "fill"));
  }),
  repeat: b(2, 2, "repeat a string n times", (a, c) => {
    const s = str(c, a[0]);
    const n = int(c, a[1], "count");
    if (n < 0 || s.length * n > c.evaluator.limits.maxStringLength) fail(c, "result too large");
    return s.repeat(n);
  }),
  // ---- numbers --------------------------------------------------------------
  round: b(1, 2, "round to n decimals", (a, c) => {
    const digits = a[1] === undefined ? 0 : int(c, a[1], "digits");
    if (digits < 0 || digits > 10) fail(c, "digits must be between 0 and 10");
    const f = 10 ** digits;
    return Math.round(num(c, a[0]) * f) / f;
  }),
  floor: b(1, 1, "round down", (a, c) => Math.floor(num(c, a[0]))),
  ceil: b(1, 1, "round up", (a, c) => Math.ceil(num(c, a[0]))),
  abs: b(1, 1, "absolute value", (a, c) => Math.abs(num(c, a[0]))),
  min: b(1, 32, "smallest number", (a, c) => {
    const v = aggregate(c, a);
    return v.length === 0 ? null : Math.min(...v);
  }),
  max: b(1, 32, "largest number", (a, c) => {
    const v = aggregate(c, a);
    return v.length === 0 ? null : Math.max(...v);
  }),
  sum: b(1, 1, "sum of numbers", (a, c) => aggregate(c, a).reduce((s, n) => s + n, 0)),
  avg: b(1, 1, "mean of numbers", (a, c) => {
    const v = aggregate(c, a);
    return v.length === 0 ? null : v.reduce((s, n) => s + n, 0) / v.length;
  }),
  // ---- arrays -----------------------------------------------------------------
  range: b(1, 2, "integers from start (inclusive) to end (exclusive)", (a, c) => {
    const start = a.length === 2 ? int(c, a[0], "start") : 0;
    const end = int(c, a.length === 2 ? a[1] : a[0], "end");
    const size = Math.max(0, end - start);
    if (size > c.evaluator.limits.maxArrayLength) fail(c, "range too large");
    c.evaluator.tick(c.pos, size);
    return Array.from({ length: size }, (_, i) => start + i);
  }),
  map: b(2, 2, "transform each item with a lambda", (a, c) => mapItems(c, arr(c, a[0]), a[1])),
  filter: b(2, 2, "keep items where the lambda is truthy", (a, c) => {
    const items = arr(c, a[0]);
    const keep = mapItems(c, items, a[1]);
    return items.filter((_, i) => truthy(keep[i] ?? null));
  }),
  find: b(2, 2, "first item where the lambda is truthy", (a, c) => {
    for (const [i, item] of arr(c, a[0]).entries()) {
      c.evaluator.tick(c.pos);
      if (truthy(c.evaluator.call(a[1] ?? null, [item, i], c.pos))) return item;
    }
    return null;
  }),
  some: b(2, 2, "true when any item matches", (a, c) =>
    arr(c, a[0]).some((item, i) => {
      c.evaluator.tick(c.pos);
      return truthy(c.evaluator.call(a[1] ?? null, [item, i], c.pos));
    }),
  ),
  every: b(2, 2, "true when all items match", (a, c) =>
    arr(c, a[0]).every((item, i) => {
      c.evaluator.tick(c.pos);
      return truthy(c.evaluator.call(a[1] ?? null, [item, i], c.pos));
    }),
  ),
  reduce: b(3, 3, "fold items with (acc, item) => ...", (a, c) =>
    arr(c, a[0]).reduce<Value>((acc, item) => {
      c.evaluator.tick(c.pos);
      return c.evaluator.call(a[1] ?? null, [acc, item], c.pos);
    }, plain(c, a[2])),
  ),
  sort: b(1, 2, "sort numbers/strings, optionally by a key lambda", (a, c) => {
    const items = [...arr(c, a[0])];
    const keys = a[1] === undefined ? items : mapItems(c, items, a[1]);
    c.evaluator.tick(c.pos, items.length);
    return items
      .map((item, i) => ({ item, key: keys[i] ?? null }))
      .sort((x, y) => sortKey(c, x.key, y.key))
      .map((e) => e.item);
  }),
  reverse: b(1, 1, "reverse an array", (a, c) => [...arr(c, a[0])].reverse()),
  unique: b(1, 1, "remove duplicate items", (a, c) => {
    const out: Value[] = [];
    for (const item of arr(c, a[0])) {
      c.evaluator.tick(c.pos, out.length + 1);
      if (!out.some((v) => deepEqual(v, item))) out.push(item);
    }
    return out;
  }),
  flatten: b(1, 1, "flatten one level of nesting", (a, c) =>
    arr(c, a[0]).flatMap((v) => (Array.isArray(v) ? v : [v])),
  ),
  slice: b(2, 3, "sub-array or substring", (a, c) => {
    const v = plain(c, a[0]);
    const start = int(c, a[1], "start");
    const end = a[2] === undefined ? undefined : int(c, a[2], "end");
    if (typeof v === "string" || Array.isArray(v)) return v.slice(start, end);
    return fail(c, `cannot slice ${typeName(v)}`);
  }),
  indexOf: b(2, 2, "position of an item or substring, -1 if absent", (a, c) => {
    const v = plain(c, a[0]);
    const item = plain(c, a[1]);
    if (typeof v === "string") return v.indexOf(str(c, item, "search"));
    return arr(c, v).findIndex((x) => deepEqual(x, item));
  }),
  first: b(1, 1, "first array item", (a, c) => arr(c, a[0])[0] ?? null),
  last: b(1, 1, "last array item", (a, c) => arr(c, a[0]).at(-1) ?? null),
  // ---- objects --------------------------------------------------------------
  keys: b(1, 1, "object keys", (a, c) => Object.keys(obj(c, a[0]))),
  values: b(1, 1, "object values", (a, c) => Object.values(obj(c, a[0]))),
  entries: b(1, 1, "[key, value] pairs", (a, c) => Object.entries(obj(c, a[0])).map(([k, v]) => [k, v])),
  fromEntries: b(1, 1, "object from [key, value] pairs", (a, c) => {
    const out = newObject();
    for (const pair of arr(c, a[0])) {
      const [k, v] = arr(c, pair, "entry");
      out[str(c, k, "entry key")] = v ?? null;
    }
    return toValue(out);
  }),
  merge: b(1, 16, "shallow merge objects (later wins)", (a, c) => {
    const out = newObject();
    for (const v of a) Object.assign(out, obj(c, v));
    return out;
  }),
  pick: b(2, 2, "object with only the given keys", (a, c) => {
    const source = obj(c, a[0]);
    const out = newObject();
    for (const k of arr(c, a[1], "keys")) {
      const key = str(c, k, "key");
      if (Object.hasOwn(source, key)) out[key] = source[key] ?? null;
    }
    return out;
  }),
  omit: b(2, 2, "object without the given keys", (a, c) => {
    const drop = new Set(arr(c, a[1], "keys").map((k) => str(c, k, "key")));
    const out = newObject();
    for (const [k, v] of Object.entries(obj(c, a[0]))) if (!drop.has(k)) out[k] = v;
    return out;
  }),
  get: b(2, 3, "read a dotted path with a default", (a, c) => {
    let current = plain(c, a[0]);
    for (const segment of str(c, a[1], "path").split(".")) {
      if (current === null) break;
      const key = Array.isArray(current) && /^-?\d+$/.test(segment) ? Number(segment) : segment;
      if (!Array.isArray(current) && !isPlainObject(current)) {
        current = null;
        break;
      }
      current = readProperty(current, key, c.pos);
    }
    return current ?? plain(c, a[2] ?? null);
  }),
  // ---- dates & JSON ---------------------------------------------------------
  now: b(0, 0, "current time in epoch milliseconds", (_a, c) => c.evaluator.now()),
  toIso: b(1, 1, "epoch milliseconds to ISO-8601 string", (a, c) => {
    const d = new Date(num(c, a[0]));
    if (Number.isNaN(d.getTime())) fail(c, "invalid timestamp");
    return d.toISOString();
  }),
  parseDate: b(1, 1, "ISO-8601 string to epoch milliseconds", (a, c) => {
    const t = Date.parse(str(c, a[0]));
    if (Number.isNaN(t)) fail(c, "invalid date string");
    return t;
  }),
  jsonParse: b(1, 1, "parse a JSON string", (a, c) => {
    const s = c.evaluator.checkString(str(c, a[0]), c.pos);
    try {
      return toValue(JSON.parse(s));
    } catch {
      return fail(c, "invalid JSON");
    }
  }),
  jsonStringify: b(1, 1, "serialise a value as JSON", (a, c) => JSON.stringify(plain(c, a[0]))),
});

export function listBuiltins(): { name: string; description: string; minArgs: number; maxArgs: number }[] {
  return Object.entries(BUILTINS).map(([name, def]) => ({
    name,
    description: def.description,
    minArgs: def.minArgs,
    maxArgs: def.maxArgs,
  }));
}
