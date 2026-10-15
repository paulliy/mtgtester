import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlCurseOverrides } from '../src/cards/overrides/white-black-control-curse';
import { registerWhiteBlackControlPromiseOverrides } from '../src/cards/overrides/white-black-control-promise';
import { runCombatPhase } from '../src/combat/combat';
import { computeCharacteristics } from '../src/effects/continuous';
import { changeController, moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import {
  conjure,
  copies,
  declareAttacks,
  forest,
  gameConfig,
  oracle,
  pick,
  pump,
  spawn,
  plains,
  swamp,
} from './fixtures';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8'),
) as { cards: PinnedCard[] };
const pins = {
  'Curse of Disturbance': '6106530fb8f86fed0553091e4eebc4238155e5193826f14fb676361b473dd717',
  'Promise of Loyalty': '2c168d95b98fc29bee9fb1d7a562d50070400c32fe9b4476196eb820d301b472',
} as const;
type CardName = keyof typeof pins;
const pinned = new Map<CardName, PinnedCard>();
for (const [name, hash] of Object.entries(pins) as [CardName, string][]) {
  const found = fixture.cards.find((entry) => entry.card.name === name);
  if (found === undefined) throw new Error(`Missing pinned Oracle card ${name}`);
  if (found.sha256 !== hash) throw new Error(`Oracle hash drift for ${name}`);
  pinned.set(name, found);
}
beforeAll(() => {
  registerWhiteBlackControlCurseOverrides();
  registerWhiteBlackControlPromiseOverrides();
});

function card(name: CardName): OracleCard {
  const found = pinned.get(name);
  if (found === undefined) throw new Error(`Missing pinned card ${name}`);
  return found.card;
}

function context(seed: string): GameContext {
  const game = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(12, forest) })),
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

function cast(
  game: GameContext,
  name: CardName,
  targetPlayer?: string,
  answer?: Parameters<typeof pump>[1],
): void {
  const cost = name === 'Promise of Loyalty' ? 5 : 3;
  for (let index = 0; index < cost - (name === 'Curse of Disturbance' ? 1 : 0); index++)
    spawn(game, 'P1', plains());
  if (name === 'Curse of Disturbance') spawn(game, 'P1', swamp());
  conjure(game, 'P1', card(name), 'hand');
  let casted = false;
  pump(runPrioritySequence(game), (decision, count) => {
    if (decision.decisionType === 'priority' && decision.player === 'P1' && !casted) {
      const index = decision.options.findIndex(
        (option) => option.type === 'castSpell' && option.description.includes(name),
      );
      if (index >= 0) {
        casted = true;
        return {
          index,
          targets: targetPlayer === undefined ? new Map() : new Map([[0, targetPlayer]]),
        };
      }
    }
    return answer?.(decision, count) ?? pick(decision, /Pass|does not/i);
  });
  expect(casted, `${name} cast from hand via priority`).toBe(true);
}

function zombieTokens(game: GameContext, controllerId?: string): EnginePermanent[] {
  return game.state.battlefield.filter(
    (permanent) =>
      permanent.isToken &&
      permanent.name.toLowerCase().includes('zombie') &&
      (controllerId === undefined || permanent.controllerId === controllerId),
  );
}

function creature(name: string, keywords: string[] = []): OracleCard {
  return oracle({
    name,
    typeLine: 'Creature — Soldier',
    manaCost: '{1}{W}',
    power: '2',
    toughness: '2',
    keywords,
  });
}

function runAttackers(
  game: GameContext,
  activePlayer: string,
  assignment: (subject: { subjectId: string; name: string }) => string | null,
  callback?: Parameters<typeof pump>[1],
): void {
  const playerIndex = game.state.players.findIndex((player) => player.id === activePlayer);
  game.state.currentTurnPlayer = activePlayer;
  game.state.activePlayerIndex = playerIndex;
  game.state.phase = 'combat';
  pump(runCombatPhase(game), (decision) => {
    if (decision.decisionType === 'declareAttackers') {
      const custom = callback?.(decision, 1);
      if (custom !== undefined) return custom;
      return declareAttacks(decision, (_id, subject) => assignment(subject));
    }
    return callback?.(decision, 1) ?? pick(decision, /Pass|does not/i);
  });
}

describe('Curse of Disturbance and Promise of Loyalty — pinned Oracle rules paths', () => {
  it('pins exact Oracle text and models both cards after local override registration', () => {
    for (const name of Object.keys(pins) as CardName[]) {
      expect(pinned.get(name)?.sha256).toBe(pins[name]);
      const definition = interpretCard(card(name));
      expect(definition.modeled, `${name}: ${definition.unmodeledReasons.join('; ')}`).toBe(true);
      expect(definition.unmodeledReasons).toEqual([]);
    }
  });

  it('curse-disturbance-c01 — normal enchant-player cast and multiple attackers create one Zombie for the controller and each attacking opponent', () => {
    const game = context('curse-many-attackers');
    cast(game, 'Curse of Disturbance', 'P2');
    const aura = game.state.battlefield.find(
      (permanent) => permanent.name === 'Curse of Disturbance',
    )!;
    expect(aura.attachedTo).toBe('P2');
    const attackers = [
      spawn(game, 'P3', creature('Attacker A')),
      spawn(game, 'P3', creature('Attacker B')),
    ];
    runAttackers(game, 'P3', (subject) =>
      attackers.some((permanent) => permanent.name === subject.name) ? 'P2' : null,
    );
    expect(zombieTokens(game, 'P1')).toHaveLength(1);
    expect(zombieTokens(game, 'P3')).toHaveLength(1);
    expect(zombieTokens(game)).toHaveLength(2);
  });

  it('curse-disturbance-c01 — the curse controller attacking enchanted player gets only the controller Zombie', () => {
    const game = context('curse-controller-attacks');
    cast(game, 'Curse of Disturbance', 'P2');
    const attackers = [
      spawn(game, 'P1', creature('Controller Attacker A')),
      spawn(game, 'P1', creature('Controller Attacker B')),
    ];
    runAttackers(game, 'P1', (subject) =>
      attackers.some((permanent) => permanent.name === subject.name) ? 'P2' : null,
    );
    expect(zombieTokens(game, 'P1')).toHaveLength(1);
    expect(zombieTokens(game, 'P2')).toHaveLength(0);
    expect(zombieTokens(game)).toHaveLength(1);
  });

  it('curse-disturbance-c01 — attacks on another player or the enchanted player’s planeswalker do not trigger it', () => {
    const game = context('curse-other-defenders');
    cast(game, 'Curse of Disturbance', 'P2');
    const walker = spawn(
      game,
      'P2',
      oracle({ name: 'P2 Walker', typeLine: 'Planeswalker', loyalty: '4' }),
    );
    const toPlayer = spawn(game, 'P1', creature('Attacks P3'));
    const toWalker = spawn(game, 'P1', creature('Attacks P2 Walker'));
    runAttackers(game, 'P1', (subject) =>
      subject.name === toPlayer.name ? 'P3' : subject.name === toWalker.name ? walker.id : null,
    );
    expect(zombieTokens(game)).toHaveLength(0);
  });

  it('curse-disturbance-c02 — the attack trigger resolves after its aura source leaves', () => {
    const game = context('curse-source-leaves');
    cast(game, 'Curse of Disturbance', 'P2');
    const aura = game.state.battlefield.find(
      (permanent) => permanent.name === 'Curse of Disturbance',
    )!;
    const attacker = spawn(game, 'P3', creature('Trigger Attacker'));
    game.state.currentTurnPlayer = 'P3';
    game.state.activePlayerIndex = 2;
    game.state.phase = 'combat';
    const combat = runCombatPhase(game);
    let outcome: { index: number; targets: ReadonlyMap<number, string> } | undefined;
    let first = true;
    let attackersDeclared = false;
    let auraRemoved = false;
    for (;;) {
      const step = first ? combat.next() : combat.next(outcome!);
      first = false;
      if (step.done) break;
      const decision = step.value;
      if (decision.decisionType === 'declareAttackers') {
        attackersDeclared = true;
        outcome = declareAttacks(decision, (_id, subject) =>
          subject.name === attacker.name ? 'P2' : null,
        );
        continue;
      }
      if (!auraRemoved && attackersDeclared && decision.decisionType === 'priority') {
        auraRemoved = true;
        pump(moveObject(game, aura, { zone: 'graveyard' }));
      }
      outcome = { index: 0, targets: new Map() };
    }
    expect(auraRemoved).toBe(true);
    expect(game.state.battlefield.some((permanent) => permanent.id === aura.id)).toBe(false);
    expect(zombieTokens(game, 'P1')).toHaveLength(1);
    expect(zombieTokens(game, 'P3')).toHaveLength(1);
  });

  it('promise-loyalty-c01 — normal cast gets APNAP choices from every creature player before counters or sacrifices change the board', () => {
    const game = context('promise-apnap-choices');
    const perPlayer = new Map<string, EnginePermanent[]>();
    for (const id of ['P1', 'P2', 'P4']) {
      perPlayer.set(id, [
        spawn(game, id, creature(`${id} Keeper`)),
        spawn(game, id, creature(`${id} Other`)),
      ]);
    }
    const indestructible = spawn(game, 'P2', creature('P2 Indestructible', ['indestructible']));
    const artifact = spawn(
      game,
      'P3',
      oracle({
        name: 'P3 Noncreature',
        typeLine: 'Artifact',
        manaCost: '{1}',
        power: null,
        toughness: null,
      }),
    );
    const selected = new Map([...perPlayer].map(([id, permanents]) => [id, permanents[0]!]));
    const order: string[] = [];
    const battlefieldAtChoices: string[][] = [];
    cast(game, 'Promise of Loyalty', undefined, (decision) => {
      if (decision.prompt === 'Choose a creature to keep and put a vow counter on.') {
        order.push(decision.player);
        battlefieldAtChoices.push(
          game.state.battlefield
            .filter((permanent) =>
              computeCharacteristics(game, permanent).types.includes('Creature'),
            )
            .map((permanent) => permanent.id),
        );
        return pick(decision, `${decision.player} Keeper`);
      }
      return pick(decision, /Pass|does not/i);
    });
    expect(order).toEqual(['P1', 'P2', 'P4']);
    expect(battlefieldAtChoices).toHaveLength(3);
    expect(battlefieldAtChoices.every((ids) => ids.includes(indestructible.id))).toBe(true);
    for (const [id, permanents] of perPlayer) {
      expect(permanents[0]!.counters['vow']).toBe(1);
      expect(permanents[1]!.ownerId).toBe(id);
      expect(game.state.battlefield.some((permanent) => permanent.id === permanents[1]!.id)).toBe(
        false,
      );
    }
    expect(game.state.battlefield.some((permanent) => permanent.id === indestructible.id)).toBe(
      false,
    );
    expect(game.state.battlefield).toContain(artifact);
    expect(game.state.creaturesDiedThisTurn).toBe(4);
    expect(selected.size).toBe(3);
  });

  it('promise-loyalty-c02 — vow creature attack restriction excludes caster and their planeswalker but allows another opponent', () => {
    const game = context('promise-attack-restrictions');
    const p2CreatureCard = creature('P2 Vowed Creature');
    const p2Creature = spawn(game, 'P2', p2CreatureCard);
    const casterWalker = spawn(
      game,
      'P1',
      oracle({ name: 'Caster Walker', typeLine: 'Planeswalker', loyalty: '4' }),
    );
    cast(game, 'Promise of Loyalty');
    expect(p2Creature.counters['vow']).toBe(1);
    const defenders = attackOptions(game, 'P2', p2Creature);
    expect(defenders).not.toContain('P1');
    expect(defenders).not.toContain(casterWalker.id);
    expect(defenders).toContain('P3');
  });

  it('promise-loyalty-c02 — restriction follows a control change, ends with vow counter removal, and does not transfer to a blinked object', () => {
    const controlled = context('promise-control-changed');
    const controlledCreature = spawn(controlled, 'P2', creature('Control Changed Vow'));
    const walker = spawn(
      controlled,
      'P1',
      oracle({ name: 'Protected Walker', typeLine: 'Planeswalker', loyalty: '4' }),
    );
    cast(controlled, 'Promise of Loyalty');
    changePermanentController(controlled, controlledCreature, 'P3');
    // The control-changing event makes a creature summoning sick; clear that independent
    // combat limitation so this menu isolates the persistent vow restriction.
    controlledCreature.summoningSick = false;
    const restricted = attackOptions(controlled, 'P3', controlledCreature);
    expect(restricted).not.toContain('P1');
    expect(restricted).not.toContain(walker.id);
    expect(restricted).toContain('P2');

    const removed = context('promise-counter-removed');
    const removedCreature = spawn(removed, 'P2', creature('Removed Vow'));
    const removedWalker = spawn(
      removed,
      'P1',
      oracle({ name: 'Removed Walker', typeLine: 'Planeswalker', loyalty: '4' }),
    );
    cast(removed, 'Promise of Loyalty');
    delete removedCreature.counters['vow'];
    const unrestricted = attackOptions(removed, 'P2', removedCreature);
    expect(unrestricted).toContain('P1');
    expect(unrestricted).toContain(removedWalker.id);

    const blinked = context('promise-blinked-new-object');
    const original = spawn(blinked, 'P2', creature('Blinked Vow'));
    cast(blinked, 'Promise of Loyalty');
    pump(moveObject(blinked, original, { zone: 'hand' }));
    const newObject = spawn(blinked, 'P2', p2CreatureOracle('Blinked Vow'));
    expect(newObject.id).not.toBe(original.id);
    expect(newObject.counters['vow'] ?? 0).toBe(0);
    expect(attackOptions(blinked, 'P2', newObject)).toContain('P1');
  });
});

function attackOptions(
  game: GameContext,
  activePlayer: string,
  attacker: EnginePermanent,
): string[] {
  let offered: string[] = [];
  runAttackers(
    game,
    activePlayer,
    () => null,
    (decision) => {
      if (decision.decisionType === 'declareAttackers' && decision.player === activePlayer) {
        const subject = decision.presentationAttackDeclaration?.subjects.find(
          (entry) => entry.subjectId === attacker.id,
        );
        offered = [
          ...(subject?.defenders.map((defender) => defender.playerId) ?? []),
          ...(subject?.planeswalkers.map((planeswalker) => planeswalker.objectId) ?? []),
        ];
        return declareAttacks(decision, () => null);
      }
      return decision.decisionType === 'declareAttackers'
        ? declareAttacks(decision, () => null)
        : pick(decision, /Pass|does not/i);
    },
  );
  return offered;
}

function changePermanentController(
  game: GameContext,
  permanent: EnginePermanent,
  controllerId: string,
): void {
  changeController(game, permanent, controllerId);
}

function p2CreatureOracle(name: string): OracleCard {
  return creature(name);
}
