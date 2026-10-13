import type { BinaryOperator, Expr, LambdaNode } from "./ast.js";
import { ExpressionError } from "./errors.js";
import { tokenize, type Token } from "./lexer.js";

export interface ParseOptions {
  maxLength?: number;
  maxDepth?: number;
}

const BINARY_PRECEDENCE: Record<string, number> = {
  "??": 2,
  "||": 3,
  "&&": 4,
  "==": 5,
  "!=": 5,
  "<": 6,
  "<=": 6,
  ">": 6,
  ">=": 6,
  in: 6,
  "+": 7,
  "-": 7,
  "*": 8,
  "/": 8,
  "%": 8,
};

const UNARY_PRECEDENCE = 9;
const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Pratt parser for the workflow expression language. The grammar is a small,
 * side-effect free subset of JavaScript expressions: literals, member access,
 * whitelisted function calls, arithmetic/logic operators, the ternary operator
 * and arrow lambdas (only as function arguments).
 */
export class Parser {
  private readonly tokens: Token[];
  private index = 0;
  private depth = 0;
  private readonly maxDepth: number;

  constructor(source: string, options: ParseOptions = {}) {
    this.tokens = tokenize(source, options.maxLength);
    this.maxDepth = options.maxDepth ?? 48;
  }

  parse(): Expr {
    const expr = this.parseExpression(0);
    const next = this.peek();
    if (next.kind !== "eof") this.fail(`unexpected '${next.value}'`, next);
    return expr;
  }

  private peek(offset = 0): Token {
    const token = this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
    if (!token) throw new ExpressionError("unexpected end of input", "E_SYNTAX", 0);
    return token;
  }

  private next(): Token {
    const token = this.peek();
    if (this.index < this.tokens.length - 1) this.index++;
    return token;
  }

  private isPunct(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === "punct" && token.value === value;
  }

  private expectPunct(value: string): Token {
    const token = this.next();
    if (token.kind !== "punct" || token.value !== value) {
      this.fail(token.kind === "eof" ? `expected '${value}' but reached end` : `expected '${value}'`, token);
    }
    return token;
  }

  private fail(message: string, token: Token): never {
    throw new ExpressionError(message, "E_SYNTAX", token.start);
  }

  private enter(token: Token): void {
    this.depth++;
    if (this.depth > this.maxDepth) {
      throw new ExpressionError(`expression nesting exceeds ${this.maxDepth}`, "E_TOO_DEEP", token.start);
    }
  }

  private parseExpression(minPrecedence: number): Expr {
    const start = this.peek();
    this.enter(start);
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token.kind === "punct" && token.value === "?" && minPrecedence <= 1) {
        this.next();
        const consequent = this.parseExpression(0);
        this.expectPunct(":");
        const alternate = this.parseExpression(1);
        left = { type: "Conditional", test: left, consequent, alternate, pos: token.start };
        continue;
      }
      const operator = token.kind === "punct" || (token.kind === "keyword" && token.value === "in") ? token.value : "";
      const precedence = BINARY_PRECEDENCE[operator];
      if (precedence === undefined || precedence <= minPrecedence) break;
      this.next();
      const right = this.parseExpression(precedence);
      left = { type: "Binary", operator: operator as BinaryOperator, left, right, pos: token.start };
    }
    this.depth--;
    return left;
  }

  private parseUnary(): Expr {
    const token = this.peek();
    if (token.kind === "punct" && (token.value === "!" || token.value === "-" || token.value === "+")) {
      this.next();
      this.enter(token);
      const argument = this.parseExpression(UNARY_PRECEDENCE - 1);
      this.depth--;
      return { type: "Unary", operator: token.value, argument, pos: token.start };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(base: Expr): Expr {
    let expr = base;
    for (;;) {
      const token = this.peek();
      if (token.kind !== "punct") return expr;
      if (token.value === "." || token.value === "?.") {
        this.next();
        if (token.value === "?." && this.isPunct("[")) {
          this.next();
          const property = this.parseExpression(0);
          this.expectPunct("]");
          expr = { type: "Member", object: expr, property, optional: true, pos: token.start };
          continue;
        }
        const name = this.next();
        if (name.kind !== "identifier" && name.kind !== "keyword") this.fail("expected property name", name);
        this.checkName(name.value, name);
        expr = { type: "Member", object: expr, property: name.value, optional: token.value === "?.", pos: token.start };
        continue;
      }
      if (token.value === "[") {
        this.next();
        const property = this.parseExpression(0);
        this.expectPunct("]");
        if (property.type === "Literal" && typeof property.value === "string") this.checkName(property.value, token);
        expr = { type: "Member", object: expr, property, optional: false, pos: token.start };
        continue;
      }
      if (token.value === "(") {
        this.fail("only built-in functions can be called, e.g. len(x)", token);
      }
      return expr;
    }
  }

  private checkName(name: string, token: Token): void {
    if (FORBIDDEN_NAMES.has(name)) {
      throw new ExpressionError(`access to '${name}' is not allowed`, "E_FORBIDDEN", token.start);
    }
  }

  private parsePrimary(): Expr {
    const token = this.next();
    switch (token.kind) {
      case "number":
      case "string":
        return { type: "Literal", value: token.literal ?? null, pos: token.start };
      case "keyword":
        if (token.value === "true") return { type: "Literal", value: true, pos: token.start };
        if (token.value === "false") return { type: "Literal", value: false, pos: token.start };
        if (token.value === "null") return { type: "Literal", value: null, pos: token.start };
        return this.fail(`unexpected keyword '${token.value}'`, token);
      case "identifier":
        this.checkName(token.value, token);
        if (this.isPunct("(")) return this.parseCall(token);
        if (this.isPunct("=>")) this.fail("lambdas are only allowed as function arguments", token);
        return { type: "Identifier", name: token.value, pos: token.start };
      case "punct":
        return this.parsePunctPrimary(token);
      case "eof":
        return this.fail("unexpected end of expression", token);
    }
  }

  private parsePunctPrimary(token: Token): Expr {
    if (token.value === "(") {
      const inner = this.parseExpression(0);
      this.expectPunct(")");
      return inner;
    }
    if (token.value === "[") {
      const elements: Expr[] = [];
      while (!this.isPunct("]")) {
        elements.push(this.parseExpression(0));
        if (!this.isPunct("]")) this.expectPunct(",");
      }
      this.next();
      return { type: "Array", elements, pos: token.start };
    }
    if (token.value === "{") {
      const entries: { key: string; value: Expr }[] = [];
      while (!this.isPunct("}")) {
        const keyToken = this.next();
        if (keyToken.kind !== "identifier" && keyToken.kind !== "string" && keyToken.kind !== "keyword") {
          this.fail("expected object key", keyToken);
        }
        const key = keyToken.kind === "string" ? String(keyToken.literal) : keyToken.value;
        this.checkName(key, keyToken);
        let value: Expr;
        if (this.isPunct(":")) {
          this.next();
          value = this.parseExpression(0);
        } else if (keyToken.kind === "identifier") {
          value = { type: "Identifier", name: key, pos: keyToken.start }; // shorthand `{ a }`
        } else {
          return this.fail("expected ':' after object key", this.peek());
        }
        entries.push({ key, value });
        if (!this.isPunct("}")) this.expectPunct(",");
      }
      this.next();
      return { type: "Object", entries, pos: token.start };
    }
    return this.fail(`unexpected '${token.value}'`, token);
  }

  private parseCall(name: Token): Expr {
    this.expectPunct("(");
    const args: Expr[] = [];
    while (!this.isPunct(")")) {
      args.push(this.tryParseLambda() ?? this.parseExpression(0));
      if (!this.isPunct(")")) this.expectPunct(",");
    }
    this.next();
    return { type: "Call", callee: name.value, args, pos: name.start };
  }

  /** Recognises `x => body` and `(a, b) => body` using bounded lookahead. */
  private tryParseLambda(): LambdaNode | undefined {
    const first = this.peek();
    if (first.kind === "identifier" && this.isPunct("=>", 1)) {
      this.next();
      this.next();
      return { type: "Lambda", params: [first.value], body: this.parseExpression(0), pos: first.start };
    }
    if (!this.isPunct("(")) return undefined;
    const params: string[] = [];
    let offset = 1;
    for (;;) {
      const token = this.peek(offset);
      if (token.kind === "punct" && token.value === ")") break;
      if (token.kind !== "identifier") return undefined;
      params.push(token.value);
      offset++;
      const sep = this.peek(offset);
      if (sep.kind === "punct" && sep.value === ",") offset++;
      else if (!(sep.kind === "punct" && sep.value === ")")) return undefined;
    }
    if (!this.isPunct("=>", offset + 1)) return undefined;
    if (new Set(params).size !== params.length) this.fail("duplicate lambda parameter", first);
    for (const p of params) this.checkName(p, first);
    this.index += offset + 2;
    return { type: "Lambda", params, body: this.parseExpression(0), pos: first.start };
  }
}

export function parseExpression(source: string, options?: ParseOptions): Expr {
  if (source.trim() === "") throw new ExpressionError("expression is empty", "E_SYNTAX", 0);
  return new Parser(source, options).parse();
}
