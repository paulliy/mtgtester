import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard, PlayerId } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { addMana } from '../src/mana/pool';
import { runCombatPhase } from '../src/combat/combat';
import { moveObject, playerById } from '../src/state/objects';
import { createGame } from '../src/state/game';
import { queueStepTriggers } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import { computeCharacteristics } from '../src/effects/continuous';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import type { EngineCardObject, GameContext } from '../src/state/types';
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
const packEntry = fixture.cards.find(({ card }) => card.name === 'Power Pack')!;
const POWER_PACK = packEntry.card;

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 5,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}

function pass(decision: PendingDecision): DecisionOutcome {
  const index = decision.options.findIndex(
    (option) =>
      option.type === 'pass' ||
      (option.payload as Partial<PriorityActionPayload> | undefined)?.kind === 'pass',
  );
  return { index: Math.max(0, index), targets: new Map() };
}

function settle(ctx: GameContext, answer: (decision: PendingDecision) => DecisionOutcome = pass) {
  return pump(runPrioritySequence(ctx), answer);
}

function addColoredMana(
  ctx: GameContext,
  playerId: PlayerId,
  symbols: ('C' | 'R' | 'G' | 'W' | 'U' | 'B')[],
) {
  addMana(
    playerById(ctx, playerId),
    symbols.map((symbol) => ({ symbol })),
  );
}

function attackPack(
  ctx: GameContext,
  pack: { id: string },
  answer: (decision: PendingDecision) => DecisionOutcome = pass,
) {
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'combat';
  ctx.state.step = null;
  return pump(runCombatPhase(ctx), (decision) =>
    decision.decisionType === 'declareAttackers'
      ? declareAttacks(decision, (id) => (id === pack.id ? 'P2' : null))
      : answer(decision),
  );
}

function upkeep(ctx: GameContext, playerId: PlayerId) {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(playerId);
  ctx.state.phase = 'beginning';
  ctx.state.step = 'upkeep';
  queueStepTriggers(ctx, 'upkeep');
}

function spellCard(name: string, typeLine: 'Instant' | 'Sorcery', oracleText = '') {
  return oracle({ name, typeLine, manaCost: '{R}', oracleText: oracleText || 'Draw a card.' });
}

function shockWithDiscardCost() {
  return oracle({
    name: 'Pack Test Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    oracleText:
      'As an additional cost to cast this spell, discard a card.\nPack Test Bolt deals 2 damage to any target.',
  });
}

function putInGraveyard(ctx: GameContext, playerId: PlayerId, card: OracleCard) {
  return conjure(ctx, playerId, card, 'graveyard');
}

function castPrompt(decision: PendingDecision) {
  if (decision.decisionType !== 'general') return -1;
  return decision.options.findIndex((option) => option.type === 'castFree');
}

describe('PR09 Power Pack', () => {
  it('pr09-power-pack-pinned-and-modeled — uses the exact pinned Oracle card', () => {
    expect(packEntry.sha256).toBe(
      'f25d0c1c02ee8d07ec889e88ed83b5c610fbd4e0f8b87c4a266f761ced1248af',
    );
    expect(interpretCard(POWER_PACK).unmodeledReasons).toEqual([]);
  });

  it('pr09-power-pack-normal-paid-cast-keywords-and-timing — pays five colored mana and retains all combat keywords', () => {
    const ctx = pod('pr09-power-pack-cast');
    const card = conjure(ctx, 'P1', POWER_PACK, 'hand');
    addColoredMana(ctx, 'P1', ['C', 'R', 'G', 'W']);
    const offers = () =>
      computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
        (option) => (option.payload as { objectId?: string }).objectId === card.id,
      );
    expect(offers()).toBe(false);
    addColoredMana(ctx, 'P1', ['U']);
    expect(offers()).toBe(true);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(offers()).toBe(false);
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find(
      (candidate) => (candidate.payload as { objectId?: string }).objectId === card.id,
    )!;
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    settle(ctx);
    const permanent = ctx.state.battlefield.find((entry) => entry.cardId === card.cardId)!;
    const characteristics = computeCharacteristics(ctx, permanent);
    expect(characteristics.keywords).toEqual(
      expect.arrayContaining(['flying', 'vigilance', 'trample', 'haste']),
    );
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
  });

  it('pr09-power-pack-combat-damage-random-eligible-and-seeded — actual player damage chooses uniformly from eligible graveyard cards without a choice', () => {
    const run = (seed: string) => {
      const ctx = pod(seed);
      const pack = spawn(ctx, 'P1', POWER_PACK);
      const eligible = [
        putInGraveyard(ctx, 'P1', spellCard('Eligible instant', 'Instant')),
        putInGraveyard(ctx, 'P1', spellCard('Eligible sorcery', 'Sorcery')),
      ];
      putInGraveyard(ctx, 'P2', spellCard('Opponent instant', 'Instant'));
      putInGraveyard(
        ctx,
        'P1',
        oracle({ name: 'Creature in graveyard', typeLine: 'Creature — Bear' }),
      );
      putInGraveyard(ctx, 'P1', forest());
      const result = attackPack(ctx, pack);
      const chosen = ctx.state.exile.find((card) =>
        eligible.some((candidate) => candidate.cardId === card.cardId),
      );
      return { ctx, chosen, decisions: result.decisions, eligible };
    };
    const first = run('pr09-power-pack-random');
    const replay = run('pr09-power-pack-random');
    expect(playerById(first.ctx, 'P2').life).toBe(36);
    expect(first.chosen).toBeDefined();
    expect(first.eligible.some((candidate) => candidate.cardId === first.chosen!.cardId)).toBe(
      true,
    );
    expect(first.ctx.state.eventLog.some((event) => event.type === 'randomTarget')).toBe(true);
    expect(first.decisions.some((decision) => decision.decisionType === 'chooseTargets')).toBe(
      false,
    );
    expect(replay.chosen?.name).toBe(first.chosen?.name);
    expect(first.ctx.state.delayedTriggers).toHaveLength(1);
    const counts = new Map(first.eligible.map((candidate) => [candidate.name, 0]));
    for (let seed = 0; seed < 32; seed++) {
      const sample = run(`pr09-power-pack-random-${seed}`);
      counts.set(sample.chosen!.name, (counts.get(sample.chosen!.name) ?? 0) + 1);
    }
    const frequencies = [...counts.values()];
    expect(frequencies.every((count) => count > 0)).toBe(true);
    expect(Math.abs(frequencies[0]! - frequencies[1]!)).toBeLessThan(16);
  });

  it('pr09-power-pack-no-eligible-card — no instant or sorcery means no target or delayed trigger', () => {
    const ctx = pod('pr09-power-pack-empty-targets');
    const pack = spawn(ctx, 'P1', POWER_PACK);
    putInGraveyard(ctx, 'P1', forest());
    putInGraveyard(ctx, 'P1', oracle({ name: 'Only creature', typeLine: 'Creature — Bear' }));
    attackPack(ctx, pack);
    expect(ctx.state.eventLog.some((event) => event.type === 'randomTarget')).toBe(false);
    expect(ctx.state.delayedTriggers).toHaveLength(0);
  });

  it('pr09-power-pack-target-moved-before-resolution — a chosen card moved in response is not exiled and creates no delayed trigger', () => {
    const ctx = pod('pr09-power-pack-moved-target');
    const pack = spawn(ctx, 'P1', POWER_PACK);
    const candidate = putInGraveyard(ctx, 'P1', spellCard('Moved candidate', 'Instant'));
    conjure(
      ctx,
      'P2',
      oracle({
        name: 'Response available',
        typeLine: 'Instant',
        manaCost: '{0}',
        oracleText: 'Draw a card.',
      }),
      'hand',
    );
    let moved = false;
    const seen: unknown[] = [];
    attackPack(ctx, pack, (decision) => {
      const chosen = ctx.state.eventLog.find((event) => event.type === 'randomTarget');
      seen.push({
        type: decision.decisionType,
        chosen,
        stack: ctx.state.stack.map((entry) => entry.ability?.effects.map((effect) => effect.op)),
      });
      if (!moved && decision.decisionType === 'priority' && chosen !== undefined) {
        pump(moveObject(ctx, candidate, { zone: 'hand' }));
        moved = true;
      }
      return pass(decision);
    });
    expect(moved, JSON.stringify(seen)).toBe(true);
    expect(playerById(ctx, 'P1').hand.some((card) => card.cardId === candidate.cardId)).toBe(true);
    expect(ctx.state.exile.some((card) => card.cardId === candidate.cardId)).toBe(false);
    expect(ctx.state.delayedTriggers).toHaveLength(0);
  });

  it('pr09-power-pack-source-gone-and-your-upkeep-only — the delayed trigger survives source departure and waits for your upkeep', () => {
    const ctx = pod('pr09-power-pack-upkeep-scope');
    const pack = spawn(ctx, 'P1', POWER_PACK);
    const candidate = putInGraveyard(ctx, 'P1', spellCard('Upkeep candidate', 'Instant'));
    attackPack(ctx, pack);
    const exiled = ctx.state.exile.find((card) => card.cardId === candidate.cardId)!;
    pump(moveObject(ctx, pack, { zone: 'graveyard' }));

    upkeep(ctx, 'P2');
    const opponent = settle(ctx);
    expect(
      opponent.decisions.some((decision) => decision.prompt.includes('cast Upkeep candidate')),
    ).toBe(false);
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    upkeep(ctx, 'P1');
    const own = settle(ctx, (decision) => {
      const cast = castPrompt(decision);
      return cast >= 0 ? { index: cast, targets: new Map() } : pass(decision);
    });
    expect(
      own.decisions.some((decision) => decision.prompt.includes('cast Upkeep candidate')),
    ).toBe(true);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['cardId'] === exiled.cardId,
      ),
    ).toBe(true);
    expect(ctx.state.delayedTriggers).toHaveLength(0);
  });

  it('pr09-power-pack-decline-expires-trigger — declining consumes the one-shot delayed trigger and leaves the card exiled', () => {
    const ctx = pod('pr09-power-pack-decline');
    const pack = spawn(ctx, 'P1', POWER_PACK);
    const candidate = putInGraveyard(ctx, 'P1', spellCard('Declined candidate', 'Sorcery'));
    attackPack(ctx, pack);
    upkeep(ctx, 'P1');
    const result = settle(ctx, (decision) => {
      const decline = decision.options.findIndex((option) => option.type === 'decline');
      return decline >= 0 ? { index: decline, targets: new Map() } : pass(decision);
    });
    expect(
      result.decisions.some((decision) => decision.prompt.includes('cast Declined candidate')),
    ).toBe(true);
    expect(ctx.state.delayedTriggers).toHaveLength(0);
    expect(ctx.state.exile.some((card) => card.cardId === candidate.cardId)).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'castSpell')).toBe(false);
  });

  it('pr09-power-pack-free-targeted-spell-pays-additional-cost-and-resolves-to-exile — free casting uses the normal target and cost flow', () => {
    const ctx = pod('pr09-power-pack-free-cast');
    const pack = spawn(ctx, 'P1', POWER_PACK);
    const bolt = shockWithDiscardCost();
    expect(interpretCard(bolt).unmodeledReasons).toEqual([]);
    const candidate = putInGraveyard(ctx, 'P1', bolt);
    const discard = conjure(ctx, 'P1', forest(), 'hand');
    const targetId = 'P2';
    attackPack(ctx, pack);
    const initialExile = ctx.state.exile.find((card) => card.cardId === candidate.cardId)!;
    upkeep(ctx, 'P1');
    const result = settle(ctx, (decision) => {
      const cast = castPrompt(decision);
      if (cast >= 0) return { index: cast, targets: new Map() };
      if (decision.decisionType === 'chooseTargets') {
        const option = decision.options.findIndex((entry) =>
          entry.targets?.some((target) => target.options.includes(targetId)),
        );
        const selected = decision.options[option];
        expect(option).toBeGreaterThanOrEqual(0);
        return {
          index: option,
          targets: new Map(
            (selected?.targets ?? []).map((target) => [
              target.slot,
              target.options.find((id) => id === targetId) ?? target.options[0]!,
            ]),
          ),
        };
      }
      const discardIndex = decision.options.findIndex((option) =>
        option.description.includes(discard.name),
      );
      return discardIndex >= 0 ? { index: discardIndex, targets: new Map() } : pass(decision);
    });
    expect(result.decisions.some((decision) => decision.decisionType === 'chooseTargets')).toBe(
      true,
    );
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'discard' && event.payload['cardId'] === discard.cardId,
      ),
    ).toBe(true);
    expect(playerById(ctx, 'P2').life).toBe(34);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['cardId'] === candidate.cardId,
      ),
    ).toBe(true);
    expect(
      ctx.state.exile.some(
        (card) => card.cardId === candidate.cardId && card.id !== initialExile.id,
      ),
    ).toBe(true);
  });

  it('pr09-power-pack-fizzled-spell-exiles — an illegal target on resolution follows the replacement destination', () => {
    const ctx = pod('pr09-power-pack-fizzle');
    const pack = spawn(ctx, 'P1', POWER_PACK);
    const bolt = spellCard(
      'Pack Target Bolt',
      'Instant',
      'Pack Target Bolt deals 2 damage to any target.',
    );
    const candidate = putInGraveyard(ctx, 'P1', bolt);
    const targetId = 'P2';
    conjure(
      ctx,
      'P2',
      oracle({
        name: 'Response available',
        typeLine: 'Instant',
        manaCost: '{0}',
        oracleText: 'Draw a card.',
      }),
      'hand',
    );
    attackPack(ctx, pack);
    upkeep(ctx, 'P1');
    let grantedHexproof = false;
    settle(ctx, (decision) => {
      const cast = castPrompt(decision);
      if (cast >= 0) return { index: cast, targets: new Map() };
      if (decision.decisionType === 'chooseTargets') {
        const option = decision.options.findIndex((entry) =>
          entry.targets?.some((slot) => slot.options.includes(targetId)),
        );
        expect(option, JSON.stringify(decision.options)).toBeGreaterThanOrEqual(0);
        const selected = decision.options[option];
        return {
          index: option,
          targets: new Map(
            (selected?.targets ?? []).map((slot) => [
              slot.slot,
              slot.options.find((id) => id === targetId) ?? slot.options[0]!,
            ]),
          ),
        };
      }
      if (
        !grantedHexproof &&
        decision.decisionType === 'priority' &&
        ctx.state.stack.some((entry) => entry.card?.cardId === candidate.cardId)
      ) {
        ctx.state.playerHexproofTurn = { P2: ctx.state.turnNumber };
        grantedHexproof = true;
      }
      return pass(decision);
    });
    expect(grantedHexproof).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'fizzle')).toBe(true);
    expect(ctx.state.exile.some((card) => card.cardId === candidate.cardId)).toBe(true);
  });

  it('pr09-power-pack-countered-spell-exiles — a countered free spell follows its exile replacement', () => {
    const ctx = pod('pr09-power-pack-counter');
    const pack = spawn(ctx, 'P1', POWER_PACK);
    const bolt = spellCard(
      'Countered Pack Bolt',
      'Instant',
      'Countered Pack Bolt deals 2 damage to any target.',
    );
    const candidate = putInGraveyard(ctx, 'P1', bolt);
    const counterspell = oracle({
      name: 'Pack Counterspell',
      typeLine: 'Instant',
      manaCost: '{U}{U}',
      oracleText: 'Counter target spell.',
    });
    expect(interpretCard(counterspell).unmodeledReasons).toEqual([]);
    const counterInHand = conjure(ctx, 'P2', counterspell, 'hand');
    attackPack(ctx, pack);
    addColoredMana(ctx, 'P2', ['U', 'U']);
    upkeep(ctx, 'P1');
    let countered = false;
    settle(ctx, (decision) => {
      const cast = castPrompt(decision);
      if (cast >= 0) return { index: cast, targets: new Map() };
      if (decision.decisionType === 'chooseTargets') {
        const option = decision.options.findIndex((entry) =>
          entry.targets?.some((target) => target.options.includes('P2')),
        );
        const selected = decision.options[option];
        return {
          index: option,
          targets: new Map(
            (selected?.targets ?? []).map((target) => [
              target.slot,
              target.options.find((id) => id === 'P2') ?? target.options[0]!,
            ]),
          ),
        };
      }
      if (
        !countered &&
        decision.decisionType === 'priority' &&
        decision.player === 'P2' &&
        ctx.state.stack.some((entry) => entry.card?.cardId === candidate.cardId)
      ) {
        const target = ctx.state.stack.find((entry) => entry.card?.cardId === candidate.cardId)!;
        const option = computePriorityOptions(ctx, playerById(ctx, 'P2')).find((entry) => {
          const payload = entry.payload as PriorityActionPayload;
          return payload.kind === 'castSpell' && payload.objectId === counterInHand.id;
        });
        expect(option).toBeDefined();
        pump(
          applyPriorityAction(
            ctx,
            playerById(ctx, 'P2'),
            option!.payload as PriorityActionPayload,
            {
              index: 0,
              targets: new Map([[0, target.id]]),
            },
          ),
        );
        countered = true;
      }
      return pass(decision);
    });
    expect(countered).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'counterSpell')).toBe(true);
    expect(ctx.state.exile.some((card) => card.cardId === candidate.cardId)).toBe(true);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['cardId'] === counterInHand.cardId,
      ),
    ).toBe(true);
  });

  it('pr09-power-pack-bounced-spell-goes-to-hand — the replacement applies only to stack-to-graveyard moves', () => {
    const ctx = pod('pr09-power-pack-bounce');
    const pack = spawn(ctx, 'P1', POWER_PACK);
    const bolt = spellCard(
      'Bounced Pack Bolt',
      'Instant',
      'Bounced Pack Bolt deals 2 damage to any target.',
    );
    const candidate = putInGraveyard(ctx, 'P1', bolt);
    const bounce = oracle({
      name: 'Pack Reprieve',
      typeLine: 'Instant',
      manaCost: '{U}',
      oracleText: "Return target spell you don't control to its owner's hand.",
    });
    expect(interpretCard(bounce).unmodeledReasons).toEqual([]);
    const bounceInHand = conjure(ctx, 'P2', bounce, 'hand');
    attackPack(ctx, pack);
    addColoredMana(ctx, 'P2', ['U']);
    upkeep(ctx, 'P1');
    let bounced = false;
    settle(ctx, (decision) => {
      const cast = castPrompt(decision);
      if (cast >= 0) return { index: cast, targets: new Map() };
      if (decision.decisionType === 'chooseTargets') {
        const option = decision.options.findIndex((entry) =>
          entry.targets?.some((target) => target.options.includes('P2')),
        );
        const selected = decision.options[option];
        return {
          index: option,
          targets: new Map(
            (selected?.targets ?? []).map((target) => [
              target.slot,
              target.options.find((id) => id === 'P2') ?? target.options[0]!,
            ]),
          ),
        };
      }
      if (
        !bounced &&
        decision.decisionType === 'priority' &&
        decision.player === 'P2' &&
        ctx.state.stack.some((entry) => entry.card?.cardId === candidate.cardId)
      ) {
        const target = ctx.state.stack.find((entry) => entry.card?.cardId === candidate.cardId)!;
        const option = computePriorityOptions(ctx, playerById(ctx, 'P2')).find((entry) => {
          const payload = entry.payload as PriorityActionPayload;
          return payload.kind === 'castSpell' && payload.objectId === bounceInHand.id;
        });
        expect(option).toBeDefined();
        pump(
          applyPriorityAction(
            ctx,
            playerById(ctx, 'P2'),
            option!.payload as PriorityActionPayload,
            {
              index: 0,
              targets: new Map([[0, target.id]]),
            },
          ),
        );
        bounced = true;
      }
      return pass(decision);
    });
    expect(bounced).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'returnToHand')).toBe(true);
    expect(playerById(ctx, 'P1').hand.some((card) => card.cardId === candidate.cardId)).toBe(true);
    expect(ctx.state.exile.some((card) => card.cardId === candidate.cardId)).toBe(false);
  });

  it('pr09-power-pack-exact-exile-object — leaving and returning to exile does not revive a stale delayed reference', () => {
    const ctx = pod('pr09-power-pack-exact-object');
    const pack = spawn(ctx, 'P1', POWER_PACK);
    const candidate = putInGraveyard(ctx, 'P1', spellCard('Object identity candidate', 'Instant'));
    attackPack(ctx, pack);
    const original = ctx.state.exile.find((card) => card.cardId === candidate.cardId)!;
    const graveyard = pump(moveObject(ctx, original, { zone: 'graveyard' }))
      .value as EngineCardObject;
    const newExile = pump(moveObject(ctx, graveyard, { zone: 'exile' })).value as EngineCardObject;
    expect(newExile.id).not.toBe(original.id);
    upkeep(ctx, 'P1');
    const result = settle(ctx);
    expect(
      result.decisions.some((decision) =>
        decision.prompt.includes('cast Object identity candidate'),
      ),
    ).toBe(false);
    expect(ctx.state.exile.some((card) => card.id === newExile.id)).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'castSpell')).toBe(false);
  });
});
