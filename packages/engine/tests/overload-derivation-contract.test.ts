import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { Ability } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { deriveOverloadAbility } from '../src/cards/overload';
import { enforceCardDefinition, validateCardDefinition } from '../src/cards/authoring-validation';
import { manaCost } from '../src/cards/templates';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { resolveTopOfStack } from '../src/stack/stack';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { cloneContractContext } from './helpers/contract-harness';

const fixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/overload-derivation-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
type Cast = Extract<PriorityActionPayload, { kind: 'castSpell' }>;
function setup(name: string) {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  const player = ctx.state.players[0]!;
  ctx.state.currentTurnPlayer = player.id;
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  const projection = fixture.cards.find(({ card }) => card.name === name)!.card;
  const card = conjure(ctx, player.id, projection, 'hand');
  addMana(
    player,
    Array.from({ length: 7 }, () => ({
      symbol:
        name === 'Damn' ? ('W' as const) : name === 'Vandalblast' ? ('R' as const) : ('U' as const),
    })),
  );
  const options = () =>
    computePriorityOptions(ctx, player).filter(
      (option) =>
        (option.payload as Cast).kind === 'castSpell' &&
        (option.payload as Cast).objectId === card.id,
    );
  const cast = (payload: Cast, targets = new Map<number, string>()) =>
    pump(applyPriorityAction(ctx, player, payload, { index: 0, targets }));
  return { ctx, player, card, options, cast };
}

describe('guarded Overload lowering and casting', () => {
  it('pins exact canonical clauses and derives different faithful executable alternatives', () => {
    for (const { sha256, card } of fixture.cards)
      expect(createHash('sha256').update(JSON.stringify(card)).digest('hex')).toBe(sha256);
    const rift = interpretCard(fixture.cards[0]!.card);
    expect(rift.modeled).toBe(true);
    expect(rift.alternativeCasts?.[0]?.ability?.effects).toEqual([
      { op: 'overloadBounceAllNonlandOpponents' },
    ]);
    const vandalblast = interpretCard(fixture.cards[1]!.card);
    expect(vandalblast.modeled).toBe(true);
    expect(vandalblast.alternativeCasts?.[0]?.ability?.effects[0]?.op).toBe('destroyEach');
    expect(vandalblast.alternativeCasts?.[0]?.ability?.targets).toEqual([]);
  });

  it('Cyclonic Rift overload affects protected opposing nonlands and leaves yours and lands', () => {
    const state = setup('Cyclonic Rift');
    const mine = spawn(state.ctx, 'P1', bear());
    const protectedOpponent = spawn(
      state.ctx,
      'P2',
      oracle({
        name: 'Protected bounce probe',
        typeLine: 'Creature',
        power: '2',
        toughness: '2',
        oracleText: 'Shroud\nProtection from blue',
      }),
    );
    const artifact = spawn(
      state.ctx,
      'P2',
      oracle({ name: 'Bounce artifact', typeLine: 'Artifact' }),
    );
    const land = spawn(state.ctx, 'P2', forest());
    const option = state
      .options()
      .find((option) => (option.payload as Cast).alternativeCast === 'overload')!;
    expect(option.targets).toBeUndefined();
    state.cast(option.payload as Cast);
    expect(state.ctx.state.stack[0]?.targets).toEqual([]);
    pump(resolveTopOfStack(state.ctx));
    expect(state.ctx.state.battlefield).toContain(mine);
    expect(state.ctx.state.battlefield).toContain(land);
    expect(state.ctx.state.battlefield).not.toContain(protectedOpponent);
    expect(state.ctx.state.battlefield).not.toContain(artifact);
    expect(state.ctx.state.players[1]!.hand.map((card) => card.cardId)).toEqual(
      expect.arrayContaining([protectedOpponent.cardId, artifact.cardId]),
    );
  });

  it('Vandalblast overload destroys opposing artifacts through protection but honors indestructible', () => {
    const state = setup('Vandalblast');
    const mine = spawn(state.ctx, 'P1', oracle({ name: 'Own artifact', typeLine: 'Artifact' }));
    const protectedArtifact = spawn(
      state.ctx,
      'P2',
      oracle({
        name: 'Protected artifact',
        typeLine: 'Artifact',
        oracleText: 'Shroud\nProtection from red',
      }),
    );
    const indestructible = spawn(
      state.ctx,
      'P2',
      oracle({
        name: 'Indestructible artifact',
        typeLine: 'Artifact',
        oracleText: 'Indestructible',
      }),
    );
    const creature = spawn(state.ctx, 'P2', bear());
    const option = state
      .options()
      .find((option) => (option.payload as Cast).alternativeCast === 'overload')!;
    state.cast(option.payload as Cast);
    pump(resolveTopOfStack(state.ctx));
    expect(state.ctx.state.battlefield).toEqual(
      expect.arrayContaining([mine, indestructible, creature]),
    );
    expect(state.ctx.state.battlefield).not.toContain(protectedArtifact);
    expect(
      state.ctx.state.players[1]!.graveyard.some(
        (card) => card.cardId === protectedArtifact.cardId,
      ),
    ).toBe(true);
    expect(
      state.ctx.state.players[1]!.hand.some((card) => card.cardId === protectedArtifact.cardId),
    ).toBe(false);
  });

  it('normal Vandalblast still targets exactly one legal opposing artifact', () => {
    const state = setup('Vandalblast');
    const first = spawn(state.ctx, 'P2', oracle({ name: 'First artifact', typeLine: 'Artifact' }));
    const second = spawn(
      state.ctx,
      'P2',
      oracle({ name: 'Second artifact', typeLine: 'Artifact' }),
    );
    const mine = spawn(state.ctx, 'P1', oracle({ name: 'Own artifact', typeLine: 'Artifact' }));
    const normal = state
      .options()
      .find((option) => (option.payload as Cast).alternativeCast === undefined)!;
    expect(normal.targets?.[0]?.options).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(normal.targets?.[0]?.options).not.toContain(mine.id);
    state.cast(normal.payload as Cast, new Map([[0, first.id]]));
    pump(resolveTopOfStack(state.ctx));
    expect(state.ctx.state.battlefield).toContain(second);
    expect(state.ctx.state.battlefield).toContain(mine);
    expect(state.ctx.state.battlefield).not.toContain(first);
  });

  it('damn-overload-destroys-each-creature-without-regeneration', () => {
    const state = setup('Damn');
    const mine = spawn(state.ctx, 'P1', bear());
    mine.regenerationShields = 1;
    const protectedCreature = spawn(
      state.ctx,
      'P2',
      oracle({
        name: 'Protected Damn probe',
        typeLine: 'Creature',
        power: '2',
        toughness: '2',
        oracleText: 'Shroud\nProtection from white',
      }),
    );
    protectedCreature.regenerationShields = 1;
    const indestructible = spawn(
      state.ctx,
      'P2',
      oracle({
        name: 'Indestructible Damn probe',
        typeLine: 'Creature',
        power: '2',
        toughness: '2',
        oracleText: 'Indestructible',
      }),
    );
    const artifact = spawn(
      state.ctx,
      'P2',
      oracle({ name: 'Damn artifact', typeLine: 'Artifact' }),
    );
    const land = spawn(state.ctx, 'P2', forest());
    const option = state
      .options()
      .find((option) => (option.payload as Cast).alternativeCast === 'overload')!;
    expect(option).toBeDefined();
    expect(option.targets).toBeUndefined();
    state.cast(option.payload as Cast);
    pump(resolveTopOfStack(state.ctx));
    expect(state.ctx.state.battlefield).not.toContain(mine);
    expect(state.ctx.state.battlefield).not.toContain(protectedCreature);
    expect(state.ctx.state.battlefield).toEqual(
      expect.arrayContaining([indestructible, artifact, land]),
    );
    expect(state.ctx.state.players[0]!.graveyard.some((card) => card.cardId === mine.cardId)).toBe(
      true,
    );
    expect(
      state.ctx.state.players[1]!.graveyard.some(
        (card) => card.cardId === protectedCreature.cardId,
      ),
    ).toBe(true);
    expect(
      state.ctx.state.players[1]!.hand.some((card) => card.cardId === protectedCreature.cardId),
    ).toBe(false);
  });

  it('damn-normal-targets-one-creature-and-prevents-regeneration', () => {
    const state = setup('Damn');
    addMana(state.player, [{ symbol: 'B' }, { symbol: 'B' }]);
    const first = spawn(state.ctx, 'P1', bear());
    first.regenerationShields = 1;
    const second = spawn(state.ctx, 'P2', bear());
    const artifact = spawn(
      state.ctx,
      'P2',
      oracle({ name: 'Noncreature Damn probe', typeLine: 'Artifact' }),
    );
    const option = state
      .options()
      .find((option) => (option.payload as Cast).alternativeCast === undefined)!;
    expect(option.targets?.[0]?.options).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(option.targets?.[0]?.options).not.toContain(artifact.id);
    state.cast(option.payload as Cast, new Map([[0, first.id]]));
    pump(resolveTopOfStack(state.ctx));
    expect(state.ctx.state.battlefield).not.toContain(first);
    expect(state.ctx.state.battlefield).toEqual(expect.arrayContaining([second, artifact]));
  });

  it('cyclonic-rift-normal-target-restrictions', () => {
    const state = setup('Cyclonic Rift');
    const mine = spawn(state.ctx, 'P1', bear());
    const opponent = spawn(state.ctx, 'P2', bear());
    const shroud = spawn(
      state.ctx,
      'P2',
      oracle({ name: 'Shroud Rift probe', typeLine: 'Creature', oracleText: 'Shroud' }),
    );
    const land = spawn(state.ctx, 'P2', forest());
    const option = state
      .options()
      .find((option) => (option.payload as Cast).alternativeCast === undefined)!;
    expect(option.targets?.[0]?.options).toContain(opponent.id);
    for (const illegal of [mine, shroud, land])
      expect(option.targets?.[0]?.options).not.toContain(illegal.id);
    state.cast(option.payload as Cast, new Map([[0, opponent.id]]));
    pump(resolveTopOfStack(state.ctx));
    expect(state.ctx.state.battlefield).not.toContain(opponent);
    expect(state.ctx.state.battlefield).toEqual(expect.arrayContaining([mine, shroud, land]));
    expect(state.ctx.state.players[1]!.hand.some((card) => card.cardId === opponent.cardId)).toBe(
      true,
    );
  });

  it('rejects unsupported lowering scopes rather than substituting bounce', () => {
    const base: Ability = {
      kind: 'spell',
      targets: [{ kind: 'artifact', controller: 'opponent' }],
      effects: [{ op: 'destroy', target: 0 }],
    };
    expect(
      deriveOverloadAbility({
        ...base,
        targets: [{ ...base.targets[0]!, filter: { kind: 'type', value: 'Artifact' } }],
      }),
    ).toBeNull();
    expect(deriveOverloadAbility({ ...base, effects: [{ op: 'exile', target: 0 }] })).toBeNull();
    expect(
      deriveOverloadAbility({
        ...base,
        effects: [...base.effects, { op: 'draw', count: { kind: 'const', n: 1 } }],
      }),
    ).toBeNull();
    expect(
      deriveOverloadAbility({
        ...base,
        effects: [
          { ...base.effects[0]!, unexpected: true } as unknown as Ability['effects'][number],
        ],
      }),
    ).toBeNull();
  });

  it.each(fixture.cards.slice(2, 5).map(({ card }) => ({ name: card.name, card })))(
    '$name-overload-contained',
    ({ card }) => {
      const definition = interpretCard(card);
      expect(definition.modeled, card.name).toBe(false);
      expect(
        definition.unmodeledReasons.some((reason) => reason.includes('unrecognized rules text')),
      ).toBe(true);
      expect(definition.alternativeCasts?.[0]?.ability).toBeUndefined();
    },
  );

  it('marks a missing or targeted authored overload ability explicitly unsupported', () => {
    const state = setup('Vandalblast');
    const definition = state.ctx.defs.get(state.card.oracleId)!;
    const invalid = {
      ...definition,
      alternativeCasts: [
        {
          kind: 'overload' as const,
          description: 'Incomplete overload',
          manaCost: manaCost('{0}'),
        },
      ],
    };
    expect(
      validateCardDefinition(invalid).some((issue) => issue.message.includes('overload requires')),
    ).toBe(true);
    expect(enforceCardDefinition(invalid).modeled).toBe(false);
    const targeted = {
      ...invalid,
      alternativeCasts: [{ ...invalid.alternativeCasts[0]!, ability: definition.spellAbility! }],
    };
    expect(enforceCardDefinition(targeted).modeled).toBe(false);
  });

  it('cannot execute a forged missing overload ability after bypassing authoring validation', () => {
    const state = setup('Vandalblast');
    state.ctx.defs.set(state.card.oracleId, {
      ...state.ctx.defs.get(state.card.oracleId)!,
      alternativeCasts: [
        { kind: 'overload', description: 'Missing behavior', manaCost: manaCost('{0}') },
      ],
    });
    expect(() => state.options()).toThrow('no executable ability');
    const before = cloneContractContext(state.ctx);
    expect(() =>
      state.cast({
        kind: 'castSpell',
        objectId: state.card.id,
        fromCommand: false,
        alternativeCast: 'overload',
        altIndex: 0,
      }),
    ).toThrow('no executable ability');
    expect(state.ctx.state).toEqual(before.state);
  });
});

it.each([false, true])(
  'damn-simultaneous-indestructible is independent of battlefield order %s',
  (reverse) => {
    const state = setup('Damn');
    const pin = JSON.parse(
      readFileSync('packages/engine/tests/fixtures/overload-static-review-oracle.json', 'utf8'),
    ) as { cards: { card: OracleCard; sha256: string }[] };
    const exemplarPin = pin.cards.find(({ card }) => card.name === 'Knight Exemplar')!;
    expect(createHash('sha256').update(JSON.stringify(exemplarPin.card)).digest('hex')).toBe(
      exemplarPin.sha256,
    );
    const exemplar = spawn(state.ctx, 'P2', exemplarPin.card);
    const knight = spawn(
      state.ctx,
      'P2',
      oracle({
        name: 'Independent protected Knight',
        typeLine: 'Creature — Knight',
        power: '2',
        toughness: '2',
      }),
    );
    const ordinary = spawn(state.ctx, 'P2', bear());
    if (reverse) state.ctx.state.battlefield.reverse();
    const option = state
      .options()
      .find((option) => (option.payload as Cast).alternativeCast === 'overload')!;
    state.cast(option.payload as Cast);
    pump(resolveTopOfStack(state.ctx));
    expect(state.ctx.state.battlefield).toContain(knight);
    expect(state.ctx.state.battlefield).not.toContain(exemplar);
    expect(state.ctx.state.battlefield).not.toContain(ordinary);
  },
);
