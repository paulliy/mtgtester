/**
 * Cut a Deal — coverage PR08.01 (docs/plans/card-coverage-chunks.md 8.01).
 *
 * The fail-closed containment said: "you draw for each opponent, not for each opponent who
 * drew a card." The corrected `drawForEachOpponent` op reads, per resolving instruction:
 * every opponent still in the game draws one (APNAP order, CR 101.4), then the caster draws
 * one for each opponent who ACTUALLY drew — a card reached their hand and the `draw` event
 * fired. The empty-library flag and the empty-library reanimation replacement are not draws,
 * and no state-based action runs during the spell's resolution (brief §5.6: the loss waits
 * for the next SBA check).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OracleCard, PlayerId } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { runPrioritySequence } from '../src/turn/priority';
import type { GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  island,
  oracle,
  pick,
  plains,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
) as PinnedFixture;
const pinned = fixture.cards.find((entry) => entry.card.name === 'Cut a Deal')!;

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function pod(seed = 'cut-a-deal'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(12, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

function player(ctx: GameContext, id: string) {
  const found = ctx.state.players.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
}

function handDelta(ctx: GameContext, id: PlayerId, before: number): number {
  return player(ctx, id).hand.length - before;
}

/** P2..P4 hands at the moment the spell resolves. */
function opponents(): ['P2', 'P3', 'P4'] {
  return ['P2', 'P3', 'P4'];
}

function handSizes(ctx: GameContext) {
  return {
    P1: player(ctx, 'P1').hand.length,
    P2: player(ctx, 'P2').hand.length,
    P3: player(ctx, 'P3').hand.length,
    P4: player(ctx, 'P4').hand.length,
  };
}

/** Resolve the pinned spell's ability directly (fixture level), answering any choice with option 0. */
function resolveCutADeal(ctx: GameContext): ReturnType<typeof pump> {
  const def = interpretCard(pinned.card);
  expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
  return pump(
    executeAbility(
      ctx,
      {
        cardId: 'cut-a-deal-card',
        name: pinned.card.name,
        oracleId: pinned.card.oracleId,
        controllerId: 'P1',
      },
      def.spellAbility!,
      [],
    ),
  );
}

/** Players (in event order) credited with an actual card draw. */
function drawEventPlayers(ctx: GameContext, from = 0): string[] {
  return ctx.state.eventLog
    .slice(from)
    .filter((event) => event.type === 'draw')
    .map((event) => String(event.payload['player']));
}

describe('Cut a Deal — coverage PR08.01', () => {
  it('cut-a-deal-pinned-oracle-supported — pins the exact Oracle record, hash, and both modeled ids', () => {
    expect(fixture.source).toBe('packages/server/fixtures/coverage-oracle.json');
    expect(fixture.retrievedAt).toBe('2026-10-17');
    expect(pinned.sha256).toBe('ebb114b6bfc41cef8114727a540ffd8b6f277c16b451d9652f5e2e1025a29b2d');
    expect(createHash('sha256').update(canonical(pinned.card)).digest('hex')).toBe(pinned.sha256);
    expect(pinned.card.oracleText).toBe(
      'Each opponent draws a card, then you draw a card for each opponent who drew a card this way.',
    );
    const real = interpretCard(pinned.card);
    const alias = interpretCard({ ...pinned.card, oracleId: 'oracle-cut-a-deal' });
    expect(real.modeled, real.unmodeledReasons.join('\n')).toBe(true);
    expect(alias.modeled, alias.unmodeledReasons.join('\n')).toBe(true);
    expect(real.spellAbility?.effects.map((effect) => effect.op)).toEqual(['drawForEachOpponent']);
    expect(real.spellAbility?.targets).toEqual([]);
    expect(real.spellAbility?.description).toContain(
      'Each opponent draws a card, then you draw a card for each opponent who drew a card this way',
    );
  });

  it('cut-a-deal-all-draw — every opponent draws in APNAP order, then the caster draws three', () => {
    const ctx = pod('all-draw');
    // Land sources are irrelevant to the direct resolution; only hands and libraries are.
    const before = handSizes(ctx);
    resolveCutADeal(ctx);

    expect(drawEventPlayers(ctx)).toEqual(['P2', 'P3', 'P4', 'P1', 'P1', 'P1']);
    expect(handDelta(ctx, 'P2', before.P2)).toBe(1);
    expect(handDelta(ctx, 'P3', before.P3)).toBe(1);
    expect(handDelta(ctx, 'P4', before.P4)).toBe(1);
    expect(handDelta(ctx, 'P1', before.P1)).toBe(3);
    for (const id of opponents())
      expect(player(ctx, id).attemptedDrawFromEmptyLibrary ?? false).toBe(false);
  });

  it('cut-a-deal-empty-library — an emptied library draws nothing and does not count', () => {
    const ctx = pod('empty-library');
    player(ctx, 'P2').library = [];
    const before = handSizes(ctx);
    resolveCutADeal(ctx);

    // P2 drew nothing: the second instruction counts only P3 and P4.
    expect(drawEventPlayers(ctx)).toEqual(['P3', 'P4', 'P1', 'P1']);
    expect(handDelta(ctx, 'P2', before.P2)).toBe(0);
    expect(handDelta(ctx, 'P1', before.P1)).toBe(2);
    expect(player(ctx, 'P2').attemptedDrawFromEmptyLibrary).toBe(true);
    // No state-based action ran mid-resolution: the empty-library flag was set, but P2's
    // loss (and every other SBA consequence) waits for the next SBA check.
    expect(player(ctx, 'P2').hasLost).toBe(false);
  });

  it('cut-a-deal-nonactive-caster — simultaneous opponents draw in APNAP order before the caster instruction', () => {
    const ctx = pod('nonactive-caster');
    ctx.state.currentTurnPlayer = 'P3';
    ctx.state.activePlayerIndex = 2;
    resolveCutADeal(ctx);
    expect(drawEventPlayers(ctx)).toEqual(['P3', 'P4', 'P2', 'P1', 'P1', 'P1']);
  });

  it('cut-a-deal-eliminated-opponent — a player who lost the game neither draws nor counts', () => {
    const ctx = pod('eliminated');
    player(ctx, 'P4').hasLost = true;
    const before = handSizes(ctx);
    resolveCutADeal(ctx);

    // "Each opponent" reads the caster's opponents still in the game (CR 608.2c/h); P4 is out.
    expect(drawEventPlayers(ctx)).toEqual(['P2', 'P3', 'P1', 'P1']);
    expect(handDelta(ctx, 'P4', before.P4)).toBe(0);
    expect(handDelta(ctx, 'P1', before.P1)).toBe(2);
  });

  it('cut-a-deal-empty-library-replacement — the reanimation replaces the draw and does not count', () => {
    const ctx = pod('replacement');
    const guardian = oracle({
      name: 'Guardian Idol of the Empty Library',
      typeLine: 'Artifact',
      manaCost: '{3}',
      oracleText:
        'If you would draw a card while your library is empty, put a creature card from your graveyard onto the battlefield instead.',
    });
    registerCustomDef(ctx, {
      ...interpretCard(guardian),
      emptyLibraryCreatureReplacement: true,
    });
    spawn(ctx, 'P2', guardian);
    conjure(
      ctx,
      'P2',
      oracle({ name: 'Resurrected Bear', typeLine: 'Creature — Bear' }),
      'graveyard',
    );
    player(ctx, 'P2').library = [];
    const before = handSizes(ctx);
    resolveCutADeal(ctx);

    // The replacement put the creature back instead of a draw: P2 drew no card, so the
    // caster's count reads only P3 and P4.
    expect(
      ctx.state.battlefield.filter(
        (permanent) => permanent.name === 'Resurrected Bear' && permanent.controllerId === 'P2',
      ),
    ).toHaveLength(1);
    expect(drawEventPlayers(ctx)).toEqual(['P3', 'P4', 'P1', 'P1']);
    expect(handDelta(ctx, 'P2', before.P2)).toBe(0);
    expect(handDelta(ctx, 'P1', before.P1)).toBe(2);
    expect(player(ctx, 'P2').attemptedDrawFromEmptyLibrary ?? false).toBe(false);
  });

  it('cut-a-deal-all-opponents-gone — nothing happens when no opponent is left', () => {
    const ctx = pod('no-opponents');
    for (const id of opponents()) player(ctx, id).hasLost = true;
    const before = handSizes(ctx);
    resolveCutADeal(ctx);

    expect(drawEventPlayers(ctx)).toEqual([]);
    expect(handDelta(ctx, 'P1', before.P1)).toBe(0);
  });

  it('cut-a-deal-normal-cast — pays {2}{W}, resolves through priority and the stack, draws in APNAP order', () => {
    const ctx = pod('normal-cast-path');
    const mana = spawn(ctx, 'P1', plains());
    const filler = spawn(ctx, 'P1', island());
    const spare = spawn(ctx, 'P1', forest());
    conjure(ctx, 'P1', pinned.card, 'hand');
    const before = handSizes(ctx);
    let cast = false;
    pump(runPrioritySequence(ctx), (decision) => {
      if (decision.player === 'P1' && !cast) {
        const index = decision.options.findIndex((option) =>
          option.description.includes('Cast Cut a Deal'),
        );
        if (index >= 0) {
          cast = true;
          return { index, targets: new Map() };
        }
      }
      return pick(decision, 'Pass');
    });

    expect(cast).toBe(true);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'Cut a Deal',
      ),
    ).toBe(true);
    // All three sources were down for {2}{W}: no mana was left floating for a free pass.
    for (const permanent of [mana, filler, spare]) expect(permanent.tapped).toBe(true);
    expect(drawEventPlayers(ctx)).toEqual(['P2', 'P3', 'P4', 'P1', 'P1', 'P1']);
    // The cast itself left P1's hand; the three "actually drew" draws replace it.
    expect(handDelta(ctx, 'P1', before.P1)).toBe(2);
  });

  it('cut-a-deal-cast-legality — the cast is not offered when {2}{W} cannot be paid', () => {
    const ctx = pod('unpayable');
    spawn(ctx, 'P1', island());
    spawn(ctx, 'P1', island());
    spawn(ctx, 'P1', island());
    conjure(ctx, 'P1', pinned.card, 'hand');
    // Three mana sources are available, but none can produce the required white mana.
    let offered = false;
    pump(runPrioritySequence(ctx), (decision) => {
      if (
        decision.player === 'P1' &&
        decision.options.some((option) => option.type === 'castSpell')
      )
        offered ||= decision.options.some((option) =>
          option.description.includes('Cast Cut a Deal'),
        );
      return pick(decision, 'Pass');
    });
    expect(offered).toBe(false);
    expect(player(ctx, 'P1').hand.some((card) => card.name === 'Cut a Deal')).toBe(true);
    expect(drawEventPlayers(ctx)).toEqual([]);
  });

  it('cut-a-deal-sorcery-timing — payable mana does not permit casting during an opponent’s turn', () => {
    const ctx = pod('off-turn');
    spawn(ctx, 'P1', plains());
    spawn(ctx, 'P1', island());
    spawn(ctx, 'P1', forest());
    conjure(ctx, 'P1', pinned.card, 'hand');
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    let offered = false;
    pump(runPrioritySequence(ctx), (decision) => {
      if (decision.player === 'P1')
        offered ||= decision.options.some((option) =>
          option.description.includes('Cast Cut a Deal'),
        );
      return pick(decision, 'Pass');
    });
    expect(offered).toBe(false);
    expect(player(ctx, 'P1').hand.some((card) => card.name === 'Cut a Deal')).toBe(true);
    expect(drawEventPlayers(ctx)).toEqual([]);
  });
});
