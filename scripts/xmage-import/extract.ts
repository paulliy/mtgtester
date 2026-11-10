// Extracts an XMage card class into a JSON description: its static filters and one entry per
// ability the constructor adds, with the `// Oracle line` comment XMage writes above it.
// Source text is parsed, never compiled or run.

import { type JExpr, parseExpr, parseStatements } from './java-expr';

export interface XField {
  type: string;
  init: JExpr | null;
  /** `filter.add(...)` calls from static blocks, in order. */
  adds: JExpr[];
}

export interface XAbility {
  /** XMage's comments above the statements that built this ability, normally its Oracle line. */
  comment: string;
  /** 'spell' for the card's own spell ability (instants, sorceries, auras, ...). */
  kind: 'ability' | 'spell';
  /**
   * The ability expression with local variables substituted and later calls on them chained,
   * so `Ability a = new X(); a.addTarget(t);` reads as `new X().addTarget(t)`.
   */
  root: JExpr;
}

export interface XCard {
  cls: string;
  abilities: XAbility[];
  fields: Record<string, XField>;
  /** Statements that were neither abilities nor recognizable setup. */
  unparsed: string[];
  /** Classes declared in the file other than the card itself. */
  customClasses: string[];
  hasBackFace: boolean;
}

function matchingBrace(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === '"') {
      j++;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
    } else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

export function extractCard(src: string): XCard {
  const clsMatch = /public\s+final\s+class\s+(\w+)\s+extends\s+\w+/.exec(src);
  const cls = clsMatch?.[1] ?? '?';
  const customClasses = [
    ...src.matchAll(
      /^\s*(?:(?:public|private|protected|final|static|abstract)\s+)*class\s+(\w+)/gm,
    ),
  ]
    .map((m) => m[1]!)
    .filter((c) => c !== cls);
  // Static filters and static blocks are read from the card class only: inner effect classes
  // often declare their own `filter` with the same name.
  const mainStart = clsMatch?.index ?? 0;
  const nextClass = /^(?:(?:public|private|protected|final|static|abstract)\s+)*class\s+\w+/gm;
  nextClass.lastIndex = mainStart + (clsMatch?.[0].length ?? 0);
  const mainEnd = nextClass.exec(src)?.index ?? src.length;
  const main = src.slice(0, mainEnd);
  const fields: Record<string, XField> = {};
  for (const m of main.matchAll(
    /(?:private|public|protected)?\s*static\s+final\s+([\w.]+)(?:<[^>]*>)?\s+(\w+)\s*=\s*([^;]+);/g,
  )) {
    let init: JExpr | null = null;
    try {
      init = parseExpr(m[3]!);
    } catch {
      init = null;
    }
    fields[m[2]!] = { type: m[1]!, init, adds: [] };
  }
  // A static-block statement other than a direct `filter.add(...)` (e.g. one inside an `if`) may
  // narrow a filter; it is kept in `unparsed` so the card is refused rather than over-broad.
  const staticUnparsed: string[] = [];
  for (const m of main.matchAll(/\n\s*static\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchingBrace(main, open);
    for (const st of parseStatements(main.slice(open + 1, close))) {
      const e = st.expr;
      if (e?.t === 'call' && e.target?.t === 'ref' && fields[e.target.path] && e.name === 'add') {
        fields[e.target.path]!.adds.push(...e.args);
      } else {
        staticUnparsed.push(st.text);
      }
    }
  }
  const ctor = new RegExp(
    `public\\s+${cls}\\s*\\(\\s*UUID\\s+ownerId\\s*,\\s*CardSetInfo\\s+setInfo\\s*\\)\\s*\\{`,
  ).exec(src);
  const abilities: XAbility[] = [];
  const unparsed: string[] = [...staticUnparsed];
  if (ctor) {
    const open = ctor.index + ctor[0].length - 1;
    const body = src.slice(open + 1, matchingBrace(src, open));
    const locals = new Map<string, { expr: JExpr; comments: string[] }>();
    let spell: { expr: JExpr; comments: string[] } | null = null;
    // Locals are inlined as snapshots. Java shares the object, so a mutation after a local has been
    // inlined somewhere would be lost; such a mutation goes to `unparsed` instead.
    const embedded = new Set<string>();
    const resolve = (e: JExpr): JExpr => {
      switch (e.t) {
        case 'ref':
          if (!locals.has(e.path)) return e;
          embedded.add(e.path);
          return locals.get(e.path)!.expr;
        case 'new':
          return { ...e, args: e.args.map(resolve) };
        case 'call':
          return { ...e, target: e.target ? resolve(e.target) : null, args: e.args.map(resolve) };
        case 'array':
          return { ...e, items: e.items.map(resolve) };
        case 'op':
          return { ...e, args: e.args.map(resolve) };
        default:
          return e;
      }
    };
    // A call chain whose innermost receiver is `this.getSpellAbility()` / `getSpellAbility()`.
    const spellBase = (e: JExpr): boolean =>
      e.t === 'call' &&
      (e.name === 'getSpellAbility'
        ? e.target === null || (e.target.t === 'ref' && e.target.path === 'this')
        : !!e.target && spellBase(e.target));
    const rebase = (e: JExpr, base: JExpr): JExpr =>
      e.t === 'call' && e.name === 'getSpellAbility'
        ? base
        : e.t === 'call'
          ? { ...e, target: rebase(e.target!, base), args: e.args.map(resolve) }
          : e;
    const localRoot = (e: JExpr): string | null =>
      e.t === 'ref'
        ? locals.has(e.path)
          ? e.path
          : null
        : e.t === 'call' && e.target
          ? localRoot(e.target)
          : null;
    const rebaseLocal = (e: JExpr, base: JExpr): JExpr =>
      e.t === 'ref'
        ? base
        : e.t === 'call'
          ? { ...e, target: rebaseLocal(e.target!, base), args: e.args.map(resolve) }
          : e;
    for (const st of parseStatements(body)) {
      const e = st.expr;
      const assign = /^([a-z]\w*)\s*=\s*([\s\S]+)$/.exec(st.text);
      if (st.kind === 'decl' && st.declName && e) {
        locals.set(st.declName, { expr: resolve(e), comments: st.comment ? [st.comment] : [] });
        embedded.delete(st.declName);
        continue;
      }
      if (assign && !st.text.startsWith('this.')) {
        try {
          locals.set(assign[1]!, {
            expr: resolve(parseExpr(assign[2]!)),
            comments: st.comment ? [st.comment] : [],
          });
          embedded.delete(assign[1]!);
          continue;
        } catch {
          /* fall through */
        }
      }
      if (e && spellBase(e)) {
        spell ??= { expr: { t: 'ref', path: '$spell' }, comments: [] };
        spell.expr = rebase(e, spell.expr);
        if (st.comment) spell.comments.push(st.comment);
        continue;
      }
      if (
        e?.t === 'call' &&
        e.name === 'addAbility' &&
        (e.target === null || (e.target.t === 'ref' && e.target.path === 'this'))
      ) {
        const arg = e.args[0];
        if (!arg) continue;
        const name = arg.t === 'ref' && locals.has(arg.path) ? arg.path : null;
        const comments = [
          ...(name ? locals.get(name)!.comments : []),
          ...(st.comment ? [st.comment] : []),
        ];
        abilities.push({
          comment: comments.join(' '),
          kind: 'ability',
          root: name ? locals.get(name)!.expr : resolve(arg),
        });
        if (name) locals.delete(name);
        continue;
      }
      const lr = e ? localRoot(e) : null;
      if (e && lr && embedded.has(lr)) {
        unparsed.push(st.text);
        continue;
      }
      if (e && lr) {
        const l = locals.get(lr)!;
        l.expr = rebaseLocal(e, l.expr);
        if (st.comment) l.comments.push(st.comment);
        continue;
      }
      if (
        /^(super|this\.(power|toughness|subtype|supertype|color|nightCard|secondSideCardClazz))/.test(
          st.text,
        )
      )
        continue;
      if (
        /^(this\.)?(addSubType|addSuperType|setStartingLoyalty|setStartingDefense|setPT)\(/.test(
          st.text,
        )
      )
        continue;
      unparsed.push(st.text);
    }
    if (spell)
      abilities.unshift({ comment: spell.comments.join(' '), kind: 'spell', root: spell.expr });
  }
  return {
    cls,
    abilities,
    fields,
    unparsed,
    customClasses,
    hasBackFace:
      /secondSideCardClazz|TransformingDoubleFacedCard|ModalDoubleFacedCard|SplitCard|AdventureCard/.test(
        src,
      ),
  };
}
