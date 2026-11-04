/**
 * Cost phrases for the card grammar (ADR 0038): the left of an activated ability's colon, the
 * additional cost of casting a spell (CR 601.2b), and the non-mana alternative costs printed on
 * cards like Force of Will. Each parser returns `AbilityCost`s or null, and null leaves the card
 * unmodeled.
 */

import type { Color, OracleCard } from '@mtg/shared';
import { parseManaCost } from '../../mana/cost';
import type { ParsedManaCost } from '../../mana/cost';
import type { AbilityCost } from '../ability';
import { COLOR_WORDS, parseAmount, resolveSubtype, SELF_OBJECT_RE } from './words';
import { parseSubject } from './subject';
import { parseConditionClause } from './condition';
import type { Condition } from '../condition';
import type { Selector } from '../selector';
import {
  IS_TOKEN,
  YOURS,
  allOf,
  anyOf,
  ofColor,
  not,
  ofSubtype,
  ofSupertype,
  ofType,
} from '../selector';
import { noteSlotFailure } from './diagnostics';

/**
 * Split "`<costs>`: `<effect>`" at the FIRST colon. Returns null for a line that is not an
 * activated ability at all.
 */
export function splitActivation(lower: string): { costText: string; effectText: string } | null {
  const i = lower.indexOf(': ');
  if (i <= 0) return null;
  return { costText: lower.slice(0, i), effectText: lower.slice(i + 2) };
}

/**
 * The cost segment of an activated ability — "{1}, {T}, Sacrifice this creature" — as a list of
 * `AbilityCost`s. Returns null if ANY component is unrecognized: a cost the engine cannot charge
 * is worse than an ability it cannot use, because the ability would then be free.
 */
function parseActivationCostsUntraced(costText: string, card?: OracleCard): AbilityCost[] | null {
  const costs: AbilityCost[] = [];
  for (const raw of costText.split(',')) {
    const part = raw.trim();
    if (part === 'tap an untapped legendary creature you control') {
      costs.push({
        kind: 'tapOther',
        selector: allOf(ofType('Creature'), ofSupertype('Legendary'), YOURS),
      });
      continue;
    }
    // "Tap an untapped creature you control" may tap the source itself when it is one: the cost
    // names any untapped creature you control, not "another" (allowSelf).
    if (part === 'tap an untapped creature you control') {
      costs.push({ kind: 'tapOther', selector: allOf(ofType('Creature'), YOURS), allowSelf: true });
      continue;
    }
    const tapOthers = part.match(/^tap (two|three|four) untapped (.+) you control$/);
    if (tapOthers !== null) {
      const count = parseAmount(tapOthers[1] as string) as number;
      const noun = tapOthers[2] as string;
      const type = noun === 'artifacts' ? 'Artifact' : noun === 'creatures' ? 'Creature' : null;
      if (type === null) return null;
      costs.push({
        kind: 'tapOthers',
        selector: allOf(ofType(type), YOURS),
        count,
        allowSelf: true,
      });
      continue;
    }
    if (part === '{t}') {
      costs.push({ kind: 'tap' });
      continue;
    }
    if (part === 'unattach this equipment') {
      costs.push({ kind: 'unattachSelf' });
      continue;
    }
    const sacrifice = part.match(/^sacrifice (.+)$/);
    if (sacrifice !== null) {
      // Only "sacrifice THIS": sacrificing something else is a choice, and a cost that asks a
      // question needs machinery this increment does not have.
      const phrase = sacrifice[1] as string;
      if (SELF_OBJECT_RE.test(phrase)) {
        costs.push({ kind: 'sacrificeSelf' });
        continue;
      }
      // The count word runs the full number vocabulary, not just one-to-three: Westvale Abbey
      // asks for FIVE creatures, and a truncated list silently left the whole cost unparsed.
      const picked = phrase.match(
        /^(?:(a|an|one|two|three|four|five|six|seven|eight|nine|ten) )?(another )?(.+)$/,
      );
      if (picked === null) return null;
      const countWord = picked[1] ?? 'one';
      const count = countWord === 'a' || countWord === 'an' ? 1 : (parseAmount(countWord) ?? 1);
      const noun = (picked[3] as string).replace(/s$/, '');
      const subtype = card === undefined ? null : resolveSubtype(noun, card);
      // "Sacrifice a nontoken blue creature" (the Flares' alternative cost): a token or color
      // qualifier on a creature.
      const qualified = noun.match(/^(nontoken )?(?:(white|blue|black|red|green) )?creature$/);
      const qualifiers: Selector[] =
        qualified === null
          ? []
          : [
              ...(qualified[1] !== undefined ? [not(IS_TOKEN)] : []),
              ...(qualified[2] !== undefined ? [ofColor(COLOR_WORDS[qualified[2]] as Color)] : []),
            ];
      const base =
        qualifiers.length > 0
          ? allOf(ofType('Creature'), ...qualifiers)
          : noun === 'artifact or creature'
            ? anyOf(ofType('Artifact'), ofType('Creature'))
            : noun === 'artifact'
              ? ofType('Artifact')
              : noun === 'creature'
                ? ofType('Creature')
                : noun === 'land'
                  ? ofType('Land')
                  : noun === 'permanent'
                    ? anyOf(
                        ofType('Artifact'),
                        ofType('Creature'),
                        ofType('Enchantment'),
                        ofType('Land'),
                        ofType('Planeswalker'),
                        ofType('Battle'),
                      )
                    : noun === 'servo'
                      ? ofSubtype('Servo')
                      : noun === 'token'
                        ? IS_TOKEN
                        : subtype !== null
                          ? ofSubtype(subtype)
                          : null;
      if (base === null) return null;
      costs.push({
        kind: 'sacrificeOther',
        selector: allOf(YOURS, base),
        ...(count > 1 ? { count } : {}),
        ...(picked[2] === undefined ? { allowSelf: true } : {}),
      });
      continue;
    }
    // "Discard this card" (channel lands - Boseiju, Otawara) is the SOURCE leaving hand, not a
    // free choice of card, so it is `discardSelf` rather than `discardCard`. The zone that makes
    // it payable is set by the caller (`parseActivatedLine`), which sees the whole line.
    if (/^discard (?:~|this card)$/.test(part)) {
      costs.push({ kind: 'discardSelf' });
      continue;
    }
    const discard = part.match(
      /^discard (a|an|one|two|three|four|five|six|seven|eight|nine|ten) cards?$/,
    );
    if (discard !== null) {
      const count = parseAmount(discard[1] as string);
      if (count === null) return null;
      costs.push({ kind: 'discardCard', ...(count > 1 ? { count } : {}) });
      continue;
    }
    const payLife = part.match(/^pay (\d+) life$/);
    if (payLife !== null) {
      costs.push({ kind: 'payLife', amount: Number(payLife[1]) });
      continue;
    }
    const payEnergy = part.match(/^pay (\d+) \{e\}$/);
    if (payEnergy !== null) {
      costs.push({ kind: 'payEnergy', amount: Number(payEnergy[1]) });
      continue;
    }
    // "Remove a +1/+1 counter from a creature you control" (Sage of Fables): the counter comes off
    // any matching permanent you control, chosen as the cost is paid.
    const fromAmong = part.match(
      /^remove (a|an|one|two) (\+1\/\+1|[a-z]+) counters? from an? (.+) you control$/,
    );
    if (fromAmong !== null) {
      const count = parseAmount(fromAmong[1] as string);
      if (card === undefined) return null;
      const noun = parseSubject(`${fromAmong[3] as string}s you control`, card);
      if (count === null || noun === null) return null;
      costs.push({
        kind: 'removeCountersFromAmong',
        counter: fromAmong[2] as string,
        count,
        selector: noun,
      });
      continue;
    }
    const counters = part.match(/^remove (\w+) ([+-]\d+\/[+-]\d+|\w+) counters? from (.+)$/);
    if (counters !== null) {
      if (!SELF_OBJECT_RE.test(counters[3] as string)) return null;
      const count = parseAmount(counters[1] as string);
      if (count === null) return null;
      costs.push({ kind: 'removeCounters', counter: counters[2] as string, count });
      continue;
    }
    const loyalty = part.match(/^([+\u2212-]\d+)$/);
    if (loyalty !== null) {
      const valStr = loyalty[1]!.replace('\u2212', '-');
      costs.push({ kind: 'loyalty', delta: Number(valStr) });
      continue;
    }
    if (/^(?:\{[^}]+\})+$/.test(part)) {
      const parsed = parseManaCost(part.toUpperCase() as never);
      if (parsed.cost === null) return null;
      costs.push({ kind: 'mana', cost: parsed.cost });
      continue;
    }
    return null;
  }
  return costs.length > 0 ? costs : null;
}

/** Parse Flashback/Escape non-mana components that are not ordinary activation costs. */
export function parseGraveyardAlternativeCosts(costText: string): AbilityCost[] | null {
  const exileOther = costText.match(
    /^exile (one|two|three|four|five|six|seven|eight|nine|ten|\d+) other cards? from your graveyard$/,
  );
  if (exileOther !== null) {
    const count = parseAmount(exileOther[1] as string);
    return count === null ? null : [{ kind: 'exileOtherCardsFromGraveyard', count }];
  }
  return parseActivationCosts(costText);
}

/** Parse a non-mana alternate-cost line such as Force of Will's pitch cost. */
function parseNonManaAlternativeCostUntraced(
  line: string,
  card: OracleCard,
): { costs: AbilityCost[]; manaCost?: ParsedManaCost; condition?: Condition } | null {
  const match = line.match(
    /^(if it's not your turn, )?you may (.+) rather than pay (?:this spell's|its) mana cost(?: if (.+))?$/,
  );
  if (match === null) return null;
  // "... if there are thirteen or more creatures on the battlefield" (Blasphemous Edict): a
  // condition on choosing the alternative cost, checked as the spell is cast.
  const trailing = match[3] === undefined ? undefined : parseConditionClause(match[3], card);
  if (trailing === null) return null;
  const costs: AbilityCost[] = [];
  let manaCost: ParsedManaCost | undefined;
  for (const part of (match[2] as string).split(' and ')) {
    // "You may pay {B} rather than pay this spell's mana cost": a replacement mana cost.
    const pay = part.match(/^pay ((?:\{[^}]+\})+)$/);
    if (pay !== null && manaCost === undefined) {
      const parsed = parseManaCost((pay[1] as string).toUpperCase() as never);
      if (parsed.cost === null) return null;
      manaCost = parsed.cost;
      continue;
    }
    const payLife = part.match(/^(?:pay) (\d+) life$/);
    if (payLife !== null) {
      costs.push({ kind: 'payLife', amount: Number(payLife[1]) });
      continue;
    }
    const exile = part.match(/^exile (?:a|one) (white|blue|black|red|green) card from your hand$/);
    if (exile !== null) {
      const colors: Record<string, Color> = {
        white: 'W',
        blue: 'U',
        black: 'B',
        red: 'R',
        green: 'G',
      };
      costs.push({
        kind: 'exileCardFromHand',
        selector: ofColor(colors[exile[1] as string] as Color),
      });
      continue;
    }
    // "You may sacrifice a nontoken blue creature rather than pay this spell's mana cost" (the
    // Flares). A spell is never a permanent, so "a creature" can never be the spell itself.
    if (/^sacrifice /.test(part)) {
      const sacrifice = parseActivationCosts(part);
      if (sacrifice === null || sacrifice.some((cost) => cost.kind !== 'sacrificeOther')) {
        return null;
      }
      costs.push(...sacrifice);
      continue;
    }
    return null;
  }
  if (costs.length === 0 && manaCost === undefined) return null;
  if (match[1] !== undefined && trailing !== undefined) return null;
  const condition: Condition | undefined =
    match[1] !== undefined ? { kind: 'notYourTurn' } : trailing;
  return {
    costs,
    ...(manaCost !== undefined ? { manaCost } : {}),
    ...(condition !== undefined ? { condition } : {}),
  };
}

/** Parse the "As an additional cost to cast this spell, ..." header. */
function parseSpellAdditionalCostUntraced(line: string): AbilityCost[] | null {
  const m = line.match(/^as an additional cost to cast this spell, (.+)$/i);
  if (m === null) return null;
  // "pay X life" (Toxic Deluge): X is announced with the spell (CR 601.2b) and paid as a cost
  // while casting (CR 601.2h). The caller marks the spell as announcing X.
  if (m[1] === 'pay x life') return [{ kind: 'payLifeValue', amount: { kind: 'xValue' } }];
  return parseActivationCosts(m[1] as string);
}

/** `parseActivationCostsUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseActivationCosts(
  ...args: Parameters<typeof parseActivationCostsUntraced>
): ReturnType<typeof parseActivationCostsUntraced> {
  const result = parseActivationCostsUntraced(...args);
  if (result === null) noteSlotFailure('cost', args[0]);
  return result;
}

/** `parseNonManaAlternativeCostUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseNonManaAlternativeCost(
  ...args: Parameters<typeof parseNonManaAlternativeCostUntraced>
): ReturnType<typeof parseNonManaAlternativeCostUntraced> {
  const result = parseNonManaAlternativeCostUntraced(...args);
  if (result === null) noteSlotFailure('cost', args[0]);
  return result;
}

/** `parseSpellAdditionalCostUntraced`, recording a failure for slot diagnostics (ADR 0038 decision 2). */
export function parseSpellAdditionalCost(
  ...args: Parameters<typeof parseSpellAdditionalCostUntraced>
): ReturnType<typeof parseSpellAdditionalCostUntraced> {
  const result = parseSpellAdditionalCostUntraced(...args);
  if (result === null) noteSlotFailure('cost', args[0]);
  return result;
}
