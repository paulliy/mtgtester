import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlEntryOverrides } from '../src/cards/overrides/white-black-control-entry';
import { registerWhiteBlackControlGraveyardOverrides } from '../src/cards/overrides/white-black-control-graveyard';
import { registerWhiteBlackControlGraveyardTriggerOverrides } from '../src/cards/overrides/white-black-control-graveyard-triggers';
import { registerWhiteBlackControlGiftOverrides } from '../src/cards/overrides/white-black-control-gifts';
import { registerWhiteBlackControlCurseOverrides } from '../src/cards/overrides/white-black-control-curse';
import { registerWhiteBlackControlPerchOverrides } from '../src/cards/overrides/white-black-control-perch';
import { registerWhiteBlackControlPromiseOverrides } from '../src/cards/overrides/white-black-control-promise';
import { addMana } from '../src/mana/pool';
import { discardCard, moveObject, movePermanentsTogether } from '../src/state/objects';
import { phaseInAtUntap, phaseOutControlledPermanents } from '../src/state/phasing';
import { createGame } from '../src/state/game';
import type { EnginePermanent, EngineStackObject, GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { runCombatPhase } from '../src/combat/combat';
import { runPrioritySequence } from '../src/turn/priority';
import { priorityCheckpoint } from '../src/sba/sba';
import { executeAbility } from '../src/effects/resolve';
import { spell } from '../src/cards/templates';
import {
  declareAttacks,
  copies,
  conjure,
  gameConfig,
  oracle,
  pick,
  pump,
  spawn,
  swamp,
} from './fixtures';

interface Pinned {
  sha256: string;
  card: OracleCard;
}
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8'),
) as { cards: Pinned[] };
const pins = {
  Hushbringer: 'cb7031304a5cf6ff57f97f9590d97b3d91c0a66a4ac15937926bb0a4810837a5',
  'Planar Void': '146d72b8e678921fad84434578e02fd647a18c6cf2733a55c2df2d45080cf066',
  'The Haunt of Hightower': '85b6c7f3a24a701a82b107aa6b27a0a07cc0796d83f3dcc13d7bedfbd6870e31',
  "Dawn's Truce": '9b94a7f24557052e39ba56e4a491a924a83f664f8eea7d2f37ff14dcd488877b',
  'Perch Protection': 'e9adf2313e4738116e684727c9ebc9efc4d3a1e85ee65f91f9040d618252c80d',
  'Curse of Disturbance': '6106530fb8f86fed0553091e4eebc4238155e5193826f14fb676361b473dd717',
  'Promise of Loyalty': '2c168d95b98fc29bee9fb1d7a562d50070400c32fe9b4476196eb820d301b472',
} as const;
type Name = keyof typeof pins;
const cards = new Map<Name, Pinned>(
  Object.keys(pins).map((name) => {
    const entry = fixture.cards.find((item) => item.card.name === name);
    if (!entry) throw new Error(`Missing pinned card ${name}`);
    if (entry.sha256 !== pins[name as Name]) throw new Error(`Oracle hash drift: ${name}`);
    return [name as Name, entry];
  }),
);
beforeAll(() => {
  registerWhiteBlackControlEntryOverrides();
  registerWhiteBlackControlGraveyardOverrides();
  registerWhiteBlackControlGraveyardTriggerOverrides();
  registerWhiteBlackControlGiftOverrides();
  registerWhiteBlackControlCurseOverrides();
  registerWhiteBlackControlPerchOverrides();
  registerWhiteBlackControlPromiseOverrides();
});

function ctx(seed: string): GameContext {
  const game = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(20, swamp) })),
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
function player(game: GameContext, id: string) {
  return game.state.players.find((p) => p.id === id)!;
}
function pinned(name: Name): OracleCard {
  const definition = interpretCard(cards.get(name)!.card);
  expect(definition.modeled, `${name}: ${definition.unmodeledReasons.join('; ')}`).toBe(true);
  expect(definition.unmodeledReasons).toEqual([]);
  return cards.get(name)!.card;
}
function cast(
  game: GameContext,
  seat: string,
  name: Name,
  options: { target?: string; gift?: string } = {},
): EngineStackObject {
  const printed = pinned(name);
  const object = conjure(game, seat, printed, 'hand');
  addMana(player(game, seat), [
    ...Array.from({ length: 8 }, () => ({ symbol: 'W' as const })),
    ...Array.from({ length: 8 }, () => ({ symbol: 'B' as const })),
    ...Array.from({ length: 8 }, () => ({ symbol: 'C' as const })),
  ]);
  const action = computePriorityOptions(game, player(game, seat)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  });
  expect(action, `normal cast offered for ${name}`).toBeDefined();
  const targets = new Map<number, string>();
  if (options.target !== undefined) targets.set(0, options.target);
  pump(
    applyPriorityAction(game, player(game, seat), action!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
    (decision) => {
      if (decision.prompt.startsWith('Promise an opponent a gift')) {
        const chosen =
          options.gift === undefined
            ? 0
            : decision.options.findIndex((o) =>
                o.description.includes(`Promise ${options.gift} a gift`),
              );
        expect(chosen).toBeGreaterThanOrEqual(0);
        return { index: chosen, targets: new Map() };
      }
      return pick(decision, /Pass|does not/i);
    },
  );
  return game.state.stack.find((spell) => spell.sourceCardId === object.cardId)!;
}
function resolve(game: GameContext, spell: EngineStackObject): void {
  pump(resolveTopOfStack(game), (decision) => {
    if (decision.prompt === 'Choose a creature to keep and put a vow counter on.')
      return { index: 0, targets: new Map() };
    return pick(decision, /Pass|does not/i);
  });
  expect(game.state.stack).not.toContain(spell);
  pump(priorityCheckpoint(game));
}
function witness(name: string, typeLine: string, manaCost = '{0}'): OracleCard {
  return oracle({
    name,
    typeLine,
    manaCost,
    cmc: 0,
    power: typeLine.includes('Creature') ? '2' : null,
    toughness: typeLine.includes('Creature') ? '2' : null,
  });
}
function attackDefenders(game: GameContext, seat: string, attacker: EnginePermanent): string[] {
  const index = game.state.players.findIndex((p) => p.id === seat);
  game.state.currentTurnPlayer = seat;
  game.state.activePlayerIndex = index;
  game.state.phase = 'combat';
  let defenders: string[] = [];
  pump(runCombatPhase(game), (decision) => {
    if (decision.decisionType === 'declareAttackers') {
      if (decision.player === seat) {
        const subject = decision.presentationAttackDeclaration?.subjects.find(
          (s) => s.subjectId === attacker.id,
        );
        defenders = [
          ...(subject?.defenders.map((d) => d.playerId) ?? []),
          ...(subject?.planeswalkers.map((p) => p.objectId) ?? []),
        ];
      }
      return declareAttacks(decision, () => null);
    }
    return pick(decision, /Pass|does not/i);
  });
  return defenders;
}

describe('white-black control review regressions', () => {
  it('Hushbringer suppresses creature-death graveyard watchers but not artifact death or hand discard', () => {
    const game = ctx('hush-graveyard-event-filter');
    const hush = cast(game, 'P1', 'Hushbringer');
    resolve(game, hush);
    const planar = cast(game, 'P1', 'Planar Void');
    resolve(game, planar);
    const hauntSpell = cast(game, 'P1', 'The Haunt of Hightower');
    resolve(game, hauntSpell);
    const haunt = game.state.battlefield.find(
      (permanent) => permanent.name === 'The Haunt of Hightower',
    )!;

    const artifact = spawn(game, 'P2', witness('Dies Artifact', 'Artifact'));
    pump(moveObject(game, artifact, { zone: 'graveyard' }));
    expect(game.state.pendingTriggers).toHaveLength(2);
    while (game.state.pendingTriggers.length) pump(runPrioritySequence(game));
    while (game.state.stack.length) pump(resolveTopOfStack(game));
    expect(game.state.exile.some((card) => card.cardId === artifact.cardId)).toBe(true);
    expect(haunt.counters['+1/+1']).toBe(1);

    const discard = conjure(game, 'P2', witness('Discard Creature', 'Creature — Bear'), 'hand');
    pump(discardCard(game, discard, 'P2'));
    expect(game.state.pendingTriggers).toHaveLength(2);
    while (game.state.pendingTriggers.length) pump(runPrioritySequence(game));
    while (game.state.stack.length) pump(resolveTopOfStack(game));
    const death = spawn(game, 'P2', witness('Creature Dies Under Hush', 'Creature — Bear'));
    pump(moveObject(game, death, { zone: 'graveyard' }));
    expect(game.state.pendingTriggers).toHaveLength(0);
    expect(player(game, 'P2').graveyard.some((card) => card.cardId === death.cardId)).toBe(true);
  });

  it('a simultaneous Hushbringer departure uses post-event presence for graveyard-entry triggers', () => {
    const game = ctx('hush-and-creature-leave-together');
    const hushSpell = cast(game, 'P1', 'Hushbringer');
    resolve(game, hushSpell);
    const hush = game.state.battlefield.find((permanent) => permanent.name === 'Hushbringer')!;
    const planar = cast(game, 'P1', 'Planar Void');
    resolve(game, planar);
    const hauntSpell = cast(game, 'P1', 'The Haunt of Hightower');
    resolve(game, hauntSpell);
    const haunt = game.state.battlefield.find(
      (permanent) => permanent.name === 'The Haunt of Hightower',
    )!;
    const victim = spawn(game, 'P2', witness('Simultaneous Death', 'Creature — Bear'));
    pump(movePermanentsTogether(game, [hush, victim], { zone: 'graveyard' }));
    expect(game.state.pendingTriggers).toHaveLength(3);
    while (game.state.pendingTriggers.length) pump(runPrioritySequence(game));
    while (game.state.stack.length) pump(resolveTopOfStack(game));
    expect(
      game.state.exile.filter((card) => [hush.cardId, victim.cardId].includes(card.cardId)),
    ).toHaveLength(2);
    expect(haunt.counters['+1/+1']).toBe(1);
  });

  it('Dawn hexproof leaves an existing opponent Curse attached, while Perch protection removes it', () => {
    const dawnGame = ctx('dawn-existing-curse');
    dawnGame.state.currentTurnPlayer = 'P2';
    dawnGame.state.activePlayerIndex = 1;
    const dawnCurse = cast(dawnGame, 'P2', 'Curse of Disturbance', { target: 'P1' });
    resolve(dawnGame, dawnCurse);
    const dawnAura = dawnGame.state.battlefield.find((p) => p.name === 'Curse of Disturbance')!;
    dawnGame.state.currentTurnPlayer = 'P1';
    dawnGame.state.activePlayerIndex = 0;
    dawnGame.state.phase = 'precombatMain';
    const truce = cast(dawnGame, 'P1', "Dawn's Truce", { gift: 'P2' });
    resolve(dawnGame, truce);
    expect(dawnAura.attachedTo).toBe('P1');
    expect(dawnGame.state.battlefield).toContain(dawnAura);

    const perchGame = ctx('perch-existing-curse');
    perchGame.state.currentTurnPlayer = 'P2';
    perchGame.state.activePlayerIndex = 1;
    const perchCurse = cast(perchGame, 'P2', 'Curse of Disturbance', { target: 'P1' });
    resolve(perchGame, perchCurse);
    const auraCardId = perchGame.state.battlefield.find(
      (p) => p.name === 'Curse of Disturbance',
    )!.cardId;
    perchGame.state.currentTurnPlayer = 'P1';
    perchGame.state.activePlayerIndex = 0;
    perchGame.state.phase = 'precombatMain';
    const perch = cast(perchGame, 'P1', 'Perch Protection', { gift: 'P2' });
    resolve(perchGame, perch);
    expect(perchGame.state.battlefield.some((p) => p.cardId === auraCardId)).toBe(false);
    expect(player(perchGame, 'P2').graveyard.some((card) => card.cardId === auraCardId)).toBe(true);
  });

  it('Promise of Loyalty restriction ends permanently at zero vow counters and at phasing', () => {
    const game = ctx('promise-vow-counter-phase');
    const p1Keeper = spawn(game, 'P1', witness('P1 Keeper', 'Creature — Bear'));
    const p2Vowed = spawn(game, 'P2', witness('P2 Vowed', 'Creature — Bear'));
    const promise = cast(game, 'P1', 'Promise of Loyalty');
    resolve(game, promise);
    expect(p1Keeper.counters['vow']).toBe(1);
    expect(p2Vowed.counters['vow']).toBe(1);
    expect(attackDefenders(game, 'P2', p2Vowed)).not.toContain('P1');
    const source = {
      cardId: p1Keeper.cardId,
      oracleId: p1Keeper.oracleId,
      name: p1Keeper.name,
      controllerId: 'P1',
    };
    pump(
      executeAbility(
        game,
        source,
        spell({
          targets: [{ kind: 'permanent' }],
          effects: [{ op: 'removeCounters', target: 0, counter: 'vow', count: 1 }],
        }),
        [p2Vowed.id],
      ),
    );
    expect(attackDefenders(game, 'P2', p2Vowed)).toContain('P1');
    pump(
      executeAbility(
        game,
        source,
        spell({
          targets: [{ kind: 'permanent' }],
          effects: [{ op: 'putCounters', target: 0, counter: 'vow', count: 1 }],
        }),
        [p2Vowed.id],
      ),
    );
    expect(attackDefenders(game, 'P2', p2Vowed)).toContain('P1');
    game.state.currentTurnPlayer = 'P1';
    game.state.activePlayerIndex = 0;
    game.state.phase = 'precombatMain';
    const repeatedPromise = cast(game, 'P1', 'Promise of Loyalty');
    resolve(game, repeatedPromise);
    expect(attackDefenders(game, 'P2', p2Vowed)).not.toContain('P1');
    // CR 702.26f: the "for as long as" duration ends at phasing out, though the counter stays.
    phaseOutControlledPermanents(game, 'P2');
    phaseInAtUntap(game, 'P2');
    expect(attackDefenders(game, 'P2', p2Vowed)).toContain('P1');
  });
});
