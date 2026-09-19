import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import {
  computePriorityOptions,
  computeTargetOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import type { EngineStackObject, GameContext } from '../src/state/types';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const dash = String.fromCharCode(0x2014);
const nl = String.fromCharCode(10);

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

function putSpellOnStack(
  ctx: GameContext,
  controllerId: string,
  card: ReturnType<typeof oracle>,
  cantBeCountered = false,
): EngineStackObject {
  const object = conjure(ctx, controllerId, card, 'hand');
  const player = ctx.state.players.find((candidate) => candidate.id === controllerId)!;
  player.hand = player.hand.filter((candidate) => candidate.id !== object.id);
  object.zone = 'stack';
  const entry: EngineStackObject = {
    id: object.id,
    sourceId: object.id,
    controllerId,
    kind: 'spell',
    description: object.name,
    targets: [],
    card: object,
    ability: {
      kind: 'spell',
      targets: [],
      effects: [],
      ...(cantBeCountered ? { cantBeCountered: true } : {}),
    },
    sourceOracleId: object.oracleId,
    sourceCardId: object.cardId,
    isCommanderCast: false,
  };
  ctx.state.stack.push(entry);
  return entry;
}

function sourceFor(name: string, controllerId = 'P1') {
  return {
    cardId: `source-${name}`,
    oracleId: `oracle-${name}`,
    name,
    controllerId,
  };
}

describe('Tier 3 target-controller beneficiaries', () => {
  it("counters with Offer and creates two Treasures for the countered spell's controller", () => {
    const offer = oracle({
      name: "Test Offer You Can't Refuse",
      typeLine: 'Instant',
      manaCost: '{U}',
      colors: ['U'],
      colorIdentity: ['U'],
      oracleText: 'Counter target noncreature spell. Its controller creates two Treasure tokens.',
    });
    const def = interpretCard(offer);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(def.spellAbility?.effects[0]).toMatchObject({
      op: 'counterAndCreateTokenForController',
      count: { kind: 'const', n: 2 },
    });

    const ctx = pod('tier3-offer-beneficiary');
    const target = putSpellOnStack(
      ctx,
      'P2',
      oracle({
        name: 'Target Sorcery',
        typeLine: 'Sorcery',
        manaCost: '{2}',
        oracleText: 'Draw a card.',
      }),
    );
    pump(executeAbility(ctx, sourceFor(offer.name), def.spellAbility!, [target.id]));

    expect(ctx.state.stack.some((entry) => entry.id === target.id)).toBe(false);
    expect(
      ctx.state.players[1]!.graveyard.some((card) => card.cardId === target.sourceCardId),
    ).toBe(true);
    const treasures = ctx.state.battlefield.filter(
      (perm) => perm.controllerId === 'P2' && perm.name === 'Treasure',
    );
    expect(treasures).toHaveLength(2);
    expect(
      ctx.state.battlefield.some((perm) => perm.controllerId === 'P1' && perm.name === 'Treasure'),
    ).toBe(false);
  });

  it('uses filtered stack targets for Swan Song and still grants the token if countering is prevented', () => {
    const swan = oracle({
      name: 'Test Swan Song',
      typeLine: 'Instant',
      manaCost: '{U}',
      colors: ['U'],
      colorIdentity: ['U'],
      oracleText:
        'Counter target enchantment, instant, or sorcery spell. Its controller creates a 2/2 blue Bird creature token with flying.',
    });
    const def = interpretCard(swan);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    const ctx = pod('tier3-swan-beneficiary');
    const artifact = putSpellOnStack(
      ctx,
      'P2',
      oracle({ name: 'Target Artifact', typeLine: 'Artifact', oracleText: '' }),
    );
    const creature = putSpellOnStack(ctx, 'P2', bear());
    const enchantment = putSpellOnStack(
      ctx,
      'P2',
      oracle({ name: 'Target Enchantment', typeLine: 'Enchantment', oracleText: '' }),
      true,
    );

    expect(computeTargetOptions(ctx, def.spellAbility!.targets[0]!, 'P1')).toEqual([
      enchantment.id,
    ]);
    pump(executeAbility(ctx, sourceFor(swan.name), def.spellAbility!, [enchantment.id]));
    expect(ctx.state.stack.map((entry) => entry.id)).toEqual([
      artifact.id,
      creature.id,
      enchantment.id,
    ]);
    const birds = ctx.state.battlefield.filter(
      (perm) => perm.controllerId === 'P2' && perm.name === 'Bird',
    );
    expect(birds).toHaveLength(1);
    expect(birds[0] && birds[0].controllerId).toBe('P2');
  });

  it("lets Trophy's target controller find the basic land", () => {
    const trophy = oracle({
      name: "Test Assassin's Trophy",
      typeLine: 'Instant',
      manaCost: '{B}{G}',
      colors: ['B', 'G'],
      colorIdentity: ['B', 'G'],
      oracleText:
        'Destroy target permanent an opponent controls. Its controller may search their library for a basic land card, put it onto the battlefield, then shuffle.',
    });
    const def = interpretCard(trophy);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    const ctx = pod('tier3-trophy-beneficiary');
    const victim = spawn(ctx, 'P2', bear());
    const basic = conjure(ctx, 'P2', forest(), 'library');

    pump(executeAbility(ctx, sourceFor(trophy.name), def.spellAbility!, [victim.id]));
    expect(ctx.state.players[1]!.graveyard.some((card) => card.cardId === victim.cardId)).toBe(
      true,
    );
    const found = ctx.state.battlefield.find((perm) => perm.cardId === basic.cardId);
    expect(found?.controllerId).toBe('P2');
    expect(found?.tapped).toBe(false);
  });
});

describe('Tier 3 full-graveyard exile', () => {
  it('parses and resolves Exile all graveyards for every player', () => {
    const farewell = oracle({
      name: 'Test Farewell Mode',
      typeLine: 'Sorcery',
      manaCost: '{4}{W}{W}',
      colors: ['W'],
      colorIdentity: ['W'],
      oracleText: 'Exile all graveyards.',
    });
    const def = interpretCard(farewell);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(def.spellAbility?.effects).toEqual([{ op: 'exileAllGraveyards' }]);
    const ctx = pod('tier3-all-graveyards');
    for (const player of ctx.state.players) {
      conjure(ctx, player.id, bear(), 'graveyard');
    }

    pump(executeAbility(ctx, sourceFor(farewell.name), def.spellAbility!, []));
    expect(ctx.state.players.every((player) => player.graveyard.length === 0)).toBe(true);
    expect(ctx.state.exile).toHaveLength(4);
  });

  it('pays Scavenger Grounds by sacrificing its own Desert, then exiles it with all graveyards', () => {
    const grounds = oracle({
      name: 'Test Scavenger Grounds',
      typeLine: `Land ${dash} Desert`,
      types: ['Land'],
      subtypes: ['Desert'],
      manaCost: null,
      cmc: 0,
      oracleText: [`{T}: Add {C}.`, `{2}, {T}, Sacrifice a Desert: Exile all graveyards.`].join(nl),
    });
    const def = interpretCard(grounds);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(def.activatedAbilities[0]?.costs).toContainEqual(
      expect.objectContaining({
        kind: 'sacrificeOther',
        allowSelf: true,
      }),
    );

    const ctx = pod('tier3-scavenger-grounds');
    const source = spawn(ctx, 'P1', grounds);
    const manaA = spawn(ctx, 'P1', forest());
    const manaB = spawn(ctx, 'P1', forest());
    conjure(ctx, 'P2', bear(), 'graveyard');
    const player = ctx.state.players[0]!;
    const option = computePriorityOptions(ctx, player).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === source.id;
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(manaA.tapped && manaB.tapped).toBe(true);
    expect(player.graveyard.some((card) => card.cardId === source.cardId)).toBe(true);
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.players.every((candidate) => candidate.graveyard.length === 0)).toBe(true);
    expect(ctx.state.exile.some((card) => card.cardId === source.cardId)).toBe(true);
  });
});
