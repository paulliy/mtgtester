import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { computeCharacteristics } from '../src/effects/continuous';
import { moveObject } from '../src/state/objects';
import { queueStepTriggers } from '../src/turn/turn';
import { addMana } from '../src/mana/pool';
import type { GameContext } from '../src/state/types';
import { conjure, forest, oracle, pump, spawn } from './fixtures';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import {
  asActive,
  bear,
  castFromHand,
  castOption,
  choose,
  labShock,
  p,
  pinned,
  pinnedDefinition,
  pod,
  putPendingTriggersOnStack,
  settle,
} from './pr10-helpers';

/**
 * `settle`, recording the type of every decision asked (an unforced one is answered with the first
 * option, unless `answer` says otherwise).
 */
function settleRecording(
  ctx: GameContext,
  answer?: (decision: PendingDecision) => DecisionOutcome,
): string[] {
  const asked: string[] = [];
  settle(ctx, (decision) => {
    asked.push(decision.decisionType);
    return answer?.(decision) ?? { index: 0, targets: new Map() };
  });
  return asked;
}

/** `playerId` plays a Forest from hand through the real special action. */
function playForest(ctx: GameContext, playerId: string) {
  const land = conjure(ctx, playerId, forest(), 'hand');
  const option = computePriorityOptions(ctx, p(ctx, playerId)).find(
    (candidate) =>
      candidate.type === 'playLand' &&
      (candidate.payload as PriorityActionPayload & { objectId?: string }).objectId === land.id,
  );
  expect(option, 'the Forest can be played').toBeDefined();
  pump(
    applyPriorityAction(ctx, p(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  // None of the landfall-style triggers this helper serves is a "you may".
  expect(settleRecording(ctx)).not.toContain('optionalTrigger');
}

const tokensOf = (ctx: GameContext, playerId: string) =>
  ctx.state.battlefield.filter(
    (permanent) => permanent.isToken && permanent.controllerId === playerId,
  );

describe('PR10.23 Scute Swarm', () => {
  function swarmWithLands(seed: string, lands: number) {
    const ctx = pod(seed);
    const swarm = spawn(ctx, 'P1', pinned('Scute Swarm'));
    for (let i = 0; i < lands; i++) spawn(ctx, 'P1', forest());
    return { ctx, swarm };
  }

  it('pr10-scute-swarm-pinned-oracle-supported — landfall is modeled', () => {
    const def = pinnedDefinition('Scute Swarm');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
  });

  it('pr10-scute-swarm-insect — fewer than six lands makes a 1/1 green Insect', () => {
    const { ctx } = swarmWithLands('pr10-scute-insect', 4);
    playForest(ctx, 'P1');
    const tokens = tokensOf(ctx, 'P1');
    expect(tokens.map((token) => token.name)).toEqual(['Insect']);
    const insect = computeCharacteristics(ctx, tokens[0]!);
    expect([insect.power, insect.toughness, insect.colors]).toEqual([1, 1, ['G']]);
  });

  it('pr10-scute-swarm-copy — six or more lands makes a copy of Scute Swarm instead', () => {
    const { ctx } = swarmWithLands('pr10-scute-copy', 5);
    playForest(ctx, 'P1');
    expect(tokensOf(ctx, 'P1').map((token) => token.name)).toEqual(['Scute Swarm']);
    // The copy has landfall too: the next land makes two more.
    const restore = asActive(ctx, 'P1');
    ctx.state.players[0]!.landsPlayedThisTurn = 0;
    playForest(ctx, 'P1');
    restore();
    expect(tokensOf(ctx, 'P1').filter((token) => token.name === 'Scute Swarm')).toHaveLength(3);
  });

  it("pr10-scute-swarm-your-lands-only — an opponent's land does not trigger it", () => {
    const { ctx } = swarmWithLands('pr10-scute-opponent', 0);
    const restore = asActive(ctx, 'P2');
    playForest(ctx, 'P2');
    restore();
    expect(tokensOf(ctx, 'P1')).toHaveLength(0);
    // Only a LAND entering counts: one of your creatures entering makes no Insect and no copy.
    const creatureCtx = swarmWithLands('pr10-scute-creature', 0).ctx;
    const cub = conjure(creatureCtx, 'P1', bear('Swarm Cub'), 'hand');
    pump(moveObject(creatureCtx, cub, { zone: 'battlefield', controllerId: 'P1' }));
    expect(creatureCtx.state.pendingTriggers).toHaveLength(0);
    settle(creatureCtx);
    expect(tokensOf(creatureCtx, 'P1')).toHaveLength(0);
  });
});

describe('PR10.27 Council of Reeds', () => {
  const legendaryArtifact = () =>
    oracle({
      name: 'Reeds Relic',
      typeLine: 'Legendary Artifact',
      manaCost: '{1}',
      cmc: 1,
      power: null,
      toughness: null,
    });

  it('pr10-council-of-reeds-pinned-oracle-supported — both lines are modeled', () => {
    const def = pinnedDefinition('Council of Reeds');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
  });

  it('pr10-council-of-reeds-legend-rule — your legendary creatures share a name freely', () => {
    const ctx = pod('pr10-reeds-legend');
    spawn(ctx, 'P1', pinned('Council of Reeds'));
    spawn(ctx, 'P1', pinned('Council of Reeds'));
    putPendingTriggersOnStack(ctx);
    expect(ctx.state.battlefield.filter((perm) => perm.name === 'Council of Reeds')).toHaveLength(
      2,
    );
  });

  it('pr10-council-of-reeds-legend-rule-scope — noncreatures and opponents are unaffected', () => {
    const ctx = pod('pr10-reeds-scope');
    spawn(ctx, 'P1', pinned('Council of Reeds'));
    spawn(ctx, 'P1', legendaryArtifact());
    spawn(ctx, 'P1', legendaryArtifact());
    const rivalLegend = () =>
      oracle({
        name: 'Reeds Rival',
        typeLine: 'Legendary Creature — Human',
        power: '2',
        toughness: '2',
      });
    spawn(ctx, 'P2', rivalLegend());
    spawn(ctx, 'P2', rivalLegend());
    putPendingTriggersOnStack(ctx);
    expect(
      ctx.state.battlefield.filter(
        (perm) => perm.name === 'Reeds Relic' && perm.controllerId === 'P1',
      ),
    ).toHaveLength(1);
    expect(
      ctx.state.battlefield.filter(
        (perm) => perm.name === 'Reeds Rival' && perm.controllerId === 'P2',
      ),
    ).toHaveLength(1);
  });

  it('pr10-council-of-reeds-combat-copy — a copy only after a noncreature spell this turn', () => {
    const ctx = pod('pr10-reeds-combat');
    spawn(ctx, 'P1', pinned('Council of Reeds'));
    queueStepTriggers(ctx, 'beginningOfCombat');
    settle(ctx);
    expect(tokensOf(ctx, 'P1')).toHaveLength(0);
    castFromHand(ctx, 'P1', labShock(), new Map([[0, 'P2']]));
    settle(ctx);
    queueStepTriggers(ctx, 'beginningOfCombat');
    // The trigger is mandatory: no "use this ability?" yes/no is asked.
    expect(settleRecording(ctx)).not.toContain('optionalTrigger');
    const tokens = tokensOf(ctx, 'P1');
    expect(tokens.map((token) => token.name)).toEqual(['Council of Reeds']);
    // Both copies stay: the legend rule doesn't apply to them.
    expect(ctx.state.battlefield.filter((perm) => perm.name === 'Council of Reeds')).toHaveLength(
      2,
    );
  });
});

describe('PR10.31 Twilight Diviner', () => {
  const zombie = (name: string) =>
    oracle({
      name,
      typeLine: 'Creature — Zombie',
      manaCost: '{1}{B}',
      cmc: 2,
      colors: ['B'],
      power: '2',
      toughness: '2',
      oracleText: 'Escape—{2}{B}, Exile two other cards from your graveyard.',
    });

  /** `name` returns from P1's graveyard to the battlefield (a reanimation). */
  function reanimate(ctx: GameContext, name: string) {
    const card = conjure(ctx, 'P1', zombie(name), 'graveyard');
    pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P1' }));
    // The copy trigger is mandatory: no "use this ability?" yes/no is asked.
    expect(settleRecording(ctx)).not.toContain('optionalTrigger');
  }

  const copiesOf = (ctx: GameContext, name: string) =>
    tokensOf(ctx, 'P1').filter((token) => token.name === name);

  it('pr10-twilight-diviner-pinned-oracle-supported — surveil and the copy trigger are modeled', () => {
    const def = pinnedDefinition('Twilight Diviner');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.triggers).toHaveLength(2);

    // The enter trigger surveils 2 (two cards, one decision each) and is not a "you may".
    const ctx = pod('pr10-diviner-surveil');
    const diviner = conjure(ctx, 'P1', pinned('Twilight Diviner'), 'hand');
    pump(moveObject(ctx, diviner, { zone: 'battlefield', controllerId: 'P1' }));
    const prompts: string[] = [];
    const asked = settleRecording(ctx, (decision) => {
      prompts.push(decision.prompt);
      return { index: 0, targets: new Map() };
    });
    expect(asked).not.toContain('optionalTrigger');
    expect(prompts.filter((prompt) => prompt.includes('surveil — keep'))).toHaveLength(2);
  });

  it('pr10-twilight-diviner-entered-from-graveyard — copies a reanimated creature', () => {
    const ctx = pod('pr10-diviner-reanimate');
    spawn(ctx, 'P1', pinned('Twilight Diviner'));
    reanimate(ctx, 'Diviner Zombie');
    expect(copiesOf(ctx, 'Diviner Zombie')).toHaveLength(1);

    // Only OTHER creatures count: the Diviner itself coming back from the graveyard copies nothing.
    const selfCtx = pod('pr10-diviner-self');
    const self = spawn(selfCtx, 'P1', pinned('Twilight Diviner'));
    pump(moveObject(selfCtx, self, { zone: 'graveyard' }));
    const dead = selfCtx.state.players[0]!.graveyard.find((c) => c.name === 'Twilight Diviner')!;
    pump(moveObject(selfCtx, dead, { zone: 'battlefield', controllerId: 'P1' }));
    settle(selfCtx);
    expect(tokensOf(selfCtx, 'P1')).toHaveLength(0);

    // Only CREATURES count: a land returning from the graveyard copies nothing.
    const landCtx = pod('pr10-diviner-land');
    spawn(landCtx, 'P1', pinned('Twilight Diviner'));
    const land = conjure(landCtx, 'P1', forest(), 'graveyard');
    pump(moveObject(landCtx, land, { zone: 'battlefield', controllerId: 'P1' }));
    settle(landCtx);
    expect(tokensOf(landCtx, 'P1')).toHaveLength(0);
  });

  it('pr10-twilight-diviner-cast-from-graveyard — copies a creature cast from a graveyard', () => {
    const ctx = pod('pr10-diviner-escape');
    spawn(ctx, 'P1', pinned('Twilight Diviner'));
    const card = conjure(ctx, 'P1', zombie('Escaped Zombie'), 'graveyard');
    conjure(ctx, 'P1', forest(), 'graveyard');
    conjure(ctx, 'P1', forest(), 'graveyard');
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'B' }]);
    const option = castOption(ctx, 'P1', card.id, 'nonMana');
    expect(option, 'escape is offered').toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    settle(ctx);
    expect(copiesOf(ctx, 'Escaped Zombie')).toHaveLength(1);
  });

  it('pr10-twilight-diviner-from-hand — a creature cast from hand is not copied', () => {
    const ctx = pod('pr10-diviner-hand');
    spawn(ctx, 'P1', pinned('Twilight Diviner'));
    castFromHand(ctx, 'P1', zombie('Hand Zombie'));
    settle(ctx);
    expect(tokensOf(ctx, 'P1')).toHaveLength(0);
  });

  it('pr10-twilight-diviner-once-each-turn — the second reanimation this turn is not copied', () => {
    const ctx = pod('pr10-diviner-once');
    spawn(ctx, 'P1', pinned('Twilight Diviner'));
    reanimate(ctx, 'First Zombie');
    reanimate(ctx, 'Second Zombie');
    expect(copiesOf(ctx, 'First Zombie')).toHaveLength(1);
    expect(copiesOf(ctx, 'Second Zombie')).toHaveLength(0);
  });

  it("pr10-twilight-diviner-opponents-creature — an opponent's reanimation is not copied", () => {
    const ctx = pod('pr10-diviner-opponent');
    spawn(ctx, 'P1', pinned('Twilight Diviner'));
    const card = conjure(ctx, 'P2', zombie('Rival Zombie'), 'graveyard');
    pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P2' }));
    settle(ctx);
    expect(tokensOf(ctx, 'P1')).toHaveLength(0);
    expect(tokensOf(ctx, 'P2')).toHaveLength(0);
  });
});

describe('PR10.16 Saheeli, Radiant Creator', () => {
  const trinket = () =>
    oracle({
      name: 'Radiant Trinket',
      typeLine: 'Artifact',
      manaCost: '{1}',
      cmc: 1,
      power: null,
      toughness: null,
    });
  const artificer = () =>
    oracle({
      name: 'Radiant Tinkerer',
      typeLine: 'Creature — Human Artificer',
      manaCost: '{1}',
      cmc: 1,
      power: '1',
      toughness: '1',
    });

  it('pr10-saheeli-radiant-creator-pinned-oracle-supported — both triggers are modeled', () => {
    const def = pinnedDefinition('Saheeli, Radiant Creator');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.triggers).toHaveLength(2);
  });

  it('pr10-saheeli-radiant-creator-energy — {E} for each Artificer or artifact spell', () => {
    const ctx = pod('pr10-radiant-energy');
    spawn(ctx, 'P1', pinned('Saheeli, Radiant Creator'));
    const asked: string[] = [];
    castFromHand(ctx, 'P1', trinket());
    asked.push(...settleRecording(ctx));
    castFromHand(ctx, 'P1', artificer());
    asked.push(...settleRecording(ctx));
    castFromHand(ctx, 'P1', labShock(), new Map([[0, 'P2']]));
    asked.push(...settleRecording(ctx));
    expect(p(ctx, 'P1').energy).toBe(2);
    // The energy trigger is mandatory: no "use this ability?" yes/no is asked.
    expect(asked).not.toContain('optionalTrigger');
  });

  it('pr10-saheeli-radiant-creator-combat-copy — pay three energy, then copy a permanent as a hasty 5/5', () => {
    const ctx = pod('pr10-radiant-copy');
    const saheeli = spawn(ctx, 'P1', pinned('Saheeli, Radiant Creator'));
    const relic = spawn(ctx, 'P1', trinket());
    const rivalRelic = spawn(ctx, 'P2', { ...trinket(), name: 'Rival Trinket' });
    p(ctx, 'P1').energy = 4;
    queueStepTriggers(ctx, 'beginningOfCombat');
    const asked: string[] = [];
    let offered: string[] = [];
    settle(ctx, (decision) => {
      asked.push(decision.decisionType);
      if (decision.prompt.includes('pay energy')) return choose('Pay 3 energy')(decision);
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined) offered = slot.options;
      return { index: 0, targets: new Map([[0, relic.id]]) };
    });
    // Neither the trigger nor its reflexive copy is a "you may": the only yes/no is paying energy.
    expect(asked).not.toContain('optionalTrigger');
    // "Target permanent you control": Saheeli and the Trinket, never the opponent's permanent.
    expect([...offered].sort()).toEqual([saheeli.id, relic.id].sort());
    expect(offered).not.toContain(rivalRelic.id);
    expect(p(ctx, 'P1').energy).toBe(1);
    expect(tokensOf(ctx, 'P1')).toHaveLength(1);
    const [token] = tokensOf(ctx, 'P1');
    expect(token?.name).toBe('Radiant Trinket');
    const now = computeCharacteristics(ctx, token!);
    expect(now.types).toEqual(expect.arrayContaining(['Artifact', 'Creature']));
    expect([now.power, now.toughness]).toEqual([5, 5]);
    expect(now.keywords).toContain('haste');
    // Sacrificed at the beginning of the next end step.
    queueStepTriggers(ctx, 'endStep');
    settle(ctx);
    expect(tokensOf(ctx, 'P1')).toHaveLength(0);
  });

  it('pr10-saheeli-radiant-creator-not-enough-energy — nothing to pay with two energy', () => {
    const ctx = pod('pr10-radiant-poor');
    spawn(ctx, 'P1', pinned('Saheeli, Radiant Creator'));
    spawn(ctx, 'P1', trinket());
    p(ctx, 'P1').energy = 2;
    queueStepTriggers(ctx, 'beginningOfCombat');
    settle(ctx, () => {
      throw new Error('no decision expected');
    });
    expect(p(ctx, 'P1').energy).toBe(2);
    expect(tokensOf(ctx, 'P1')).toHaveLength(0);
  });

  it('pr10-saheeli-radiant-creator-decline — declining keeps the energy and copies nothing', () => {
    const ctx = pod('pr10-radiant-decline');
    spawn(ctx, 'P1', pinned('Saheeli, Radiant Creator'));
    spawn(ctx, 'P1', trinket());
    p(ctx, 'P1').energy = 3;
    queueStepTriggers(ctx, 'beginningOfCombat');
    settle(ctx, choose('Pay no energy'));
    expect(p(ctx, 'P1').energy).toBe(3);
    expect(tokensOf(ctx, 'P1')).toHaveLength(0);
  });
});
