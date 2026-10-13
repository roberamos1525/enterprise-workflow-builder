export type ExpressionErrorCode =
  | "E_SYNTAX"
  | "E_TOO_LONG"
  | "E_TOO_DEEP"
  | "E_TYPE"
  | "E_REFERENCE"
  | "E_FORBIDDEN"
  | "E_STEP_LIMIT"
  | "E_SIZE_LIMIT"
  | "E_CALL";

/** Raised for both compile-time and runtime expression failures. */
export class ExpressionError extends Error {
  readonly code: ExpressionErrorCode;
  /** Character offset in the source where the problem was detected. */
  readonly position: number;

  constructor(message: string, code: ExpressionErrorCode, position: number) {
    super(message);
    this.name = "ExpressionError";
    this.code = code;
    this.position = position;
  }
}
