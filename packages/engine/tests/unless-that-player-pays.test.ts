/**
 * "…unless that player pays {N}" — `unlessPlayerPays` (Rhystic Study, Mystic Remora).
 *
 * The EDH-staple coverage plan's Tier 2 item 4. `counterUnlessPays` already proved the
 * ask-an-opponent-to-pay decision shape; what was missing was the same question attached to an
 * arbitrary effect rather than a counter.
 *
 * Two things beyond the obvious are pinned here:
 *
 *  - **Who is asked, and in what order.** The clause is NOT the ability-level `optional` flag.
 *    That flag asks the controller first; the printed clause asks the caster first, and only
 *    then offers the controller their "you may". A Rhystic Study where you commit to the draw
 *    before the opponent decides is a different card.
 *  - **The event player is recorded at all.** `castsSpell` triggers carried no `eventPlayerId`,
 *    so "that player" had no referent. Kambal, Consul of Allocation — the one shipped card that
 *    already read it — was consequently a no-op on every cast.
 */

import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { queueCastTriggers } from '../src/state/objects';
import type { EngineStackObject, EnginePlayerState, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, island, oracle, pump, spawn } from './fixtures';

const rhysticStudy = (): OracleCard =>
  oracle({
    name: 'Test Rhystic Study',
    typeLine: 'Enchantment',
    manaCost: '{2}{U}',
    colors: ['U'],
    colorIdentity: ['U'],
    power: null,
    toughness: null,
    oracleText: 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.',
  });

const someSpell = (): OracleCard =>
  oracle({ name: 'Test Opponent Spell', typeLine: 'Sorcery', manaCost: '{1}', power: null, toughness: null });

function pod(seed = 'unless-pays'): GameContext {
  const ctx = createGame(
    gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })), { seed }),
  );
  ctx.state.currentTurnPlayer = 'P2';
  ctx.state.activePlayerIndex = 1;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const player = (ctx: GameContext, id: string): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === id) as EnginePlayerState;

/** Put an opponent's spell on the stack and queue whatever it triggers. */
function opponentCasts(ctx: GameContext): void {
  const card = conjure(ctx, 'P2', someSpell(), 'hand');
  const entry: EngineStackObject = {
    id: card.id,
    sourceId: card.id,
    controllerId: 'P2',
    kind: 'spell',
    description: card.name,
    targets: [],
    card,
    ability: null,
    sourceOracleId: card.oracleId,
    sourceCardId: card.cardId,
    isCommanderCast: false,
  };
  ctx.state.stack.push(entry);
  queueCastTriggers(ctx, entry);
}

/** Resolve the queued trigger, answering decisions by option description. */
function resolveTrigger(
  ctx: GameContext,
  answers: Record<string, string>,
): ReturnType<typeof pump> {
  const pending = ctx.state.pendingTriggers[0];
  if (pending === undefined) throw new Error('test bug: no trigger queued');
  return pump(
    executeAbility(
      ctx,
      {
        cardId: pending.sourceCardId,
        name: pending.sourceName,
        oracleId: pending.sourceOracleId,
        controllerId: pending.controllerId,
      },
      pending.ability,
      [],
      undefined,
      pending.scope,
    ),
    (decision) => {
      for (const [promptFragment, optionFragment] of Object.entries(answers)) {
        if (!decision.prompt.includes(promptFragment)) continue;
        const index = decision.options.findIndex((o) => o.description.includes(optionFragment));
        if (index >= 0) return { index, targets: new Map() };
      }
      return { index: 0, targets: new Map() };
    },
  );
}

describe('unless that player pays', () => {
  it('parses to one effect that wraps the payoff, not to an optional ability', () => {
    const def = interpretCard(rhysticStudy());

    expect(def.modeled).toBe(true);
    expect(def.triggers).toHaveLength(1);
    expect(def.triggers[0]?.optional).toBe(false);
    expect(def.triggers[0]?.effects).toEqual([
      {
        op: 'unlessPlayerPays',
        payer: 'eventPlayer',
        cost: { generic: 1, colored: { W: 0, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 },
        then: [{ op: 'draw', count: { kind: 'const', n: 1 } }],
        optionalThen: true,
      },
    ]);
  });

  it('records the caster as the event player on a cast trigger', () => {
    const ctx = pod();
    spawn(ctx, 'P1', rhysticStudy());
    opponentCasts(ctx);

    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.scope?.eventPlayerId).toBe('P2');
  });

  it('taxes the caster and skips the draw when they pay', () => {
    const ctx = pod();
    spawn(ctx, 'P1', rhysticStudy());
    spawn(ctx, 'P2', island());
    opponentCasts(ctx);
    const handBefore = player(ctx, 'P1').hand.length;

    const { decisions } = resolveTrigger(ctx, { 'pay {1}': 'Pay {1}' });

    expect(decisions.map((d) => d.player)).toEqual(['P2']); // only the caster is asked
    expect(player(ctx, 'P1').hand).toHaveLength(handBefore);
    expect(ctx.state.battlefield.filter((p) => p.controllerId === 'P2' && p.tapped)).toHaveLength(1);
  });

  it('asks the caster first, then the controller, when the tax goes unpaid', () => {
    const ctx = pod();
    spawn(ctx, 'P1', rhysticStudy());
    spawn(ctx, 'P2', island());
    opponentCasts(ctx);
    const handBefore = player(ctx, 'P1').hand.length;

    const { decisions } = resolveTrigger(ctx, {
      'pay {1}': "Don't pay",
      'declined to pay': 'Resolve',
    });

    expect(decisions.map((d) => d.player)).toEqual(['P2', 'P1']);
    expect(player(ctx, 'P1').hand).toHaveLength(handBefore + 1);
  });

  it('lets the controller decline the draw after the tax goes unpaid', () => {
    const ctx = pod();
    spawn(ctx, 'P1', rhysticStudy());
    spawn(ctx, 'P2', island());
    opponentCasts(ctx);
    const handBefore = player(ctx, 'P1').hand.length;

    resolveTrigger(ctx, { 'pay {1}': "Don't pay", 'declined to pay': 'Decline' });

    expect(player(ctx, 'P1').hand).toHaveLength(handBefore);
  });

  it('repairs Kambal, whose drain read the same event player and never fired', () => {
    // The one shipped card that already depended on `eventPlayerId`: with none recorded, its
    // effect broke out immediately, so Kambal drained nobody. Its override also declared
    // `caster: 'each'`, which only became observable once the drain worked — it would have made
    // Kambal hit its own controller.
    const kambal = oracle({
      oracleId: '4987c458-604a-4727-b360-170616e91e67',
      name: 'Kambal, Consul of Allocation',
      typeLine: 'Legendary Creature — Human Advisor',
      manaCost: '{2}{W}{B}',
      power: '2',
      toughness: '3',
      oracleText:
        'Whenever an opponent casts a noncreature spell, that player loses 2 life and you gain 2 life.',
    });
    const def = interpretCard(kambal);
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]?.trigger).toMatchObject({ when: 'castsSpell', caster: 'opponent' });

    const ctx = pod();
    spawn(ctx, 'P1', kambal);
    opponentCasts(ctx);
    const drained = player(ctx, 'P2').life;
    const gained = player(ctx, 'P1').life;

    resolveTrigger(ctx, {});

    expect(player(ctx, 'P2').life).toBe(drained - 2);
    expect(player(ctx, 'P1').life).toBe(gained + 2);
  });

  it('does not ask a caster who cannot afford the cost', () => {
    const ctx = pod();
    spawn(ctx, 'P1', rhysticStudy());
    // P2 controls nothing, so {1} is unpayable — the question is skipped, not asked and refused.
    opponentCasts(ctx);
    const handBefore = player(ctx, 'P1').hand.length;

    const { decisions } = resolveTrigger(ctx, { 'declined to pay': 'Resolve' });

    expect(decisions.map((d) => d.player)).toEqual(['P1']);
    expect(player(ctx, 'P1').hand).toHaveLength(handBefore + 1);
  });
});
