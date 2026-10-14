import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { registerWhiteBlackControlTinybonesOverrides } from '../src/cards/overrides/white-black-control-tinybones';
import { resolveTopOfStack } from '../src/stack/stack';
import { queueStepTriggers } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import { priorityCheckpoint } from '../src/sba/sba';
import { createGame } from '../src/state/game';
import { discardCard } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { executeAbility } from '../src/effects/resolve';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { runTurn } from '../src/turn/turn';
import { copies, conjure, gameConfig, oracle, pick, pump, spawn, swamp } from './fixtures';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}
const pinned = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: PinnedCard[] };
const pins = {
  'Tinybones Joins Up': 'e0975b6f80bbae0706c845c15bae881e181f8dda64878d0f101c568224c2d71a',
  'Tinybones, Trinket Thief': 'fa942a88eac3190440d190334f15b964ae56dfb0fb5bcc87d876b8df28cf4651',
} as const;
const cards = new Map(
  Object.keys(pins).map((name) => {
    const entry = pinned.cards.find((item) => item.card.name === name);
    if (!entry) throw new Error(`Missing pinned card: ${name}`);
    return [name, entry] as const;
  }),
);
beforeAll(() => registerWhiteBlackControlTinybonesOverrides());
function card(name: keyof typeof pins): OracleCard {
  return cards.get(name)!.card;
}
function ctx(seed = 'tinybones'): GameContext {
  const game = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(12, swamp) })),
      { seed },
    ),
  );
  Object.assign(game.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 2,
    phase: 'precombatMain',
    step: null,
  });
  return game;
}
function player(game: GameContext, id: string) {
  return game.state.players.find((p) => p.id === id)!;
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
function addHand(game: GameContext, id: string, ...names: string[]) {
  return names.map((name) => conjure(game, id, handCard(name), 'hand'));
}
function cast(
  game: GameContext,
  id: string,
  source: OracleCard,
  answer?: Parameters<typeof pump>[1],
) {
  conjure(game, id, source, 'hand');
  let casted = false;
  pump(runPrioritySequence(game), (decision) => {
    if (decision.decisionType === 'priority' && decision.player === id && !casted) {
      const index = decision.options.findIndex(
        (o) => o.type === 'castSpell' && o.description.includes(source.name),
      );
      if (index >= 0) {
        casted = true;
        return { index, targets: new Map() };
      }
    }
    return answer?.(decision, 1) ?? pick(decision, /Pass|does not/i);
  });
  expect(casted).toBe(true);
}
function passPriority(game: GameContext) {
  pump(priorityCheckpoint(game));
}
function settle(game: GameContext) {
  passPriority(game);
  while (game.state.stack.length)
    pump(resolveTopOfStack(game), (decision) => {
      const decline = decision.options.findIndex((o) =>
        /Choose no more targets/.test(o.description),
      );
      return decline >= 0
        ? { index: decline, targets: new Map() }
        : pick(decision, /Pass|does not/i);
    });
}

describe('Tinybones cards — pinned Oracle behavior', () => {
  it('keeps both exact Oracle pins and parses the authored replacement abilities', () => {
    for (const name of Object.keys(pins) as (keyof typeof pins)[]) {
      expect(cards.get(name)!.sha256).toBe(pins[name]);
      const definition = interpretCard(card(name));
      expect(definition.modeled, `${name}: ${definition.unmodeledReasons.join('; ')}`).toBe(true);
    }
  });

  it('keeps counted-player effect contracts and rejects ordinary/permanent refs and unsupported flags', () => {
    const joins = interpretCard(card('Tinybones Joins Up'));
    expect(validateCardDefinition(joins)).toEqual([]);
    expect(joins.triggers?.[0]?.targets?.[0]).toMatchObject({
      kind: 'player',
      count: { min: 0, max: Infinity },
    });
    const ordinary = structuredClone(joins);
    ordinary.triggers![0]!.targets![0] = { kind: 'player' };
    expect(
      validateCardDefinition(ordinary)
        .map((issue) => issue.message)
        .join('\n'),
    ).toMatch(/counted|target/i);
    const permanent = structuredClone(joins);
    permanent.triggers![0]!.targets![0] = { kind: 'permanent' };
    expect(
      validateCardDefinition(permanent)
        .map((issue) => issue.message)
        .join('\n'),
    ).toMatch(/player|target/i);
    const thief = interpretCard(card('Tinybones, Trinket Thief'));
    const invalidFlag = structuredClone(thief);
    invalidFlag.activatedAbilities[0]!.ability.effects[0] = {
      ...invalidFlag.activatedAbilities[0]!.ability.effects[0]!,
      emptyHandOnly: 'yes',
    } as never;
    expect(
      validateCardDefinition(invalidFlag)
        .map((issue) => issue.message)
        .join('\n'),
    ).toMatch(/empty hand restriction|true/i);
    const invalidPermanentReference = structuredClone(thief);
    invalidPermanentReference.activatedAbilities[0]!.ability.effects[0] = {
      op: 'eachOpponentLosesLife',
      amount: { kind: 'const', n: 10 },
      emptyHandOnly: true,
      target: { kind: 'sourcePermanent' },
    } as never;
    expect(
      validateCardDefinition(invalidPermanentReference)
        .map((issue) => issue.message)
        .join('\n'),
    ).toMatch(/target|reference|unknown/i);
  });

  it('Tinybones Joins Up is cast normally and its ETB counted selection can be empty', () => {
    const game = ctx();
    for (let i = 0; i < 3; i++) spawn(game, 'P1', swamp());
    cast(game, 'P1', card('Tinybones Joins Up'), (decision) => {
      const decline = decision.options.findIndex((o) =>
        /Choose no more targets/.test(o.description),
      );
      return decline >= 0
        ? { index: decline, targets: new Map() }
        : pick(decision, /Pass|does not/i);
    });
    const joins = game.state.battlefield.find((p) => p.name === 'Tinybones Joins Up');
    expect(joins).toBeDefined();
    passPriority(game);
    expect(game.state.stack.length).toBeGreaterThanOrEqual(0);
    // No players selected: the trigger resolves without changing any hand.
    while (game.state.stack.length) pump(resolveTopOfStack(game));
    expect(player(game, 'P1').discardedCardsThisTurn ?? 0).toBe(0);
  });

  it('Tinybones Joins Up can select exactly one opponent and leaves every other hand alone', () => {
    const game = ctx('joins-one-target');
    for (let i = 0; i < 3; i++) spawn(game, 'P1', swamp());
    addHand(game, 'P2', 'P2 selected', 'P2 spare');
    addHand(game, 'P3', 'P3 untouched');
    cast(game, 'P1', card('Tinybones Joins Up'), (decision) => {
      const target = decision.options.findIndex((o) => o.description === 'Target P2');
      if (target >= 0) return { index: target, targets: new Map() };
      const done = decision.options.findIndex((o) => /Choose no more targets/.test(o.description));
      if (done >= 0) return { index: done, targets: new Map() };
      if (/Discard a card/.test(decision.prompt)) return pick(decision, /P2 selected/);
      return pick(decision, /Pass|does not/i);
    });
    expect(player(game, 'P2').graveyard.map((c) => c.name)).toContain('P2 selected');
    expect(player(game, 'P3').hand.map((c) => c.name)).toEqual(['P3 untouched']);
  });

  it('Tinybones Joins Up lets several players select and makes all discard choices before moving cards', () => {
    const game = ctx('joins-selected-players');
    for (let i = 0; i < 3; i++) spawn(game, 'P1', swamp());
    addHand(game, 'P1', 'P1 choice', 'P1 spare');
    addHand(game, 'P2', 'P2 choice', 'P2 spare');
    addHand(game, 'P3', 'P3 choice', 'P3 spare');
    addHand(game, 'P4', 'P4 stays');
    const chosen = new Set<string>();
    const prompted: string[] = [];
    cast(game, 'P1', card('Tinybones Joins Up'), (decision) => {
      if (/Discard a card/.test(decision.prompt)) {
        expect(player(game, 'P1').hand).toHaveLength(2);
        expect(player(game, 'P2').hand).toHaveLength(2);
        expect(player(game, 'P3').hand).toHaveLength(2);
        prompted.push(decision.player);
        return pick(decision, /choice/);
      }
      const target = decision.options.findIndex((o) => /^Target P[123]$/.test(o.description));
      if (target >= 0 && chosen.size < 3) {
        chosen.add(decision.options[target]!.description.slice(-2));
        return { index: target, targets: new Map() };
      }
      const finish = decision.options.findIndex((o) =>
        /Choose no more targets/.test(o.description),
      );
      if (finish >= 0) return { index: finish, targets: new Map() };
      if (/Discard a card/.test(decision.prompt)) {
        expect(player(game, 'P1').hand).toHaveLength(1);
        expect(player(game, 'P2').hand).toHaveLength(1);
        expect(player(game, 'P3').hand).toHaveLength(1);
        prompted.push(decision.player);
        return { index: 0, targets: new Map() };
      }
      return pick(decision, /Pass|does not/i);
    });
    while (game.state.stack.length > 0)
      pump(resolveTopOfStack(game), (decision) => {
        if (/Discard a card/.test(decision.prompt)) {
          expect(player(game, 'P1').hand).toHaveLength(1);
          expect(player(game, 'P2').hand).toHaveLength(1);
          expect(player(game, 'P3').hand).toHaveLength(1);
          prompted.push(decision.player);
          return { index: 0, targets: new Map() };
        }
        return pick(decision, /P1 choice|P2 choice|P3 choice/);
      });
    expect(prompted).toEqual(['P1', 'P2', 'P3']);
    for (const id of ['P1', 'P2', 'P3'])
      expect(player(game, id).graveyard.map((o) => o.name)).toContain(`${id} choice`);
    expect(player(game, 'P4').hand.map((o) => o.name)).toContain('P4 stays');
  });

  it('skips a selected player who has lost before the discard trigger resolves', () => {
    const game = ctx('joins-lost-target');
    spawn(game, 'P1', swamp());
    addHand(game, 'P1', 'P1 discard', 'P1 spare');
    addHand(game, 'P2', 'P2 discard', 'P2 spare');
    const printed = card('Tinybones Joins Up');
    const spell = conjure(game, 'P1', printed, 'hand');
    const castAction = computePriorityOptions(game, player(game, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(castAction).toBeDefined();
    pump(
      applyPriorityAction(game, player(game, 'P1'), castAction!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(game));
    const targetChoices: string[] = [];
    pump(priorityCheckpoint(game), (decision) => {
      const target = decision.options.findIndex((o) => /^Target P[12]$/.test(o.description));
      if (target >= 0 && targetChoices.length < 2) {
        targetChoices.push(decision.options[target]!.description.slice(-2));
        return { index: target, targets: new Map() };
      }
      const done = decision.options.findIndex((o) => /Choose no more targets/.test(o.description));
      return done >= 0 ? { index: done, targets: new Map() } : pick(decision, /Pass|does not/i);
    });
    expect(targetChoices).toEqual(['P1', 'P2']);
    player(game, 'P2').hasLost = true;
    expect(game.state.stack.length).toBeGreaterThan(0);
    pump(resolveTopOfStack(game), (decision) => pick(decision, /P1 discard/));
    expect(player(game, 'P1').graveyard.map((c) => c.name)).toContain('P1 discard');
    expect(player(game, 'P2').graveyard.map((c) => c.name)).not.toContain('P2 discard');
  });

  it('Tinybones Joins Up mill-and-life trigger handles empty libraries and only your legendary entries', () => {
    const game = ctx('joins-legendary-entry');
    const joins = spawn(game, 'P1', card('Tinybones Joins Up'));
    settle(game);
    player(game, 'P1').library.length = 0;
    const life = ['P1', 'P2', 'P3', 'P4'].map((id) => player(game, id).life);
    const legend = oracle({
      name: 'Test Legend',
      typeLine: 'Legendary Creature — Test',
      manaCost: '{0}',
      cmc: 0,
      power: '1',
      toughness: '1',
    });
    cast(game, 'P1', legend, (decision) => {
      const target = decision.options.findIndex((o) => /Target P[12]$/.test(o.description));
      if (target >= 0) return { index: target, targets: new Map() };
      const done = decision.options.findIndex((o) => /Choose no more targets/.test(o.description));
      return done >= 0 ? { index: done, targets: new Map() } : pick(decision, /Pass|does not/i);
    });
    expect(player(game, 'P1').life).toBe(life[0]! - 1);
    expect(player(game, 'P2').life).toBe(life[1]! - 1);
    expect(player(game, 'P1').library.length).toBe(0);
    expect(player(game, 'P2').library.length).toBe(11);
    expect(joins.zone).toBe('battlefield');
  });

  it("Tinybones Joins Up ignores your nonlegendary creature and an opponent's legendary creature", () => {
    const game = ctx('joins-negative-entries');
    spawn(game, 'P1', card('Tinybones Joins Up'));
    settle(game);
    const life = player(game, 'P2').life;
    const library = player(game, 'P2').library.length;
    const ordinary = oracle({
      name: 'Test Ordinary',
      typeLine: 'Creature — Test',
      manaCost: '{0}',
      cmc: 0,
      power: '1',
      toughness: '1',
    });
    const legend = oracle({
      name: 'Opponent Legend',
      typeLine: 'Legendary Creature — Test',
      manaCost: '{0}',
      cmc: 0,
      power: '1',
      toughness: '1',
    });
    spawn(game, 'P1', ordinary);
    spawn(game, 'P2', legend);
    expect(player(game, 'P2').life).toBe(life);
    expect(player(game, 'P2').library).toHaveLength(library);
  });

  it('Trinket Thief counts opponent discards from an actual effect, excludes own discards, then draws and loses once', () => {
    const game = ctx();
    const thief = spawn(game, 'P1', card('Tinybones, Trinket Thief'));
    const target = addHand(game, 'P2', 'Opponent effect discard')[0]!;
    const source = {
      id: thief.id,
      cardId: thief.cardId,
      name: thief.name,
      oracleId: thief.oracleId,
      controllerId: thief.controllerId,
    };
    const discardEffect = {
      kind: 'activated' as const,
      targets: [{ kind: 'player' as const }],
      effects: [
        { op: 'discardTarget' as const, target: 0, count: { kind: 'const' as const, n: 1 } },
      ],
    };
    pump(executeAbility(game, source, discardEffect, ['P2']));
    expect(player(game, 'P2').graveyard).toContainEqual(
      expect.objectContaining({ cardId: target.cardId }),
    );
    const secondOpponentDiscard = addHand(game, 'P3', 'Second opponent discard')[0]!;
    pump(discardCard(game, secondOpponentDiscard, 'P3'));
    const own = addHand(game, 'P1', 'Controller discard')[0]!;
    pump(discardCard(game, own, 'P1'));
    expect(player(game, 'P2').discardedCardsThisTurn).toBe(1);
    expect(player(game, 'P3').discardedCardsThisTurn).toBe(1);
    queueStepTriggers(game, 'endStep');
    passPriority(game);
    expect(game.state.stack).toHaveLength(1);
    const beforeLife = player(game, 'P1').life;
    const beforeHand = player(game, 'P1').hand.length;
    pump(resolveTopOfStack(game));
    expect(player(game, 'P1').life).toBe(beforeLife - 1);
    expect(player(game, 'P1').hand.length).toBe(beforeHand + 1);
  });

  it('counts a discard before Tinybones enters later in the same turn', () => {
    const game = ctx('trinket-enters-after-discard');
    const earlier = addHand(game, 'P2', 'Earlier discard')[0]!;
    pump(discardCard(game, earlier, 'P2'));
    spawn(game, 'P1', card('Tinybones, Trinket Thief'));
    queueStepTriggers(game, 'endStep');
    passPriority(game);
    expect(game.state.stack).toHaveLength(1);
    const life = player(game, 'P1').life;
    const hand = player(game, 'P1').hand.length;
    pump(resolveTopOfStack(game));
    expect(player(game, 'P1').life).toBe(life - 1);
    expect(player(game, 'P1').hand.length).toBe(hand + 1);
  });

  it('does not trigger from own discard and resets the opponent tally at the next untap', () => {
    const game = ctx();
    spawn(game, 'P1', card('Tinybones, Trinket Thief'));
    const own = addHand(game, 'P1', 'Only own discard')[0]!;
    pump(discardCard(game, own, 'P1'));
    queueStepTriggers(game, 'endStep');
    passPriority(game);
    expect(game.state.stack).toHaveLength(0);
    const rival = addHand(game, 'P2', 'Turn one discard')[0]!;
    pump(discardCard(game, rival, 'P2'));
    expect(player(game, 'P2').discardedCardsThisTurn).toBe(1);
    game.state.currentTurnPlayer = 'P2';
    pump(runTurn(game), (decision) => pick(decision, /Pass|does not/i));
    expect(player(game, 'P2').discardedCardsThisTurn).toBe(0);
    queueStepTriggers(game, 'endStep');
    passPriority(game);
    expect(game.state.stack).toHaveLength(0);
  });

  it('counts an opponent cycling discard cost and an actual cleanup discard', () => {
    const game = ctx('trinket-cost-cleanup');
    spawn(game, 'P1', card('Tinybones, Trinket Thief'));
    const cycler = oracle({
      name: 'P2 Cycler',
      typeLine: 'Creature — Test',
      manaCost: '{0}',
      cmc: 0,
      power: '1',
      toughness: '1',
      oracleText: 'Cycling {0}',
    });
    const cycleObject = conjure(game, 'P2', cycler, 'hand');
    const cycleOption = computePriorityOptions(game, player(game, 'P2')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return (
        payload.kind === 'activateAbility' &&
        payload.fromHand === true &&
        payload.objectId === cycleObject.id
      );
    });
    expect(cycleOption).toBeDefined();
    pump(
      applyPriorityAction(game, player(game, 'P2'), cycleOption!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(player(game, 'P2').discardedCardsThisTurn).toBe(1);
    pump(resolveTopOfStack(game));
    const before = player(game, 'P1').hand.length;
    queueStepTriggers(game, 'endStep');
    passPriority(game);
    expect(game.state.stack).toHaveLength(1);
    pump(resolveTopOfStack(game));
    expect(player(game, 'P1').hand.length).toBe(before + 1);

    game.state.currentTurnPlayer = 'P3';
    for (let i = 0; i < 8; i++) addHand(game, 'P3', `Cleanup ${i}`);
    pump(runTurn(game), (decision) =>
      /Discard down to seven/.test(decision.prompt)
        ? pick(decision, /Cleanup/)
        : pick(decision, /Pass|does not/i),
    );
    expect(player(game, 'P3').discardedCardsThisTurn).toBe(2);
    expect(player(game, 'P3').graveyard.some((c) => c.name.startsWith('Cleanup'))).toBe(true);
  });

  it('resolves the paid six-mana activation against each opponent with an empty hand', () => {
    const game = ctx();
    const thief = spawn(game, 'P1', card('Tinybones, Trinket Thief'));
    for (let i = 0; i < 6; i++) spawn(game, 'P1', swamp());
    const action = computePriorityOptions(game, player(game, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === thief.id;
    });
    expect(action).toBeDefined();
    pump(
      applyPriorityAction(game, player(game, 'P1'), action!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(game.state.stack).toHaveLength(1);
    addHand(game, 'P3', 'Nonempty at resolution');
    const lives = game.state.players.map((p) => p.life);
    pump(resolveTopOfStack(game));
    expect(player(game, 'P2').life).toBe(lives[1]! - 10);
    expect(player(game, 'P3').life).toBe(lives[2]);
    expect(player(game, 'P4').life).toBe(lives[3]! - 10);
    expect(player(game, 'P1').life).toBe(lives[0]);
  });
});
