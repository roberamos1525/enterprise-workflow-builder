import { ExpressionError } from "./errors.js";

export type TokenKind = "number" | "string" | "identifier" | "keyword" | "punct" | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  /** Parsed literal value for number/string tokens. */
  literal?: number | string;
  start: number;
  end: number;
}

const KEYWORDS = new Set(["true", "false", "null", "in"]);

/** Multi-character punctuators first so the longest match wins. */
const PUNCTUATORS = [
  "?.",
  "??",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ".",
  "?",
  ":",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
  "<",
  ">",
];

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "0": "\0" };

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "$";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

export function tokenize(source: string, maxLength = 10_000): Token[] {
  if (source.length > maxLength) {
    throw new ExpressionError(`expression exceeds ${maxLength} characters`, "E_TOO_LONG", 0);
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    const start = i;
    if (isDigit(ch) || (ch === "." && isDigit(source.charAt(i + 1)))) {
      i = readNumber(source, i, tokens);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = readString(source, i, tokens);
      continue;
    }
    if (isIdentStart(ch)) {
      while (i < source.length && isIdentPart(source.charAt(i))) i++;
      const value = source.slice(start, i);
      tokens.push({ kind: KEYWORDS.has(value) ? "keyword" : "identifier", value, start, end: i });
      continue;
    }
    const punct = PUNCTUATORS.find((p) => source.startsWith(p, i));
    if (punct) {
      // `a?.5:1` must lex as `a ? .5 : 1`, mirroring JavaScript.
      if (punct === "?." && isDigit(source.charAt(i + 2))) {
        tokens.push({ kind: "punct", value: "?", start, end: i + 1 });
        i += 1;
        continue;
      }
      tokens.push({ kind: "punct", value: punct, start, end: i + punct.length });
      i += punct.length;
      continue;
    }
    if (ch === "=") {
      throw new ExpressionError("assignment is not supported; use '==' to compare", "E_SYNTAX", i);
    }
    throw new ExpressionError(`unexpected character '${ch}'`, "E_SYNTAX", i);
  }
  tokens.push({ kind: "eof", value: "", start: source.length, end: source.length });
  return tokens;
}

function readNumber(source: string, start: number, tokens: Token[]): number {
  let i = start;
  while (isDigit(source.charAt(i)) || source.charAt(i) === "_") i++;
  if (source.charAt(i) === "." && isDigit(source.charAt(i + 1))) {
    i++;
    while (isDigit(source.charAt(i))) i++;
  }
  if (source.charAt(i) === "e" || source.charAt(i) === "E") {
    let j = i + 1;
    if (source.charAt(j) === "+" || source.charAt(j) === "-") j++;
    if (!isDigit(source.charAt(j))) throw new ExpressionError("malformed exponent", "E_SYNTAX", i);
    while (isDigit(source.charAt(j))) j++;
    i = j;
  }
  if (isIdentStart(source.charAt(i))) {
    throw new ExpressionError("identifier directly after number", "E_SYNTAX", i);
  }
  const raw = source.slice(start, i);
  const literal = Number(raw.replaceAll("_", ""));
  if (!Number.isFinite(literal)) throw new ExpressionError(`invalid number '${raw}'`, "E_SYNTAX", start);
  tokens.push({ kind: "number", value: raw, literal, start, end: i });
  return i;
}

function readString(source: string, start: number, tokens: Token[]): number {
  const quote = source.charAt(start);
  let i = start + 1;
  let out = "";
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === quote) {
      tokens.push({ kind: "string", value: source.slice(start, i + 1), literal: out, start, end: i + 1 });
      return i + 1;
    }
    if (ch === "\\") {
      const next = source.charAt(i + 1);
      if (next === "u") {
        const hex = source.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ExpressionError("invalid unicode escape", "E_SYNTAX", i);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      const mapped = ESCAPES[next];
      if (mapped === undefined) throw new ExpressionError(`invalid escape '\\${next}'`, "E_SYNTAX", i);
      out += mapped;
      i += 2;
      continue;
    }
    if (ch === "\n") throw new ExpressionError("unterminated string", "E_SYNTAX", start);
    out += ch;
    i++;
  }
  throw new ExpressionError("unterminated string", "E_SYNTAX", start);
}
