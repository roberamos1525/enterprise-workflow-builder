import { describe, expect, it } from "vitest";
import { compileExpression, ExpressionError } from "./index.js";

/** Deterministic PRNG (mulberry32) so the fuzz corpus is identical on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  "trigger", "vars", "input", ".", "?.", "[", "]", "(", ")", "{", "}", ",", ":", "?", "+", "-", "*", "/", "%", "!",
  "==", "!=", "<", ">=", "&&", "||", "??", " in ", "=>", "x", "1", "0", "2.5", "'s'", '"t"', "true", "null",
  "map", "filter", "len", "keys", "get", "range", "__proto__", "constructor", "items", "a", "repeat", "jsonParse",
];

const scope = { trigger: { items: [1, 2, 3], a: { b: "c" } }, vars: { x: 1 }, input: "str" };

describe("expression robustness", () => {
  it("only ever fails with ExpressionError on random token soup", () => {
    const random = rng(1234);
    let parsed = 0;
    for (let i = 0; i < 3000; i++) {
      const length = 1 + Math.floor(random() * 12);
      const source = Array.from({ length }, () => FRAGMENTS[Math.floor(random() * FRAGMENTS.length)]).join("");
      try {
        compileExpression(source).evaluate(scope, { maxSteps: 2000 });
        parsed++;
      } catch (err) {
        if (!(err instanceof ExpressionError)) {
          throw new Error(`non-sandboxed failure for ${JSON.stringify(source)}: ${String(err)}`);
        }
      }
    }
    expect(parsed).toBeGreaterThan(50);
  });

  it("never leaks host objects or functions into results", () => {
    const sources = ["trigger", "keys(trigger)", "map(trigger.items, i => i)", "merge(trigger.a, {z: 1})", "entries(trigger.a)"];
    for (const src of sources) {
      const value = compileExpression(src).evaluate(scope);
      const walk = (v: unknown): void => {
        expect(typeof v).not.toBe("function");
        if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(value);
    }
  });

  it("does not mutate the input scope", () => {
    const input = { list: [3, 1, 2], obj: { k: 1 } };
    const snapshot = JSON.stringify(input);
    compileExpression("sort(list)").evaluate(input);
    compileExpression("reverse(list)").evaluate(input);
    compileExpression("merge(obj, {k: 2})").evaluate(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("bounds deeply nested data and huge outputs", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = { d: deep };
    expect(() => compileExpression("x").evaluate({ x: deep })).toThrow(ExpressionError);
    expect(() => compileExpression("map(range(5000), i => repeat('ab', 20))").evaluate({}, { maxSteps: 1_000_000 })).not.toThrow();
    expect(() => compileExpression("join(map(range(9000), i => repeat('abcdefghij', 2)), '')").evaluate({}, { maxSteps: 1_000_000 })).toThrow(/exceeds/);
  });
});
