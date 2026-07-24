/**
 * Oracle-text interpreter (brief §6). Turns an `OracleCard` into a `CardDefinition` by
 * accounting for EVERY line of rules text against the mechanics the engine implements:
 * keyword lists, mana abilities, enters-tapped clauses, a registry of spell-effect
 * sentence patterns, and a registry of trigger patterns.
 *
 * Any line (or cost symbol, or P/T value) that cannot be accounted for marks the card
 * `modeled: false` with a specific reason. The engine will halt loudly when that card's
 * behavior is needed — a visible failure is more useful than a wrong game (brief §6.3),
 * and the reasons form the backlog of mechanics to implement next.
 */

import type { OracleCard } from '@mtg/shared';
import { parseManaCost } from '../mana/cost';
import type { ManaUnit } from '../mana/cost';
import { IMPLEMENTED_KEYWORDS } from './ability';
import type {
  Ability,
  Effect,
  KeywordAbility,
  TargetKind,
  TargetSpec,
  TriggerEvent,
} from './ability';
import type { StaticEffect } from './continuous-types';
import type { Value } from './value';
import type { CardDefinition, ManaAbilitySpec } from './definition';

/** Allocates a target slot of the given kind and returns its index (ADR 0004). */
type SlotAllocator = (kind: TargetKind) => number;

/** Basic land subtypes → intrinsic mana ability (CR 305.6). */
const BASIC_LAND_MANA: Record<string, ManaUnit> = {
  Plains: ['W'],
  Island: ['U'],
  Swamp: ['B'],
  Mountain: ['R'],
  Forest: ['G'],
  Wastes: ['C'],
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function parseAmount(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  return NUMBER_WORDS[word] ?? null;
}

/** Strip reminder text (parenthesized), collapse whitespace. */
function stripReminderText(text: string): string {
  return text.replace(/\([^)]*\)/g, '').replace(/[ \t]+/g, ' ');
}

/** Replace the card's own name (and its short pre-comma name) with `~`. */
function substituteSelfName(text: string, name: string): string {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = text.replace(new RegExp(escape(name), 'g'), '~');
  const comma = name.indexOf(',');
  if (comma > 0) {
    out = out.replace(new RegExp(escape(name.slice(0, comma)), 'g'), '~');
  }
  return out;
}

/** Split a line into sentences, dropping the terminal period of each. */
function splitSentences(line: string): string[] {
  return line
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter((s) => s.length > 0);
}

const KEYWORD_SET = new Set<string>(IMPLEMENTED_KEYWORDS);

/**
 * Parse one sentence into effect primitives (ADR 0004). Returns null when unrecognized.
 * Targeted primitives allocate a slot via `alloc` and reference it by index. Sentences are
 * matched lowercased with `~` substituted for the card's name.
 */
function parseEffectSentence(sentence: string, alloc: SlotAllocator): Effect[] | null {
  const s = sentence.toLowerCase();

  // "target creature gets +3/+3 until end of turn"
  // "target creature gets +2/+2 and gains flying until end of turn"
  {
    const m = s.match(
      /^target creature gets ([+-]\d+)\/([+-]\d+)(?: and gains ([a-z ]+))? until end of turn$/,
    );
    if (m) {
      const effects: Effect[] = [
        {
          op: 'pumpUntilEot',
          target: alloc('creature'),
          power: Number(m[1]),
          toughness: Number(m[2]),
        },
      ];
      if (m[3] !== undefined) {
        if (!KEYWORD_SET.has(m[3])) return null;
        effects.push({
          op: 'grantKeywordUntilEot',
          target: alloc('creature'),
          keyword: m[3] as KeywordAbility,
        });
      }
      return effects;
    }
  }
  // "target creature gains flying until end of turn"
  {
    const m = s.match(/^target creature gains ([a-z ]+) until end of turn$/);
    if (m) {
      if (!KEYWORD_SET.has(m[1] as string)) return null;
      return [
        { op: 'grantKeywordUntilEot', target: alloc('creature'), keyword: m[1] as KeywordAbility },
      ];
    }
  }
  // "~ deals 3 damage to any target" / "… to target creature" / "… to each opponent"
  {
    const m = s.match(/^~ deals (\w+) damage to (any target|target creature|each opponent)$/);
    if (m) {
      const amount = parseAmount(m[1] as string);
      if (amount === null) return null;
      if (m[2] === 'any target') return [{ op: 'dealDamage', target: alloc('anyTarget'), amount }];
      if (m[2] === 'target creature')
        return [{ op: 'dealDamage', target: alloc('creature'), amount }];
      return [{ op: 'eachOpponentDamage', amount }];
    }
  }
  if (s === 'destroy target creature') return [{ op: 'destroy', target: alloc('creature') }];
  if (s === 'exile target creature') return [{ op: 'exile', target: alloc('creature') }];
  if (s === 'counter target spell') return [{ op: 'counter', target: alloc('spell') }];
  // "draw a card" / "draw two cards" / "you draw a card"
  {
    const m = s.match(/^(?:you )?draw (\w+) cards?$/);
    if (m) {
      const count = parseAmount(m[1] as string);
      if (count === null) return null;
      return [{ op: 'draw', count }];
    }
  }
  // "you gain 3 life"
  {
    const m = s.match(/^you gain (\w+) life$/);
    if (m) {
      const amount = parseAmount(m[1] as string);
      if (amount === null) return null;
      return [{ op: 'gainLife', amount }];
    }
  }
  // "each opponent loses 1 life"
  {
    const m = s.match(/^each opponent loses (\w+) life$/);
    if (m) {
      const amount = parseAmount(m[1] as string);
      if (amount === null) return null;
      return [{ op: 'eachOpponentLosesLife', amount }];
    }
  }
  return null;
}

const TRIGGER_HEAD_RE =
  /^(when ~ enters(?: the battlefield)?|when ~ dies|at the beginning of your upkeep|at the beginning of each(?: player's)? upkeep), (.*)$/;

/** Parse a full line as a triggered ability (an `Ability`). Returns null when unrecognized. */
function parseTriggerLine(line: string): Ability | null {
  const m = line.toLowerCase().match(TRIGGER_HEAD_RE);
  if (!m) return null;
  const head = m[1] as string;
  let body = m[2] as string;
  const optional = body.startsWith('you may ');
  if (optional) body = body.slice('you may '.length);

  // Phase 2 restriction: trigger effects must be targetless, so announcing a trigger never
  // needs a target decision. Any target allocation ⇒ reject.
  const targets: TargetSpec[] = [];
  const alloc: SlotAllocator = (kind) => {
    targets.push({ kind });
    return targets.length - 1;
  };

  const effects: Effect[] = [];
  for (const sentence of splitSentences(body)) {
    const parsed = parseEffectSentence(sentence, alloc);
    if (parsed === null) return null;
    effects.push(...parsed);
  }
  if (effects.length === 0 || targets.length > 0) return null;

  const event: TriggerEvent = head.startsWith('when ~ enters')
    ? 'etbSelf'
    : head === 'when ~ dies'
      ? 'diesSelf'
      : head === 'at the beginning of your upkeep'
        ? 'upkeepYours'
        : 'upkeepEach';
  return { kind: 'triggered', trigger: event, optional, targets: [], effects, description: line };
}

const MANA_ABILITY_RE = /^\{t\}: add ((?:\{[wubrgc]\})+)$/;

/**
 * Parse a continuous static ability or CDA into a `StaticEffect` (ADR 0005). `lower` is the
 * lowercased, period-stripped line with `~` substituted for the card name. Returns null when
 * unrecognized. These card-specific patterns are the seed of the authored-override registry.
 */
function parseStaticLine(lower: string): StaticEffect | null {
  // Blood Moon — "Nonbasic lands are Mountains." (layer 4: set subtype, lose abilities.)
  if (lower === 'nonbasic lands are mountains') {
    return {
      affects: { kind: 'nonbasicLands' },
      op: { layer: 4, setLandSubtype: 'Mountain', loseAbilities: true },
    };
  }
  // Tarmogoyf — CDA (layer 7a): power = card types in all graveyards, toughness = that + N.
  {
    const m = lower.match(
      /^~['’]s power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus (\d+)$/,
    );
    if (m) {
      const types: Value = { kind: 'cardTypesInAllGraveyards' };
      return {
        affects: { kind: 'self' },
        op: {
          layer: 7,
          sublayer: 'a',
          power: types,
          toughness: { kind: 'plus', of: types, n: Number(m[1]) },
        },
      };
    }
  }
  return null;
}

/** Interpret one oracle card. Never throws — unmodeled cards are reported, not errors. */
export function interpretCard(card: OracleCard): CardDefinition {
  const reasons: string[] = [];

  const isLandCard = card.types.includes('Land');
  const costResult = parseManaCost(card.manaCost);
  if (costResult.unsupportedSymbols.length > 0) {
    reasons.push(`unsupported mana cost symbols: ${costResult.unsupportedSymbols.join(' ')}`);
  }

  const parseNumeric = (value: string | null, label: string): number | null => {
    if (value === null) return null;
    if (!/^[+-]?\d+$/.test(value)) {
      reasons.push(`non-numeric ${label} "${value}"`);
      return null;
    }
    return Number(value);
  };
  // P/T may be non-numeric ("*") when a CDA defines it; defer the reason until after the
  // text is parsed (checked below once we know whether a layer-7a CDA was found).
  const parseIntOrNull = (value: string | null): number | null =>
    value !== null && /^[+-]?\d+$/.test(value) ? Number(value) : null;
  const power = parseIntOrNull(card.power);
  const toughness = parseIntOrNull(card.toughness);
  const loyalty = parseNumeric(card.loyalty, 'loyalty');
  const defense = parseNumeric(card.defense, 'defense');

  if (card.layout !== 'normal') {
    reasons.push(`unsupported layout "${card.layout}"`);
  }
  const KNOWN_TYPES = [
    'Creature',
    'Artifact',
    'Enchantment',
    'Land',
    'Instant',
    'Sorcery',
    'Planeswalker',
    'Battle',
  ];
  for (const t of card.types) {
    if (!KNOWN_TYPES.includes(t)) {
      reasons.push(`unsupported card type "${t}"`);
    }
  }
  // A planeswalker/battle must know its starting loyalty/defense to enter correctly
  // (CR 306.5b / 310.6). Real cards of these types are double-faced and already unmodeled;
  // this guards a single-faced or fixture-injected one from entering at 0 and dying.
  if (card.types.includes('Planeswalker') && loyalty === null) {
    reasons.push('planeswalker with no readable starting loyalty');
  }
  if (card.types.includes('Battle') && defense === null) {
    reasons.push('battle with no readable starting defense');
  }

  const keywords: KeywordAbility[] = [];
  const manaAbilities: ManaAbilitySpec[] = [];
  const spellTargets: TargetSpec[] = [];
  const spellEffects: Effect[] = [];
  const triggers: Ability[] = [];
  const staticEffects: StaticEffect[] = [];
  let entersTapped = false;

  const isSpell = card.types.includes('Instant') || card.types.includes('Sorcery');
  const text = substituteSelfName(stripReminderText(card.oracleText), card.name);

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const lower = line.toLowerCase().replace(/\.$/, '');

    // 1. A pure keyword list ("Flying, vigilance").
    const parts = lower.split(/[,;]/).map((p) => p.trim());
    if (parts.every((p) => KEYWORD_SET.has(p))) {
      for (const p of parts) keywords.push(p as KeywordAbility);
      continue;
    }
    // 2. A mana ability ("{T}: Add {G}." — single-symbol units only in Phase 2;
    //    "Add {G} or {W}" style choices are left unmodeled).
    {
      const m = lower.match(MANA_ABILITY_RE);
      if (m) {
        const units: ManaUnit[] = [...(m[1] as string).matchAll(/\{([wubrgc])\}/g)].map(
          (sym) => [(sym[1] as string).toUpperCase() as ManaUnit[number]] as const,
        );
        manaAbilities.push({ units });
        continue;
      }
    }
    // 3. Enters tapped.
    if (/^(?:~|this land) enters (?:the battlefield )?tapped$/.test(lower)) {
      entersTapped = true;
      continue;
    }
    // 4. A triggered ability.
    {
      const trigger = parseTriggerLine(line);
      if (trigger !== null) {
        triggers.push(trigger);
        continue;
      }
    }
    // 4b. A continuous static ability / CDA (ADR 0005). These specific patterns will move to
    //     the authored-override registry; here they prove the layer engine end-to-end.
    {
      const stat = parseStaticLine(lower);
      if (stat !== null) {
        staticEffects.push(stat);
        continue;
      }
    }
    // 5. Spell effect sentences (instants/sorceries only). Parse into a scratch slot list
    //    (based at the current spell slot count) so a partially-parsing line allocates no
    //    slots; merge only when the whole line parses.
    if (isSpell) {
      const sentences = splitSentences(line);
      const lineEffects: Effect[] = [];
      const lineTargets: TargetSpec[] = [];
      const base = spellTargets.length;
      const lineAlloc: SlotAllocator = (kind) => {
        lineTargets.push({ kind });
        return base + lineTargets.length - 1;
      };
      let allParsed = sentences.length > 0;
      for (const sentence of sentences) {
        const parsed = parseEffectSentence(sentence, lineAlloc);
        if (parsed === null) {
          allParsed = false;
          break;
        }
        lineEffects.push(...parsed);
      }
      if (allParsed) {
        spellTargets.push(...lineTargets);
        spellEffects.push(...lineEffects);
        continue;
      }
    }
    reasons.push(`unrecognized rules text: "${line}"`);
  }

  // Intrinsic basic-land mana abilities (CR 305.6).
  for (const subtype of card.subtypes) {
    const unit = BASIC_LAND_MANA[subtype];
    if (unit !== undefined && isLandCard) {
      manaAbilities.push({ units: [unit] });
    }
  }

  // Non-numeric printed P/T ("*") is only OK if a CDA (layer 7a) defines it; otherwise it's
  // an unmodeled characteristic-defining ability.
  const hasCdaPT = staticEffects.some((s) => s.op.layer === 7 && s.op.sublayer === 'a');
  if (!hasCdaPT) {
    if (card.power !== null && power === null)
      reasons.push(`non-numeric power/toughness "${card.power}"`);
    if (card.toughness !== null && toughness === null)
      reasons.push(`non-numeric power/toughness "${card.toughness}"`);
  }

  // A spell that parsed to zero effects does nothing when it resolves — that is almost
  // certainly a modeling gap, not a real no-op card.
  if (isSpell && spellEffects.length === 0 && reasons.length === 0) {
    reasons.push('instant/sorcery with no interpretable effect');
  }

  return {
    oracleId: card.oracleId,
    name: card.name,
    typeLine: card.typeLine,
    supertypes: card.supertypes,
    types: card.types,
    subtypes: card.subtypes,
    colors: card.colors,
    manaCost: isLandCard ? null : costResult.cost,
    hasUnsupportedCost: costResult.unsupportedSymbols.length > 0,
    power,
    toughness,
    loyalty,
    defense,
    keywords,
    manaAbilities,
    entersTapped,
    spellAbility:
      isSpell && spellEffects.length > 0
        ? { kind: 'spell', targets: spellTargets, effects: spellEffects }
        : null,
    triggers,
    staticEffects,
    modeled: reasons.length === 0,
    unmodeledReasons: reasons,
  };
}
