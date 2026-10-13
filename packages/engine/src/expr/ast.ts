export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||"
  | "??"
  | "in";

export type UnaryOperator = "!" | "-" | "+";

interface Base {
  pos: number;
}

export interface LiteralNode extends Base {
  type: "Literal";
  value: string | number | boolean | null;
}

export interface IdentifierNode extends Base {
  type: "Identifier";
  name: string;
}

export interface MemberNode extends Base {
  type: "Member";
  object: Expr;
  /** Static property name (`a.b`) or computed key expression (`a[b]`). */
  property: string | Expr;
  optional: boolean;
}

export interface CallNode extends Base {
  type: "Call";
  callee: string;
  args: Expr[];
}

export interface UnaryNode extends Base {
  type: "Unary";
  operator: UnaryOperator;
  argument: Expr;
}

export interface BinaryNode extends Base {
  type: "Binary";
  operator: BinaryOperator;
  left: Expr;
  right: Expr;
}

export interface ConditionalNode extends Base {
  type: "Conditional";
  test: Expr;
  consequent: Expr;
  alternate: Expr;
}

export interface ArrayNode extends Base {
  type: "Array";
  elements: Expr[];
}

export interface ObjectNode extends Base {
  type: "Object";
  entries: { key: string; value: Expr }[];
}

export interface LambdaNode extends Base {
  type: "Lambda";
  params: string[];
  body: Expr;
}

export type Expr =
  | LiteralNode
  | IdentifierNode
  | MemberNode
  | CallNode
  | UnaryNode
  | BinaryNode
  | ConditionalNode
  | ArrayNode
  | ObjectNode
  | LambdaNode;
