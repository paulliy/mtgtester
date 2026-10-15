import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlImpOverrides } from '../src/cards/overrides/white-black-control-imp';
import { registerWhiteBlackControlRestorationOverrides } from '../src/cards/overrides/white-black-control-restoration';
import { computeCharacteristics } from '../src/effects/continuous';
import { addMana } from '../src/mana/pool';
import { parseManaCost } from '../src/mana/cost';
import { createGame } from '../src/state/game';
import { targetIsLegal } from '../src/targets/legality';
import type { EnginePermanent, EngineStackObject, GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { moveObject } from '../src/state/objects';
import {
  conjure,
  copies,
  gameConfig,
  oracle,
  pump,
  registerCustomDef,
  spawn,
  swamp,
  plains,
} from './fixtures';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}
const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: PinnedCard[] };
const pins = {
  "Imp's Mischief": 'ff07c155d9e445bf1175adebbfa3860a5c1efa0b21f705535e777b680797f890',
  'Restoration Magic': 'fe14aacd1b134c4f90f994409eb6d0a6852d23b46a9f486af258de9093058d22',
} as const;
type Name = keyof typeof pins;
const cards = new Map<Name, PinnedCard>();
for (const name of Object.keys(pins) as Name[]) {
  const entry = pinned.cards.find((candidate) => candidate.card.name === name);
  if (!entry) throw new Error(`Missing pinned Oracle card: ${name}`);
  cards.set(name, entry);
}
beforeAll(() => {
  registerWhiteBlackControlImpOverrides();
  registerWhiteBlackControlRestorationOverrides();
});
function card(name: Name): OracleCard {
  return cards.get(name)!.card;
}
function ctx(seed = 'white-black-control-imp-restoration'): GameContext {
  const game = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(12, swamp) })),
      { seed },
    ),
  );
  Object.assign(game.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 3,
    phase: 'precombatMain',
    step: null,
  });
  return game;
}
function player(game: GameContext, id: string) {
  return game.state.players.find((p) => p.id === id)!;
}
function hand(game: GameContext, id: string, printed: OracleCard) {
  return conjure(game, id, printed, 'hand');
}
function customTargetSpell(
  game: GameContext,
  name: string,
  targetId: string,
  cost = '{0}',
  targets = [{ kind: 'creature' as const }],
) {
  const printed = oracle({
    name,
    typeLine: 'Instant',
    manaCost: cost,
    oracleText: 'Target creature gets +1/+1 until end of turn.',
  });
  const def = {
    ...interpretCard(printed),
    modeled: true,
    unmodeledReasons: [],
    spellAbility: {
      kind: 'spell' as const,
      targets: [{ kind: 'creature' as const }],
      effects: [{ op: 'pumpUntilEot' as const, target: 0, power: 1, toughness: 1 }],
    },
  };
  registerCustomDef(game, def);
  const object = hand(game, 'P2', printed);
  const p = player(game, 'P2');
  addMana(
    p,
    cost.includes('R') ? [{ symbol: 'R' }] : [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }],
  );
  const option = computePriorityOptions(game, p).find((o) => {
    const payload = o.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  })!;
  // Allow tests to model multiple ordinary target occurrences while still announcing the spell normally.
  const targetMap = new Map<number, string>(targets.map((_, i) => [i, targetId]));
  pump(
    applyPriorityAction(game, p, option.payload as PriorityActionPayload, {
      index: 0,
      targets: targetMap,
    }),
  );
  return game.state.stack.at(-1)!;
}
function cast(
  game: GameContext,
  id: string,
  printed: OracleCard,
  modeName?: string,
  targets = new Map<number, string>(),
) {
  const object = hand(game, id, printed);
  const options = computePriorityOptions(game, player(game, id));
  const option = options.find((o) => {
    const payload = o.payload as PriorityActionPayload;
    return (
      payload.kind === 'castSpell' &&
      payload.objectId === object.id &&
      (modeName === undefined || o.description.includes(modeName))
    );
  });
  if (!option)
    throw new Error(`No normal cast option for ${printed.name}${modeName ? ` (${modeName})` : ''}`);
  pump(
    applyPriorityAction(game, player(game, id), option.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
  );
  return game.state.stack.at(-1)!;
}
function perm(game: GameContext, id: string, printed: OracleCard): EnginePermanent {
  return spawn(game, id, printed);
}
function keywords(game: GameContext, permanent: EnginePermanent) {
  return computeCharacteristics(game, permanent).keywords ?? [];
}

describe('Imp’s Mischief and Restoration Magic — pinned Oracle behavior', () => {
  it('binds both exact Oracle hashes and parses each authored replacement', () => {
    for (const name of Object.keys(pins) as Name[]) {
      expect(cards.get(name)!.sha256, name).toBe(pins[name]);
      const def = interpretCard(card(name));
      expect(def.modeled, `${name}: ${def.unmodeledReasons.join('; ')}`).toBe(true);
      expect(def.unmodeledReasons).toEqual([]);
    }
  });

  it('casts Imp normally, changes one target by occurrence identity, and loses the spell mana value even when no change is possible', () => {
    const game = ctx('imp-change-target');
    const old = perm(
      game,
      'P1',
      oracle({
        name: 'Old target',
        typeLine: 'Creature',
        manaCost: '{2}',
        power: '2',
        toughness: '2',
      }),
    );
    const next = perm(
      game,
      'P1',
      oracle({
        name: 'New target',
        typeLine: 'Creature',
        manaCost: '{1}',
        oracleText: 'Ward {9}',
        power: '2',
        toughness: '2',
      }),
    );
    game.defs.set(next.oracleId, {
      ...game.defs.get(next.oracleId)!,
      ward: { kind: 'mana', cost: parseManaCost('{9}').cost! },
    });
    const targeted = customTargetSpell(game, 'Three mana spell', old.id, '{3}');
    addMana(player(game, 'P1'), [{ symbol: 'B' }, { symbol: 'C' }]);
    const imp = cast(game, 'P1', card("Imp's Mischief"), undefined, new Map([[0, targeted.id]]));
    expect(imp.targets).toEqual([targeted.id]);
    pump(resolveTopOfStack(game), (decision) => ({
      index: decision.options.findIndex((o) => o.description.includes(next.name)),
      targets: new Map(),
    }));
    expect(targeted.targets).toEqual([next.id]);
    const ward = game.state.pendingTriggers.find((trigger) =>
      trigger.ability.description?.startsWith('ward'),
    );
    expect(ward?.controllerId).toBe('P1');
    expect(ward?.ability.effects[0]).toMatchObject({
      op: 'counterUnlessPays',
      stackObjectId: targeted.id,
    });
    expect(player(game, 'P1').life).toBe(37);
    expect(next.counters['+1/+1']).toBeUndefined(); // the changed spell still resolves only when its controller gets priority
    // With the only target currently illegal and no other creature, the choice is skipped.
    const retained = ctx('imp-no-alternative');
    const hexproof = perm(
      retained,
      'P2',
      oracle({
        name: 'Hexproof wall',
        typeLine: 'Creature',
        oracleText: 'Hexproof',
        manaCost: '{0}',
        power: '1',
        toughness: '1',
      }),
    );
    const only = customTargetSpell(retained, 'One target spell', hexproof.id);
    const originalTarget = only.targets[0];
    addMana(player(retained, 'P1'), [{ symbol: 'B' }, { symbol: 'C' }]);
    cast(retained, 'P1', card("Imp's Mischief"), undefined, new Map([[0, only.id]]));
    pump(resolveTopOfStack(retained));
    expect(only.targets).toEqual([originalTarget]);
    expect(player(retained, 'P1').life).toBe(40); // zero-mana spell causes no loss
  });

  it('redirects a single counted target and transfers its divided amount with the target identity', () => {
    const game = ctx('imp-counted-division');
    const old = perm(
      game,
      'P1',
      oracle({
        name: 'Counted old',
        typeLine: 'Creature',
        manaCost: '{0}',
        power: '1',
        toughness: '1',
      }),
    );
    const next = perm(
      game,
      'P1',
      oracle({
        name: 'Counted new',
        typeLine: 'Creature',
        manaCost: '{0}',
        power: '1',
        toughness: '1',
      }),
    );
    const spell = customTargetSpell(game, 'Counted spell', old.id);
    spell.targets = [];
    spell.countTargets = { 0: [old.id] };
    spell.ability = {
      kind: 'spell',
      targets: [{ kind: 'creature', count: { min: 1, max: 1 } }],
      effects: [],
    };
    spell.divisionAmounts = { [old.id]: 2 };
    addMana(player(game, 'P1'), [{ symbol: 'B' }, { symbol: 'C' }]);
    cast(game, 'P1', card("Imp's Mischief"), undefined, new Map([[0, spell.id]]));
    pump(resolveTopOfStack(game), (decision) => ({
      index: decision.options.findIndex((o) => o.description.includes(next.name)),
      targets: new Map(),
    }));
    expect(spell.countTargets).toEqual({ 0: [next.id] });
    expect(spell.divisionAmounts).toEqual({ [next.id]: 2 });
  });

  it('rejects targetless, multiple-occurrence, and ability targets as Imp target candidates', () => {
    const game = ctx('imp-target-filter');
    const creature = perm(
      game,
      'P1',
      oracle({ name: 'Target', typeLine: 'Creature', manaCost: '{0}', power: '2', toughness: '2' }),
    );
    const single = customTargetSpell(game, 'Single target candidate', creature.id);
    const targetless = {
      ...single,
      id: 'targetless-stack-spell',
      sourceId: 'targetless-stack-spell',
      targets: [],
      ability: { kind: 'spell' as const, targets: [], effects: [] },
    };
    const multi = {
      ...single,
      id: 'two-occurrences-same-object',
      sourceId: 'two-occurrences-same-object',
      targets: [creature.id, creature.id],
      ability: {
        kind: 'spell' as const,
        targets: [{ kind: 'creature' as const }, { kind: 'creature' as const }],
        effects: [],
      },
    };
    const ability: EngineStackObject = {
      ...single,
      id: 'activation-probe',
      sourceId: 'activation-probe',
      kind: 'activatedAbility',
      description: 'Target ability',
      ability: { kind: 'activated', targets: [{ kind: 'creature' }], effects: [] },
    };
    game.state.stack.push(targetless, multi, ability);
    const impDef = interpretCard(card("Imp's Mischief"));
    const spec = impDef.spellAbility!.targets![0]!;
    expect(spec.spellHasSingleTarget).toBe(true);
    const targetingContext = {
      controllerId: 'P1',
      sourceCardId: 'imp-source',
      sourceColors: ['B'] as const,
    };
    expect(targetIsLegal(game, spec, single.id, targetingContext)).toBe(true);
    expect(targetIsLegal(game, spec, targetless.id, targetingContext)).toBe(false);
    expect(targetIsLegal(game, spec, multi.id, targetingContext)).toBe(false);
    expect(targetIsLegal(game, spec, ability.id, targetingContext)).toBe(false);
  });

  it('retains an existing now-illegal target when no alternative is legal, and uses the targeted spell controller/colors for a redirect', () => {
    const game = ctx('imp-original-spell-legality');
    const old = perm(
      game,
      'P1',
      oracle({
        name: 'Old red target',
        typeLine: 'Creature',
        manaCost: '{0}',
        power: '1',
        toughness: '1',
      }),
    );
    const spell = customTargetSpell(game, 'Red spell', old.id, '{R}');
    game.state.effects.push({
      id: 'red-protection',
      sourceId: 'effect-source',
      description: 'protection from red',
      targetCardIds: [old.cardId],
      kind: 'grantProtection',
      protectionFrom: ['R'],
      timestamp: game.state.nextTimestamp++,
    });
    expect(
      targetIsLegal(game, spell.ability!.targets![0]!, old.id, {
        controllerId: 'P2',
        sourceCardId: spell.sourceCardId,
        sourceColors: ['R'],
      }),
    ).toBe(false);
    addMana(player(game, 'P1'), [{ symbol: 'B' }, { symbol: 'C' }]);
    cast(game, 'P1', card("Imp's Mischief"), undefined, new Map([[0, spell.id]]));
    pump(resolveTopOfStack(game));
    expect(spell.targets).toEqual([old.id]);
    expect(player(game, 'P1').life).toBe(39);

    const blackProtected = perm(
      game,
      'P1',
      oracle({
        name: 'Protection from black',
        typeLine: 'Creature',
        manaCost: '{0}',
        power: '1',
        toughness: '1',
      }),
    );
    game.state.effects.push({
      id: 'black-protection',
      sourceId: 'effect-source',
      description: 'protection from black',
      targetCardIds: [blackProtected.cardId],
      kind: 'grantProtection',
      protectionFrom: ['B'],
      timestamp: game.state.nextTimestamp++,
    });
    const another = perm(
      game,
      'P1',
      oracle({
        name: 'Another legal original target',
        typeLine: 'Creature',
        manaCost: '{0}',
        power: '1',
        toughness: '1',
      }),
    );
    const secondSpell = customTargetSpell(game, 'Second red spell', another.id, '{R}');
    expect(
      targetIsLegal(game, secondSpell.ability!.targets![0]!, blackProtected.id, {
        controllerId: 'P2',
        sourceCardId: secondSpell.sourceCardId,
        sourceColors: ['R'],
      }),
    ).toBe(true);
    expect(
      targetIsLegal(game, secondSpell.ability!.targets![0]!, blackProtected.id, {
        controllerId: 'P1',
        sourceCardId: 'imp-source',
        sourceColors: ['B'],
      }),
    ).toBe(false);
    addMana(player(game, 'P1'), [{ symbol: 'B' }, { symbol: 'C' }]);
    cast(game, 'P1', card("Imp's Mischief"), undefined, new Map([[0, secondSpell.id]]));
    pump(resolveTopOfStack(game), (decision) => ({
      index: decision.options.findIndex((o) => o.description.includes(blackProtected.name)),
      targets: new Map(),
    }));
    expect(secondSpell.targets).toEqual([blackProtected.id]);
  });

  it('casts Restoration tiers with their additional costs, targeting, life, and end-of-turn keyword grants', () => {
    const game = ctx('restoration-cure-cura');
    const own = perm(game, 'P1', oracle({ name: 'Own land', typeLine: 'Land', manaCost: null }));
    const opposing = perm(
      game,
      'P2',
      oracle({ name: 'Opposing permanent', typeLine: 'Artifact', manaCost: '{2}' }),
    );
    addMana(player(game, 'P1'), [{ symbol: 'W' }]);
    const cure = cast(game, 'P1', card('Restoration Magic'), 'Cure', new Map([[0, own.id]]));
    expect(cure.ability?.effects).toHaveLength(2);
    pump(resolveTopOfStack(game));
    expect(keywords(game, own)).toEqual(expect.arrayContaining(['hexproof', 'indestructible']));
    addMana(player(game, 'P1'), [{ symbol: 'W' }, { symbol: 'C' }]);
    const before = player(game, 'P1').life;
    cast(game, 'P1', card('Restoration Magic'), 'Cura', new Map([[1, opposing.id]]));
    pump(resolveTopOfStack(game));
    expect(player(game, 'P1').life).toBe(before + 3);
    expect(keywords(game, opposing)).toEqual(
      expect.arrayContaining(['hexproof', 'indestructible']),
    );
  });

  it('pays Curaga’s exact {3}{W} tier, protects its fixed controller set, and gains six life', () => {
    const game = ctx('restoration-curaga');
    const land = perm(game, 'P1', plains());
    const creature = perm(
      game,
      'P1',
      oracle({
        name: 'Own creature',
        typeLine: 'Creature',
        manaCost: '{1}',
        power: '2',
        toughness: '2',
      }),
    );
    const opponent = perm(
      game,
      'P2',
      oracle({ name: 'Opponent artifact', typeLine: 'Artifact', manaCost: '{1}' }),
    );
    addMana(player(game, 'P1'), [
      { symbol: 'W' },
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'C' },
    ]);
    const life = player(game, 'P1').life;
    cast(game, 'P1', card('Restoration Magic'), 'Curaga');
    pump(resolveTopOfStack(game));
    expect(player(game, 'P1').life).toBe(life + 6);
    for (const own of [land, creature])
      expect(keywords(game, own)).toEqual(expect.arrayContaining(['hexproof', 'indestructible']));
    expect(keywords(game, opponent)).not.toContain('hexproof');
  });

  it('offers only affordable tiers before targets and a Cura whose only target leaves gives no life', () => {
    const unaffordable = ctx('restoration-tier-affordability');
    perm(
      unaffordable,
      'P2',
      oracle({
        name: 'Affordable tier target',
        typeLine: 'Creature',
        manaCost: '{0}',
        power: '1',
        toughness: '1',
      }),
    );
    addMana(player(unaffordable, 'P1'), [{ symbol: 'W' }]);
    const cardObject = hand(unaffordable, 'P1', card('Restoration Magic'));
    const tierOptions = computePriorityOptions(unaffordable, player(unaffordable, 'P1')).filter(
      (option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'castSpell' && payload.objectId === cardObject.id;
      },
    );
    expect(tierOptions.some((option) => option.description.includes('Cure'))).toBe(true);
    expect(tierOptions.some((option) => option.description.includes('Cura'))).toBe(false);
    expect(tierOptions.some((option) => option.description.includes('Curaga'))).toBe(false);

    const game = ctx('restoration-cura-target-gone');
    const target = perm(
      game,
      'P2',
      oracle({ name: 'Cura target leaves', typeLine: 'Artifact', manaCost: '{1}' }),
    );
    addMana(player(game, 'P1'), [{ symbol: 'W' }, { symbol: 'C' }]);
    const life = player(game, 'P1').life;
    cast(game, 'P1', card('Restoration Magic'), 'Cura', new Map([[1, target.id]]));
    pump(moveObject(game, target, { zone: 'exile' }));
    pump(resolveTopOfStack(game));
    expect(player(game, 'P1').life).toBe(life);
    expect(keywords(game, target)).not.toContain('hexproof');
  });
});
