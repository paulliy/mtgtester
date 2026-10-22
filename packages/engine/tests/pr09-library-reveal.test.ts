import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Color, OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { queueStepTriggers, cleanupStep } from '../src/turn/turn';
import { runCombatPhase } from '../src/combat/combat';
import { runPrioritySequence } from '../src/turn/priority';
import { buildPlayerView } from '../src/view/view';
import { buildPlayerBoardState } from '../src/view/spectator';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import {
  conjure,
  copies,
  declareAttacks,
  forest,
  gameConfig,
  oracle,
  pump,
  spawn,
} from './fixtures';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
const spellFaceFixture = JSON.parse(
  readFileSync(new URL('./fixtures/selected-spell-faces-oracle.json', import.meta.url), 'utf8'),
) as { cards: { card: OracleCard }[] };
const FOULMIRE = spellFaceFixture.cards.find(({ card }) =>
  card.name.startsWith('Foulmire Knight'),
)!.card;

function pinned(name: string): OracleCard {
  const entry = fixture.cards.find(({ card }) => card.name === name);
  if (entry === undefined) throw new Error(`Missing PR09 pin ${name}`);
  expect(createHash('sha256').update(JSON.stringify(entry.card)).digest('hex')).toBe(entry.sha256);
  return entry.card;
}

const SONGBIRDS = pinned("Songbirds' Blessing");
const ETALI = pinned('Etali, Primal Conqueror // Etali, Primal Sickness');
const FORGE = pinned('Mystic Forge');
const SUNBIRD = pinned("Sunbird's Invocation");
const DILATION = pinned("Mind's Dilation");
const ITERATION = pinned('Expressive Iteration');
const ULTIMATUM = pinned('Genesis Ultimatum');
const VORTEX = pinned('Into the Time Vortex');

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(24, forest) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  for (const player of ctx.state.players) player.hand = [];
  return ctx;
}

const p = (ctx: GameContext, id: string) => playerById(ctx, id);

function exactMana(card: OracleCard): { symbol: Color | 'C' }[] {
  const cost = interpretCard(card).manaCost;
  if (cost === null) return [];
  const mana: { symbol: Color | 'C' }[] = [];
  for (const color of ['W', 'U', 'B', 'R', 'G'] as const) {
    for (let i = 0; i < cost.colored[color]; i++) mana.push({ symbol: color });
  }
  for (let i = 0; i < cost.colorless; i++) mana.push({ symbol: 'C' });
  for (const pip of cost.hybrid ?? []) mana.push({ symbol: pip[0]! });
  for (const pip of cost.phyrexian ?? []) mana.push({ symbol: pip });
  for (let i = 0; i < cost.generic; i++) mana.push({ symbol: 'C' });
  return mana;
}

function pass(decision: PendingDecision): DecisionOutcome {
  const index = decision.options.findIndex(
    (option) =>
      option.type === 'pass' ||
      (option.payload as Partial<PriorityActionPayload> | undefined)?.kind === 'pass',
  );
  if (index < 0) throw new Error(`no priority pass option for ${decision.prompt}`);
  return { index, targets: new Map() };
}

function choose(decision: PendingDecision, pattern: RegExp): DecisionOutcome {
  const index = decision.options.findIndex((option) => pattern.test(option.description));
  if (index < 0)
    throw new Error(
      `no ${pattern} choice in ${decision.options.map((o) => o.description).join(' | ')}`,
    );
  return {
    index,
    targets: new Map(
      (decision.options[index]?.targets ?? []).map((target) => [target.slot, target.options[0]!]),
    ),
  };
}

function decline(decision: PendingDecision): DecisionOutcome {
  const index = decision.options.findIndex((option) => option.type === 'decline');
  if (index < 0) throw new Error(`no decline option for ${decision.prompt}`);
  return { index, targets: new Map() };
}

function settle(ctx: GameContext, answer: (decision: PendingDecision) => DecisionOutcome = pass) {
  return pump(runPrioritySequence(ctx), (decision) =>
    decision.decisionType === 'priority' ? pass(decision) : answer(decision),
  );
}

function normalOption(ctx: GameContext, playerId: string, objectId: string) {
  return computePriorityOptions(ctx, p(ctx, playerId)).find((option) => {
    const payload = option.payload as PriorityActionPayload & { alternativeCast?: string };
    return (
      option.type === 'castSpell' &&
      payload.kind === 'castSpell' &&
      payload.objectId === objectId &&
      payload.alternativeCast === undefined
    );
  });
}

function castNormally(
  ctx: GameContext,
  playerId: string,
  card: OracleCard,
  targets: Map<number, string> = new Map(),
  answer: (decision: PendingDecision) => DecisionOutcome = pass,
) {
  const object = conjure(ctx, playerId, card, 'hand');
  addMana(p(ctx, playerId), exactMana(card));
  const option = normalOption(ctx, playerId, object.id);
  expect(option, `${card.name} is offered through its normal cast action`).toBeDefined();
  pump(
    applyPriorityAction(ctx, p(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
    answer,
  );
  settle(ctx, answer);
  return object;
}

function library(ctx: GameContext, playerId: string, cards: OracleCard[]) {
  const objects = cards.map((card) => conjure(ctx, playerId, card, 'library'));
  p(ctx, playerId).library = objects;
  return [...objects];
}

function labCard(name: string, cost: string, typeLine: string, oracleText = ''): OracleCard {
  return oracle({
    name,
    manaCost: cost,
    cmc: Number(cost.replace(/\D/g, '')) || 0,
    typeLine,
    oracleText,
  });
}

describe('PR09 library reveal and casting cards', () => {
  it('pr09-mystic-forge-top-privacy-and-eligibility — exposes only the top card to its controller and permits artifact or colorless spells', () => {
    const ctx = pod('pr09-forge-eligibility');
    spawn(ctx, 'P1', FORGE);
    const artifact = library(ctx, 'P1', [
      labCard('Forge Colored Artifact', '{1}{R}', 'Artifact'),
      labCard('Forge Colored Spell', '{R}', 'Sorcery', 'Draw a card.'),
    ]);
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'R' }]);
    expect(JSON.stringify(buildPlayerView(ctx, 'P1'))).toContain('Forge Colored Artifact');
    expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).not.toContain('Forge Colored Artifact');
    expect(buildPlayerBoardState(ctx, 'P1').revealedLibraryTops).toEqual([
      {
        player: 'P1',
        card: expect.objectContaining({ id: artifact[0]!.id, name: 'Forge Colored Artifact' }),
      },
    ]);
    for (const seat of ['P2', 'P3', 'P4']) {
      expect(buildPlayerBoardState(ctx, seat).revealedLibraryTops).toEqual([]);
    }
    expect(JSON.stringify(buildPlayerBoardState(ctx, 'P1'))).not.toContain('Forge Colored Spell');
    const artifactCast = normalOption(ctx, 'P1', artifact[0]!.id);
    expect(artifactCast).toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), artifactCast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
      pass,
    );
    settle(ctx);
    expect(ctx.state.battlefield.some((item) => item.cardId === artifact[0]!.cardId)).toBe(true);
    expect(normalOption(ctx, 'P1', artifact[1]!.id)).toBeUndefined();
    expect(buildPlayerBoardState(ctx, 'P1').revealedLibraryTops?.[0]?.card.name).toBe(
      'Forge Colored Spell',
    );

    const colorlessSpell = library(ctx, 'P1', [
      labCard('Forge Colorless Spell', '{2}', 'Sorcery', 'Draw a card.'),
    ])[0]!;
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }]);
    expect(normalOption(ctx, 'P1', colorlessSpell.id)).toBeDefined();
    const land = library(ctx, 'P1', [labCard('Forge Top Land', '', 'Land')])[0]!;
    expect(normalOption(ctx, 'P1', land.id)).toBeUndefined();
    const forge = ctx.state.battlefield.find((card) => card.name === 'Mystic Forge')!;
    pump(moveObject(ctx, forge, { zone: 'graveyard' }));
    expect(buildPlayerBoardState(ctx, 'P1').revealedLibraryTops).toEqual([]);
    expect(JSON.stringify(buildPlayerBoardState(ctx, 'P1'))).not.toContain('Forge Top Land');
  });

  it('pr09-mystic-forge-activation-costs-and-top-object — pays life and tap, exiles the current top, and rejects unavailable costs', () => {
    const ctx = pod('pr09-forge-activation-costs');
    const forgeCard = castNormally(ctx, 'P1', FORGE);
    const forge = ctx.state.battlefield.find((card) => card.cardId === forgeCard.cardId)!;
    const tops = library(ctx, 'P1', [
      labCard('Forge First Top', '{R}', 'Sorcery', 'You gain 1 life.'),
      labCard('Forge Second Top', '{2}', 'Artifact'),
    ]);
    const activation = () =>
      computePriorityOptions(ctx, p(ctx, 'P1')).find((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'activateAbility' && payload.objectId === forge.id;
      });
    const offered = activation();
    expect(offered).toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), offered!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(forge.tapped).toBe(true);
    expect(p(ctx, 'P1').life).toBe(39);
    expect(activation()).toBeUndefined();
    settle(ctx);
    const exiled = ctx.state.exile.find((card) => card.cardId === tops[0]!.cardId);
    expect(exiled).toBeDefined();
    expect(exiled!.id).not.toBe(tops[0]!.id);
    expect(p(ctx, 'P1').library.map((card) => card.id)).toEqual([tops[1]!.id]);
    expect(buildPlayerBoardState(ctx, 'P1').revealedLibraryTops?.[0]?.card.id).toBe(tops[1]!.id);
    forge.tapped = false;
    p(ctx, 'P1').life = 0;
    expect(activation()).toBeUndefined();
    expect(p(ctx, 'P1').library[0]!.id).toBe(tops[1]!.id);
  });

  it('pr09-songbirds-illegal-aura-host-goes-to-hand — the attack trigger reveals to an Aura, but a departed host keeps it out of play', () => {
    const ctx = pod('pr09-songbirds-illegal-host');
    const hostCard = labCard('Songbirds Host', '{2}', 'Creature — Bird');
    const host = spawn(ctx, 'P1', hostCard);
    const aura = library(ctx, 'P1', [
      labCard('Songbirds Miss', '{1}', 'Sorcery'),
      labCard('Songbirds Aura', '{1}{W}', 'Enchantment — Aura', 'Enchant creature'),
    ])[1]!;
    const songbirds = conjure(ctx, 'P1', SONGBIRDS, 'hand');
    addMana(p(ctx, 'P1'), exactMana(SONGBIRDS));
    const castOption = normalOption(ctx, 'P1', songbirds.id);
    expect(castOption).toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), castOption!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, host.id]]),
      }),
    );
    settle(ctx);
    const enchanted = ctx.state.battlefield.find((item) => item.cardId === songbirds.cardId)!;
    expect(enchanted.attachedTo).toBe(host.id);

    const combat = runCombatPhase(ctx);
    let step = combat.next();
    while (!step.done && step.value.decisionType !== 'declareAttackers')
      step = combat.next(pass(step.value));
    if (step.done) throw new Error('combat ended before attacker declaration');
    step = combat.next(declareAttacks(step.value, (id) => (id === host.id ? 'P2' : null)));
    pump(moveObject(ctx, host, { zone: 'graveyard' }));
    while (!step.done) {
      const decision = step.value;
      step = combat.next(
        decision.decisionType === 'priority' ? pass(decision) : choose(decision, /Songbirds Aura/),
      );
    }
    expect(p(ctx, 'P1').hand.some((card) => card.cardId === aura.cardId)).toBe(true);
    expect(ctx.state.battlefield.some((item) => item.cardId === aura.cardId)).toBe(false);
    expect(ctx.state.eventLog.filter((event) => event.type === 'revealCard')).toHaveLength(2);
  });

  it('pr09-etali-exiles-all-first-then-casts-in-chosen-order-and-can-decline — each library is processed before choices begin', () => {
    const ctx = pod('pr09-etali-all-first');
    const hits = new Map<string, ReturnType<typeof conjure>>();
    for (const playerId of ['P1', 'P2', 'P3', 'P4']) {
      library(ctx, playerId, [
        labCard(`${playerId} Etali land`, '', 'Land'),
        labCard(`${playerId} Etali hit`, '{1}', 'Sorcery', 'You gain 1 life.'),
      ]);
      hits.set(playerId, p(ctx, playerId).library[1]!);
    }
    let sawAllExiledBeforeChoice = false;
    let sawFirstCastChoice = false;
    const castOrder: string[] = [];
    castNormally(ctx, 'P1', ETALI, new Map(), (decision) => {
      if (decision.options.some((option) => option.type === 'castFree')) {
        if (!sawFirstCastChoice) {
          sawFirstCastChoice = true;
          sawAllExiledBeforeChoice = [...hits.values()].every((hit) =>
            ctx.state.exile.some((card) => card.cardId === hit.cardId),
          );
        }
        if (decision.options.some((option) => /P2 Etali hit/.test(option.description)))
          return choose(decision, /P2 Etali hit/);
        if (decision.options.some((option) => /P1 Etali hit/.test(option.description)))
          return choose(decision, /P1 Etali hit/);
        return choose(decision, /Stop casting/);
      }
      if (decision.options.some((option) => /Stop casting/.test(option.description)))
        return choose(decision, /Stop casting/);
      return pass(decision);
    });
    castOrder.push(
      ...ctx.state.eventLog
        .filter(
          (event) => event.type === 'castSpell' && /Etali hit/.test(String(event.payload['name'])),
        )
        .map((event) => String(event.payload['name'])),
    );
    expect(
      sawAllExiledBeforeChoice,
      JSON.stringify({
        hits: [...hits].map(([player, hit]) => [player, hit.cardId]),
        exile: ctx.state.exile.map((card) => card.cardId),
      }),
    ).toBe(true);
    expect(castOrder).toEqual(['P2 Etali hit', 'P1 Etali hit']);
    expect(ctx.state.exile.some((card) => card.cardId === hits.get('P3')!.cardId)).toBe(true);
    expect(ctx.state.exile.some((card) => card.cardId === hits.get('P4')!.cardId)).toBe(true);
    expect(p(ctx, 'P1').library).toHaveLength(0);
    expect(p(ctx, 'P2').library).toHaveLength(0);
    expect(p(ctx, 'P3').library).toHaveLength(0);
    expect(p(ctx, 'P4').library).toHaveLength(0);
  });

  it("pr09-sunbirds-captured-mana-value-and-reveal-count — the triggering spell's mana value sets X and the reveal is public", () => {
    const ctx = pod('pr09-sunbird-captured-value');
    spawn(ctx, 'P1', SUNBIRD);
    settle(ctx);
    const cards = library(ctx, 'P1', [
      FOULMIRE,
      labCard('Sunbird Too Large', '{4}', 'Sorcery', 'Draw a card.'),
      labCard('Sunbird Tail', '{1}', 'Sorcery', 'Draw a card.'),
      labCard('Sunbird Outside', '{1}', 'Sorcery', 'Draw a card.'),
    ]);
    const trigger = labCard('Sunbird Trigger Spell', '{2}', 'Sorcery', 'Draw a card.');
    let seenReveals = 0;
    castNormally(ctx, 'P1', trigger, new Map(), (decision) => {
      if (decision.options.some((option) => /Foulmire Knight/.test(option.description))) {
        seenReveals = ctx.state.eventLog.filter((event) => event.type === 'revealCard').length;
        expect(
          decision.options.some((option) => /Sunbird Too Large/.test(option.description)),
        ).toBe(false);
        return choose(decision, /Foulmire Knight/);
      }
      return pass(decision);
    });
    expect(seenReveals).toBe(2);
    const freeFaceCast = ctx.state.eventLog.find(
      (event) => event.type === 'castSpell' && event.payload['cardId'] === cards[0]!.cardId,
    );
    expect(freeFaceCast).toBeDefined();
    expect(freeFaceCast?.payload['alternativeCast']).toBeUndefined();
    expect(cards).toHaveLength(4);
  });

  it("pr09-minds-dilation-first-opponent-spell — exiles and offers only the first opposing spell's top card each turn", () => {
    const ctx = pod('pr09-dilation-first-only');
    spawn(ctx, 'P1', DILATION);
    settle(ctx);
    const firstHit = library(ctx, 'P2', [
      labCard('Dilation First Hit', '{2}', 'Instant', 'You gain 1 life.'),
    ])[0]!;
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    castNormally(
      ctx,
      'P2',
      labCard('Opponent First Spell', '{1}', 'Instant', 'You gain 1 life.'),
      new Map(),
      (decision) =>
        decision.options.some((option) => /Dilation First Hit/.test(option.description))
          ? choose(decision, /Dilation First Hit/)
          : pass(decision),
    );
    expect(
      ctx.state.eventLog.filter(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'Dilation First Hit',
      ),
    ).toHaveLength(1);
    expect(ctx.state.exile.some((card) => card.cardId === firstHit.cardId)).toBe(false);
    library(ctx, 'P2', [labCard('Dilation Second Top', '{2}', 'Instant', 'You gain 1 life.')]);
    castNormally(ctx, 'P2', labCard('Opponent Second Spell', '{1}', 'Instant', 'You gain 1 life.'));
    expect(ctx.state.exile.some((card) => card.name === 'Dilation Second Top')).toBe(false);
    expect(ctx.state.eventLog.filter((event) => event.type === 'revealCard')).toHaveLength(0);
  });

  it('pr09-expressive-iteration-short-library-and-land-timing — handles fewer than three cards and only permits a land during this turn', () => {
    const ctx = pod('pr09-iteration-short-land');
    const land = labCard('Iteration Land', '', 'Land');
    const spell = labCard('Iteration Spell', '{1}', 'Sorcery', 'Draw a card.');
    const cards = library(ctx, 'P1', [land, spell]);
    const answer = (decision: PendingDecision): DecisionOutcome => {
      if (decision.prompt.includes('choose a card to put into your hand'))
        return choose(decision, /Iteration Spell/);
      if (decision.prompt.includes('choose a card to put on the bottom'))
        return choose(decision, /Iteration Land/);
      return pass(decision);
    };
    castNormally(ctx, 'P1', ITERATION, new Map(), answer);
    expect(p(ctx, 'P1').hand.some((card) => card.cardId === cards[1]!.cardId)).toBe(true);
    expect(p(ctx, 'P1').library.map((card) => card.cardId)).toEqual([cards[0]!.cardId]);
    expect(ctx.state.exile).toHaveLength(0);
    expect(
      computePriorityOptions(ctx, p(ctx, 'P1')).some(
        (option) =>
          option.type === 'playLand' &&
          (option.payload as { objectId?: string }).objectId === cards[0]!.id,
      ),
    ).toBe(false);

    const full = pod('pr09-iteration-land-window');
    const trio = library(full, 'P1', [
      labCard('Iteration Hand', '{1}', 'Sorcery', 'Draw a card.'),
      labCard('Iteration Bottom', '{1}', 'Sorcery', 'Draw a card.'),
      land,
    ]);
    castNormally(full, 'P1', ITERATION, new Map(), (decision) => {
      if (decision.prompt.includes('choose a card to put into your hand'))
        return choose(decision, /Iteration Hand/);
      if (decision.prompt.includes('choose a card to put on the bottom'))
        return choose(decision, /Iteration Bottom/);
      return pass(decision);
    });
    const exiledLand = full.state.exile.find((card) => card.cardId === trio[2]!.cardId);
    expect(exiledLand).toBeDefined();
    expect(
      computePriorityOptions(full, p(full, 'P1')).some(
        (option) =>
          option.type === 'playLand' &&
          (option.payload as { objectId?: string }).objectId === exiledLand!.id,
      ),
    ).toBe(true);
    pump(cleanupStep(full));
    expect(
      computePriorityOptions(full, p(full, 'P1')).some(
        (option) =>
          option.type === 'playLand' &&
          (option.payload as { objectId?: string }).objectId === exiledLand!.id,
      ),
    ).toBe(false);
  });

  it('pr09-genesis-ultimatum-batch-and-remainder — chosen permanents enter together, unchosen cards go to hand, and the spell exiles itself', () => {
    const ctx = pod('pr09-genesis-batch');
    const cards = library(ctx, 'P1', [
      labCard(
        'Genesis Creature A',
        '{2}',
        'Creature — Beast',
        'When this creature enters, you gain 1 life.',
      ),
      labCard('Genesis Artifact', '{2}', 'Artifact', 'When this artifact enters, you gain 1 life.'),
      labCard('Genesis Spell', '{1}', 'Sorcery', 'Draw a card.'),
      labCard('Genesis Creature B', '{2}', 'Creature — Beast'),
      labCard('Genesis Enchantment', '{2}', 'Enchantment'),
    ]);
    const spell = castNormally(ctx, 'P1', ULTIMATUM, new Map(), (decision) => {
      if (decision.options.some((option) => /Genesis Creature A/.test(option.description)))
        return choose(decision, /Genesis Creature A/);
      if (decision.options.some((option) => /Genesis Artifact/.test(option.description)))
        return choose(decision, /Genesis Artifact/);
      if (decision.options.some((option) => /Finish choosing/.test(option.description)))
        return choose(decision, /Finish choosing/);
      return pass(decision);
    });
    expect(
      ctx.state.battlefield.filter((item) =>
        ['Genesis Creature A', 'Genesis Artifact'].includes(item.name),
      ),
    ).toHaveLength(2);
    expect(p(ctx, 'P1').life).toBe(42);
    expect(p(ctx, 'P1').hand.map((card) => card.name)).toEqual([
      'Genesis Spell',
      'Genesis Creature B',
      'Genesis Enchantment',
    ]);
    expect(ctx.state.exile.some((card) => card.cardId === spell.cardId)).toBe(true);
    expect(cards).toHaveLength(5);
  });

  it('pr09-time-vortex-cascade-and-rebound — cascades on the hand cast, rebounds at upkeep, and cascades again on that cast', () => {
    const ctx = pod('pr09-time-vortex-rebound');
    library(ctx, 'P1', [labCard('Vortex Cascade Hit', '{2}', 'Sorcery', 'Draw a card.')]);
    let cascades = 0;
    const answer = (decision: PendingDecision): DecisionOutcome => {
      if (/Rebound: cast this card/.test(decision.prompt))
        return choose(decision, /Cast .* without paying its mana cost/);
      if (decision.options.some((option) => /Vortex Cascade Hit/.test(option.description))) {
        cascades++;
        return decline(decision);
      }
      return pass(decision);
    };
    const vortex = castNormally(ctx, 'P1', VORTEX, new Map(), answer);
    expect(cascades).toBe(1);
    expect(ctx.state.exile.some((card) => card.cardId === vortex.cardId)).toBe(true);

    ctx.state.phase = 'beginning';
    ctx.state.step = 'upkeep';
    queueStepTriggers(ctx, 'upkeep');
    settle(ctx, answer);
    expect(cascades).toBe(2);
    expect(ctx.state.exile.some((card) => card.cardId === vortex.cardId)).toBe(false);
    expect(p(ctx, 'P1').graveyard.some((card) => card.cardId === vortex.cardId)).toBe(true);
  });
});
