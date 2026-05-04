/**
 * Boolean expression DSL for composite sensors.
 *
 * Grammar (case-insensitive keywords):
 *   expr   := orExpr
 *   orExpr := andExpr ( OR andExpr )*
 *   andExpr:= notExpr ( AND notExpr )*
 *   notExpr:= NOT notExpr | atom
 *   atom   := IDENTIFIER | "(" expr ")"
 *
 * Identifiers are [A-Za-z_][A-Za-z0-9_]*, matched to source names.
 */

export type Ast =
  | { kind: "id"; name: string }
  | { kind: "not"; expr: Ast }
  | { kind: "and"; left: Ast; right: Ast }
  | { kind: "or"; left: Ast; right: Ast };

type TokenKind = "id" | "and" | "or" | "not" | "lparen" | "rparen" | "eof";
interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

const KEYWORDS: Record<string, TokenKind> = {
  and: "and",
  or: "or",
  not: "not",
};

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "lparen", value: "(", pos: i });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "rparen", value: ")", pos: i });
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) {
        i++;
      }
      const word = src.slice(start, i);
      const kw = KEYWORDS[word.toLowerCase()];
      tokens.push({ kind: kw ?? "id", value: word, pos: start });
      continue;
    }
    throw new Error(
      `Unexpected character "${c}" at position ${i} in expression: ${src}`,
    );
  }
  tokens.push({ kind: "eof", value: "", pos: src.length });
  return tokens;
}

export function parseExpression(src: string): Ast {
  const tokens = tokenize(src);
  let pos = 0;

  function peek(): Token {
    return tokens[pos];
  }

  function consume(kind: TokenKind): Token {
    const t = tokens[pos];
    if (t.kind !== kind) {
      throw new Error(
        `Expected ${kind} but got ${t.kind} "${t.value}" at position ${t.pos}`,
      );
    }
    pos++;
    return t;
  }

  function parseAtom(): Ast {
    const t = peek();
    if (t.kind === "id") {
      consume("id");
      return { kind: "id", name: t.value };
    }
    if (t.kind === "lparen") {
      consume("lparen");
      const e = parseOr();
      consume("rparen");
      return e;
    }
    throw new Error(
      `Unexpected token ${t.kind} "${t.value}" at position ${t.pos}`,
    );
  }

  function parseNot(): Ast {
    if (peek().kind === "not") {
      consume("not");
      return { kind: "not", expr: parseNot() };
    }
    return parseAtom();
  }

  function parseAnd(): Ast {
    let left = parseNot();
    while (peek().kind === "and") {
      consume("and");
      const right = parseNot();
      left = { kind: "and", left, right };
    }
    return left;
  }

  function parseOr(): Ast {
    let left = parseAnd();
    while (peek().kind === "or") {
      consume("or");
      const right = parseAnd();
      left = { kind: "or", left, right };
    }
    return left;
  }

  const ast = parseOr();
  if (peek().kind !== "eof") {
    const t = peek();
    throw new Error(
      `Unexpected trailing token ${t.kind} "${t.value}" at position ${t.pos}`,
    );
  }
  return ast;
}

/**
 * Collects all identifier names referenced by an AST — used to validate
 * sensor expressions against declared sources at startup.
 */
export function collectIdentifiers(ast: Ast): string[] {
  const out = new Set<string>();
  const walk = (n: Ast) => {
    switch (n.kind) {
      case "id":
        out.add(n.name);
        return;
      case "not":
        walk(n.expr);
        return;
      case "and":
      case "or":
        walk(n.left);
        walk(n.right);
        return;
    }
  };
  walk(ast);
  return [...out];
}

/**
 * Evaluates an AST against a map of source values. `values.get(name)` may
 * return undefined for a degraded/unknown source — in that case we return
 * undefined for the whole expression; the sensor's onDegraded policy then
 * decides the final boolean.
 */
export function evaluate(
  ast: Ast,
  values: Map<string, boolean | undefined>,
): boolean | undefined {
  switch (ast.kind) {
    case "id":
      return values.get(ast.name);
    case "not": {
      const v = evaluate(ast.expr, values);
      return v === undefined ? undefined : !v;
    }
    case "and": {
      const l = evaluate(ast.left, values);
      if (l === false) {
        return false;
      }
      const r = evaluate(ast.right, values);
      if (r === false) {
        return false;
      }
      if (l === undefined || r === undefined) {
        return undefined;
      }
      return true;
    }
    case "or": {
      const l = evaluate(ast.left, values);
      if (l === true) {
        return true;
      }
      const r = evaluate(ast.right, values);
      if (r === true) {
        return true;
      }
      if (l === undefined || r === undefined) {
        return undefined;
      }
      return false;
    }
  }
}

// Like evaluate(), but degraded operands "abstain" — a working branch can
// still decide the result without an undefined sibling poisoning it. Only
// returns undefined when NO branch is working (genuine total information loss).
//
// The presence-detector OR aggregate ("any room saw someone → home") is the
// motivating case: with strict Kleene logic, `false OR undefined = undefined`
// keeps the sensor stuck on lastKnown forever the moment one HAP TCP drops,
// even though every other room reports a clean silent. Door-anchor mode opts
// into this so the door event actually decides at check-time. AND is treated
// symmetrically: a degraded operand abstains, the determinate side wins.
export function evaluateAbstain(
  ast: Ast,
  values: Map<string, boolean | undefined>,
): boolean | undefined {
  switch (ast.kind) {
    case "id":
      return values.get(ast.name);
    case "not": {
      const v = evaluateAbstain(ast.expr, values);
      return v === undefined ? undefined : !v;
    }
    case "and": {
      const l = evaluateAbstain(ast.left, values);
      if (l === false) {
        return false;
      }
      const r = evaluateAbstain(ast.right, values);
      if (r === false) {
        return false;
      }
      if (l === true && r === true) {
        return true;
      }
      if (l === true || r === true) {
        return true;  // sibling abstains, working side decides
      }
      return undefined;  // both abstain
    }
    case "or": {
      const l = evaluateAbstain(ast.left, values);
      if (l === true) {
        return true;
      }
      const r = evaluateAbstain(ast.right, values);
      if (r === true) {
        return true;
      }
      if (l === false && r === false) {
        return false;
      }
      if (l === false || r === false) {
        return false;  // sibling abstains, working side decides
      }
      return undefined;  // both abstain
    }
  }
}
