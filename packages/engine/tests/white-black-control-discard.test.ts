import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { getOverride } from '../src/cards/overrides';
import { registerWhiteBlackControlDiscardOverrides } from '../src/cards/overrides/white-black-control-discard';
import { priorityCheckpoint } from '../src/sba/sba';
import { discardCard } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { queueStepTriggers } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import { executeAbility } from '../src/effects/resolve';
import {
  bear,
  copies,
  conjure,
  declareAttacks,
  doom,
  gameConfig,
  oracle,
  pick,
  pump,
  spawn,
  swamp,
} from './fixtures';
import { runCombatPhase } from '../src/combat/combat';
import { computeCharacteristics } from '../src/effects/continuous';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}

const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: PinnedCard[] };

const pins = {
  'Hymn to Tourach': 'd16287c5c9454bd70fa143c711594965f7cb5657930ab6e4eeaa6fafaab43c66',
  'Bottomless Pit': '3e70a3db7bc2437db19f3e7479ebb4eb3a3de4e96aed439d799fc53b2a858d93',
  'Necrogen Mists': '304b0b1c7df5b09fbc24084a3cf9c15f64002fa89eb7364bf966168cd503314a',
  'Hypnotic Specter': '34d0636699a90f6312b9cdc068cb5b822f51b5cf5cdca3cf669bda675df64582',
  Oppression: '94486b101e3ab95e200fe5b1839ee3513fe9a59cb0e0184d17e77992ddf5465d',
  'Syphon Mind': '3f874892d271ffd03fbd6abc86fc342537719e1d1a86765af3187ae7ca698d12',
  "Geth's Grimoire": '5b69db18aafa89cd067bbe5be9d0b6397b00200abe381fbfea927a3d6e682a91',
} as const;

const names = Object.keys(pins) as (keyof typeof pins)[];
const cards = new Map<keyof typeof pins, PinnedCard>();
for (const name of names) {
  const entry = pinned.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing pinned Oracle card: ${name}`);
  cards.set(name, entry);
}

beforeAll(() => registerWhiteBlackControlDiscardOverrides());

function card(name: keyof typeof pins): OracleCard {
  const entry = cards.get(name);
  if (entry === undefined) throw new Error(`Missing pinned card: ${name}`);
  return entry.card;
}

function context(seed = 'white-black-control-discard'): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(12, swamp) })),
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
  return ctx;
}

function handCard(name: string): OracleCard {
  return oracle({
    name,
    typeLine: 'Basic Land — Test',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });
}

function putInHand(ctx: GameContext, playerId: string, ...names: string[]): void {
  for (const name of names) conjure(ctx, playerId, handCard(name), 'hand');
}

function player(ctx: GameContext, playerId: string) {
  const found = ctx.state.players.find((candidate) => candidate.id === playerId);
  if (found === undefined) throw new Error(`Missing player ${playerId}`);
  return found;
}

/** Cast the pinned card through the ordinary priority, target, payment, and resolution path. */
function castCardFromHand(
  ctx: GameContext,
  playerId: string,
  spellCard: OracleCard,
  targets: ReadonlyMap<number, string> = new Map(),
  answer?: Parameters<typeof pump>[1],
): void {
  conjure(ctx, playerId, spellCard, 'hand');
  let cast = false;
  pump(runPrioritySequence(ctx), (decision) => {
    if (decision.decisionType === 'priority' && decision.player === playerId && !cast) {
      const index = decision.options.findIndex(
        (option) => option.type === 'castSpell' && option.description.includes(spellCard.name),
      );
      if (index >= 0) {
        cast = true;
        return { index, targets };
      }
    }
    return answer?.(decision, 1) ?? pick(decision, /Pass|does not/i);
  });
  expect(cast).toBe(true);
}

function castFromHand(
  ctx: GameContext,
  playerId: string,
  name: keyof typeof pins,
  targets: ReadonlyMap<number, string> = new Map(),
  answer?: Parameters<typeof pump>[1],
): void {
  castCardFromHand(ctx, playerId, card(name), targets, answer);
}

describe('white-black-control discard cards — pinned Oracle', () => {
  it('uses exact pinned hashes and replaces only each card’s unparsed behavior', () => {
    for (const name of names) {
      const entry = cards.get(name)!;
      expect(entry.sha256).toBe(pins[name]);
      // The interpreter reads Necrogen Mists' and Oppression's lines since EDHREC plan Phase 4
      // batch 4 (player verbs); their overrides keep the same definition and claim nothing.
      // Geth's Grimoire's discard trigger is read since batch 6 (opponent discard heads).
      const grammarRead =
        name === 'Necrogen Mists' || name === 'Oppression' || name === "Geth's Grimoire";
      expect(getOverride(entry.card.oracleId)?.handledLines).toHaveLength(grammarRead ? 0 : 1);
      const definition = interpretCard(entry.card);
      expect(definition.modeled, `${name}: ${definition.unmodeledReasons.join('; ')}`).toBe(true);
      expect(definition.unmodeledReasons).toEqual([]);
    }
  });

  it('casts Hymn to Tourach normally and randomly discards exactly two from its target', () => {
    const ctx = context();
    spawn(ctx, 'P1', swamp());
    spawn(ctx, 'P1', swamp());
    spawn(ctx, 'P1', card("Geth's Grimoire"));
    putInHand(ctx, 'P2', 'Target One', 'Target Two', 'Target Three');
    putInHand(ctx, 'P3', 'Untargeted Card');

    castFromHand(ctx, 'P1', 'Hymn to Tourach', new Map([[0, 'P2']]), () => ({
      index: 0,
      targets: new Map(),
    }));

    expect(
      player(ctx, 'P2').graveyard.filter((object) => object.name.startsWith('Target ')),
    ).toHaveLength(2);
    expect(
      player(ctx, 'P2').hand.filter((object) => object.name.startsWith('Target ')),
    ).toHaveLength(1);
    expect(player(ctx, 'P3').hand.map((object) => object.name)).toContain('Untargeted Card');
    expect(player(ctx, 'P1').hand).toHaveLength(2);
  });

  it.each([
    ['Bottomless Pit', true],
    ['Necrogen Mists', false],
  ] as const)(
    '%s triggers only for the active player’s upkeep and discards as printed',
    (name, random) => {
      const ctx = context(`white-black-${name}`);
      const first = spawn(ctx, 'P1', card(name));
      expect(first.name).toBe(name);
      ctx.state.currentTurnPlayer = 'P2';
      ctx.state.activePlayerIndex = 1;
      putInHand(ctx, 'P2', 'P2 First', 'P2 Second');
      putInHand(ctx, 'P3', 'P3 Untouched');

      queueStepTriggers(ctx, 'upkeep');
      pump(priorityCheckpoint(ctx));
      expect(ctx.state.stack).toHaveLength(1);
      pump(resolveTopOfStack(ctx), (decision) => pick(decision, 'P2 Second'));

      expect(player(ctx, 'P2').hand.map((object) => object.name)).toHaveLength(1);
      expect(player(ctx, 'P3').hand.map((object) => object.name)).toEqual(['P3 Untouched']);
      if (random) expect(player(ctx, 'P2').graveyard.map((object) => object.name)).toHaveLength(1);
      else expect(player(ctx, 'P2').graveyard.map((object) => object.name)).toContain('P2 Second');
    },
  );

  it('Oppression triggers on an opponent’s cast and has that caster discard', () => {
    const ctx = context('oppression-cast');
    spawn(ctx, 'P1', card('Oppression'));
    spawn(ctx, 'P2', swamp());
    const target = spawn(ctx, 'P1', bear());
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    putInHand(ctx, 'P2', 'Discarded by Oppression');
    const testSpell = doom();

    castCardFromHand(ctx, 'P2', testSpell, new Map([[0, target.id]]), (decision) => {
      if (decision.decisionType === 'priority' && decision.player === 'P2')
        return pick(decision, /Cast Test Doom/);
      if (decision.decisionType === 'general' && decision.player === 'P2')
        return pick(decision, 'Discarded by Oppression');
      return pick(decision, /Pass|does not/i);
    });

    expect(player(ctx, 'P2').graveyard.map((object) => object.name)).toContain(
      'Discarded by Oppression',
    );
  });

  it('Hypnotic Specter preserves flying and discards after combat damage to an opponent', () => {
    const ctx = context('hypnotic-specter-combat');
    for (let i = 0; i < 3; i++) spawn(ctx, 'P1', swamp());
    putInHand(ctx, 'P2', 'Specter Random Discard', 'Specter Survivor');
    castFromHand(ctx, 'P1', 'Hypnotic Specter');
    const specter = ctx.state.battlefield.find(
      (permanent) => permanent.name === 'Hypnotic Specter',
    );
    expect(specter).toBeDefined();
    specter!.summoningSick = false;
    expect(computeCharacteristics(ctx, specter!).keywords).toContain('flying');
    ctx.state.phase = 'combat';

    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (_id, subject) =>
          subject.name === 'Hypnotic Specter' ? 'P2' : null,
        );
      return pick(decision, /Pass|does not/i);
    });

    expect(player(ctx, 'P2').life).toBe(38);
    expect(player(ctx, 'P2').graveyard.map((object) => object.name)).toHaveLength(1);
    expect(player(ctx, 'P2').hand.map((object) => object.name)).toHaveLength(1);
  });

  it('Hypnotic Specter also sees actual noncombat damage to an opponent, but not zero or self damage', () => {
    const ctx = context('hypnotic-specter-noncombat');
    const specter = spawn(ctx, 'P1', card('Hypnotic Specter'));
    putInHand(ctx, 'P2', 'Noncombat Random Discard', 'Noncombat Survivor');
    const effect = {
      kind: 'activated' as const,
      targets: [{ kind: 'player' as const }],
      effects: [{ op: 'dealDamage' as const, target: 0, amount: { kind: 'const' as const, n: 1 } }],
    };
    const source = {
      id: specter.id,
      cardId: specter.cardId,
      name: specter.name,
      oracleId: specter.oracleId,
      controllerId: specter.controllerId,
    };

    pump(executeAbility(ctx, source, effect, ['P2']));
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    pump(resolveTopOfStack(ctx));
    expect(player(ctx, 'P2').graveyard.map((object) => object.name)).toHaveLength(1);

    pump(executeAbility(ctx, source, effect, ['P1']));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    pump(
      executeAbility(
        ctx,
        source,
        {
          ...effect,
          effects: [{ op: 'dealDamage', target: 0, amount: { kind: 'const', n: 0 } }],
        },
        ['P2'],
      ),
    );
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('Syphon Mind casts normally, opponents discard, and the controller draws once per actual discard', () => {
    const ctx = context('syphon-mind');
    for (let i = 0; i < 4; i++) spawn(ctx, 'P1', swamp());
    putInHand(ctx, 'P1', 'P1 Untouched');
    putInHand(ctx, 'P2', 'P2 Card');
    putInHand(ctx, 'P3', 'P3 Card One', 'P3 Card Two');

    castFromHand(ctx, 'P1', 'Syphon Mind', new Map(), (decision) => {
      if (decision.decisionType === 'general' && decision.player === 'P2')
        return pick(decision, 'P2 Card');
      if (decision.decisionType === 'general' && decision.player === 'P3')
        return pick(decision, 'P3 Card Two');
      return pick(decision, /Pass|does not/i);
    });

    expect(player(ctx, 'P2').graveyard.map((object) => object.name)).toContain('P2 Card');
    expect(player(ctx, 'P3').graveyard.map((object) => object.name)).toContain('P3 Card Two');
    expect(player(ctx, 'P4').hand).toHaveLength(0);
    expect(player(ctx, 'P1').hand.map((object) => object.name)).toContain('P1 Untouched');
    expect(player(ctx, 'P1').hand).toHaveLength(3);
  });

  it("Geth's Grimoire triggers for opponent discards, is optional, and ignores its controller's discards", () => {
    const ctx = context('geths-grimoire');
    spawn(ctx, 'P1', card("Geth's Grimoire"));
    const opponentCard = conjure(ctx, 'P2', handCard('Opponent Discard'), 'hand');

    pump(discardCard(ctx, opponentCard, 'P2'));
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.stack).toHaveLength(1);
    pump(resolveTopOfStack(ctx), (decision) => pick(decision, 'Yes'));
    expect(player(ctx, 'P1').hand).toHaveLength(1);

    const controllerCard = conjure(ctx, 'P1', handCard('Controller Discard'), 'hand');
    pump(discardCard(ctx, controllerCard, 'P1'));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});
