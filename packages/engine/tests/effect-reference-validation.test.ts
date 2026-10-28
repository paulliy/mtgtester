// ADR 0034 decision 2: a reference from one effect to another resolves within the effect list the
// executor runs it in, or the card is unsupported with the exact path.
import { describe, expect, it } from 'vitest';
import type { Ability, Effect } from '../src/cards/ability';
import { enforceCardDefinition, validateCardDefinition } from '../src/cards/authoring-validation';
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { EngineInvariantError } from '../src/errors';
import { createGame } from '../src/state/game';
import { FABLED_PASSAGE_CANDIDATE } from '../src/cards/overrides/queen-marchesa-queens-gambit';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const land = interpretCard(oracle({ name: 'Reference Probe', typeLine: 'Land', oracleText: '' }));

function withPassageEffects(effects: Effect[]): CardDefinition {
  const [ability] = FABLED_PASSAGE_CANDIDATE.activatedAbilities ?? [];
  if (ability === undefined) throw new Error('Fabled Passage candidate has no ability');
  return {
    ...land,
    activatedAbilities: [{ ...ability, ability: { ...ability.ability, effects } }],
  };
}

function passageEffects(): Effect[] {
  return structuredClone(FABLED_PASSAGE_CANDIDATE.activatedAbilities?.[0]?.ability.effects ?? []);
}

const drain = interpretCard(
  oracle({
    name: 'Drain Probe',
    typeLine: 'Sorcery',
    oracleText: 'Each opponent loses 2 life. You gain life equal to the life lost this way.',
  }),
);

function spell(effects: Effect[]): CardDefinition {
  if (drain.spellAbility === null) throw new Error('Drain Probe has no spell ability');
  return { ...drain, spellAbility: { ...drain.spellAbility, effects } };
}

describe('effect reference validation (ADR 0034 decision 2)', () => {
  it("accepts Fabled Passage's bind and the untap that reads it", () => {
    expect(validateCardDefinition(withPassageEffects(passageEffects()))).toEqual([]);
  });

  it('rejects a misspelled binding with its path', () => {
    const effects = passageEffects().map((effect) =>
      effect.op === 'untapBoundIf' ? { ...effect, binding: 'foundLnad' } : effect,
    );
    const issues = validateCardDefinition(withPassageEffects(effects));

    expect(issues).toEqual([
      {
        path: 'definition.activatedAbilities[0].ability.effects[2].binding',
        message: 'binding "foundLnad" is not bound by an earlier effect in the same effect list',
      },
    ]);
    const enforced = enforceCardDefinition(withPassageEffects(effects));
    expect(enforced.modeled).toBe(false);
    expect(enforced.unmodeledReasons.join('\n')).toContain('effects[2].binding');
  });

  it('rejects an untap placed before the bind it reads', () => {
    const [search, shuffle, untap] = passageEffects();
    const issues = validateCardDefinition(withPassageEffects([untap, search, shuffle] as Effect[]));

    expect(issues.map((issue) => issue.path)).toEqual([
      'definition.activatedAbilities[0].ability.effects[0].binding',
    ]);
  });

  it('does not see a bind made inside a nested body', () => {
    const [search, shuffle, untap] = passageEffects();
    const nested = {
      op: 'conditionalEffect',
      condition: untap?.op === 'untapBoundIf' ? untap.condition : undefined,
      then: [search, shuffle],
      else: [],
    } as Effect;
    const issues = validateCardDefinition(withPassageEffects([nested, untap] as Effect[]));

    expect(issues.map((issue) => issue.path)).toEqual([
      'definition.activatedAbilities[0].ability.effects[1].binding',
    ]);
  });

  it('accepts the interpreted drain clause', () => {
    expect(drain.modeled).toBe(true);
    expect(drain.spellAbility?.effects.map((effect) => effect.op)).toEqual([
      'eachOpponentLosesLife',
      'gainLifeEqualToLifeLostThisWay',
    ]);
    expect(validateCardDefinition(drain)).toEqual([]);
  });

  it('accepts life lost this way after an op that feeds it', () => {
    const definition = spell([
      { op: 'eachOpponentLosesLife', amount: { kind: 'const', n: 2 } },
      { op: 'gainLifeEqualToLifeLostThisWay' },
    ] as Effect[]);

    expect(validateCardDefinition(definition)).toEqual([]);
  });

  it('rejects life lost this way after an op that does not feed it', () => {
    const definition = spell([
      { op: 'eachPlayerLosesLife', amount: { kind: 'const', n: 2 } },
      { op: 'gainLifeEqualToLifeLostThisWay' },
    ] as Effect[]);

    expect(validateCardDefinition(definition)).toEqual([
      {
        path: 'definition.spellAbility.effects[1]',
        message:
          'life lost this way needs an earlier eachOpponentLosesLife, loseLifeTarget or loseHalfLifeTarget in the same effect list',
      },
    ]);
  });
});

describe('an unset binding at resolution (ADR 0034 decision 2)', () => {
  it('throws EngineInvariantError instead of untapping nothing', () => {
    const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(4, forest) }))));
    for (let i = 0; i < 4; i++) spawn(ctx, 'P1', forest());
    const source = spawn(ctx, 'P1', oracle({ name: 'Malformed Passage', typeLine: 'Land' }));
    const [, , untap] = passageEffects();
    const ability: Ability = { kind: 'activated', targets: [], effects: [untap as Effect] };

    expect(() => pump(executeAbility(ctx, source, ability, []))).toThrow(EngineInvariantError);
  });
});
