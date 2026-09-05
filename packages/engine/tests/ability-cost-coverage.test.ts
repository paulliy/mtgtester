import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `AbilityCost` kind must be answered by BOTH sides of the payment contract: the
 * affordability check (`canPayNonManaCosts`) and the payment itself (`payAbilityCosts`).
 *
 * The affordability side is the dangerous one, and it is dangerous by construction:
 * `canPayNonManaCosts` is a `for`/`switch` with no `default` and no exhaustiveness check, so an
 * unrecognised cost falls through to the trailing `return true`. **An unknown cost reads as
 * payable.** The engine then offers the ability, and the payment switch — which has no arm for it
 * either — charges nothing. The player gets the effect for free.
 *
 * `discardSelf` was in exactly that state: emitted by both cycling parsers, absent from both
 * switches. It was unreachable only by accident (nothing enumerated hand-zone abilities), and the
 * battlefield loop did not filter on `ActivatedAbility.zone`, so a creature on the battlefield
 * offered its own cycling and would have "paid" by discarding a card that was not in hand.
 *
 * Costs paid on a ZONE path rather than by a battlefield permanent are listed explicitly below
 * with the path that pays them, so that "handled elsewhere" is a decision on the record rather
 * than a silent gap that looks identical to it.
 */
const ENGINE_SRC = join(import.meta.dirname, '..', 'src');

/**
 * Costs whose source is a card in a hidden zone, not an `EnginePermanent`. `payAbilityCosts`
 * takes a permanent and can never pay these; the zone activation paths in `apply.ts` pay them
 * directly. `canPayNonManaCosts` must still REFUSE them (it is only ever asked about battlefield
 * permanents, which are in neither zone) — that refusal is asserted separately.
 */
const PAID_ON_A_ZONE_PATH: Record<string, string> = {
  discardSelf: "applyPriorityAction's fromHand branch — cycling",
  exileSelfFromGraveyard: "applyPriorityAction's fromGraveyard branch — Runehorn Hellkite",
};

/** Costs that belong to CASTING a spell, not to activating an ability of a permanent. */
const SPELL_ONLY_COSTS: Record<string, string> = {
  exileOtherCardsFromGraveyard: 'escape — canPaySpellAdditionalCosts in legal.ts',
  exileCardFromHand: 'Force of Will pitch — canPaySpellAdditionalCosts in legal.ts',
  discardHand: 'spell additional cost',
};

function declaredCostKinds(): Set<string> {
  const ability = readFileSync(join(ENGINE_SRC, 'cards', 'ability.ts'), 'utf8');
  // The AbilityCost union only — stop at the next exported declaration after it.
  const start = ability.indexOf('export type AbilityCost');
  expect(start).toBeGreaterThan(-1);
  const end = ability.indexOf('export interface AlternativeCast', start);
  expect(end).toBeGreaterThan(start);
  const union = ability.slice(start, end);
  return new Set([...union.matchAll(/kind:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1] as string));
}

function armsIn(file: string, functionName: string): Set<string> {
  const source = readFileSync(join(ENGINE_SRC, file), 'utf8');
  const start = source.indexOf(functionName);
  expect(start, `${functionName} not found in ${file}`).toBeGreaterThan(-1);
  // Bound the scan at the next top-level export, so an arm belonging to a LATER function is
  // never mistaken for coverage here. `payAbilityCosts` is immediately followed by
  // `applyManaRider`, whose switch is over `Effect` ops — a scan to end-of-file would read
  // its arms as ability costs.
  const after = source.slice(start + functionName.length);
  const nextExport = after.indexOf('\nexport function');
  const body = nextExport === -1 ? after : after.slice(0, nextExport);
  return new Set([...body.matchAll(/case\s+'([A-Za-z0-9_]+)'/g)].map((m) => m[1] as string));
}

describe('ability cost coverage', () => {
  const declared = declaredCostKinds();

  it('declares a plausible number of cost kinds', () => {
    expect(declared.size).toBeGreaterThan(15);
    expect(declared.has('discardSelf')).toBe(true);
  });

  it('has an affordability arm in canPayNonManaCosts for every cost kind', () => {
    const handled = armsIn('state/queries.ts', 'export function canPayNonManaCosts');
    const missing = [...declared]
      .filter((kind) => kind in SPELL_ONLY_COSTS === false)
      .filter((kind) => !handled.has(kind))
      .sort();
    expect(
      missing,
      'canPayNonManaCosts falls through to a permissive `return true`, so an unlisted cost reads ' +
        'as PAYABLE and the ability is offered for free. Add an explicit arm — returning false is ' +
        'the correct answer for a cost a battlefield permanent cannot pay.',
    ).toEqual([]);
  });

  it('has a payment arm in payAbilityCosts for every cost kind', () => {
    const handled = armsIn('effects/resolve.ts', 'export function* payAbilityCosts');
    const missing = [...declared]
      .filter((kind) => kind in SPELL_ONLY_COSTS === false)
      .filter((kind) => kind in PAID_ON_A_ZONE_PATH === false)
      .filter((kind) => !handled.has(kind))
      .sort();
    expect(
      missing,
      'These costs can be attached to an activated ability but are never charged. The ability ' +
        'resolves and the cost is not paid.',
    ).toEqual([]);
  });

  it('refuses the zone-path costs on a battlefield permanent', () => {
    // The pairing that makes PAID_ON_A_ZONE_PATH safe: those costs are paid by their own path
    // AND rejected on the battlefield path, so neither side is permissive.
    const source = readFileSync(join(ENGINE_SRC, 'state', 'queries.ts'), 'utf8');
    const start = source.indexOf('export function canPayNonManaCosts');
    const body = source.slice(start, source.indexOf('\n}', start));
    for (const kind of Object.keys(PAID_ON_A_ZONE_PATH)) {
      const arm = body.indexOf(`case '${kind}'`);
      expect(arm, `${kind} has no arm in canPayNonManaCosts`).toBeGreaterThan(-1);
      // The arm must reach a `return false` before the next `break`.
      const rest = body.slice(arm);
      const nextReturnFalse = rest.indexOf('return false');
      const nextBreak = rest.indexOf('break;');
      expect(
        nextReturnFalse !== -1 && (nextBreak === -1 || nextReturnFalse < nextBreak),
        `${kind} must return false: a battlefield permanent is not in the zone this cost is paid from`,
      ).toBe(true);
    }
  });
});
