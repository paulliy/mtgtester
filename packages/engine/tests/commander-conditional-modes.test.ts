/**
 * "Choose one. If you control a commander as you cast this spell, you may choose both instead."
 * (Jeska's Will, Akroma's Will) — the EDH-staple coverage plan's Tier 2 item 6.
 *
 * A GATE, not a closure: it makes the mode cap state-dependent, and closes neither real card on
 * its own. Both are still blocked on their MODES — Akroma's Will wants "protection from all
 * colors until end of turn" (an until-EOT effect carries a single keyword name, with nowhere to
 * put a protection grant), Jeska's Will wants "Add {R} for each card in target opponent's hand"
 * and a play-from-exile window. The header is worth landing separately because those are three
 * unrelated primitives, and this is the one piece both cards share.
 *
 * The cap is resolved during option generation rather than at resolution: the number of modes
 * is locked in at announcement (CR 601.2b), and each legal mode set is already its own cast
 * option, so an offered option stays applicable no matter what happens to the commander after.
 */

import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, spawn } from './fixtures';

const willShaped = (): OracleCard =>
  oracle({
    name: 'Test Commander Will',
    typeLine: 'Instant',
    manaCost: '{2}{W}',
    cmc: 3,
    colors: ['W'],
    colorIdentity: ['W'],
    power: null,
    toughness: null,
    oracleText:
      'Choose one. If you control a commander as you cast this spell, you may choose both instead.\n• Creatures you control gain flying and vigilance until end of turn.\n• Creatures you control gain trample and haste until end of turn.',
  });

function pod(seed = 'commander-modes'): GameContext {
  const ctx = createGame(
    gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(6, forest) })), { seed }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P1') as EnginePlayerState;

/** A board with three white sources and the spell in hand; `withCommander` adds a commander. */
function board(withCommander: boolean): GameContext {
  const ctx = pod();
  for (let i = 0; i < 3; i++) {
    spawn(ctx, 'P1', oracle({ name: 'Plains', typeLine: 'Basic Land — Plains', manaCost: null, power: null, toughness: null }));
  }
  const general = spawn(ctx, 'P1', oracle({ name: 'Test General', typeLine: 'Legendary Creature — Soldier' }));
  general.isCommander = withCommander;
  conjure(ctx, 'P1', willShaped(), 'hand');
  return ctx;
}

const modeLabelsOffered = (ctx: GameContext): string[] =>
  computePriorityOptions(ctx, p1(ctx))
    .filter((o) => o.type === 'castSpell' && o.description.includes('Test Commander Will'))
    .map((o) => String(o.data?.['modeLabel'] ?? ''));

describe('commander-conditional modal header', () => {
  it('parses the two caps separately', () => {
    const def = interpretCard(willShaped());

    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.modes).toMatchObject({
      minChoices: 1,
      maxChoices: 1,
      maxChoicesWithCommander: 2,
    });
    expect(def.spellAbility?.modes?.options).toHaveLength(2);
  });

  it('offers one mode at a time without a commander', () => {
    const offered = modeLabelsOffered(board(false));

    expect(offered).toHaveLength(2);
    expect(offered.every((label) => !label.includes(';'))).toBe(true);
  });

  it('adds the both-modes option while a commander is on the battlefield', () => {
    const offered = modeLabelsOffered(board(true));

    expect(offered).toHaveLength(3);
    expect(offered.filter((label) => label.includes(';'))).toHaveLength(1);
  });

  it('reads an opponent’s commander as no commander at all', () => {
    const ctx = board(false);
    const theirs = spawn(ctx, 'P2', oracle({ name: 'Test Rival General', typeLine: 'Legendary Creature — Soldier' }));
    theirs.isCommander = true;

    expect(modeLabelsOffered(ctx)).toHaveLength(2);
  });

  it('refuses a header promising more modes than the card prints', () => {
    // "You may choose both" over a single bullet is a misread template, not a card — guessing a
    // cap here would invent a mode combination that does not exist.
    const def = interpretCard(
      oracle({
        name: 'Test Malformed Will',
        typeLine: 'Instant',
        manaCost: '{1}{W}',
        power: null,
        toughness: null,
        oracleText:
          'Choose two. If you control a commander as you cast this spell, you may choose three instead.\n• Creatures you control gain flying until end of turn.\n• Creatures you control gain haste until end of turn.',
      }),
    );

    expect(def.modeled).toBe(false);
  });
});
