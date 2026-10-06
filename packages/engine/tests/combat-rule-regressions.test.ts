import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { runCombatPhase } from '../src/combat/combat';
import { createGame } from '../src/state/game';
import { runTurn } from '../src/turn/turn';
import {
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  mountain,
  pick,
  pump,
  spawn,
  splitDamage,
} from './fixtures';

const fixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/bug-hunt-oracle.json', 'utf8'),
) as { cards: { card: OracleCard }[] };
function real(name: string) {
  const card = fixture.cards
    .map((entry) => entry.card)
    .find((candidate) => candidate.name === name);
  if (!card) throw new Error(`Missing Oracle fixture ${name}`);
  expect(interpretCard(card).modeled, name).toBe(true);
  return card;
}

function combatContext() {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) }))));
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'combat',
    step: null,
  });
  return ctx;
}

describe('combat rules', () => {
  it('Rith sees excess noncombat damage to a planeswalker', () => {
    const ctx = combatContext();
    spawn(ctx, 'P1', real('Rith, Liberated Primeval'));
    spawn(ctx, 'P1', real('Gisela, Blade of Goldnight'));
    const ajani = spawn(ctx, 'P2', real('Ajani, Caller of the Pride'));
    expect(ajani.counters['loyalty']).toBe(4);
    conjure(ctx, 'P1', real('Lightning Bolt'), 'hand');
    spawn(ctx, 'P1', mountain());
    let boltCast = false;
    pump(runTurn(ctx), (decision) => {
      if (!boltCast && decision.player === 'P1' && ctx.state.phase === 'precombatMain') {
        const index = decision.options.findIndex(
          (option) => option.type === 'castSpell' && option.description.includes('Lightning Bolt'),
        );
        if (index >= 0) {
          boltCast = true;
          return { index, targets: new Map([[0, ajani.id]]) };
        }
      }
      if (decision.decisionType === 'declareAttackers') return declareAttacks(decision, () => null);
      return pick(decision, /Pass|does not/);
    });
    expect(boltCast).toBe(true);
    const _damage = ctx.state.eventLog
      .filter((event) => event.type === 'damage')
      .map((event) => event.payload);
    const dragons = ctx.state.battlefield.filter(
      (permanent) =>
        permanent.isToken && permanent.name === 'Dragon' && permanent.controllerId === 'P1',
    );
    // Gisela doubles Bolt to 6 damage; Ajani has 4 loyalty, so 2 is excess.
    expect(dragons).toHaveLength(1);
  });

  it('Rith sees excess combat damage from a deathtouch source', () => {
    const ctx = combatContext();
    spawn(ctx, 'P1', real('Rith, Liberated Primeval'));
    const vampire = spawn(ctx, 'P1', real('Vampire Nighthawk'));
    const atarka = spawn(ctx, 'P2', real('Atarka, World Render'));
    pump(runTurn(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id) => (id === vampire.id ? 'P2' : null));
      if (decision.decisionType === 'declareBlockers')
        return declareBlocks(decision, (id) => (id === atarka.id ? vampire.id : null));
      return pick(decision, /Pass|does not/);
    });
    const _damage = ctx.state.eventLog
      .filter((event) => event.type === 'damage')
      .map((event) => event.payload);
    const dragons = ctx.state.battlefield.filter(
      (permanent) =>
        permanent.isToken && permanent.name === 'Dragon' && permanent.controllerId === 'P1',
    );
    // Two deathtouch damage includes one excess damage even though Atarka has
    // four toughness. Rith must therefore create its end-step Dragon token.
    expect(dragons).toHaveLength(1);
  });

  it.each(['P1', 'P2'] as const)(
    'Twinflame Tyrant doubles damage only from its controller (attacker=%s)',
    (attackingPlayer) => {
      const ctx = combatContext();
      ctx.state.currentTurnPlayer = attackingPlayer;
      ctx.state.activePlayerIndex = attackingPlayer === 'P1' ? 0 : 1;
      spawn(ctx, 'P1', real('Twinflame Tyrant'));
      const baloths = spawn(ctx, attackingPlayer, real('Rampaging Baloths'));
      pump(runCombatPhase(ctx), (decision) => {
        if (decision.decisionType === 'declareAttackers')
          return declareAttacks(decision, (id) => (id === baloths.id ? 'P3' : null));
        return pick(decision, /Pass|does not/);
      });
      const _damage = ctx.state.eventLog
        .filter((event) => event.type === 'damage')
        .map((event) => event.payload);
      expect(ctx.state.players[2]!.life).toBe(attackingPlayer === 'P1' ? 28 : 34);
    },
  );

  it('offers a trample split with one blocker, including one already marked lethal', () => {
    const ctx = combatContext();
    const atarka = spawn(ctx, 'P1', real('Atarka, World Render'));
    const bird = spawn(ctx, 'P2', real('Birds of Paradise'));
    conjure(ctx, 'P2', real('Heroic Intervention'), 'hand');
    spawn(ctx, 'P2', forest());
    spawn(ctx, 'P2', forest());
    let interventionCast = false;
    const { decisions } = pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id) => (id === atarka.id ? 'P2' : null));
      if (decision.decisionType === 'declareBlockers')
        return declareBlocks(decision, (id) => (id === bird.id ? atarka.id : null));
      if (decision.decisionType === 'assignCombatDamage') {
        return splitDamage(
          ctx.state.step === 'firstStrikeCombatDamage'
            ? { [bird.id]: 1, P2: 5 }
            : { [bird.id]: 0, P2: 6 },
        );
      }
      if (!interventionCast && decision.player === 'P2' && ctx.state.step === 'declareBlockers') {
        const index = decision.options.findIndex(
          (option) =>
            option.type === 'castSpell' && option.description.includes('Heroic Intervention'),
        );
        if (index >= 0) {
          interventionCast = true;
          return { index, targets: new Map() };
        }
      }
      return pick(decision, /Pass|does not/);
    });
    expect(interventionCast).toBe(true);
    const _damage = ctx.state.eventLog
      .filter((event) => event.type === 'damage' && event.payload['source'] === atarka.name)
      .map((event) => event.payload);
    const divisions = decisions.filter(
      (decision) => decision.decisionType === 'assignCombatDamage',
    );
    // Both steps offer a genuine choice under CR 702.19b: excess may stay on
    // the blocker or go to P2. The supplied response chooses maximum P2 damage.
    expect(divisions).toHaveLength(2);
    expect(ctx.state.players[1]!.life).toBe(29);
  });
});
