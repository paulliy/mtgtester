/**
 * Amount forms that wrap a whole effect sentence (ADR 0038 decision 3, EDHREC plan Phase 4 step
 * 1): "…, where X is <value>", "<verb> … equal to <value>" and "<effect> for each <noun>". Each
 * one is read by parsing the sentence it wraps with an ordinary amount in the amount position and
 * then putting the counted `Value` there, so every verb the effect grammar already reads gains
 * these amounts at once instead of one fixed phrasing per sentence regex.
 *
 * Only tried after the sentence-level parse fails, so no sentence that already parses changes.
 */

import type { OracleCard } from '@mtg/shared';
import type { Effect } from '../ability';
import type { Value } from '../value';
import { parseDynamicCountValue } from './amount';

/** Replace every announced-X reference in `effects` with `value`, counting the replacements. */
export function bindX(effects: Effect[], value: Value): { effects: Effect[]; replaced: number } {
  let replaced = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const record = node as Record<string, unknown>;
    if (record['kind'] === 'xValue' && Object.keys(record).length === 1) {
      replaced++;
      return value;
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, walk(child)]));
  };
  return { effects: walk(effects) as Effect[], replaced };
}

/**
 * The amount field of each op whose quantity "for each …" may multiply. Only ops whose field is
 * a `Value` (or a number the executor also accepts as a `Value`) are listed; an op that is not
 * here leaves the sentence unread rather than guessing which number is the amount.
 */
const SCALABLE_AMOUNT: Partial<Record<Effect['op'], string>> = {
  draw: 'count',
  drawTarget: 'count',
  mill: 'count',
  gainLife: 'amount',
  loseLife: 'amount',
  loseLifeTarget: 'amount',
  eachPlayerGainsLife: 'amount',
  eachPlayerLosesLife: 'amount',
  eachOpponentLosesLife: 'amount',
  eachOpponentDamage: 'amount',
  dealDamage: 'amount',
  damageEachPlayer: 'amount',
  damageEach: 'amount',
  createToken: 'count',
  putCounters: 'count',
  putCountersEach: 'count',
  gainEnergy: 'amount',
  scry: 'count',
};

const asValue = (amount: unknown): Value | null =>
  typeof amount === 'number'
    ? { kind: 'const', n: amount }
    : amount !== null && typeof amount === 'object' && 'kind' in amount
      ? (amount as Value)
      : null;

/**
 * "<effect> for each <noun>": multiply the one amount in `effects` by `per`. Exactly one
 * top-level effect must carry a constant amount; anything else (two amounts, an amount that is
 * already counted, a nested effect) returns null.
 */
export function scaleByCount(effects: Effect[], per: Value): Effect[] | null {
  let scaled = 0;
  const out = effects.map((effect) => {
    const field = SCALABLE_AMOUNT[effect.op];
    if (field === undefined) return effect;
    const record = effect as unknown as Record<string, unknown>;
    const amount = asValue(record[field]);
    if (amount === null || amount.kind !== 'const') return effect;
    scaled++;
    const value: Value = amount.n === 1 ? per : { kind: 'times', of: per, n: amount.n };
    return { ...record, [field]: value } as unknown as Effect;
  });
  return scaled === 1 ? out : null;
}

/** The counted noun after "for each", read as the number of that noun. */
export function parseForEachCount(noun: string, card: OracleCard): Value | null {
  const text = noun.trim();
  if (text === 'opponent you have' || text === 'opponent') return { kind: 'countOpponents' };
  return parseDynamicCountValue(`the number of ${text}`, card);
}

/**
 * "draw cards equal to V" → "draw x cards", and the other verbs whose amount "equal to" can
 * replace, so the sentence parses with X in the amount position and X is then bound to V.
 * Returns the rewritten sentence and the value phrase, or null when the sentence is not one of
 * these shapes.
 */
export function rewriteEqualTo(s: string): { body: string; value: string } | null {
  const forms: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^(.*\b(?:draw|draws)) cards equal to (.+)$/, (m) => `${m[1]} x cards`],
    [/^(.*\b(?:mill|mills)) cards equal to (.+)$/, (m) => `${m[1]} x cards`],
    [/^(.*\b(?:gain|gains|lose|loses)) life equal to (.+)$/, (m) => `${m[1]} x life`],
    [/^(.*\bdeals?) damage equal to (.+?) to (.+)$/, (m) => `${m[1]} x damage to ${m[3]}`],
    [/^(.*\bcreates?) a number of (.+?) equal to (.+)$/, (m) => `${m[1]} x ${m[2]}`],
    [
      /^(.*\bput) a number of (\S+) counters on (.+?) equal to (.+)$/,
      (m) => `${m[1]} x ${m[2]} counters on ${m[3]}`,
    ],
  ];
  for (const [re, body] of forms) {
    const m = s.match(re);
    if (m === null) continue;
    // The value phrase is the last group of each form.
    const value = m[m.length - 1] as string;
    // "deals damage equal to V to T": V is group 2 and the target group 3.
    return { body: body(m), value: re.source.includes('damage') ? (m[2] as string) : value };
  }
  return null;
}
