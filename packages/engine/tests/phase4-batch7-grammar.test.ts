/**
 * EDHREC coverage plan, Phase 4 batch 7: "its controller …" after a sentence with one permanent
 * target, read as that target's controller (last known once an earlier instruction moved it, CR
 * 608.2h), and the gainLifeTarget op. Nature's Claim and Vapor Snag's runner scenarios drive the
 * normal cast path; this file covers the executor and the edges (D1).
 */
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { Ability } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

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
const instant = (oracleText: string): OracleCard =>
  oracle({ name: 'P7 Spell', typeLine: 'Instant', manaCost: '{G}', oracleText });
const player = (ctx: GameContext, id: string) => ctx.state.players.find((p) => p.id === id)!;
function run(ctx: GameContext, card: OracleCard, ability: Ability, targets: string[]): void {
  pump(
    executeAbility(
      ctx,
      { cardId: 'p7-source', name: card.name, oracleId: card.oracleId, controllerId: 'P1' },
      ability,
      targets,
    ),
    undefined,
    { strict: true },
  );
}

describe('Phase 4 batch 7: "its controller"', () => {
  it("the destroyed permanent's last-known controller gains the life (Nature's Claim)", () => {
    const card = instant('Destroy target artifact or enchantment. Its controller gains 4 life.');
    const def = interpretCard(card);
    expect(def.spellAbility!.effects).toEqual([
      { op: 'destroy', target: 0 },
      { op: 'gainLifeTarget', target: { controllerOf: 0 }, amount: { kind: 'const', n: 4 } },
    ]);
    const ctx = pod('p7-claim');
    const relic = spawn(
      ctx,
      'P3',
      oracle({ name: 'P7 Relic', typeLine: 'Artifact', manaCost: '{1}', oracleText: '' }),
    );
    run(ctx, card, def.spellAbility!, [relic.id]);
    expect(ctx.state.battlefield).not.toContain(relic);
    expect(player(ctx, 'P3').life).toBe(44);
    expect(player(ctx, 'P1').life).toBe(40);
  });

  it('a target that left before resolution makes the spell do nothing, its controller included', () => {
    const card = instant('Destroy target artifact or enchantment. Its controller gains 4 life.');
    const def = interpretCard(card);
    const ctx = pod('p7-gone');
    const relic = spawn(
      ctx,
      'P3',
      oracle({ name: 'P7 Relic', typeLine: 'Artifact', manaCost: '{1}', oracleText: '' }),
    );
    ctx.state.battlefield = ctx.state.battlefield.filter((p) => p !== relic);
    run(ctx, card, def.spellAbility!, [relic.id]);
    expect(player(ctx, 'P3').life).toBe(40);
  });

  it('"its controller" with no single permanent target before it is refused', () => {
    expect(interpretCard(instant('Its controller gains 4 life.')).modeled).toBe(false);
    expect(
      interpretCard(instant('Target player draws a card. Its controller gains 4 life.')).modeled,
    ).toBe(false);
  });

  it('"target player gains 3 life" gains for that player', () => {
    const card = instant('Target player gains 3 life.');
    const def = interpretCard(card);
    const ctx = pod('p7-gain');
    run(ctx, card, def.spellAbility!, ['P2']);
    expect(player(ctx, 'P2').life).toBe(43);
    expect(player(ctx, 'P1').life).toBe(40);
  });
});
