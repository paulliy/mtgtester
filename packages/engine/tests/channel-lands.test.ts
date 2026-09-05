/**
 * Channel lands — "{3}{U}, Discard this card: <effect>" (Otawara, Soaring City).
 *
 * These were the plan's named B6 target, and they only became reachable once hand-zone
 * activation existed (`hand-activated-abilities.test.ts`). Three further pieces were needed:
 *
 * 1. **`discardSelf` as a printed cost.** "Discard this card" is the SOURCE leaving hand, not a
 *    free choice of card, so it is `discardSelf` and not `discardCard` — and its presence is what
 *    puts the ability in the hand zone (CR 112.6a).
 * 2. **Targets from the hand.** The hand loop previously skipped any ability with targets;
 *    cycling has none, a channel land does.
 * 3. **A self-only activation discount that a card in HAND can apply.**
 *    `activationCostReductionFor` reads `gatherRuleStatics`, which only sees the battlefield and
 *    the command zone — a card in hand contributes nothing to it, so the "costs {1} less to
 *    activate for each legendary creature you control" clause would silently never apply and the
 *    ability would be offered at full price.
 *
 * Oracle text below is verbatim (Scryfall bulk, checked 2026-09-04).
 */

import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import type { PriorityActionPayload } from '../src/actions/legal';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { resolveTopOfStack } from '../src/stack/stack';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { bear, conjure, copies, gameConfig, island, oracle, pump, spawn } from './fixtures';

const otawara = () =>
  oracle({
    name: 'Test Otawara',
    typeLine: 'Legendary Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText:
      "{T}: Add {U}.\n{3}{U}, Discard this card: Return target artifact, creature, enchantment, or planeswalker to its owner's hand. This ability costs {1} less to activate for each legendary creature you control.",
  });

const legendaryBear = () =>
  oracle({
    name: 'Test Legend',
    typeLine: 'Legendary Creature — Bear',
    manaCost: '{1}{G}',
    power: '2',
    toughness: '2',
    oracleText: '',
  });

function pod(seed = 'channel-lands'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, island) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 6;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P1') as EnginePlayerState;

const channelOption = (ctx: GameContext, player: EnginePlayerState, cardId: string) =>
  computePriorityOptions(ctx, player).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.fromHand === true && payload.objectId === cardId;
  });

describe('channel lands', () => {
  it('parses as a hand ability with a discard-self cost and an activation discount', () => {
    const def = interpretCard(otawara());
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);

    const channel = def.activatedAbilities.find((a) => a.zone === 'hand');
    expect(channel).toBeDefined();
    expect(channel!.costs.some((c) => c.kind === 'discardSelf')).toBe(true);
    expect(channel!.ability.targets).toHaveLength(1);

    // The discount is a CARD-LEVEL rule static, not part of the ability it trails.
    const discount = def.ruleStatics.find((r) => r.kind === 'costReduction');
    expect(discount).toEqual({
      kind: 'costReduction',
      appliesTo: 'activate',
      selfOnly: true,
      amount: {
        kind: 'countPermanents',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'controller', who: 'you' },
            { kind: 'supertype', value: 'Legendary' },
            { kind: 'type', value: 'Creature' },
          ],
        },
        scope: 'you',
      },
    });

    // The land half is untouched.
    expect(def.manaAbilities).toHaveLength(1);
  });

  it('is not offered without enough mana, and is once there is', () => {
    const ctx = pod();
    const player = p1(ctx);
    const card = conjure(ctx, 'P1', otawara(), 'hand');
    spawn(ctx, 'P2', bear());

    for (let i = 0; i < 3; i += 1) spawn(ctx, 'P1', island());
    expect(channelOption(ctx, player, card.id)).toBeUndefined();

    spawn(ctx, 'P1', island());
    expect(channelOption(ctx, player, card.id)).toBeDefined();
  });

  it('costs {1} less per legendary creature you control', () => {
    const ctx = pod();
    const player = p1(ctx);
    const card = conjure(ctx, 'P1', otawara(), 'hand');
    spawn(ctx, 'P2', bear());
    for (let i = 0; i < 3; i += 1) spawn(ctx, 'P1', island());

    // {3}{U} with three Islands is unpayable...
    expect(channelOption(ctx, player, card.id)).toBeUndefined();

    // ...until a legendary creature makes it {2}{U}. This is the reduction that
    // `activationCostReductionFor` cannot see, because the ability's source is in hand.
    spawn(ctx, 'P1', legendaryBear());
    const option = channelOption(ctx, player, card.id);
    expect(option).toBeDefined();
    expect(option!.data?.['manaCost']).toBe('{2}{U}');
  });

  it('discards itself, bounces the target, and never touches the battlefield', () => {
    const ctx = pod();
    const player = p1(ctx);
    const card = conjure(ctx, 'P1', otawara(), 'hand');
    const victim = spawn(ctx, 'P2', bear());
    for (let i = 0; i < 4; i += 1) spawn(ctx, 'P1', island());

    const option = channelOption(ctx, player, card.id);
    expect(option).toBeDefined();
    expect(option!.targets?.[0]?.options).toContain(victim.id);

    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, victim.id]]),
      }),
    );

    // The cost is paid at announcement (CR 601.2h): the land is in the graveyard while its
    // ability is still on the stack, and it never became a permanent.
    expect(player.hand.some((c) => c.cardId === card.cardId)).toBe(false);
    expect(player.graveyard.some((c) => c.cardId === card.cardId)).toBe(true);
    expect(ctx.state.battlefield.some((p) => p.cardId === card.cardId)).toBe(false);
    expect(ctx.state.stack).toHaveLength(1);

    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield.some((p) => p.id === victim.id)).toBe(false);
    const owner = ctx.state.players.find((p) => p.id === 'P2') as EnginePlayerState;
    expect(owner.hand.some((c) => c.cardId === victim.cardId)).toBe(true);
  });

  it('is not offered when nothing legal can be targeted (CR 602.2b)', () => {
    const ctx = pod();
    const player = p1(ctx);
    const card = conjure(ctx, 'P1', otawara(), 'hand');
    for (let i = 0; i < 4; i += 1) spawn(ctx, 'P1', island());
    // Lands are on the battlefield, but this ability targets only artifacts, creatures,
    // enchantments and planeswalkers.
    expect(channelOption(ctx, player, card.id)).toBeUndefined();
  });
});
