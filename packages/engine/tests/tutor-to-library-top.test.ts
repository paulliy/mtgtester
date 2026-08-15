/**
 * "…then shuffle and put that card on top" — `SearchDestination.zone: 'libraryTop'`.
 *
 * The EDH-staple coverage plan's Tier 2 item 2 (Vampiric, Mystical, Enlightened, Worldly
 * Tutor). The cards are named for orientation; the cases below are the printed TEMPLATE on
 * synthetic cards, which is what the grammar contracts to.
 *
 * The ordering assertion is the reason this file exists. The template's clauses run
 * shuffle-then-place, the reverse of every other search the engine models, so representing it
 * as the usual `searchLibrary` + `shuffle` pair would put the tutored card back into a
 * shuffled library — a tutor that tutors nothing, silently. The test therefore checks *where
 * the card ended up*, not just that both steps happened.
 */

import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump } from './fixtures';

const mysticalTutor = (): OracleCard =>
  oracle({
    name: 'Test Mystical Tutor',
    typeLine: 'Instant',
    manaCost: '{U}',
    colors: ['U'],
    colorIdentity: ['U'],
    power: null,
    toughness: null,
    oracleText:
      'Search your library for an instant or sorcery card, reveal that card, then shuffle and put that card on top.',
  });

const vampiricTutor = (): OracleCard =>
  oracle({
    name: 'Test Vampiric Tutor',
    typeLine: 'Instant',
    manaCost: '{B}',
    colors: ['B'],
    colorIdentity: ['B'],
    power: null,
    toughness: null,
    oracleText:
      'Search your library for a card, then shuffle and put that card on top. You lose 2 life.',
  });

const spell = (name: string, typeLine: string): OracleCard =>
  oracle({ name, typeLine, manaCost: '{1}', power: null, toughness: null });

function pod(seed = 'tutor-to-top'): GameContext {
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

const cast = (ctx: GameContext, def: ReturnType<typeof interpretCard>, pick?: string): void => {
  pump(
    executeAbility(
      ctx,
      { cardId: 'tutor-1', name: def.name, oracleId: def.oracleId, controllerId: 'P1' },
      def.spellAbility ?? { kind: 'spell', targets: [], effects: [] },
      [],
    ),
    (decision) => {
      const found = decision.options.findIndex((o) => pick !== undefined && o.description.includes(pick));
      return { index: found >= 0 ? found : 0, targets: new Map() };
    },
  );
};

describe('tutor to the top of the library', () => {
  it('parses to a single search op — no trailing shuffle to undo it', () => {
    const def = interpretCard(mysticalTutor());

    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.effects).toEqual([
      {
        op: 'searchLibrary',
        filter: {
          kind: 'anyOf',
          of: [{ kind: 'type', value: 'Instant' }, { kind: 'type', value: 'Sorcery' }],
        },
        destinations: [{ zone: 'libraryTop' }],
      },
    ]);
  });

  it('leaves the found card on top, not shuffled back in', () => {
    const ctx = pod();
    // A big enough library that "on top by luck" is not a plausible explanation.
    for (let i = 0; i < 12; i++) conjure(ctx, 'P1', forest(), 'library');
    conjure(ctx, 'P1', spell('Test Counterspell', 'Instant'), 'library');
    const librarySize = p1(ctx).library.length;

    cast(ctx, interpretCard(mysticalTutor()), 'Test Counterspell');

    expect(p1(ctx).library[0]?.name).toBe('Test Counterspell');
    expect(p1(ctx).library).toHaveLength(librarySize);
  });

  it('only offers cards matching the filter', () => {
    const ctx = pod();
    conjure(ctx, 'P1', spell('Test Sorcery Card', 'Sorcery'), 'library');
    conjure(ctx, 'P1', spell('Test Instant Card', 'Instant'), 'library');
    conjure(ctx, 'P1', spell('Test Artifact Card', 'Artifact'), 'library');

    const { decisions } = pump(
      executeAbility(
        ctx,
        { cardId: 'tutor-1', name: 'Test Mystical Tutor', oracleId: 'tutor-oracle', controllerId: 'P1' },
        interpretCard(mysticalTutor()).spellAbility!,
        [],
      ),
      (decision) => {
        const pick = decision.options.findIndex((o) => o.description.includes('Test Sorcery Card'));
        return { index: pick >= 0 ? pick : 0, targets: new Map() };
      },
    );

    // Two eligible cards, so the engine actually asks (one would be auto-selected). Forests and
    // the artifact are in the library too, and neither is an instant or sorcery.
    const offered = decisions.flatMap((d) => d.options.map((o) => o.description));
    expect(offered.some((d) => d.includes('Test Sorcery Card'))).toBe(true);
    expect(offered.some((d) => d.includes('Test Instant Card'))).toBe(true);
    expect(offered.some((d) => d.includes('Test Artifact Card'))).toBe(false);
    expect(offered.some((d) => d.includes('Forest'))).toBe(false);
    expect(p1(ctx).library[0]?.name).toBe('Test Sorcery Card');
  });

  it('still shuffles when the player declines to find', () => {
    const ctx = pod();
    for (let i = 0; i < 10; i++) conjure(ctx, 'P1', forest(), 'library');
    conjure(ctx, 'P1', spell('Test Sorcery Card', 'Sorcery'), 'library');
    const before = p1(ctx).library.map((c) => c.id);

    cast(ctx, interpretCard(mysticalTutor()), 'Find nothing');

    const after = p1(ctx).library.map((c) => c.id);
    expect(after).toHaveLength(before.length);
    expect(after).not.toEqual(before); // CR 701.19c: declining does not skip the shuffle.
  });

  it('reads the unrestricted form, and its life payment, as one card', () => {
    const def = interpretCard(vampiricTutor());
    expect(def.modeled).toBe(true);
    expect(def.spellAbility?.effects).toEqual([
      { op: 'searchLibrary', filter: { kind: 'allOf', of: [] }, destinations: [{ zone: 'libraryTop' }] },
      { op: 'loseLife', amount: { kind: 'const', n: 2 } },
    ]);

    const ctx = pod();
    for (let i = 0; i < 8; i++) conjure(ctx, 'P1', forest(), 'library');
    conjure(ctx, 'P1', spell('Test Wincon', 'Sorcery'), 'library');
    const lifeBefore = p1(ctx).life;

    cast(ctx, def, 'Test Wincon');

    expect(p1(ctx).library[0]?.name).toBe('Test Wincon');
    expect(p1(ctx).life).toBe(lifeBefore - 2);
  });
});
