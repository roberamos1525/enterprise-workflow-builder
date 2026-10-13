# Expression language

Expressions are used for branch conditions, transforms, variables, delays (`until`), event filters, sub-workflow inputs
and inside `{{ … }}` templates (HTTP URL, headers and body; notification and approval texts). The implementation is in
`packages/engine/src/expr`:

- a hand-written tokenizer;
- a Pratt parser that produces an AST;
- a tree-walking evaluator with sandboxing and resource limits.

Nothing is passed to `eval` or `Function`.

## Variables

| Name | Value |
| --- | --- |
| `trigger` | the run input (webhook body, manual input, `{ id, type, payload }` for events, schedule payload + `scheduledFor`) |
| `input` | output of the predecessor node (an object keyed by node id when several predecessors are active or for joins) |
| `vars` | run variables (initial `variables` from the definition, plus Set Variable results) |
| `steps.<nodeId>` | `{ output, status, port, attempt }` of finished steps |
| `run` | `{ id, workflowId, version, startedAt, attempt }` |
| `event` | only in event-trigger filters |

## Syntax

- Literals:
  - numbers (`1_000`, `2.5e3`);
  - strings (`'…'` or `"…"` with `\n \t \\ \' \" \uXXXX` escapes);
  - `true`, `false` and `null`;
  - arrays `[1, 2]` and objects `{ a: 1, "b c": 2, shorthand }`.
- Member access `a.b`, `a[expr]`, optional chaining `a?.b` / `a?.[k]`, and negative indexes `items[-1]`. A missing key
  yields `null`; reading a property of `null` without `?.` is an error.
- Operators, in increasing precedence:
  1. `?:`
  2. `??`
  3. `||`
  4. `&&`
  5. `==` and `!=` (deep equality, no type coercion)
  6. `<`, `<=`, `>`, `>=` and `in`
  7. `+` and `-`
  8. `*`, `/` and `%`
  9. unary `!`, `-` and `+`
- `+` adds numbers, concatenates when one side is a string, and concatenates two arrays. Comparing mixed types or
  dividing by zero is an error.
- `in` tests array membership (deep equality), substrings, or object own keys.
- Calls are only allowed to built-in functions. Lambdas (`x => …`, `(acc, x) => …`) are only allowed as function
  arguments.

## Built-in functions (54)

| Group | Functions |
| --- | --- |
| Types | `type`, `isNull`, `coalesce`, `string`, `number`, `boolean` |
| Strings | `len`, `upper`, `lower`, `trim`, `startsWith`, `endsWith`, `contains`, `split`, `join`, `replace`, `padStart`, `repeat` |
| Numbers | `round(x, digits)`, `floor`, `ceil`, `abs`, `min`, `max`, `sum`, `avg` |
| Arrays | `range`, `map`, `filter`, `find`, `some`, `every`, `reduce`, `sort(arr, keyFn?)`, `reverse`, `unique`, `flatten`, `slice`, `indexOf`, `first`, `last` |
| Objects | `keys`, `values`, `entries`, `fromEntries`, `merge`, `pick`, `omit`, `get(obj, "a.b.0", default)` |
| Dates & JSON | `now()` (engine clock), `toIso(ms)`, `parseDate(iso)`, `jsonParse`, `jsonStringify` |

`GET /api/catalog` lists the functions with descriptions.

## Templates

`"Order {{ trigger.id }} totals {{ round(trigger.amount, 2) }}"` interpolates values. A template that consists of exactly
one `{{ expr }}` returns the raw value, which is useful for JSON bodies: `{{ { id: trigger.id } }}`.

## Sandbox and limits

- `__proto__`, `constructor` and `prototype` are rejected as identifiers, property names, object keys and computed keys.
- Only own properties of plain objects, arrays and strings can be read, so inherited members such as `toString` read as
  `null`. Host data is copied into null-prototype objects, and functions or exotic objects become `null`.
- There are no method calls, assignments or loops. Lambdas cannot be returned or stored.
- Limits:
  - source length 10,000 characters and nesting depth 48;
  - 20,000 evaluation steps (lambda iterations count);
  - strings of at most 100,000 characters and arrays of at most 10,000 items.
- Errors are `ExpressionError` with a `code` (`E_SYNTAX`, `E_TYPE`, `E_REFERENCE`, `E_FORBIDDEN`, `E_STEP_LIMIT`, …) and
  a character `position`, which the editor uses for inline feedback. In a running workflow they fail the step with
  `EXPRESSION_ERROR`, which is not retried.

A deterministic fuzz test (`expr/robustness.test.ts`) evaluates 3,000 random token sequences. It asserts that only
`ExpressionError` is ever thrown and that inputs are never mutated.
