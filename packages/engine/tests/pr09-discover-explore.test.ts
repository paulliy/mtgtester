import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { addMana } from '../src/mana/pool';
import { moveObject, playerById } from '../src/state/objects';
import { createGame } from '../src/state/game';
import { queueStepTriggers } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import type { EnginePermanent, GameContext } from '../src/state/types';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const pins = (
  JSON.parse(
    readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
  ) as { cards: { sha256: string; card: OracleCard }[] }
).cards;
function pinned(name: string): OracleCard {
  const e = pins.find((x) => x.card.name === name);
  if (!e) throw new Error(`Missing pin ${name}`);
  expect(createHash('sha256').update(JSON.stringify(e.card)).digest('hex')).toBe(e.sha256);
  return e.card;
}
const FRANKLIN = pinned('Franklin Richards, Ascendant'),
  VORTEX = pinned('Monstrous Vortex'),
  CHIMIL = pinned('Chimil, the Inner Sun'),
  CARNOSAUR = pinned('Trumpeting Carnosaur'),
  PATH = pinned('Path of Discovery'),
  PREDATORS = pinned('Lurking Predators');
function pod(seed: string): GameContext {
  const c = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  Object.assign(c.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  for (const p of c.state.players) p.hand = [];
  return c;
}
const pass = (d: PendingDecision): DecisionOutcome => ({
  index: Math.max(
    0,
    d.options.findIndex(
      (o) =>
        o.type === 'pass' ||
        (o.payload as Partial<PriorityActionPayload> | undefined)?.kind === 'pass',
    ),
  ),
  targets: new Map(),
});
const choose = (d: PendingDecision, re: RegExp): DecisionOutcome => {
  const i = d.options.findIndex((o) => re.test(o.description));
  if (i < 0) throw new Error(`No ${re} in ${d.options.map((o) => o.description).join(' | ')}`);
  return { index: i, targets: new Map() };
};
const decline = (d: PendingDecision): DecisionOutcome => {
  const i = d.options.findIndex((o) => o.type === 'decline' || o.type === 'keepTop');
  return { index: Math.max(i, 0), targets: new Map() };
};
function settle(c: GameContext, answer: (d: PendingDecision) => DecisionOutcome = pass) {
  return pump(runPrioritySequence(c), (d) => {
    if (d.decisionType === 'priority') return pass(d);
    // Every trigger in this file is mandatory: no "use this ability?" question is ever asked.
    expect(d.decisionType).not.toBe('optionalTrigger');
    return answer(d);
  });
}
function cast(
  c: GameContext,
  card: OracleCard,
  mana: ('C' | 'G' | 'R' | 'W' | 'U' | 'B')[],
  answer: (d: PendingDecision) => DecisionOutcome = pass,
): EnginePermanent {
  return castBy(c, 'P1', card, mana, answer);
}
function castBy(
  c: GameContext,
  who: string,
  card: OracleCard,
  mana: ('C' | 'G' | 'R' | 'W' | 'U' | 'B')[],
  answer: (d: PendingDecision) => DecisionOutcome = pass,
): EnginePermanent {
  const o = conjure(c, who, card, 'hand');
  addMana(
    playerById(c, who),
    mana.map((symbol) => ({ symbol })),
  );
  const a = computePriorityOptions(c, playerById(c, who)).find(
    (x) =>
      (x.payload as PriorityActionPayload).kind === 'castSpell' &&
      (x.payload as { objectId?: string }).objectId === o.id,
  );
  expect(a, `${card.name} normal cast`).toBeDefined();
  pump(
    applyPriorityAction(c, playerById(c, who), a!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  settle(c, answer);
  return c.state.battlefield.find((x) => x.cardId === o.cardId)!;
}
function lib(c: GameContext, cards: OracleCard[]) {
  const os = cards.map((x) => conjure(c, 'P1', x, 'library'));
  playerById(c, 'P1').library = os;
  return os;
}
const testCard = (name: string, cost = '{1}', type = 'Sorcery', text = '') =>
  oracle({
    name,
    manaCost: cost,
    cmc: cost === '' ? 0 : Number(cost.replace(/[^0-9]/g, '')) || 0,
    typeLine: type,
    oracleText: text,
    power: type.includes('Creature') ? '5' : null,
    toughness: type.includes('Creature') ? '5' : null,
  });

describe('PR09 discover, explore, and reveal production cards', () => {
  it('pr09-franklin-own-combat-discover — after your noncreature spell, beginning combat queues and resolves Discover 6', () => {
    const c = pod('franklin-discover');
    const f = spawn(c, 'P1', FRANKLIN);
    // No spell cast yet this turn, then only a creature spell: the intervening condition fails.
    queueStepTriggers(c, 'beginningOfCombat');
    expect(c.state.pendingTriggers).toHaveLength(0);
    cast(c, testCard('Franklin setup creature', '{1}', 'Creature — Test'), ['C']);
    queueStepTriggers(c, 'beginningOfCombat');
    expect(c.state.pendingTriggers).toHaveLength(0);
    cast(c, testCard('Franklin setup artifact', '{1}', 'Artifact'), ['C']);
    // Discover 6: the mana value 7 card is exiled past (and bottomed); the mana value 6 card hits.
    lib(c, [
      testCard('Franklin too costly', '{7}', 'Artifact'),
      testCard('Franklin hit', '{6}', 'Artifact'),
    ]);
    queueStepTriggers(c, 'beginningOfCombat');
    expect(c.state.pendingTriggers).toHaveLength(1);
    settle(c, (d) => (d.decisionType === 'general' ? decline(d) : pass(d)));
    const hand = playerById(c, 'P1').hand.map((x) => x.name);
    expect(hand).toContain('Franklin hit');
    expect(hand).not.toContain('Franklin too costly');
    expect(playerById(c, 'P1').library.map((x) => x.name)).toEqual(['Franklin too costly']);
    expect(f.name).toBe(FRANKLIN.name);
  });
  it('pr09-franklin-no-opponent-combat — Franklin does not trigger at another player’s beginning of combat', () => {
    const c = pod('franklin-opponent');
    spawn(c, 'P1', FRANKLIN);
    c.state.currentTurnPlayer = 'P2';
    c.state.activePlayerIndex = 1;
    queueStepTriggers(c, 'beginningOfCombat');
    expect(c.state.pendingTriggers).toHaveLength(0);
  });
  it('pr09-monstrous-creature-discover — your power-five creature spell triggers Discover using its mana value', () => {
    const c = pod('vortex-hit');
    spawn(c, 'P1', VORTEX);
    lib(c, [testCard('Vortex hit', '{3}', 'Artifact')]);
    cast(c, testCard('Vortex creature', '{3}', 'Creature — Beast'), ['C', 'C', 'C'], (d) =>
      d.decisionType === 'general' ? decline(d) : pass(d),
    );
    expect(playerById(c, 'P1').hand.some((x) => x.name === 'Vortex hit')).toBe(true);
  });
  it('pr09-monstrous-excludes-low-power-and-opponent — low-power own creature and opponent creature casts do not queue', () => {
    const c = pod('vortex-exclusions');
    spawn(c, 'P1', VORTEX);
    const low = testCard('Low creature', '{2}', 'Creature — Beast');
    low.power = '2';
    cast(c, low, ['C', 'C']);
    expect(c.state.pendingTriggers).toHaveLength(0);
    c.state.currentTurnPlayer = 'P2';
    c.state.activePlayerIndex = 1;
    castBy(c, 'P2', testCard('Enemy giant', '{6}', 'Creature — Giant'), Array(6).fill('C'));
    expect(c.state.pendingTriggers).toHaveLength(0);
  });
  it('pr09-chimil-own-end-step-discover — own end step triggers Discover 5', () => {
    const c = pod('chimil-end');
    spawn(c, 'P1', CHIMIL);
    lib(c, [
      testCard('Chimil too costly', '{6}', 'Artifact'),
      testCard('Chimil hit', '{5}', 'Artifact'),
    ]);
    queueStepTriggers(c, 'endStep');
    expect(c.state.pendingTriggers).toHaveLength(1);
    settle(c, (d) => (d.decisionType === 'general' ? decline(d) : pass(d)));
    // Discover 5 skips the mana value 6 card (it goes to the library bottom) and takes the 5.
    expect(playerById(c, 'P1').hand.map((x) => x.name)).toEqual(['Chimil hit']);
    expect(playerById(c, 'P1').library.map((x) => x.name)).toEqual(['Chimil too costly']);
  });
  it('pr09-chimil-opponent-end-step — opponent end step does not queue Chimil', () => {
    const c = pod('chimil-opponent');
    spawn(c, 'P1', CHIMIL);
    c.state.currentTurnPlayer = 'P2';
    queueStepTriggers(c, 'endStep');
    expect(c.state.pendingTriggers).toHaveLength(0);
  });
  it('pr09-carnosaur-cast-etb-discover — pays {4}{R}{R}, resolves, and its ETB discovers', () => {
    const c = pod('carnosaur-cast');
    lib(c, [
      testCard('Carnosaur too costly', '{6}', 'Artifact'),
      testCard('Carnosaur hit', '{5}', 'Artifact'),
    ]);
    const car = cast(c, CARNOSAUR, ['C', 'C', 'C', 'C', 'R', 'R'], (d) =>
      d.decisionType === 'general' ? decline(d) : pass(d),
    );
    expect(car.name).toBe(CARNOSAUR.name);
    // Discover 5: the mana value 6 card is skipped, the mana value 5 card is the hit.
    expect(playerById(c, 'P1').hand.map((x) => x.name)).toEqual(['Carnosaur hit']);
    expect(playerById(c, 'P1').library.map((x) => x.name)).toEqual(['Carnosaur too costly']);
  });
  it('pr09-carnosaur-activation-hand-only-cost — ability requires hand zone and {2}{R}', () => {
    const c = pod('carnosaur-cost');
    const hand = conjure(c, 'P1', CARNOSAUR, 'hand');
    const foe = spawn(c, 'P2', testCard('Target', '{1}', 'Creature — Test'));
    const walker = spawn(
      c,
      'P2',
      oracle({ name: 'Carnosaur Walker', typeLine: 'Planeswalker — Test', loyalty: '5' }),
    );
    const notTargetable = spawn(c, 'P2', testCard('Carnosaur Relic', '{1}', 'Artifact'));
    const actions = () =>
      computePriorityOptions(c, playerById(c, 'P1')).filter(
        (o) => (o.payload as { objectId?: string }).objectId === hand.id,
      );
    expect(actions().length).toBe(0);
    addMana(
      playerById(c, 'P1'),
      (['C', 'C'] as const).map((symbol) => ({ symbol })),
    );
    expect(actions().length).toBe(0);
    addMana(playerById(c, 'P1'), [{ symbol: 'R' }]);
    const activate = actions().find(
      (o) => (o.payload as PriorityActionPayload).kind === 'activateAbility',
    );
    expect(activate).toBeDefined();
    // Targets only creatures and planeswalkers.
    const legal = activate!.targets!.flatMap((slot) => slot.options);
    expect(legal).toContain(foe.id);
    expect(legal).toContain(walker.id);
    expect(legal).not.toContain(notTargetable.id);
    pump(
      applyPriorityAction(c, playerById(c, 'P1'), activate!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[activate!.targets![0]!.slot, foe.id]]),
      }),
    );
    // The cost is paid on activation: the card is discarded and the mana is spent.
    expect(playerById(c, 'P1').graveyard.some((x) => x.cardId === hand.cardId)).toBe(true);
    expect(playerById(c, 'P1').hand.some((x) => x.cardId === hand.cardId)).toBe(false);
    expect(playerById(c, 'P1').manaEntries).toHaveLength(0);
    settle(c);
    expect(c.state.battlefield.find((x) => x.id === foe.id)?.damageMarked).toBe(3);
    expect(c.state.battlefield.find((x) => x.id === walker.id)?.counters['loyalty'] ?? 5).toBe(5);
  });
  it('pr09-path-own-creature-enters-explore-land — own creature entering explores; land goes to hand without a draw', () => {
    const c = pod('path-land');
    spawn(c, 'P1', PATH);
    lib(c, [testCard('Explore land', '', 'Land')]);
    // An opposing creature and your own noncreature permanent entering do not explore.
    const enemy = conjure(c, 'P2', testCard('Path enemy', '{2}', 'Creature — Scout'), 'hand');
    pump(moveObject(c, enemy, { zone: 'battlefield' }));
    const relic = conjure(c, 'P1', testCard('Path relic', '{2}', 'Artifact'), 'hand');
    pump(moveObject(c, relic, { zone: 'battlefield' }));
    expect(c.state.pendingTriggers).toHaveLength(0);
    settle(c);
    expect(playerById(c, 'P1').hand.some((x) => x.name === 'Explore land')).toBe(false);
    expect(playerById(c, 'P1').library.map((x) => x.name)).toEqual(['Explore land']);
    expect(c.state.battlefield.find((x) => x.id === enemy.id)?.counters['+1/+1'] ?? 0).toBe(0);
    const object = conjure(c, 'P1', testCard('Path creature', '{2}', 'Creature — Scout'), 'hand');
    pump(moveObject(c, object, { zone: 'battlefield' }));
    settle(c);
    expect(playerById(c, 'P1').hand.some((x) => x.name === 'Explore land')).toBe(true);
    expect(c.state.eventLog.some((e) => e.type === 'draw')).toBe(false);
  });
  it('pr09-path-nonland-counter-and-graveyard-choice — nonland revealed on explore gives a counter and may go to graveyard', () => {
    const c = pod('path-nonland');
    const path = spawn(c, 'P1', PATH);
    lib(c, [testCard('Explore nonland', '{1}', 'Artifact')]);
    const object = conjure(c, 'P1', testCard('Explore host', '{2}', 'Creature — Scout'), 'hand');
    pump(moveObject(c, object, { zone: 'battlefield' }));
    const creature = c.state.battlefield.find((x) => x.name === 'Explore host')!;
    settle(c, (d) => (d.decisionType === 'general' ? choose(d, /graveyard/) : pass(d)));
    expect(creature.counters['+1/+1'] ?? 0).toBe(1);
    expect(playerById(c, 'P1').graveyard.some((x) => x.name === 'Explore nonland')).toBe(true);
    expect(path.name).toBe(PATH.name);
  });
  it('pr09-path-empty-library-still-counter — exploration with no library card still adds a +1/+1 counter', () => {
    const c = pod('path-empty');
    spawn(c, 'P1', PATH);
    playerById(c, 'P1').library = [];
    const object = conjure(c, 'P1', testCard('Empty explore', '{2}', 'Creature — Scout'), 'hand');
    pump(moveObject(c, object, { zone: 'battlefield' }));
    settle(c);
    const creature = c.state.battlefield.find((x) => x.name === 'Empty explore')!;
    expect(creature.counters['+1/+1'] ?? 0).toBe(1);
  });
  it('pr09-predators-opponent-creature-publicly-enters — opponent spell reveals publicly and creature must enter battlefield', () => {
    const c = pod('predators-creature');
    spawn(c, 'P1', PREDATORS);
    lib(c, [testCard('Predator creature', '{2}', 'Creature — Beast')]);
    c.state.currentTurnPlayer = 'P2';
    c.state.activePlayerIndex = 1;
    castBy(c, 'P2', testCard('Opponent spell', '{1}', 'Artifact'), ['C']);
    expect(c.state.battlefield.some((x) => x.name === 'Predator creature')).toBe(true);
    expect(c.state.eventLog.some((e) => e.type === 'revealCard')).toBe(true);
  });
  it('pr09-predators-own-cast-does-not-trigger — own spell does not cause the opponent-cast trigger', () => {
    const c = pod('predators-own');
    spawn(c, 'P1', PREDATORS);
    cast(c, testCard('Own spell', '{1}', 'Artifact'), ['C']);
    expect(c.state.pendingTriggers).toHaveLength(0);
  });
  it('pr09-predators-noncreature-bottom-or-keep — revealed noncreature is public and optional to bottom, never drawn', () => {
    const c = pod('predators-noncreature');
    spawn(c, 'P1', PREDATORS);
    const top = testCard('Predator noncreature', '{1}', 'Artifact');
    lib(c, [top]);
    c.state.currentTurnPlayer = 'P2';
    c.state.activePlayerIndex = 1;
    castBy(c, 'P2', testCard('Enemy spell', '{1}', 'Artifact'), ['C'], (d) =>
      d.decisionType === 'general' ? choose(d, /bottom/) : pass(d),
    );
    expect(playerById(c, 'P1').library.some((x) => x.name === 'Predator noncreature')).toBe(true);
    expect(c.state.eventLog.some((e) => e.type === 'draw')).toBe(false);
  });
});
