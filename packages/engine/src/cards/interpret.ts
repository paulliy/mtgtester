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
import type {
  CardDefinition,
  EffectSpec,
  KeywordAbility,
  ManaAbilitySpec,
  TriggerSpec,
} from './definition';
import { IMPLEMENTED_KEYWORDS, effectTargetKind } from './definition';

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
 * Parse one sentence as a spell/trigger effect. Returns null when unrecognized.
 * Sentences are matched lowercased with `~` substituted for the card's name.
 */
function parseEffectSentence(sentence: string): EffectSpec[] | null {
  const s = sentence.toLowerCase();

  // "target creature gets +3/+3 until end of turn"
  // "target creature gets +2/+2 and gains flying until end of turn"
  {
    const m = s.match(
      /^target creature gets ([+-]\d+)\/([+-]\d+)(?: and gains ([a-z ]+))? until end of turn$/,
    );
    if (m) {
      const effects: EffectSpec[] = [
        { kind: 'pump', power: Number(m[1]), toughness: Number(m[2]) },
      ];
      if (m[3] !== undefined) {
        if (!KEYWORD_SET.has(m[3])) return null;
        effects.push({ kind: 'grantKeyword', keyword: m[3] as KeywordAbility });
      }
      return effects;
    }
  }
  // "target creature gains flying until end of turn"
  {
    const m = s.match(/^target creature gains ([a-z ]+) until end of turn$/);
    if (m) {
      if (!KEYWORD_SET.has(m[1] as string)) return null;
      return [{ kind: 'grantKeyword', keyword: m[1] as KeywordAbility }];
    }
  }
  // "~ deals 3 damage to any target" / "… to target creature" / "… to each opponent"
  {
    const m = s.match(/^~ deals (\w+) damage to (any target|target creature|each opponent)$/);
    if (m) {
      const amount = parseAmount(m[1] as string);
      if (amount === null) return null;
      if (m[2] === 'any target') return [{ kind: 'damageTarget', amount, targetKind: 'anyTarget' }];
      if (m[2] === 'target creature')
        return [{ kind: 'damageTarget', amount, targetKind: 'creature' }];
      return [{ kind: 'eachOpponentDamage', amount }];
    }
  }
  if (s === 'destroy target creature') return [{ kind: 'destroyTarget' }];
  if (s === 'exile target creature') return [{ kind: 'exileTarget' }];
  if (s === 'counter target spell') return [{ kind: 'counterTarget' }];
  // "draw a card" / "draw two cards" / "you draw a card"
  {
    const m = s.match(/^(?:you )?draw (\w+) cards?$/);
    if (m) {
      const count = parseAmount(m[1] as string);
      if (count === null) return null;
      return [{ kind: 'draw', count }];
    }
  }
  // "you gain 3 life"
  {
    const m = s.match(/^you gain (\w+) life$/);
    if (m) {
      const amount = parseAmount(m[1] as string);
      if (amount === null) return null;
      return [{ kind: 'gainLife', amount }];
    }
  }
  // "each opponent loses 1 life"
  {
    const m = s.match(/^each opponent loses (\w+) life$/);
    if (m) {
      const amount = parseAmount(m[1] as string);
      if (amount === null) return null;
      return [{ kind: 'eachOpponentLosesLife', amount }];
    }
  }
  return null;
}

const TRIGGER_HEAD_RE =
  /^(when ~ enters(?: the battlefield)?|when ~ dies|at the beginning of your upkeep|at the beginning of each(?: player's)? upkeep), (.*)$/;

/** Parse a full line as a triggered ability. Returns null when unrecognized. */
function parseTriggerLine(line: string): TriggerSpec | null {
  const m = line.toLowerCase().match(TRIGGER_HEAD_RE);
  if (!m) return null;
  const head = m[1] as string;
  let body = m[2] as string;
  const optional = body.startsWith('you may ');
  if (optional) body = body.slice('you may '.length);

  const effects: EffectSpec[] = [];
  for (const sentence of splitSentences(body)) {
    const parsed = parseEffectSentence(sentence);
    if (parsed === null) return null;
    // Phase 2 restriction: trigger effects must be targetless, so announcing a trigger
    // never needs a target decision.
    if (parsed.some((e) => effectTargetKind(e) !== null)) return null;
    effects.push(...parsed);
  }
  if (effects.length === 0) return null;

  const event = head.startsWith('when ~ enters')
    ? 'etbSelf'
    : head === 'when ~ dies'
      ? 'diesSelf'
      : head === 'at the beginning of your upkeep'
        ? 'upkeepYours'
        : 'upkeepEach';
  return { event, optional, effects, description: line };
}

const MANA_ABILITY_RE = /^\{t\}: add ((?:\{[wubrgc]\})+)$/;

/** Interpret one oracle card. Never throws — unmodeled cards are reported, not errors. */
export function interpretCard(card: OracleCard): CardDefinition {
  const reasons: string[] = [];

  const isLandCard = card.types.includes('Land');
  const costResult = parseManaCost(card.manaCost);
  if (costResult.unsupportedSymbols.length > 0) {
    reasons.push(`unsupported mana cost symbols: ${costResult.unsupportedSymbols.join(' ')}`);
  }

  const parsePT = (value: string | null): number | null => {
    if (value === null) return null;
    if (!/^[+-]?\d+$/.test(value)) {
      reasons.push(`non-numeric power/toughness "${value}"`);
      return null;
    }
    return Number(value);
  };
  const power = parsePT(card.power);
  const toughness = parsePT(card.toughness);

  if (card.layout !== 'normal') {
    reasons.push(`unsupported layout "${card.layout}"`);
  }
  for (const t of card.types) {
    if (!['Creature', 'Artifact', 'Enchantment', 'Land', 'Instant', 'Sorcery'].includes(t)) {
      reasons.push(`unsupported card type "${t}"`);
    }
  }

  const keywords: KeywordAbility[] = [];
  const manaAbilities: ManaAbilitySpec[] = [];
  const spellEffects: EffectSpec[] = [];
  const triggers: TriggerSpec[] = [];
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
    // 5. Spell effect sentences (instants/sorceries only).
    if (isSpell) {
      const sentences = splitSentences(line);
      const lineEffects: EffectSpec[] = [];
      let allParsed = sentences.length > 0;
      for (const sentence of sentences) {
        const parsed = parseEffectSentence(sentence);
        if (parsed === null) {
          allParsed = false;
          break;
        }
        lineEffects.push(...parsed);
      }
      if (allParsed) {
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
    keywords,
    manaAbilities,
    entersTapped,
    spellEffects,
    triggers,
    modeled: reasons.length === 0,
    unmodeledReasons: reasons,
  };
}
