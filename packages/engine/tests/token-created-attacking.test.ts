/**
 * `createTokenAttacking` (issue #95, known gap `token-created-attacking`): a token put onto the
 * battlefield attacking attacks whichever defending player, or planeswalker one of them controls,
 * its controller chooses as that token enters (CR 508.4). With attacks on several players every
 * opponent is a defending player (CR 802.2), so the choice is not limited to players already
 * attacked, each token gets its own choice, and a player first attacked by a token can block it.
 * Outside combat, or for a player who is not attacking, the tokens still enter but never attack
 * (CR 506.3b, 508.4a). They enter tapped unless the text leaves out "tapped".
 */
import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '../src/cards/definition';
import type { Effect } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { spell } from '../src/cards/templates';
import { SOLDIER_1_1 } from '../src/cards/tokens';
import { constant } from '../src/cards/value';
import type { PendingDecision } from '../src/decisions';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runCombatAndExtraCombats } from '../src/turn/turn';
import {
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  oracle,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

/** A four-player game in P1's declare-attackers step, with `attacked` already attacked. */
function inCombat(seed: string, attacked: string[] = ['P2']): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'combat';
  ctx.state.step = 'declareAttackers';
  ctx.state.combat = { defendingPlayers: [...attacked] };
  return ctx;
}

const attackingTokens = (
  n: number,
  extra: Partial<Extract<Effect, { op: 'createTokenAttacking' }>> = {},
) =>
  spell({
    effects: [{ op: 'createTokenAttacking', spec: SOLDIER_1_1, count: constant(n), ...extra }],
  });

/** Resolve the effect for `controllerId`; `pick` answers each "who the token attacks" choice. */
function resolve(
  ctx: GameContext,
  controllerId: string,
  ability: ReturnType<typeof spell>,
  pick: (descriptions: string[], asked: number) => string = (d) => d[0]!,
) {
  const asked: string[][] = [];
  pump(
    executeAbility(
      ctx,
      { cardId: 'src', oracleId: 'probe', name: 'Probe', controllerId },
      ability,
      [],
    ),
    (decision: PendingDecision) => {
      const descriptions = decision.options.map((option) => option.description);
      asked.push(descriptions);
      return {
        index: descriptions.indexOf(pick(descriptions, asked.length - 1)),
        targets: new Map(),
      };
    },
  );
  const tokens = ctx.state.battlefield.filter((perm) => perm.isToken && perm.name === 'Soldier');
  return { asked, tokens };
}

const WALKER = oracle({
  name: 'Lab Walker',
  typeLine: 'Planeswalker — Lab',
  manaCost: '{3}',
  cmc: 3,
  loyalty: '5',
  oracleText: '',
});
const BEAR = (name: string) =>
  oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2' });

describe('tokens created attacking', () => {
  it('token-attacking-unattacked-opponent — every opponent and their planeswalkers are offered, not only players already attacked (CR 802.2)', () => {
    const ctx = inCombat('tca-unattacked', ['P2']);
    spawn(ctx, 'P3', WALKER);
    const { asked, tokens } = resolve(ctx, 'P1', attackingTokens(1), () => 'Attack P4');
    expect(asked).toEqual([['Attack P2', 'Attack P3', 'Attack Lab Walker', 'Attack P4']]);
    expect(tokens.map((token) => token.attacking)).toEqual(['P4']);
    // P4 is a defending player from now on, so P4 can block it.
    expect(ctx.state.combat?.defendingPlayers).toEqual(['P2', 'P4']);
  });

  it('token-attacking-each-token-chooses — each token gets its own choice, not one shared choice (CR 508.4)', () => {
    const ctx = inCombat('tca-each');
    const order = ['Attack P2', 'Attack P3'];
    const { asked, tokens } = resolve(ctx, 'P1', attackingTokens(2), (_d, i) => order[i]!);
    expect(asked).toHaveLength(2);
    expect(tokens.map((token) => token.attacking)).toEqual(['P2', 'P3']);
  });

  it('token-attacking-tapped — "tapped and attacking" enters tapped; without "tapped" it enters untapped', () => {
    const tapped = resolve(inCombat('tca-tapped'), 'P1', attackingTokens(1));
    expect(tapped.tokens.map((token) => [token.tapped, token.attacking])).toEqual([[true, 'P2']]);
    const untapped = resolve(
      inCombat('tca-untapped'),
      'P1',
      attackingTokens(1, { untapped: true }),
    );
    expect(untapped.tokens.map((token) => [token.tapped, token.attacking])).toEqual([
      [false, 'P2'],
    ]);
  });

  it('token-attacking-outside-combat — outside combat the tokens still enter, tapped, and never attack (CR 506.3)', () => {
    const ctx = inCombat('tca-main');
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    ctx.state.combat = null;
    const { asked, tokens } = resolve(ctx, 'P1', attackingTokens(2));
    expect(asked).toEqual([]);
    expect(tokens.map((token) => [token.tapped, token.attacking ?? null])).toEqual([
      [true, null],
      [true, null],
    ]);
  });

  it("token-attacking-not-attacking-player — a non-active player's token enters but never attacks (CR 506.3b)", () => {
    const ctx = inCombat('tca-nonactive');
    const { asked, tokens } = resolve(ctx, 'P3', attackingTokens(1));
    expect(asked).toEqual([]);
    expect(tokens.map((token) => [token.controllerId, token.attacking ?? null])).toEqual([
      ['P3', null],
    ]);
  });

  it('token-attacking-opponent-left — an opponent who left the game is not offered', () => {
    const ctx = inCombat('tca-left');
    playerById(ctx, 'P3').hasLost = true;
    const { asked } = resolve(ctx, 'P1', attackingTokens(1));
    expect(asked).toEqual([['Attack P2', 'Attack P4']]);
  });

  it('token-attacking-whole-combat — a player first attacked by the token is asked to block, and can block it', () => {
    const ctx = inCombat('tca-combat');
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    ctx.state.combat = null;
    // "Whenever this creature attacks, create a 1/1 white Soldier creature token that's tapped
    // and attacking." (Skyknight Vanguard's line, on a stand-in.)
    const vanguard = oracle({
      name: 'Lab Vanguard',
      typeLine: 'Creature — Human Soldier',
      power: '1',
      toughness: '2',
    });
    const attacker = spawn(ctx, 'P1', vanguard);
    const def: CardDefinition = {
      ...interpretCard(vanguard),
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'attacks', subject: { kind: 'self' } },
          optional: false,
          targets: [],
          effects: [{ op: 'createTokenAttacking', spec: SOLDIER_1_1, count: constant(1) }],
        },
      ],
    };
    registerCustomDef(ctx, def);
    const blocker = spawn(ctx, 'P4', BEAR('P4 Bear'));
    const askedToBlock: string[] = [];
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (id) => (id === attacker.id ? 'P2' : null));
      if (decision.presentationBlockDeclaration !== undefined) {
        askedToBlock.push(decision.player);
        const token = ctx.state.battlefield.find((perm) => perm.isToken && perm.name === 'Soldier');
        return declareBlocks(decision, (id) => (id === blocker.id ? (token?.id ?? null) : null));
      }
      const attack = decision.options.findIndex((option) => option.description === 'Attack P4');
      if (attack >= 0) return { index: attack, targets: new Map() };
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    // P4 was never declared against, yet is asked to block and kills the 1/1 Soldier.
    expect(askedToBlock).toContain('P4');
    expect(ctx.state.battlefield.some((perm) => perm.isToken && perm.name === 'Soldier')).toBe(
      false,
    );
    expect(playerById(ctx, 'P4').life).toBe(40);
  });
});
