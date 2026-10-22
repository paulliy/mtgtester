import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Color, OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import type { CardDefinition } from '../src/cards/definition';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import type { ManaEntry } from '../src/cards/ability';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
if (fixture.cards.length !== 31)
  throw new Error('Expected 31 PR09 pins, found ' + fixture.cards.length);

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

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
const definition = (card: OracleCard): CardDefinition => interpretCard(card);

/** Build only the exact printed mana pool, from the parsed definition cost. */
function exactMana(def: CardDefinition): ManaEntry[] {
  const cost = def.manaCost;
  if (cost === null) return [];
  const mana: ManaEntry[] = [];
  for (const color of ['W', 'U', 'B', 'R', 'G'] as const satisfies readonly Color[]) {
    for (let i = 0; i < cost.colored[color]; i++) mana.push({ symbol: color });
  }
  for (let i = 0; i < cost.colorless; i++) mana.push({ symbol: 'C' });
  for (const pip of cost.hybrid ?? []) mana.push({ symbol: pip[0]! });
  for (const pip of cost.phyrexian ?? []) mana.push({ symbol: pip });
  for (let i = 0; i < cost.generic; i++) mana.push({ symbol: 'C' });
  return mana;
}

function normalCastOption(ctx: GameContext, playerId: string, objectId: string) {
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

function answerFirstLegal(decision: PendingDecision): DecisionOutcome {
  const decline = decision.options.findIndex((option) => option.type === 'decline');
  const index = decline >= 0 ? decline : 0;
  const option = decision.options[index];
  return {
    index,
    targets: new Map((option?.targets ?? []).map((slot) => [slot.slot, slot.options[0]!])),
  };
}

function targetsFor(
  ctx: GameContext,
  card: OracleCard,
  opponentSpell?: string,
): Map<number, string> {
  if (card.name === "Songbirds' Blessing") {
    const creature = ctx.state.battlefield.find(
      (candidate) =>
        candidate.controllerId === 'P1' &&
        computeCharacteristics(ctx, candidate).types.includes('Creature'),
    );
    if (creature === undefined)
      throw new Error('Songbirds target fixture is missing its friendly creature');
    return new Map([[0, creature.id]]);
  }
  if (card.name === 'Chaos Warp') {
    const target = ctx.state.battlefield.find((candidate) => candidate.controllerId === 'P2');
    if (target === undefined)
      throw new Error('Chaos Warp target fixture is missing an opponent permanent');
    return new Map([[0, target.id]]);
  }
  if (card.name === "Tibalt's Trickery") {
    if (opponentSpell === undefined)
      throw new Error('Tibalt target fixture is missing the opponent spell');
    return new Map([[0, opponentSpell]]);
  }
  return new Map();
}

function castSupport(ctx: GameContext, card: OracleCard) {
  if (card.name === "Songbirds' Blessing") {
    spawn(ctx, 'P1', oracle({ name: 'Friendly Songbirds Target', typeLine: 'Creature — Bird' }));
  }
  if (card.name === 'Chaos Warp') {
    spawn(ctx, 'P2', oracle({ name: 'Chaos Warp Target', typeLine: 'Artifact' }));
  }
}

function castOpponentSpell(ctx: GameContext, playerId = 'P2') {
  const opponentCard = oracle({
    name: 'Normal Cast Stack Fixture ' + playerId,
    typeLine: 'Sorcery',
    manaCost: '{1}',
    cmc: 1,
    power: null,
    toughness: null,
    oracleText: 'Draw a card.',
  });
  const spell = conjure(ctx, playerId, opponentCard, 'hand');
  addMana(p(ctx, playerId), [{ symbol: 'C' }]);
  const previousTurn = ctx.state.currentTurnPlayer;
  const previousIndex = ctx.state.activePlayerIndex;
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = ctx.state.players.findIndex((player) => player.id === playerId);
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  const option = normalCastOption(ctx, playerId, spell.id);
  expect(option, playerId + ' normal-casts the stack fixture').toBeDefined();
  pump(
    applyPriorityAction(ctx, p(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
    answerFirstLegal,
  );
  const stackItem = ctx.state.stack.find((item) => item.sourceCardId === spell.cardId);
  if (stackItem === undefined) throw new Error(playerId + ' spell did not remain on the stack');
  ctx.state.currentTurnPlayer = previousTurn;
  ctx.state.activePlayerIndex = previousIndex;
  // Casting creates a new stack object; targeted counterspells need that object ID, not the
  // hand-zone object's now-stale ID.
  return { ...spell, id: stackItem.id };
}

function cardIsPermanent(def: CardDefinition): boolean {
  return (['Creature', 'Artifact', 'Enchantment', 'Planeswalker', 'Battle'] as const).some((type) =>
    def.types.includes(type),
  );
}

describe('PR09 pinned cards — normal cast boundaries', () => {
  for (const entry of fixture.cards) {
    const card = entry.card;
    const cardSlug = slug(card.name);
    const def = definition(card);

    it(
      'pr09-' +
        cardSlug +
        '-normal-cast — pays the printed cost and resolves through the real cast path',
      () => {
        expect(createHash('sha256').update(JSON.stringify(card)).digest('hex')).toBe(entry.sha256);
        expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
        expect(def.manaCost, card.name + ' has a parsed printed mana cost').not.toBeNull();

        const ctx = pod('pr09-card-' + cardSlug + '-normal');
        castSupport(ctx, card);
        const opponentSpell =
          card.name === "Tibalt's Trickery" ? castOpponentSpell(ctx, 'P2') : undefined;
        const spell = conjure(ctx, 'P1', card, 'hand');
        addMana(p(ctx, 'P1'), exactMana(def));
        const option = normalCastOption(ctx, 'P1', spell.id);
        expect(option, card.name + ' normal printed-cost cast is offered').toBeDefined();
        const targets = targetsFor(ctx, card, opponentSpell?.id);
        const cast = pump(
          applyPriorityAction(ctx, p(ctx, 'P1'), option!.payload as PriorityActionPayload, {
            index: 0,
            targets,
          }),
          answerFirstLegal,
        );
        expect(p(ctx, 'P1').manaEntries, card.name + ' consumed exact printed mana').toHaveLength(
          0,
        );
        expect(
          ctx.state.eventLog.some(
            (event) => event.type === 'castSpell' && event.payload['cardId'] === spell.cardId,
          ),
        ).toBe(true);
        expect(cast.value).toBeUndefined();
        expect(
          ctx.state.stack.some((stackItem) => stackItem.sourceCardId === spell.cardId),
          JSON.stringify({ spellCardId: spell.cardId, stack: ctx.state.stack }),
        ).toBe(true);

        pump(resolveTopOfStack(ctx), answerFirstLegal);
        expect(ctx.state.stack.some((stackItem) => stackItem.sourceCardId === spell.cardId)).toBe(
          false,
        );
        const onBattlefield = ctx.state.battlefield.some(
          (permanent) => permanent.cardId === spell.cardId,
        );
        if (cardIsPermanent(def))
          expect(onBattlefield, card.name + ' resolves as a permanent').toBe(true);
        else expect(onBattlefield, card.name + ' resolves as a nonpermanent spell').toBe(false);
        expect(
          ctx.state.eventLog.some(
            (event) =>
              event.type === 'zoneChange' &&
              event.payload['cardId'] === spell.cardId &&
              event.payload['from'] === 'stack' &&
              event.payload['to'] !== 'stack',
          ),
        ).toBe(true);
      },
    );

    it(
      'pr09-' +
        cardSlug +
        '-insufficient-cost — does not offer the printed-cost cast short one mana',
      () => {
        const ctx = pod('pr09-card-' + cardSlug + '-short');
        castSupport(ctx, card);
        if (card.name === "Tibalt's Trickery") castOpponentSpell(ctx, 'P2');
        const spell = conjure(ctx, 'P1', card, 'hand');
        const mana = exactMana(def);
        expect(mana.length, card.name + ' has a nonzero printed cost to underpay').toBeGreaterThan(
          0,
        );
        addMana(p(ctx, 'P1'), mana.slice(0, -1));
        expect(
          normalCastOption(ctx, 'P1', spell.id),
          card.name + ' cannot be cast short one mana',
        ).toBeUndefined();
      },
    );

    it(
      'pr09-' + cardSlug + '-sorcery-timing — applies the card printed instant or sorcery timing',
      () => {
        const isInstant = def.types.includes('Instant');
        const scenarios = [
          {
            name: 'opponent-turn',
            setup: (ctx: GameContext) => {
              ctx.state.currentTurnPlayer = 'P2';
              ctx.state.activePlayerIndex = 1;
            },
          },
          {
            name: 'combat',
            setup: (ctx: GameContext) => {
              ctx.state.phase = 'combat';
              ctx.state.step = 'declareAttackers';
            },
          },
          {
            name: 'stack-nonempty',
            setup: (ctx: GameContext) => {
              // Tibalt's target spell was already cast before this setup. Reuse it instead of
              // trying to cast another sorcery onto an occupied stack.
              if (ctx.state.stack.length === 0) castOpponentSpell(ctx, 'P2');
            },
          },
        ];
        for (const scenario of scenarios) {
          const ctx = pod('pr09-card-' + cardSlug + '-timing-' + scenario.name);
          castSupport(ctx, card);
          if (card.name === "Tibalt's Trickery") castOpponentSpell(ctx, 'P2');
          const spell = conjure(ctx, 'P1', card, 'hand');
          addMana(p(ctx, 'P1'), exactMana(def));
          scenario.setup(ctx);
          const option = normalCastOption(ctx, 'P1', spell.id);
          if (!isInstant) {
            expect(option, card.name + ' is unavailable during ' + scenario.name).toBeUndefined();
          } else if (card.name === 'Chaos Warp' || card.name === "Tibalt's Trickery") {
            expect(
              option,
              card.name + ' instant has its required target during ' + scenario.name,
            ).toBeDefined();
          } else {
            expect(
              option,
              card.name + ' instant timing is available during ' + scenario.name,
            ).toBeDefined();
          }
        }
      },
    );
  }
});
