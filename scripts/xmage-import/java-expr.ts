// A small parser for the Java subset XMage card classes use: constructor bodies made of local
// declarations, method calls and `this.addAbility(...)`, with expressions built from `new`,
// method chains, field references, literals, `+`, `!`, `?:` and lambdas (kept as opaque text).
// It parses source text only; nothing from XMage is executed.

export type JExpr =
  | { t: 'new'; cls: string; args: JExpr[]; body?: true }
  | { t: 'call'; target: JExpr | null; name: string; args: JExpr[] }
  | { t: 'ref'; path: string }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'array'; cls: string; items: JExpr[] }
  | { t: 'op'; op: string; args: JExpr[] }
  | { t: 'opaque'; text: string };

export interface JStatement {
  /** `// comment` lines directly above the statement, joined. */
  comment: string;
  kind: 'decl' | 'expr';
  /** For `Type name = expr;` */
  declType?: string;
  declName?: string;
  expr: JExpr | null;
  text: string;
}

type Tok = { k: 'id' | 'num' | 'str' | 'chr' | 'p'; v: string; pos: number };

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? src.length : e;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? src.length : e + 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const n = src[j + 1];
          s +=
            n === 'n'
              ? '\n'
              : n === 't'
                ? '\t'
                : n === 'u'
                  ? String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16))
                  : n;
          j += n === 'u' ? 6 : 2;
        } else s += src[j++];
      }
      out.push({ k: 'str', v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      out.push({ k: 'chr', v: src.slice(i + 1, j), pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j]!)) j++;
      out.push({ k: 'id', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/\d/.test(c)) {
      let j = i;
      while (j < src.length && /[\w.]/.test(src[j]!)) j++;
      out.push({ k: 'num', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (['>>>', '...'].includes(three)) {
      out.push({ k: 'p', v: three, pos: i });
      i += 3;
    } else if (
      ['==', '!=', '<=', '>=', '&&', '||', '->', '::', '++', '--', '+=', '-='].includes(two)
    ) {
      out.push({ k: 'p', v: two, pos: i });
      i += 2;
    } else {
      out.push({ k: 'p', v: c, pos: i });
      i++;
    }
  }
  return out;
}

class Parser {
  i = 0;
  constructor(
    private toks: Tok[],
    private src: string,
  ) {}
  peek(o = 0) {
    return this.toks[this.i + o];
  }
  is(v: string, o = 0) {
    const t = this.peek(o);
    return !!t && t.k === 'p' && t.v === v;
  }
  eat(v: string) {
    if (!this.is(v)) throw new Error(`expected ${v} at ${this.peek()?.pos} got ${this.peek()?.v}`);
    this.i++;
  }
  /** Skips a balanced `<...>` generic argument list if one starts here. */
  skipGenerics() {
    if (!this.is('<')) return;
    let depth = 0;
    do {
      const t = this.peek()!;
      if (t.k === 'p' && t.v === '<') depth++;
      else if (t.k === 'p' && t.v === '>') depth--;
      else if (t.k === 'p' && t.v === '>>') depth -= 2;
      this.i++;
    } while (depth > 0 && this.i < this.toks.length);
  }
  qualified(): string {
    let name = this.peek()!.v;
    this.i++;
    while (this.is('.') && this.peek(1)?.k === 'id' && !this.is('(', 2)) {
      name += '.' + this.peek(1)!.v;
      this.i += 2;
    }
    return name;
  }
  args(): JExpr[] {
    this.eat('(');
    const out: JExpr[] = [];
    while (!this.is(')')) {
      out.push(this.expr());
      if (this.is(',')) this.i++;
    }
    this.eat(')');
    return out;
  }
  skipBalanced(open: string, close: string): string {
    const start = this.peek()!.pos;
    let depth = 0;
    do {
      const t = this.peek()!;
      if (t.k === 'p' && t.v === open) depth++;
      if (t.k === 'p' && t.v === close) depth--;
      this.i++;
    } while (depth > 0 && this.i < this.toks.length);
    const end = this.toks[this.i - 1]!.pos + 1;
    return this.src.slice(start, end);
  }
  expr(): JExpr {
    // lambda: x -> ...  or (a, b) -> ...
    if ((this.peek()?.k === 'id' && this.is('->', 1)) || (this.is('(') && this.lambdaAhead())) {
      const start = this.peek()!.pos;
      let depth = 0;
      while (this.i < this.toks.length) {
        const t = this.peek()!;
        if (t.k === 'p' && (t.v === '(' || t.v === '{')) depth++;
        if (t.k === 'p' && (t.v === ')' || t.v === '}')) {
          if (depth === 0) break;
          depth--;
        }
        if (t.k === 'p' && t.v === ',' && depth === 0) break;
        this.i++;
      }
      return { t: 'opaque', text: this.src.slice(start, this.peek()?.pos ?? this.src.length) };
    }
    const cond = this.binary(0);
    if (this.is('?')) {
      this.i++;
      const a = this.expr();
      this.eat(':');
      const b = this.expr();
      return { t: 'op', op: '?:', args: [cond, a, b] };
    }
    return cond;
  }
  lambdaAhead(): boolean {
    let j = this.i;
    let depth = 0;
    for (; j < this.toks.length; j++) {
      const t = this.toks[j]!;
      if (t.k === 'p' && t.v === '(') depth++;
      if (t.k === 'p' && t.v === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const n = this.toks[j + 1];
    return !!n && n.k === 'p' && n.v === '->';
  }
  static PREC: Record<string, number> = {
    '||': 1,
    '&&': 2,
    '==': 3,
    '!=': 3,
    '<': 4,
    '>': 4,
    '<=': 4,
    '>=': 4,
    '+': 5,
    '-': 5,
    '*': 6,
    '/': 6,
    '%': 6,
  };
  binary(min: number): JExpr {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      const p = t && t.k === 'p' ? Parser.PREC[t.v] : undefined;
      if (p === undefined || p <= min) return left;
      this.i++;
      const right = this.binary(p);
      left = { t: 'op', op: t!.v, args: [left, right] };
    }
  }
  unary(): JExpr {
    if (this.is('!') || this.is('-')) {
      const op = this.peek()!.v;
      this.i++;
      return { t: 'op', op: op === '-' ? 'neg' : '!', args: [this.unary()] };
    }
    // cast: (Type) expr
    if (
      this.is('(') &&
      this.peek(1)?.k === 'id' &&
      this.is(')', 2) &&
      /^[A-Z]/.test(this.peek(1)!.v)
    ) {
      this.i += 3;
      return this.unary();
    }
    return this.postfix(this.primary());
  }
  primary(): JExpr {
    const t = this.peek();
    if (!t) throw new Error('unexpected end');
    if (t.k === 'str') {
      this.i++;
      return { t: 'str', v: t.v };
    }
    if (t.k === 'chr') {
      this.i++;
      return { t: 'str', v: t.v };
    }
    if (t.k === 'num') {
      this.i++;
      return { t: 'num', v: Number(t.v.replace(/[LlFfDd_]/g, '')) };
    }
    if (t.k === 'p' && t.v === '(') {
      this.i++;
      const e = this.expr();
      this.eat(')');
      return e;
    }
    if (t.k === 'id') {
      if (t.v === 'true' || t.v === 'false') {
        this.i++;
        return { t: 'bool', v: t.v === 'true' };
      }
      if (t.v === 'null') {
        this.i++;
        return { t: 'null' };
      }
      if (t.v === 'new') {
        this.i++;
        const cls = this.qualified();
        this.skipGenerics();
        if (this.is('[')) {
          while (this.is('[')) this.skipBalanced('[', ']');
          const items: JExpr[] = [];
          if (this.is('{')) {
            this.eat('{');
            while (!this.is('}')) {
              items.push(this.expr());
              if (this.is(',')) this.i++;
            }
            this.eat('}');
          }
          return { t: 'array', cls, items };
        }
        const args = this.args();
        if (this.is('{')) {
          this.skipBalanced('{', '}');
          return { t: 'new', cls, args, body: true };
        }
        return { t: 'new', cls, args };
      }
      // identifier or qualified name, maybe a call
      const name = this.peek()!.v;
      this.i++;
      if (this.is('(')) return { t: 'call', target: null, name, args: this.args() };
      return { t: 'ref', path: name };
    }
    throw new Error(`unexpected token ${t.v} at ${t.pos}`);
  }
  postfix(e: JExpr): JExpr {
    for (;;) {
      if (this.is('.')) {
        this.i++;
        if (this.is('<')) this.skipGenerics();
        const n = this.peek()!;
        if (n.k !== 'id') throw new Error(`bad member at ${n.pos}`);
        this.i++;
        if (this.is('(')) e = { t: 'call', target: e, name: n.v, args: this.args() };
        else
          e =
            e.t === 'ref'
              ? { t: 'ref', path: `${e.path}.${n.v}` }
              : { t: 'call', target: e, name: n.v, args: [] };
        continue;
      }
      if (this.is('::')) {
        this.i++;
        const n = this.peek()!;
        this.i++;
        e = { t: 'opaque', text: `${JSON.stringify(e)}::${n.v}` };
        continue;
      }
      if (this.is('[')) {
        this.skipBalanced('[', ']');
        continue;
      }
      return e;
    }
  }
}

export function parseExpr(src: string): JExpr {
  const p = new Parser(tokenize(src), src);
  return p.expr();
}

/**
 * Splits a block body (without its outer braces) into statements, keeping the line comments
 * directly above each one, then parses each.
 */
export function parseStatements(body: string): JStatement[] {
  const out: JStatement[] = [];
  let i = 0;
  let comments: string[] = [];
  while (i < body.length) {
    const ws = /^\s+/.exec(body.slice(i));
    if (ws) {
      if ((ws[0].match(/\n/g)?.length ?? 0) > 1) comments = [];
      i += ws[0].length;
      continue;
    }
    if (body.startsWith('//', i)) {
      const e = body.indexOf('\n', i);
      comments.push(body.slice(i + 2, e < 0 ? body.length : e).trim());
      i = e < 0 ? body.length : e;
      continue;
    }
    if (body.startsWith('/*', i)) {
      const e = body.indexOf('*/', i);
      i = e < 0 ? body.length : e + 2;
      continue;
    }
    // find statement end at depth 0
    let j = i;
    let depth = 0;
    while (j < body.length) {
      const c = body[j]!;
      if (c === '"') {
        j++;
        while (j < body.length && body[j] !== '"') j += body[j] === '\\' ? 2 : 1;
      } else if (c === "'") {
        j++;
        while (j < body.length && body[j] !== "'") j += body[j] === '\\' ? 2 : 1;
      } else if (c === '/' && body[j + 1] === '/') {
        const e = body.indexOf('\n', j);
        j = e < 0 ? body.length : e;
        continue;
      } else if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        depth--;
        if (depth === 0 && c === '}' && /^\s*(if|for|while|switch|else)\b/.test(body.slice(i, j))) {
          j++;
          break;
        }
      } else if (c === ';' && depth === 0) break;
      j++;
    }
    const text = body.slice(i, j).trim();
    i = j + 1;
    const comment = comments.join(' ');
    comments = [];
    if (!text) continue;
    out.push(parseStatement(text, comment));
  }
  return out;
}

function parseStatement(text: string, comment: string): JStatement {
  const decl =
    /^(?:final\s+)?([A-Z][\w.]*(?:<[^=]*>)?(?:\[\])?)\s+([a-z]\w*)\s*=\s*([\s\S]+)$/.exec(text);
  try {
    if (decl)
      return {
        comment,
        kind: 'decl',
        declType: decl[1]!.replace(/<.*>/, ''),
        declName: decl[2]!,
        expr: parseExpr(decl[3]!),
        text,
      };
    if (/^(if|for|while|switch)\b/.test(text))
      return { comment, kind: 'expr', expr: { t: 'opaque', text }, text };
    return { comment, kind: 'expr', expr: parseExpr(text), text };
  } catch {
    return decl
      ? { comment, kind: 'decl', declType: decl[1]!, declName: decl[2]!, expr: null, text }
      : { comment, kind: 'expr', expr: null, text };
  }
}
