import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computeTargetOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { PendingDecision } from '../src/decisions';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { computeCharacteristics } from '../src/effects/continuous';
import { addSagaLoreCounters } from '../src/effects/resolve';
import { moveObject } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { bear, conjure, oracle, pump, spawn } from './fixtures';
import {
  activate,
  anyMana,
  battlefield,
  castFromHand,
  checkpoint,
  game,
  nextTurnOf,
  pinned,
  player,
  priorityOption,
  resolve,
} from './pr11-helpers';

const WAR = pinned('The War in Heaven');
const URZA = pinned("Urza's Saga");

const creature = (name: string, manaCost: string): OracleCard =>
  oracle({
    name,
    typeLine: 'Creature — Test',
    manaCost,
    oracleText: '',
    power: '2',
    toughness: '2',
  });
const artifact = (name: string, manaCost: string | null, typeLine = 'Artifact'): OracleCard =>
  oracle({ name, typeLine, manaCost: manaCost as string, oracleText: '' });

const types = (decisions: PendingDecision[]): string[] =>
  decisions.map((decision) => decision.decisionType);

const lore = (saga: EnginePermanent): number => saga.counters['lore'] ?? 0;

/** The lore counter of P1's precombat main phase (CR 714.3b), its chapter left on the stack. */
function nextChapter(ctx: GameContext): void {
  addSagaLoreCounters(ctx, 'P1');
  checkpoint(ctx);
}

function warEntered(seed: string): { ctx: GameContext; war: EnginePermanent } {
  const ctx = game(seed);
  castFromHand(ctx, 'P1', WAR, new Map(), { B: 3, C: 3 });
  resolve(ctx);
  const war = battlefield(ctx, 'The War in Heaven')[0]!;
  return { ctx, war };
}

function playUrza(seed: string): { ctx: GameContext; urza: EnginePermanent } {
  const ctx = game(seed);
  const card = conjure(ctx, 'P1', URZA, 'hand');
  const option = priorityOption(
    ctx,
    'P1',
    (payload) => payload.kind === 'playLand' && payload.objectId === card.id,
  );
  expect(option, "play Urza's Saga").toBeDefined();
  pump(
    applyPriorityAction(ctx, player(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  const urza = battlefield(ctx, "Urza's Saga")[0]!;
  return { ctx, urza };
}

describe('Saga modeling', () => {
  it('saga-modeled — both Sagas model every chapter under the Oracle and fixture ids', () => {
    for (const card of [WAR, URZA]) {
      for (const oracleId of [card.oracleId, fixtureOracleId(card.name)]) {
        const def = interpretCard({ ...card, oracleId } as typeof card);
        expect(def.unmodeledReasons).toEqual([]);
        expect(def.triggers).toHaveLength(3);
      }
    }
  });
});

describe('The War in Heaven', () => {
  it('war-c01-positive — it enters with a lore counter, and chapter I draws three and loses 3 life', () => {
    const { ctx, war } = warEntered('war-chapter-1');
    expect(lore(war)).toBe(1);
    const hand = player(ctx, 'P1').hand.length;
    const life = player(ctx, 'P1').life;
    checkpoint(ctx);
    expect(ctx.state.stack.at(-1)?.description).toContain('I — You draw three cards');
    // Chapter I is mandatory: nobody is asked "use this ability?".
    expect(types(resolve(ctx))).not.toContain('optionalTrigger');
    expect(player(ctx, 'P1').hand.length).toBe(hand + 3);
    expect(player(ctx, 'P1').life).toBe(life - 3);
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('war-c02-positive — the lore counter at your precombat main triggers chapter II only', () => {
    const { ctx, war } = warEntered('war-chapter-2');
    checkpoint(ctx);
    resolve(ctx);
    const graveyard = player(ctx, 'P1').graveyard.length;
    const life = player(ctx, 'P1').life;
    // The turn runs through its precombat main phase, resolving what triggers there.
    const asked = nextTurnOf(ctx, 'P1');
    expect(types(asked)).not.toContain('optionalTrigger');
    expect(lore(war)).toBe(2);
    expect(player(ctx, 'P1').graveyard.length).toBe(graveyard + 3);
    expect(player(ctx, 'P1').life).toBe(life);
    expect(battlefield(ctx, 'The War in Heaven')).toHaveLength(1);
  });

  it("war-c03-positive — chapter III returns creatures as artifacts with necrodermis, then it's sacrificed", () => {
    const { ctx, war } = warEntered('war-chapter-3');
    checkpoint(ctx);
    resolve(ctx);
    war.counters['lore'] = 2;
    const picks = [creature('Test Two', '{1}{B}'), creature('Test Six', '{5}{B}')].map((card) =>
      conjure(ctx, 'P1', card, 'graveyard'),
    );
    nextChapter(ctx);
    const trigger = ctx.state.stack.at(-1)!;
    expect(trigger.description).toContain('III —');
    trigger.countTargets = { 0: picks.map((card) => card.id) };
    // The Saga waits for its chapter III ability to leave the stack (CR 714.4).
    checkpoint(ctx);
    expect(battlefield(ctx, 'The War in Heaven')).toHaveLength(1);
    expect(types(resolve(ctx))).not.toContain('optionalTrigger');
    for (const name of ['Test Two', 'Test Six']) {
      const [returned] = battlefield(ctx, name);
      expect(returned?.counters['necrodermis']).toBe(1);
      expect(computeCharacteristics(ctx, returned!).types).toEqual(['Creature', 'Artifact']);
    }
    checkpoint(ctx);
    expect(battlefield(ctx, 'The War in Heaven')).toHaveLength(0);
    expect(player(ctx, 'P1').graveyard.some((card) => card.name === 'The War in Heaven')).toBe(
      true,
    );
  });

  it('war-c03-budget — a choice over total mana value 8 returns nothing', () => {
    const { ctx, war } = warEntered('war-budget');
    checkpoint(ctx);
    resolve(ctx);
    war.counters['lore'] = 2;
    const picks = [creature('Test Five', '{4}{B}'), creature('Test Four', '{3}{B}')].map((card) =>
      conjure(ctx, 'P1', card, 'graveyard'),
    );
    // Only creature cards in your graveyard can be chosen for chapter III.
    const spell = conjure(
      ctx,
      'P1',
      oracle({ name: 'Test Spell', typeLine: 'Sorcery' }),
      'graveyard',
    );
    const theirs = conjure(ctx, 'P2', creature('Test Theirs', '{1}{B}'), 'graveyard');
    const spec = interpretCard(WAR).triggers[2]!.targets[0]!;
    const legal = computeTargetOptions(ctx, spec, 'P1');
    expect(legal).toEqual(expect.arrayContaining(picks.map((card) => card.id)));
    expect(legal).not.toContain(spell.id);
    expect(legal).not.toContain(theirs.id);
    nextChapter(ctx);
    ctx.state.stack.at(-1)!.countTargets = { 0: picks.map((card) => card.id) };
    resolve(ctx);
    expect(battlefield(ctx, 'Test Five')).toHaveLength(0);
    expect(battlefield(ctx, 'Test Four')).toHaveLength(0);
  });

  it('war-c03-artifact-lasts — the artifact type outlasts the turn but not the object (CR 400.7)', () => {
    const { ctx, war } = warEntered('war-object');
    checkpoint(ctx);
    resolve(ctx);
    war.counters['lore'] = 2;
    const pick = conjure(ctx, 'P1', bear(), 'graveyard');
    nextChapter(ctx);
    ctx.state.stack.at(-1)!.countTargets = { 0: [pick.id] };
    resolve(ctx);
    const [returned] = battlefield(ctx, 'Test Bear');
    nextTurnOf(ctx, 'P2');
    expect(computeCharacteristics(ctx, returned!).types).toContain('Artifact');
    const card = pump(moveObject(ctx, returned!, { zone: 'graveyard' })).value!;
    pump(moveObject(ctx, card, { zone: 'battlefield', controllerId: 'P1' }));
    const [again] = battlefield(ctx, 'Test Bear');
    expect(computeCharacteristics(ctx, again!).types).toEqual(['Creature']);
  });
});

describe("Urza's Saga", () => {
  it("urza-c01-positive — playing it adds a lore counter, and chapter I gives it '{T}: Add {C}'", () => {
    const { ctx, urza } = playUrza('urza-chapter-1');
    expect(lore(urza)).toBe(1);
    expect(computeCharacteristics(ctx, urza).manaAbilities).toEqual([]);
    checkpoint(ctx);
    // Chapter I is mandatory: nobody is asked "use this ability?".
    expect(types(resolve(ctx))).not.toContain('optionalTrigger');
    expect(computeCharacteristics(ctx, urza).manaAbilities.map((ability) => ability.units)).toEqual(
      [[['C']]],
    );
  });

  it('urza-c02-positive — chapter II gives it a Construct maker that counts artifacts', () => {
    const { ctx, urza } = playUrza('urza-chapter-2');
    checkpoint(ctx);
    resolve(ctx);
    // Chapter II is mandatory too.
    expect(types(nextTurnOf(ctx, 'P1'))).not.toContain('optionalTrigger');
    expect(lore(urza)).toBe(2);
    expect(computeCharacteristics(ctx, urza).manaAbilities).toHaveLength(1);
    anyMana(ctx, 'P1', 2);
    activate(ctx, 'P1', urza);
    resolve(ctx);
    expect(urza.tapped).toBe(true);
    // Exactly one Construct token is made.
    expect(battlefield(ctx, 'Construct')).toHaveLength(1);
    const [construct] = battlefield(ctx, 'Construct');
    const chars = computeCharacteristics(ctx, construct!);
    expect([chars.power, chars.toughness, chars.types]).toEqual([1, 1, ['Artifact', 'Creature']]);
    spawn(ctx, 'P1', artifact('Test Bauble', '{0}'));
    expect(computeCharacteristics(ctx, construct!).power).toBe(2);
  });

  it('urza-c03-positive — chapter III finds only an artifact with mana cost {0} or {1}', () => {
    const { ctx, urza } = playUrza('urza-chapter-3');
    checkpoint(ctx);
    resolve(ctx);
    urza.counters['lore'] = 2;
    for (const card of [
      artifact('Test X Rock', '{X}'),
      artifact('Test Two Rock', '{2}'),
      artifact('Test Artifact Land', null, 'Artifact Land'),
      artifact('Test One Rock', '{1}'),
      artifact('Test Zero Rock', '{0}'),
    ])
      conjure(ctx, 'P1', card, 'library');
    nextChapter(ctx);
    expect(ctx.state.stack.at(-1)?.description).toContain('III —');
    const decisions = resolve(ctx);
    expect(types(decisions)).not.toContain('optionalTrigger');
    // Chapter III ends with "then shuffle".
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
    const offered = decisions.flatMap((decision) =>
      decision.options.map((option) => option.description),
    );
    for (const name of ['Test One Rock', 'Test Zero Rock'])
      expect(offered.some((text) => text.includes(name))).toBe(true);
    for (const name of ['Test X Rock', 'Test Two Rock', 'Test Artifact Land'])
      expect(offered.some((text) => text.includes(name))).toBe(false);
    const found = ctx.state.battlefield.filter((perm) => /Test (One|Zero) Rock/.test(perm.name));
    expect(found).toHaveLength(1);
    checkpoint(ctx);
    expect(battlefield(ctx, "Urza's Saga")).toHaveLength(0);
  });
});
