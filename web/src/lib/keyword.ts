import type { PlanTest } from "./types"

/**
 * pytest's `-k` expressions, ported from `_pytest/mark/expression.py` (MIT) so the filter behaves exactly like
 * them, errors included:
 *
 *   expression: expr? EOF
 *   expr:       and_expr ('or' and_expr)*
 *   and_expr:   not_expr ('and' not_expr)*
 *   not_expr:   'not' not_expr | '(' expr ')' | ident kwargs?
 *   ident:      (\w|:|\+|-|\.|\[|\]|\\|/)+
 *
 * A word matches a test when it's a case-insensitive substring of one of its keywords (see `keywordsOf`).
 */
export class FilterError extends Error {}

const TOKENS = {
  lparen: "left parenthesis",
  rparen: "right parenthesis",
  or: "or",
  and: "and",
  not: "not",
  ident: "identifier",
  eof: "end of input",
  equal: "=",
  string: "string literal",
  comma: ",",
}
type Type = keyof typeof TOKENS
type Token = { type: Type; value: string; pos: number }
type Match = (names: string[]) => boolean

const fail = (column: number, message: string): never => {
  throw new FilterError(`at column ${column}: ${message}`)
}

function lex(input: string): Token[] {
  const tokens: Token[] = []
  const single: Record<string, Type> = { "(": "lparen", ")": "rparen", "=": "equal", ",": "comma" }
  let pos = 0
  while (pos < input.length) {
    const char = input[pos]
    if (char === " " || char === "\t") pos++
    else if (single[char]) tokens.push({ type: single[char], value: char, pos: pos++ })
    else if (char === "'" || char === '"') {
      const end = input.indexOf(char, pos + 1)
      if (end === -1) fail(pos + 1, `closing quote "${char}" is missing`)
      const value = input.slice(pos, end + 1)
      if (value.includes("\\"))
        fail(pos + value.indexOf("\\") + 1, 'escaping with "\\" not supported in marker expression')
      tokens.push({ type: "string", value, pos })
      pos += value.length
    } else {
      const value = /^(?:[\p{L}\p{N}\p{Mn}\p{Pc}]|[:+\-.[\]\\/])+/u.exec(input.slice(pos))?.[0]
      if (!value) return fail(pos + 1, `unexpected character "${char}"`)
      const type = value === "or" || value === "and" || value === "not" ? value : "ident"
      tokens.push({ type, value, pos })
      pos += value.length
    }
  }
  tokens.push({ type: "eof", value: "", pos })
  return tokens
}

/** Compiles a `-k` expression into a test of a test's keywords; throws a `FilterError` if it's malformed. */
export function compileKeywords(input: string): Match {
  const tokens = lex(input)
  let index = 0
  const accept = (type: Type) => (tokens[index].type === type ? tokens[index++] : undefined)
  const reject = (...expected: Type[]): never =>
    fail(
      tokens[index].pos + 1,
      `expected ${expected.map((t) => TOKENS[t]).join(" OR ")}; got ${TOKENS[tokens[index].type]}`,
    )
  const expect = (type: Type) => accept(type) ?? reject(type)

  const expr = (): Match => {
    const terms = [and()]
    while (accept("or")) terms.push(and())
    return (names) => terms.some((term) => term(names))
  }
  const and = (): Match => {
    const terms = [not()]
    while (accept("and")) terms.push(not())
    return (names) => terms.every((term) => term(names))
  }
  const not = (): Match => {
    if (accept("not")) {
      const inner = not()
      return (names) => !inner(names)
    }
    if (accept("lparen")) {
      const inner = expr()
      expect("rparen")
      return inner
    }
    const ident = accept("ident")
    if (!ident) return reject("not", "lparen", "ident")
    if (accept("lparen")) {
      kwargs()
      expect("rparen")
      return () => {
        throw new FilterError("Keyword expressions do not support call parameters.")
      }
    }
    const word = ident.value.toLowerCase()
    return (names) => names.some((name) => name.toLowerCase().includes(word))
  }
  // only `-m` (markers) takes these, but they're parsed so errors match pytest's
  const kwargs = () => {
    do {
      const name = expect("ident")
      if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name.value))
        fail(name.pos + 1, `not a valid python identifier ${name.value}`)
      expect("equal")
      if (!accept("string")) {
        const value = expect("ident")
        if (!/^-?\d+$/.test(value.value) && !["True", "False", "None"].includes(value.value))
          fail(value.pos + 1, `unexpected character/s "${value.value}"`)
      }
    } while (accept("comma"))
  }

  if (accept("eof")) return () => false
  const match = expr()
  expect("eof")
  return match
}

/**
 * The names `-k` matches a test by: those of its nodes (directories, file, class, test with params), which
 * are in its id, and the markers and other keywords the plugin recorded (runs of older plugins have none).
 */
export function keywordsOf(test: PlanTest): string[] {
  const [path, ...rest] = test.id.split("::")
  return [...path.split("/"), ...rest, ...(test.keywords ?? [])]
}
