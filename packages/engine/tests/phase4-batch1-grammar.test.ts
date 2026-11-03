/**
 * EDHREC coverage plan, Phase 4 batch 1: common sentences over existing ops. Each production is
 * read from a stand-in card and run through the executor (D1: the feature is tested once, and the
 * cards it closes need no tests of their own).
 */
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { Ability } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const creature = (name: string, oracleText: string): OracleCard =>
  oracle({
    name,
    typeLine: 'Creature — Human',
    manaCost: '{1}',
    power: '1',
    toughness: '1',
    oracleText,
  });
const sorcery = (name: string, oracleText: string): OracleCard =>
  oracle({ name, typeLine: 'Sorcery', manaCost: '{1}', oracleText });

function run(ctx: GameContext, card: OracleCard, ability: Ability, targets: string[] = []): void {
  pump(
    executeAbility(
      ctx,
      { cardId: 'p4-source', name: card.name, oracleId: card.oracleId, controllerId: 'P1' },
      ability,
      targets,
    ),
  );
}
const player = (ctx: GameContext, id: string) => ctx.state.players.find((p) => p.id === id)!;

describe('Phase 4 batch 1 productions', () => {
  it('investigate creates a Clue token (CR 701.36a)', () => {
    const card = creature('P4 Inspector', 'When this creature enters, investigate.');
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    const ctx = pod('p4-investigate');
    run(ctx, card, def.triggers[0]!);
    expect(
      ctx.state.battlefield.filter((p) => p.name === 'Clue' && p.controllerId === 'P1'),
    ).toHaveLength(1);
  });

  it('each opponent discards a card, and you do not', () => {
    const card = creature('P4 Rat', 'When this creature enters, each opponent discards a card.');
    const def = interpretCard(card);
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'discardEachPlayer', scope: 'opponents', count: { kind: 'const', n: 1 } },
    ]);
    const ctx = pod('p4-discard');
    for (const id of ['P1', 'P2', 'P3']) conjure(ctx, id, forest(), 'hand');
    const before = player(ctx, 'P1').hand.length;
    run(ctx, card, def.triggers[0]!);
    expect(player(ctx, 'P1').hand).toHaveLength(before);
    expect(player(ctx, 'P2').graveyard).toHaveLength(1);
    expect(player(ctx, 'P3').graveyard).toHaveLength(1);
  });

  it('target player mills two cards', () => {
    const card = sorcery('P4 Scour', 'Target player mills two cards.');
    const def = interpretCard(card);
    expect(def.spellAbility!.targets).toEqual([{ kind: 'player' }]);
    const ctx = pod('p4-mill');
    const library = player(ctx, 'P2').library.length;
    run(ctx, card, def.spellAbility!, ['P2']);
    expect(player(ctx, 'P2').graveyard).toHaveLength(2);
    expect(player(ctx, 'P2').library).toHaveLength(library - 2);
    expect(player(ctx, 'P1').graveyard).toHaveLength(0);
  });

  it('Fog prevents all combat damage this turn', () => {
    const card = oracle({
      name: 'P4 Fog',
      typeLine: 'Instant',
      manaCost: '{G}',
      oracleText: 'Prevent all combat damage that would be dealt this turn.',
    });
    const def = interpretCard(card);
    const ctx = pod('p4-fog');
    expect(ctx.state.combatDamagePrevention.all).toBe(false);
    run(ctx, card, def.spellAbility!);
    expect(ctx.state.combatDamagePrevention.all).toBe(true);
  });

  it("a karoo land returns a land you control, chosen on resolution, never an opponent's", () => {
    const card = oracle({
      name: 'P4 Karoo',
      typeLine: 'Land',
      oracleText: "When this land enters, return a land you control to its owner's hand.",
    });
    const def = interpretCard(card);
    expect(def.triggers[0]!.targets).toEqual([]);
    const ctx = pod('p4-karoo');
    spawn(ctx, 'P1', forest());
    const theirs = spawn(ctx, 'P2', forest());
    run(ctx, card, def.triggers[0]!);
    expect(player(ctx, 'P1').hand.filter((c) => c.name === 'Forest')).toHaveLength(1);
    expect(ctx.state.battlefield).toContain(theirs);
  });

  it('"it deals 1 damage to target opponent" on a self head targets an opponent only', () => {
    const card = oracle({
      name: 'P4 Bluffs',
      typeLine: 'Land',
      oracleText: 'When this land enters, it deals 1 damage to target opponent.',
    });
    const def = interpretCard(card);
    expect(def.triggers[0]!.targets).toEqual([{ kind: 'player', controller: 'opponent' }]);
    const ctx = pod('p4-ping');
    run(ctx, card, def.triggers[0]!, ['P2']);
    expect(player(ctx, 'P2').life).toBe(39);
  });

  it('"target opponent" never lets you target yourself', () => {
    const def = interpretCard(sorcery('P4 Drain', 'Target opponent loses 2 life.'));
    for (const target of def.spellAbility?.targets ?? [])
      if (target.kind === 'player') expect(target.controller).toBe('opponent');
  });

  it('"you may gain 1 life" is optional and gains 1', () => {
    const card = creature('P4 Attendant', 'Whenever another creature enters, you may gain 1 life.');
    const def = interpretCard(card);
    expect(def.triggers[0]!.optional).toBe(true);
    const ctx = pod('p4-gain');
    run(ctx, card, def.triggers[0]!);
    expect(player(ctx, 'P1').life).toBe(41);
  });
});
