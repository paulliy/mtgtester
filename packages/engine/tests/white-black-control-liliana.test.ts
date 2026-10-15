import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlLilianaOverrides } from '../src/cards/overrides/white-black-control-liliana';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects } from '../src/effects/resolve';
import { moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { EnginePermanent, EnginePlayerState, GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { priorityCheckpoint } from '../src/sba/sba';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers } from '../src/turn/turn';
import { copies, conjure, gameConfig, oracle, pick, pump, spawn, swamp } from './fixtures';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8'),
) as { cards: PinnedCard[] };
const pins = {
  'Liliana of the Veil': 'a57605b3abdc39782904af4ac586395623fb6f9e387bf9dc7333be186bbc0f13',
  'Liliana, Waker of the Dead': '1843d5cf2f76658288cf48bd790bfda04a38ccfbfcaac07def9b12ca0fdd5f16',
} as const;
type CardName = keyof typeof pins;
const cards = new Map<CardName, PinnedCard>();
for (const [name, hash] of Object.entries(pins) as [CardName, string][]) {
  const found = fixture.cards.find((candidate) => candidate.card.name === name);
  if (found === undefined) throw new Error(`Missing pinned Oracle card: ${name}`);
  if (found.sha256 !== hash) throw new Error(`Oracle hash drift for ${name}`);
  cards.set(name, found);
}

beforeAll(() => registerWhiteBlackControlLilianaOverrides());

function card(name: CardName): OracleCard {
  const found = cards.get(name);
  if (found === undefined) throw new Error(`Missing pinned card ${name}`);
  return found.card;
}

function context(seed: string): GameContext {
  const game = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(16, swamp) })),
      { seed },
    ),
  );
  Object.assign(game.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return game;
}

function player(game: GameContext, id: string): EnginePlayerState {
  const found = game.state.players.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing player ${id}`);
  return found;
}

function addSwamps(game: GameContext, id: string, count: number): void {
  for (let index = 0; index < count; index++) spawn(game, id, swamp());
}

function castLiliana(game: GameContext, name: CardName): EnginePermanent {
  addSwamps(game, 'P1', name === 'Liliana of the Veil' ? 3 : 4);
  conjure(game, 'P1', card(name), 'hand');
  let cast = false;
  pump(runPrioritySequence(game), (decision) => {
    if (decision.decisionType === 'priority' && decision.player === 'P1' && !cast) {
      const index = decision.options.findIndex(
        (option) => option.type === 'castSpell' && option.description.includes(name),
      );
      if (index >= 0) {
        cast = true;
        return { index, targets: new Map() };
      }
    }
    return pick(decision, /Pass|does not/i);
  });
  expect(cast, `${name} cast from hand through normal priority`).toBe(true);
  const walker = game.state.battlefield.find((permanent) => permanent.name === name);
  if (walker === undefined) throw new Error(`${name} did not resolve as a permanent`);
  return walker;
}

function activateLoyalty(
  game: GameContext,
  walker: EnginePermanent,
  index: number,
  targets: ReadonlyMap<number, string> = new Map(),
  onDecision?: Parameters<typeof pump>[1],
): void {
  const controller = player(game, walker.controllerId);
  const action = computePriorityOptions(game, controller).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return (
      payload.kind === 'activateAbility' &&
      payload.objectId === walker.id &&
      payload.index === index
    );
  });
  expect(action, `${walker.name} loyalty ability ${index} is legally available`).toBeDefined();
  pump(
    applyPriorityAction(game, controller, action!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
    onDecision,
  );
  expect(game.state.stack).toHaveLength(1);
}

function resolveAbility(game: GameContext, answer?: Parameters<typeof pump>[1]): void {
  pump(resolveTopOfStack(game), answer);
}

function cardNamed(name: string, typeLine = 'Sorcery', manaCost: string | null = null): OracleCard {
  return oracle({
    name,
    typeLine: typeLine === 'Sorcery' ? 'Artifact' : typeLine,
    manaCost,
    cmc: 1,
    power: null,
    toughness: null,
  });
}

function creature(name: string, power = '2', toughness = '2'): OracleCard {
  return oracle({ name, typeLine: 'Creature — Bear', manaCost: null, cmc: 0, power, toughness });
}

describe('Liliana cards — pinned Oracle behavior through normal casts and loyalty activations', () => {
  it('pins both exact Oracle hashes and models all six printed loyalty abilities', () => {
    for (const name of Object.keys(pins) as CardName[]) {
      expect(cards.get(name)?.sha256).toBe(pins[name]);
      const definition = interpretCard(card(name));
      expect(definition.modeled, `${name}: ${definition.unmodeledReasons.join('; ')}`).toBe(true);
      expect(definition.unmodeledReasons).toEqual([]);
      expect(
        definition.activatedAbilities.filter((ability) =>
          ability.costs.some((cost) => cost.kind === 'loyalty'),
        ),
      ).toHaveLength(3);
    }
  });

  it('liliana-veil-c01 — normal cast, +1 pays loyalty on announcement, and blocks all other loyalty abilities this turn', () => {
    const game = context('liliana-veil-loyalty-limits');
    const walker = castLiliana(game, 'Liliana of the Veil');
    expect(walker.counters['loyalty']).toBe(3);
    const available = computePriorityOptions(game, player(game, 'P1')).filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === walker.id;
    });
    expect(available).toHaveLength(2); // At three loyalty, the -6 is not yet payable.

    activateLoyalty(game, walker, 0);
    expect(walker.counters['loyalty']).toBe(4); // Cost is paid before the discard resolves.
    resolveAbility(game, (decision) => pick(decision, /Pass|does not/i));
    expect(
      computePriorityOptions(game, player(game, 'P1')).some((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'activateAbility' && payload.objectId === walker.id;
      }),
    ).toBe(false);

    game.state.currentTurnPlayer = 'P2';
    game.state.activePlayerIndex = 1;
    expect(
      computePriorityOptions(game, player(game, 'P1')).some((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'activateAbility' && payload.objectId === walker.id;
      }),
    ).toBe(false);
  });

  it('liliana-veil-c02 — +1 has every player choose, including the controller', () => {
    const game = context('liliana-veil-each-discard');
    const walker = castLiliana(game, 'Liliana of the Veil');
    type CardRef = ReturnType<typeof conjure>;
    const cards = new Map<string, [CardRef, CardRef]>();
    for (const id of ['P1', 'P2', 'P3', 'P4']) {
      cards.set(id, [
        conjure(game, id, cardNamed(`${id} Discard A`), 'hand'),
        conjure(game, id, cardNamed(`${id} Discard B`), 'hand'),
      ]);
    }
    activateLoyalty(game, walker, 0);
    const order: string[] = [];
    resolveAbility(game, (decision) => {
      if (decision.decisionType === 'general' && decision.prompt.includes('Discard a card')) {
        order.push(decision.player);
        return pick(decision, `${decision.player} Discard A`);
      }
      return pick(decision, /Pass|does not/i);
    });
    expect(order).toEqual(['P1', 'P2', 'P3', 'P4']);
    for (const [id, [discarded, retained]] of cards) {
      expect(player(game, id).graveyard.some((entry) => entry.cardId === discarded.cardId)).toBe(
        true,
      );
      expect(player(game, id).hand.map((entry) => entry.cardId)).toEqual([retained.cardId]);
    }
    expect(walker.counters['loyalty']).toBe(4);
  });

  it('liliana-veil-c03 — -2 has the targeted player choose among creatures and ignores noncreatures', () => {
    const game = context('liliana-veil-sacrifice-creature');
    const walker = castLiliana(game, 'Liliana of the Veil');
    walker.counters['loyalty'] = 5;
    const first = spawn(game, 'P2', creature('First Target Creature'));
    const second = spawn(game, 'P2', creature('Second Target Creature'));
    const artifact = spawn(game, 'P2', cardNamed('Target Artifact', 'Artifact'));
    activateLoyalty(game, walker, 1, new Map([[0, 'P2']]));
    let chooser = '';
    resolveAbility(game, (decision) => {
      if (decision.prompt === 'Sacrifice a creature.') {
        chooser = decision.player;
        return pick(decision, 'Second Target Creature');
      }
      return pick(decision, /Pass|does not/i);
    });
    expect(chooser).toBe('P2');
    expect(player(game, 'P2').graveyard.some((entry) => entry.cardId === second.cardId)).toBe(true);
    expect(game.state.battlefield.some((permanent) => permanent.id === first.id)).toBe(true);
    expect(game.state.battlefield.some((permanent) => permanent.id === artifact.id)).toBe(true);

    const emptyTarget = context('liliana-veil-no-creature');
    const emptyWalker = castLiliana(emptyTarget, 'Liliana of the Veil');
    emptyWalker.counters['loyalty'] = 5;
    const noncreature = spawn(emptyTarget, 'P3', cardNamed('Only Artifact', 'Artifact'));
    activateLoyalty(emptyTarget, emptyWalker, 1, new Map([[0, 'P3']]));
    resolveAbility(emptyTarget);
    expect(game.state.battlefield.some((permanent) => permanent.id === noncreature.id)).toBe(true);
    expect(player(emptyTarget, 'P3').graveyard).toHaveLength(0);
  });

  it('liliana-veil-c04 — -6 partitions every target permanent, lets that player choose, and sacrifices one batch', () => {
    const game = context('liliana-veil-piles');
    const walker = castLiliana(game, 'Liliana of the Veil');
    walker.counters['loyalty'] = 6;
    const c1 = spawn(game, 'P2', creature('Pile Creature One'));
    const c2 = spawn(game, 'P2', creature('Pile Creature Two'));
    const artifact = spawn(game, 'P2', cardNamed('Pile Artifact', 'Artifact'));
    activateLoyalty(game, walker, 2, new Map([[0, 'P2']]));
    pump(priorityCheckpoint(game)); // Paying -6 leaves zero loyalty before its ability resolves.
    const putters: string[] = [];
    resolveAbility(game, (decision) => {
      if (decision.prompt.startsWith('Put ')) {
        putters.push(decision.prompt);
        return pick(
          decision,
          decision.prompt.includes('Pile Creature') ? 'Put it in pile 1' : 'Put it in pile 2',
        );
      }
      if (decision.prompt === 'Choose a pile of permanents to sacrifice.') {
        expect(decision.player).toBe('P2');
        return pick(decision, 'Sacrifice pile 1');
      }
      return pick(decision, /Pass|does not/i);
    });
    expect(putters).toHaveLength(3);
    expect(player(game, 'P2').graveyard.map((entry) => entry.cardId)).toEqual(
      expect.arrayContaining([c1.cardId, c2.cardId]),
    );
    expect(game.state.battlefield.some((permanent) => permanent.id === artifact.id)).toBe(true);
    expect(game.state.creaturesDiedThisTurn).toBe(2);
    expect(game.state.battlefield.some((permanent) => permanent.id === walker.id)).toBe(false);

    const empty = context('liliana-veil-empty-pile');
    const emptyWalker = castLiliana(empty, 'Liliana of the Veil');
    emptyWalker.counters['loyalty'] = 6;
    activateLoyalty(empty, emptyWalker, 2, new Map([[0, 'P3']]));
    pump(priorityCheckpoint(empty));
    let pileDecision = false;
    resolveAbility(empty, (decision) => {
      if (decision.prompt === 'Choose a pile of permanents to sacrifice.') {
        pileDecision = true;
        expect(decision.player).toBe('P3');
        return pick(decision, 'Sacrifice pile 2: empty');
      }
      return pick(decision, /Pass|does not/i);
    });
    expect(pileDecision).toBe(true);
    expect(empty.state.creaturesDiedThisTurn).toBe(0);
  });

  it('liliana-waker-c01 — +1 charges opponents who cannot discard, but never charges its controller', () => {
    const game = context('liliana-waker-plus-one');
    const walker = castLiliana(game, 'Liliana, Waker of the Dead');
    player(game, 'P1').life = 40;
    player(game, 'P2').life = 40;
    player(game, 'P3').life = 40;
    player(game, 'P4').life = 40;
    const p3Card = conjure(game, 'P3', cardNamed('P3 Discard A'), 'hand');
    conjure(game, 'P3', cardNamed('P3 Discard B'), 'hand');
    activateLoyalty(game, walker, 0);
    const choices: string[] = [];
    resolveAbility(game, (decision) => {
      if (decision.prompt.toLowerCase().includes('discard a card')) {
        choices.push(decision.player);
        return pick(decision, 'P3 Discard A');
      }
      return pick(decision, /Pass|does not/i);
    });
    expect(choices).toEqual(['P3']);
    expect(player(game, 'P1').life).toBe(40);
    expect(player(game, 'P2').life).toBe(37);
    expect(player(game, 'P3').life).toBe(40);
    expect(player(game, 'P4').life).toBe(37);
    expect(player(game, 'P3').graveyard.some((entry) => entry.cardId === p3Card.cardId)).toBe(true);
  });

  it('liliana-waker-c02 — -3 counts all own graveyard cards at resolution and expires at cleanup', () => {
    const game = context('liliana-waker-minus-three-resolution-value');
    const walker = castLiliana(game, 'Liliana, Waker of the Dead');
    const target = spawn(game, 'P3', creature('Six Toughness Creature', '6', '6'));
    conjure(game, 'P1', cardNamed('Own Graveyard Sorcery'), 'graveyard');
    conjure(game, 'P2', cardNamed('Opponent Graveyard Sorcery'), 'graveyard');
    walker.counters['loyalty'] = 7;
    activateLoyalty(game, walker, 1, new Map([[0, target.id]]));
    conjure(game, 'P1', creature('Added Noncreature-Type Graveyard Creature'), 'graveyard');
    conjure(game, 'P1', cardNamed('Another Own Graveyard Instant'), 'graveyard');
    resolveAbility(game);
    expect(computeCharacteristics(game, target).power).toBe(3);
    expect(computeCharacteristics(game, target).toughness).toBe(3);
    endUntilEotEffects(game);
    expect(computeCharacteristics(game, target).power).toBe(6);
    expect(computeCharacteristics(game, target).toughness).toBe(6);

    const opponentGraveyard = context('liliana-waker-minus-three-not-opponent-graveyard');
    const opponentWalker = castLiliana(opponentGraveyard, 'Liliana, Waker of the Dead');
    const untouched = spawn(opponentGraveyard, 'P3', creature('No Own Graveyard Value', '5', '5'));
    for (let index = 0; index < 7; index++)
      conjure(opponentGraveyard, 'P2', cardNamed(`P2 Card ${index}`), 'graveyard');
    activateLoyalty(opponentGraveyard, opponentWalker, 1, new Map([[0, untouched.id]]));
    resolveAbility(opponentGraveyard);
    expect(computeCharacteristics(opponentGraveyard, untouched).power).toBe(5);
    expect(computeCharacteristics(opponentGraveyard, untouched).toughness).toBe(5);
  });

  it('liliana-waker-c03 — -7 emblem triggers on its controller’s combat, reanimates a creature from any graveyard with haste, and outlives Liliana', () => {
    const game = context('liliana-waker-emblem');
    const walker = castLiliana(game, 'Liliana, Waker of the Dead');
    walker.counters['loyalty'] = 7;
    activateLoyalty(game, walker, 2);
    pump(priorityCheckpoint(game)); // State-based action removes the zero-loyalty source.
    resolveAbility(game);
    expect(player(game, 'P1').emblems).toHaveLength(1);
    expect(game.state.battlefield.some((permanent) => permanent.id === walker.id)).toBe(false);

    conjure(game, 'P2', cardNamed('Opponent Sorcery Only'), 'graveyard');
    game.state.currentTurnPlayer = 'P2';
    game.state.activePlayerIndex = 1;
    queueStepTriggers(game, 'beginningOfCombat');
    expect(game.state.pendingTriggers).toHaveLength(0);

    const creatureCard = conjure(game, 'P2', creature('Reanimation Target', '3', '3'), 'graveyard');
    game.state.currentTurnPlayer = 'P1';
    game.state.activePlayerIndex = 0;
    queueStepTriggers(game, 'beginningOfCombat');
    expect(game.state.pendingTriggers).toHaveLength(1);
    pump(priorityCheckpoint(game), (decision) => {
      if (decision.decisionType === 'chooseTargets') return pick(decision, 'Reanimation Target');
      return pick(decision, /Pass|does not/i);
    });
    expect(game.state.stack).toHaveLength(1);
    resolveAbility(game);
    const returned = game.state.battlefield.find(
      (permanent) => permanent.cardId === creatureCard.cardId,
    );
    expect(returned?.controllerId).toBe('P1');
    expect(computeCharacteristics(game, returned!).keywords).toContain('haste');
  });

  it('liliana-waker-c04 — emblem cannot target a noncreature and fizzles if its target leaves the graveyard', () => {
    const game = context('liliana-waker-emblem-targets');
    const walker = castLiliana(game, 'Liliana, Waker of the Dead');
    walker.counters['loyalty'] = 7;
    activateLoyalty(game, walker, 2);
    pump(priorityCheckpoint(game));
    resolveAbility(game);

    const onlySpell = conjure(game, 'P2', cardNamed('Only Graveyard Sorcery'), 'graveyard');
    queueStepTriggers(game, 'beginningOfCombat');
    pump(priorityCheckpoint(game));
    expect(game.state.stack).toHaveLength(0);
    expect(player(game, 'P2').graveyard.some((entry) => entry.cardId === onlySpell.cardId)).toBe(
      true,
    );

    const target = conjure(game, 'P3', creature('Leaves Before Resolution'), 'graveyard');
    queueStepTriggers(game, 'beginningOfCombat');
    pump(priorityCheckpoint(game), (decision) =>
      decision.decisionType === 'chooseTargets'
        ? pick(decision, 'Leaves Before Resolution')
        : pick(decision, /Pass|does not/i),
    );
    expect(game.state.stack).toHaveLength(1);
    pump(moveObject(game, target, { zone: 'exile' }));
    resolveAbility(game);
    expect(game.state.battlefield.some((permanent) => permanent.cardId === target.cardId)).toBe(
      false,
    );
    expect(game.state.exile.some((entry) => entry.cardId === target.cardId)).toBe(true);
  });
});
