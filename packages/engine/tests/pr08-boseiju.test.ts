import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard, PlayerId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import type { PriorityActionPayload } from '../src/actions/legal';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { addMana } from '../src/mana/pool';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const pin = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
  ) as PinnedFixture
).cards.find((entry) => entry.card.name === 'Boseiju, Who Endures');
if (pin === undefined) throw new Error('Missing Boseiju, Who Endures Oracle pin');

function pod(seed: string, turn: PlayerId = 'P1'): GameContext {
  const filler = () =>
    oracle({
      name: 'Library filler',
      typeLine: 'Creature — Bear',
      manaCost: '{1}{G}',
      colors: ['G'],
    });
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, filler) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = turn;
  ctx.state.activePlayerIndex = Number(turn.slice(1)) - 1;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  ctx.state.turnNumber = 5;
  return ctx;
}

function addPool(ctx: GameContext, player: PlayerId, green: number, colorless: number): void {
  addMana(playerById(ctx, player), [
    ...Array.from({ length: green }, () => ({ symbol: 'G' as const })),
    ...Array.from({ length: colorless }, () => ({ symbol: 'C' as const })),
  ]);
}

function permanent(ctx: GameContext, controller: PlayerId, card: OracleCard): EnginePermanent {
  return spawn(ctx, controller, card);
}

function targetCard(name: string, typeLine: string, keywords: string[] = []): OracleCard {
  return oracle({ name, typeLine, keywords });
}

function channelOption(ctx: GameContext, player: PlayerId, cardId: string) {
  return computePriorityOptions(ctx, playerById(ctx, player)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return (
      payload.kind === 'activateAbility' && payload.fromHand === true && payload.objectId === cardId
    );
  });
}

function resolve(ctx: GameContext, answer?: (decision: PendingDecision) => number) {
  expect(playerById(ctx, 'P1').hand.some((card) => card.oracleId === pin!.card.oracleId)).toBe(
    false,
  );
  expect(playerById(ctx, 'P1').graveyard.some((card) => card.oracleId === pin!.card.oracleId)).toBe(
    true,
  );
  return pump(runPrioritySequence(ctx), (decision) => {
    if (decision.decisionType === 'priority') {
      return {
        index: Math.max(
          0,
          decision.options.findIndex((option) => option.type === 'pass'),
        ),
        targets: new Map(),
      };
    }
    const index = answer?.(decision) ?? 0;
    return { index, targets: new Map() } satisfies DecisionOutcome;
  });
}

function chooseTarget(option: ReturnType<typeof channelOption>, id: string) {
  expect(option?.targets?.[0]?.options).toContain(id);
  return new Map([[0, id]]);
}

function shuffleCount(ctx: GameContext, player?: PlayerId): number {
  return ctx.state.eventLog.filter(
    (event) =>
      event.type === 'shuffle' && (player === undefined || event.payload['player'] === player),
  ).length;
}

describe('Boseiju, Who Endures (PR08)', () => {
  it('boseiju-land-mana — plays as the land for turn and pays a green spell by tapping', () => {
    const ctx = pod('boseiju-land-mana');
    const source = conjure(ctx, 'P1', pin!.card, 'hand');
    const player = playerById(ctx, 'P1');
    const landAction = computePriorityOptions(ctx, player).find(
      (option) =>
        (option.payload as PriorityActionPayload).kind === 'playLand' &&
        (option.payload as { objectId?: string }).objectId === source.id,
    );
    expect(landAction).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, landAction!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    const permanent = ctx.state.battlefield.find((card) => card.cardId === source.cardId)!;
    expect(permanent.tapped).toBe(false);
    const witness = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Green land-payment witness',
        typeLine: 'Sorcery',
        manaCost: '{G}',
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    const cast = computePriorityOptions(ctx, player).find(
      (option) =>
        (option.payload as PriorityActionPayload).kind === 'castSpell' &&
        (option.payload as { objectId?: string }).objectId === witness.id,
    );
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(runPrioritySequence(ctx));
    expect(permanent.tapped).toBe(true);
    expect(player.life).toBe(41);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'tapForMana' && event.payload['name'] === 'Boseiju, Who Endures',
      ),
    ).toBe(true);
    expect(player.graveyard.some((card) => card.cardId === source.cardId)).toBe(false);
  });

  it('boseiju-pinned-hand-channel — models the pinned card and channels from hand', () => {
    expect(pin!.card.oracleId).toBe('bf1341dd-41a3-49f6-87ec-63170dde4324');
    expect(pin!.sha256).toBe('e13a9c4ab62181dc08a0dc0efb251f9bfb97aa8fce2c5545561f0b78e868970f');
    const definition = interpretCard(pin!.card);
    expect(definition.modeled).toBe(true);
    expect(definition.unmodeledReasons).toEqual([]);
    const channel = definition.activatedAbilities.find((ability) => ability.zone === 'hand');
    expect(channel?.costs.map((cost) => cost.kind)).toContain('discardSelf');
    expect(channel?.ability.targets).toHaveLength(1);
    expect(channel?.ability.effects[0]?.op).toBe(
      'destroyTargetAndControllerMaySearchBasicTypedLand',
    );

    const ctx = pod('boseiju-pinned');
    const source = conjure(ctx, 'P1', pin!.card, 'hand');
    permanent(ctx, 'P2', targetCard('Opponent Artifact', 'Artifact'));
    addPool(ctx, 'P1', 1, 1);
    expect(channelOption(ctx, 'P1', source.id)).toBeDefined();
    permanent(ctx, 'P1', pin!.card);
    expect(channelOption(ctx, 'P1', ctx.state.battlefield.at(-1)!.id)).toBeUndefined();
  });

  it('boseiju-legal-targets — allows opposing artifact, enchantment, and nonbasic land only', () => {
    const ctx = pod('boseiju-targets');
    const source = conjure(ctx, 'P1', pin!.card, 'hand');
    addPool(ctx, 'P1', 1, 1);
    const ownArtifact = permanent(ctx, 'P1', targetCard('Own Artifact', 'Artifact'));
    const ownNonbasic = permanent(ctx, 'P1', targetCard('Own Nonbasic', 'Land — Forest'));
    const opposingArtifact = permanent(ctx, 'P2', targetCard('Opposing Artifact', 'Artifact'));
    const opposingEnchantment = permanent(
      ctx,
      'P3',
      targetCard('Opposing Enchantment', 'Enchantment'),
    );
    const opposingDual = permanent(
      ctx,
      'P4',
      targetCard('Opposing Dual', 'Land — Forest Mountain'),
    );
    const opposingBasic = permanent(ctx, 'P2', targetCard('Opposing Basic', 'Basic Land — Forest'));
    const option = channelOption(ctx, 'P1', source.id);
    expect(option).toBeDefined();
    for (const legal of [opposingArtifact, opposingEnchantment, opposingDual])
      expect(option!.targets?.[0]?.options).toContain(legal.id);
    for (const illegal of [ownArtifact, ownNonbasic, opposingBasic])
      expect(option!.targets?.[0]?.options).not.toContain(illegal.id);
  });

  it('boseiju-generic-discount — legendary creatures discount generic mana, not green', () => {
    const ctx = pod('boseiju-discount');
    const source = conjure(ctx, 'P1', pin!.card, 'hand');
    permanent(ctx, 'P2', targetCard('Target Artifact', 'Artifact'));
    addPool(ctx, 'P1', 0, 1);
    permanent(ctx, 'P1', targetCard('Legendary Noncreature', 'Legendary Artifact'));
    expect(channelOption(ctx, 'P1', source.id)).toBeUndefined();
    permanent(ctx, 'P1', targetCard('Legendary Creature', 'Legendary Creature — Bear'));
    expect(channelOption(ctx, 'P1', source.id)).toBeUndefined();
    addPool(ctx, 'P1', 1, 0);
    expect(channelOption(ctx, 'P1', source.id)).toBeDefined();

    // With exactly {G} available, the channel is affordable only because one legendary creature
    // takes {1} off the {1}{G} cost.
    const bare = pod('boseiju-discount-exact');
    const bareSource = conjure(bare, 'P1', pin!.card, 'hand');
    permanent(bare, 'P2', targetCard('Target Artifact', 'Artifact'));
    addPool(bare, 'P1', 1, 0);
    expect(channelOption(bare, 'P1', bareSource.id)).toBeUndefined();
    permanent(bare, 'P1', targetCard('Legendary Creature', 'Legendary Creature — Bear'));
    expect(channelOption(bare, 'P1', bareSource.id)).toBeDefined();
  });

  it('boseiju-may-decline — target controller may decline without shuffling', () => {
    const ctx = pod('boseiju-decline', 'P2');
    const target = permanent(ctx, 'P2', targetCard('Target Dual', 'Land — Forest Island'));
    conjure(ctx, 'P2', targetCard('Search Forest', 'Basic Land — Forest'), 'library');
    const source = conjure(ctx, 'P1', pin!.card, 'hand');
    addPool(ctx, 'P1', 1, 1);
    const option = channelOption(ctx, 'P1', source.id);
    activateExisting(ctx, 'P1', option, chooseTarget(option, target.id));
    let beneficiaryPrompt: string | undefined;
    const result = resolve(ctx, (decision) => {
      if (decision.prompt.includes('search your library')) {
        beneficiaryPrompt = decision.player;
        return 1;
      }
      return 0;
    });
    expect(beneficiaryPrompt).toBe('P2');
    expect(
      result.decisions.some((decision) => decision.prompt.includes('search your library')),
    ).toBe(true);
    expect(ctx.state.battlefield).not.toContain(target);
    expect(shuffleCount(ctx, 'P2')).toBe(0);
  });

  it('boseiju-invalidated-target — fizzles without offering a search', () => {
    const ctx = pod('boseiju-fizzle');
    const target = permanent(ctx, 'P2', targetCard('Target Artifact', 'Artifact'));
    conjure(ctx, 'P2', targetCard('Search Forest', 'Basic Land — Forest'), 'library');
    const source = conjure(ctx, 'P1', pin!.card, 'hand');
    addPool(ctx, 'P1', 1, 1);
    const option = channelOption(ctx, 'P1', source.id);
    activateExisting(ctx, 'P1', option, chooseTarget(option, target.id));
    ctx.state.battlefield.splice(ctx.state.battlefield.indexOf(target), 1);
    const result = resolve(ctx);
    expect(
      result.decisions.some((decision) => decision.prompt.includes('search your library')),
    ).toBe(false);
    expect(shuffleCount(ctx, 'P2')).toBe(0);
  });

  it('boseiju-basic-subtype-search — finds a nonbasic dual by basic land subtype and enters untapped', () => {
    const ctx = pod('boseiju-search-dual');
    const target = permanent(ctx, 'P2', targetCard('Target Enchantment', 'Enchantment'));
    conjure(ctx, 'P2', targetCard('Wastes', 'Basic Land — Wastes'), 'library');
    conjure(ctx, 'P2', targetCard('Nonland Forest', 'Creature — Forest'), 'library');
    const dualCard = targetCard('Forest Mountain Dual', 'Land — Forest Mountain');
    const dual = conjure(ctx, 'P2', dualCard, 'library');
    const source = conjure(ctx, 'P1', pin!.card, 'hand');
    addPool(ctx, 'P1', 1, 1);
    const option = channelOption(ctx, 'P1', source.id);
    activateExisting(ctx, 'P1', option, chooseTarget(option, target.id));
    let searchPlayer: PlayerId | undefined;
    let foundOptionDescriptions: string[] = [];
    resolve(ctx, (decision) => {
      if (decision.prompt.includes('search your library')) {
        searchPlayer = decision.player;
        return 0;
      }
      if (decision.prompt.includes('choose a land with a basic land type')) {
        searchPlayer = decision.player;
        foundOptionDescriptions = decision.options.map((candidate) => candidate.description);
        return decision.options.findIndex((candidate) => candidate.description.includes(dual.name));
      }
      return 0;
    });
    expect(searchPlayer).toBe('P2');
    expect(foundOptionDescriptions.some((description) => description.includes('Wastes'))).toBe(
      false,
    );
    expect(
      foundOptionDescriptions.some((description) => description.includes('Nonland Forest')),
    ).toBe(false);
    expect(playerById(ctx, 'P2').hand.some((card) => card.cardId === dual.cardId)).toBe(false);
    const entered = ctx.state.battlefield.find((permanent) => permanent.cardId === dual.cardId);
    expect(entered).toBeDefined();
    expect(entered?.controllerId).toBe('P2');
    expect(entered?.tapped).toBe(false);
    expect(shuffleCount(ctx, 'P2')).toBe(1);
  });

  it('boseiju-search-intrinsic-tap — preserves the searched land’s own enters-tapped text', () => {
    const ctx = pod('boseiju-search-tapped');
    const target = permanent(ctx, 'P2', targetCard('Target Artifact', 'Artifact'));
    const tappedForest = oracle({
      name: 'Tapped Forest',
      typeLine: 'Land — Forest',
      manaCost: null,
      oracleText: 'Tapped Forest enters the battlefield tapped.\n{T}: Add {G}.',
    });
    expect(interpretCard(tappedForest).entersTapped).toBe(true);
    conjure(ctx, 'P2', tappedForest, 'library');
    const source = conjure(ctx, 'P1', pin!.card, 'hand');
    addPool(ctx, 'P1', 1, 1);
    const option = channelOption(ctx, 'P1', source.id);
    activateExisting(ctx, 'P1', option, chooseTarget(option, target.id));
    resolve(ctx, (decision) => {
      if (decision.prompt.includes('search your library')) return 0;
      if (decision.prompt.includes('choose a land with a basic land type'))
        return decision.options.findIndex((candidate) =>
          candidate.description.includes(tappedForest.name),
        );
      return 0;
    });
    const entered = ctx.state.battlefield.find(
      (permanent) => permanent.oracleId === tappedForest.oracleId,
    );
    expect(entered?.tapped).toBe(true);
  });

  it('boseiju-indestructible-and-fail-to-find — may search after indestructible stops destruction, then shuffle', () => {
    const ctx = pod('boseiju-indestructible');
    const target = permanent(ctx, 'P2', targetCard('Indestructible Artifact', 'Artifact'));
    target.copyAddKeywords = ['indestructible'];
    expect(computeCharacteristics(ctx, target).keywords).toContain('indestructible');
    conjure(ctx, 'P2', targetCard('Search Forest', 'Basic Land — Forest'), 'library');
    const source = conjure(ctx, 'P1', pin!.card, 'hand');
    addPool(ctx, 'P1', 1, 1);
    const option = channelOption(ctx, 'P1', source.id);
    activateExisting(ctx, 'P1', option, chooseTarget(option, target.id));
    let searchPlayer: PlayerId | undefined;
    let failToFindPlayer: PlayerId | undefined;
    const result = resolve(ctx, (decision) => {
      if (decision.prompt.includes('search your library')) {
        searchPlayer = decision.player;
        return 0;
      }
      if (decision.prompt.includes('choose a land with a basic land type')) {
        failToFindPlayer = decision.player;
        return decision.options.findIndex((candidate) => candidate.type === 'decline');
      }
      return 0;
    });
    expect(searchPlayer).toBe('P2');
    expect(failToFindPlayer).toBe('P2');
    expect(
      result.decisions.some((decision) =>
        decision.prompt.includes('choose a land with a basic land type'),
      ),
    ).toBe(true);
    expect(ctx.state.battlefield).toContain(target);
    expect(shuffleCount(ctx, 'P2')).toBe(1);
  });
});

function activateExisting(
  ctx: GameContext,
  player: PlayerId,
  option: ReturnType<typeof channelOption>,
  targets: ReadonlyMap<number, string>,
): void {
  expect(option).toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, player), option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
  );
  const source = playerById(ctx, player).graveyard.find(
    (card) => card.oracleId === pin!.card.oracleId,
  );
  expect(source).toBeDefined();
  expect(ctx.state.stack).toHaveLength(1);
}
