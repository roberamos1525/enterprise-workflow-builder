import { describe, expect, it } from "vitest";
import {
  checkExpression,
  checkTemplate,
  collectReferences,
  compileExpression,
  evaluateExpression,
  ExpressionError,
  renderDeep,
  renderTemplate,
} from "./index.js";
import { tokenize } from "./lexer.js";
import { parseExpression } from "./parser.js";

const ctx = {
  trigger: { amount: 1200, customer: { name: "Ada", tier: "gold" }, items: [{ sku: "a", qty: 2, price: 5 }, { sku: "b", qty: 1, price: 10 }] },
  vars: { threshold: 1000, tags: ["x", "y"] },
  steps: { fetch: { output: { status: 200, body: { ok: true } } } },
  input: { value: 3 },
};

const ev = (src: string, vars: Record<string, unknown> = ctx) => evaluateExpression(src, vars);

function expectError(src: string, code: string, vars: Record<string, unknown> = ctx): ExpressionError {
  try {
    ev(src, vars);
  } catch (err) {
    expect(err).toBeInstanceOf(ExpressionError);
    expect((err as ExpressionError).code).toBe(code);
    return err as ExpressionError;
  }
  throw new Error(`expected ${src} to throw ${code}`);
}

describe("lexer", () => {
  it("tokenizes numbers, strings, identifiers and punctuators", () => {
    const tokens = tokenize(`a.b >= 1_000.5e1 && 'x\\n' ?? "y"`);
    expect(tokens.map((t) => t.kind)).toEqual([
      "identifier", "punct", "identifier", "punct", "number", "punct", "string", "punct", "string", "eof",
    ]);
    expect(tokens[4]?.literal).toBe(10005);
    expect(tokens[6]?.literal).toBe("x\n");
  });

  it("supports unicode escapes and reports bad ones", () => {
    expect(tokenize(`'\\u0041'`)[0]?.literal).toBe("A");
    expect(() => tokenize(`'\\u00G1'`)).toThrow(/unicode/);
    expect(() => tokenize(`'\\q'`)).toThrow(/invalid escape/);
  });

  it("rejects assignment, unterminated strings and stray characters", () => {
    expect(() => tokenize("a = 1")).toThrow(/assignment/);
    expect(() => tokenize("'abc")).toThrow(/unterminated/);
    expect(() => tokenize("a # b")).toThrow(/unexpected character/);
    expect(() => tokenize("1abc")).toThrow(/identifier directly after number/);
    expect(() => tokenize("1e")).toThrow(/exponent/);
  });

  it("lexes ternary with a leading-dot number correctly", () => {
    expect(ev("true?.5:1")).toBe(0.5);
  });

  it("enforces a maximum source length", () => {
    expect(() => tokenize("1+".repeat(6000) + "1")).toThrow(/exceeds/);
  });
});

describe("parser", () => {
  it("respects operator precedence and associativity", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("10 - 4 - 3")).toBe(3);
    expect(ev("2 * 3 % 4")).toBe(2);
    expect(ev("1 < 2 == true")).toBe(true);
    expect(ev("false || true && false")).toBe(false);
    expect(ev("null ?? 1 + 1")).toBe(2);
    expect(ev("-2 * -3")).toBe(6);
    expect(ev("!true == false")).toBe(true);
  });

  it("parses nested ternaries right-associatively", () => {
    expect(ev("trigger.amount > 2000 ? 'high' : trigger.amount > 1000 ? 'mid' : 'low'")).toBe("mid");
  });

  it("parses array and object literals including shorthand and trailing commas", () => {
    expect(ev("[1, 2, 3,]")).toEqual([1, 2, 3]);
    expect(ev("{ a: 1, 'b c': 2, input }")).toEqual({ a: 1, "b c": 2, input: { value: 3 } });
  });

  it("rejects method calls, lambdas outside calls and malformed syntax", () => {
    expect(() => parseExpression("trigger.items.map(x)")).toThrow(/built-in functions/);
    expect(() => parseExpression("x => x")).toThrow(/lambdas/);
    expect(() => parseExpression("1 +")).toThrow(/end of expression/);
    expect(() => parseExpression("(1")).toThrow(/expected '\)'/);
    expect(() => parseExpression("1 2")).toThrow(/unexpected/);
    expect(() => parseExpression("")).toThrow(/empty/);
    expect(() => parseExpression("{'a' 1}")).toThrow(/':'/);
    expect(() => parseExpression("map(a, (x, x) => x)")).toThrow(/duplicate/);
  });

  it("rejects prototype-related property names at parse time", () => {
    for (const src of ["a.__proto__", "a.constructor", "a['prototype']", "{ __proto__: 1 }", "constructor"]) {
      const result = checkExpression(src);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("E_FORBIDDEN");
    }
  });

  it("limits nesting depth", () => {
    const deep = "(".repeat(80) + "1" + ")".repeat(80);
    expect(checkExpression(deep).error?.code).toBe("E_TOO_DEEP");
    expect(checkExpression("-".repeat(80) + "1").error?.code).toBe("E_TOO_DEEP");
  });

  it("reports error positions", () => {
    const result = checkExpression("1 + * 2");
    expect(result.ok).toBe(false);
    expect(result.error?.position).toBe(4);
  });
});

describe("evaluator", () => {
  it("reads nested members with dot, bracket and negative indexes", () => {
    expect(ev("trigger.customer.name")).toBe("Ada");
    expect(ev("trigger['customer']['tier']")).toBe("gold");
    expect(ev("trigger.items[1].sku")).toBe("b");
    expect(ev("trigger.items[-1].qty")).toBe(1);
    expect(ev("trigger.items.length")).toBe(2);
    expect(ev("'abc'[1]")).toBe("b");
    expect(ev("steps.fetch.output.body.ok")).toBe(true);
  });

  it("returns null for missing keys and supports optional chaining", () => {
    expect(ev("trigger.missing")).toBeNull();
    expect(ev("trigger.missing?.deeper")).toBeNull();
    expect(ev("trigger.missing?.['x']")).toBeNull();
    expectError("trigger.missing.deeper", "E_TYPE");
  });

  it("throws on unknown identifiers", () => {
    expect(expectError("unknownThing + 1", "E_REFERENCE").position).toBe(0);
  });

  it("uses deep equality and strict typing", () => {
    expect(ev("[1, {a: 2}] == [1, {a: 2}]")).toBe(true);
    expect(ev("{a: 1} != {a: 2}")).toBe(true);
    expect(ev("1 == '1'")).toBe(false);
    expectError("1 < 'a'", "E_TYPE");
    expectError("'a' - 1", "E_TYPE");
    expectError("[1] + 'a'", "E_TYPE");
    expectError("{} + {}", "E_TYPE");
  });

  it("concatenates strings and arrays with +", () => {
    expect(ev("'n=' + 5 + true")).toBe("n=5true");
    expect(ev("[1] + [2, 3]")).toEqual([1, 2, 3]);
    expect(ev("'a' < 'b'")).toBe(true);
  });

  it("short-circuits logical operators returning operand values", () => {
    expect(ev("0 || 'fallback'")).toBe("fallback");
    expect(ev("'x' && 5")).toBe(5);
    expect(ev("false && unknownName")).toBe(false);
    expect(ev("true || unknownName")).toBe(true);
    expect(ev("0 ?? 7")).toBe(0);
  });

  it("supports the in operator on arrays, strings and objects", () => {
    expect(ev("'x' in vars.tags")).toBe(true);
    expect(ev("'ell' in 'hello'")).toBe(true);
    expect(ev("'name' in trigger.customer")).toBe(true);
    expect(ev("'toString' in trigger.customer")).toBe(false);
    expectError("1 in 5", "E_TYPE");
  });

  it("rejects division by zero and overflow", () => {
    expectError("1 / 0", "E_TYPE");
    expectError("5 % 0", "E_TYPE");
    expectError("1e308 * 10", "E_TYPE");
  });

  it("cannot reach prototypes through computed keys or inherited members", () => {
    expectError("trigger[jsonParse('\"__proto__\"')]", "E_FORBIDDEN");
    expect(ev("trigger.hasOwnProperty")).toBeNull();
    expect(ev("trigger.toString")).toBeNull();
    expectError("vars.tags.push", "E_TYPE");
  });

  it("sanitises host values: drops __proto__ keys and exotic objects", () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as Record<string, unknown>;
    expect(ev("keys(x)", { x: hostile })).toEqual(["ok"]);
    expect(ev("x", { x: new Map([["a", 1]]) })).toBeNull();
    expect(ev("x", { x: () => 1 })).toBeNull();
    expect(ev("x", { x: new Date(0) })).toBe("1970-01-01T00:00:00.000Z");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("enforces the step limit against runaway computation", () => {
    expectError("map(range(5000), x => map(range(5000), y => x * y))", "E_STEP_LIMIT");
    expect(() => compileExpression("sum(range(100))").evaluate({}, { maxSteps: 50 })).toThrow(/steps/);
  });

  it("enforces string and array size limits", () => {
    expect(() => compileExpression("repeat('ab', 10)").evaluate({}, { maxStringLength: 5 })).toThrow(/result too large/);
    expect(() => compileExpression("'abc' + 'def'").evaluate({}, { maxStringLength: 5 })).toThrow(/exceeds/);
    expect(() => compileExpression("range(50)").evaluate({}, { maxArrayLength: 10 })).toThrow(/too large/);
    expect(() => compileExpression("[1,2,3]").evaluate({}, { maxArrayLength: 2 })).toThrow(/exceeds/);
  });

  it("does not let lambdas escape as values", () => {
    expect(() => parseExpression("[x => x]")).toThrow(/lambdas/);
    expectError("map([1], x => (y => y))", "E_SYNTAX");
  });
});

describe("builtins", () => {
  it("transforms collections with lambdas", () => {
    expect(ev("map(trigger.items, i => i.qty * i.price)")).toEqual([10, 10]);
    expect(ev("filter(trigger.items, i => i.price > 5)[0].sku")).toBe("b");
    expect(ev("find(trigger.items, i => i.sku == 'b').qty")).toBe(1);
    expect(ev("some(trigger.items, i => i.qty > 1)")).toBe(true);
    expect(ev("every(trigger.items, i => i.qty > 1)")).toBe(false);
    expect(ev("reduce(trigger.items, (acc, i) => acc + i.qty * i.price, 0)")).toBe(20);
    expect(ev("map([10, 20], (v, i) => v + i)")).toEqual([10, 21]);
  });

  it("sorts, dedupes and slices", () => {
    expect(ev("sort([3, 1, 2])")).toEqual([1, 2, 3]);
    expect(ev("sort(trigger.items, i => 0 - i.price)[0].sku")).toBe("b");
    expect(ev("unique([1, 1, {a: 1}, {a: 1}])")).toEqual([1, { a: 1 }]);
    expect(ev("flatten([[1], 2, [3, [4]]])")).toEqual([1, 2, 3, [4]]);
    expect(ev("slice([1, 2, 3, 4], 1, 3)")).toEqual([2, 3]);
    expect(ev("reverse([1, 2])")).toEqual([2, 1]);
    expect(ev("first([]) ?? 'none'")).toBe("none");
    expect(ev("last([1, 2])")).toBe(2);
    expect(ev("indexOf([1, 2], 2)")).toBe(1);
    expect(() => ev("sort([1, 'a'])")).toThrow(/cannot order/);
  });

  it("handles strings", () => {
    expect(ev("upper(trigger.customer.name) + lower('X')")).toBe("ADAx");
    expect(ev("split('a,b', ',')")).toEqual(["a", "b"]);
    expect(ev("join(['a', 1, null], '-')")).toBe("a-1-null");
    expect(ev("replace('a.b.c', '.', '/')")).toBe("a/b/c");
    expect(ev("trim('  hi ')")).toBe("hi");
    expect(ev("startsWith('hello', 'he') && endsWith('hello', 'lo')")).toBe(true);
    expect(ev("padStart('7', 3, '0')")).toBe("007");
    expect(ev("contains('hello', 'ell')")).toBe(true);
    expect(() => ev("upper(1)")).toThrow(/must be a string/);
  });

  it("handles numbers and aggregates", () => {
    expect(ev("round(3.14159, 2)")).toBe(3.14);
    expect(ev("floor(1.9) + ceil(1.1) + abs(-1)")).toBe(4);
    expect(ev("min(3, 1, 2)")).toBe(1);
    expect(ev("max([3, 9])")).toBe(9);
    expect(ev("sum([1, 2, 3])")).toBe(6);
    expect(ev("avg([2, 4])")).toBe(3);
    expect(ev("avg([])")).toBeNull();
    expect(ev("number('42') + number(true)")).toBe(43);
    expect(() => ev("number('abc')")).toThrow(/cannot convert/);
  });

  it("handles objects", () => {
    expect(ev("keys({b: 1, a: 2})")).toEqual(["b", "a"]);
    expect(ev("values({a: 1})")).toEqual([1]);
    expect(ev("entries({a: 1})")).toEqual([["a", 1]]);
    expect(ev("fromEntries([['k', 1]])")).toEqual({ k: 1 });
    expect(ev("merge({a: 1}, {a: 2, b: 3})")).toEqual({ a: 2, b: 3 });
    expect(ev("pick(trigger.customer, ['name'])")).toEqual({ name: "Ada" });
    expect(ev("omit(trigger.customer, ['name'])")).toEqual({ tier: "gold" });
    expect(ev("get(trigger, 'items.0.sku')")).toBe("a");
    expect(ev("get(trigger, 'nope.deeper', 'dflt')")).toBe("dflt");
    expect(ev("len(trigger.customer) + len('ab') + len([1])")).toBe(5);
  });

  it("handles types, dates and JSON with an injectable clock", () => {
    expect(ev("type([]) + type({}) + type(null) + type(1)")).toBe("arrayobjectnullnumber");
    expect(compileExpression("now()").evaluate({}, { now: () => 1234 })).toBe(1234);
    expect(ev("toIso(0)")).toBe("1970-01-01T00:00:00.000Z");
    expect(ev("parseDate('2026-01-01T00:00:00Z')")).toBe(Date.UTC(2026, 0, 1));
    expect(ev("jsonParse('{\"a\":[1]}').a[0]")).toBe(1);
    expect(ev("jsonStringify({a: 1})")).toBe('{"a":1}');
    expect(ev("coalesce(null, null, 3)")).toBe(3);
    expect(ev("isNull(trigger.nope)")).toBe(true);
    expect(() => ev("jsonParse('{')")).toThrow(/invalid JSON/);
    expect(() => ev("parseDate('nope')")).toThrow(/invalid date/);
  });

  it("validates arity and unknown functions", () => {
    expectError("len()", "E_CALL");
    expectError("len(1, 2)", "E_CALL");
    expectError("eval('1')", "E_CALL");
    expectError("toString(1)", "E_CALL");
  });
});

describe("templates", () => {
  it("interpolates expressions into text", () => {
    expect(renderTemplate("Hello {{ trigger.customer.name }}, total {{ trigger.amount / 100 }}!", ctx)).toBe("Hello Ada, total 12!");
  });

  it("returns raw values for a single expression template", () => {
    expect(renderTemplate("{{ trigger.items }}", ctx)).toEqual(ctx.trigger.items);
    expect(renderTemplate("{{ {a: 1}}}", ctx)).toEqual({ a: 1 });
    expect(renderTemplate("plain text", ctx)).toBe("plain text");
  });

  it("stringifies objects inside text and handles quotes containing braces", () => {
    expect(renderTemplate("v={{ {a: 1} }}", ctx)).toBe('v={"a":1}');
    expect(renderTemplate("{{ '}}' }}!", ctx)).toBe("}}!");
  });

  it("reports template errors with absolute positions", () => {
    const check = checkTemplate("abc {{ 1 + }}");
    expect(check.ok).toBe(false);
    expect(check.error?.position).toBeGreaterThan(4);
    expect(checkTemplate("abc {{ x").error?.message).toMatch(/unterminated/);
  });

  it("renders nested structures", () => {
    expect(renderDeep({ a: "{{ input.value * 2 }}", b: ["x{{ input.value }}"], c: 5 }, ctx)).toEqual({ a: 6, b: ["x3"], c: 5 });
  });
});

describe("collectReferences", () => {
  it("lists root/member pairs and ignores lambda params", () => {
    const refs = collectReferences(parseExpression("map(steps.fetch.output.items, x => x.id + vars.prefix) + trigger"));
    expect(refs).toEqual([{ root: "steps", member: "fetch" }, { root: "vars", member: "prefix" }, { root: "trigger" }]);
  });
});
