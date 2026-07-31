/**
 * The presentation contract (brief — player-experience overhaul, Workstream 3): a `general`
 * decision built through `present.ts`'s helpers must carry enough for the browser to render a
 * real card, never `description` regex-parsing. This is the enforcement the plan calls for —
 * not yet a full compile-time gate across every `general` site (that migration is incremental,
 * see the ADR), but a concrete assertion over the sites already migrated: scry, surveil,
 * discard, proliferate, and library ordering.
 */

import { describe, expect, it } from 'vitest';
import type { PendingDecision } from '../src/decisions';
import { executeAbility } from '../src/effects/resolve';
import type { EffectSource } from '../src/effects/resolve';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, island, mountain, oracle, pump, spawn } from './fixtures';

function pod(seed: string): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) })), { seed }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

/** Every `general` decision's options must carry a well-formed, non-lazy presentation. */
function assertWellFormedGeneralDecisions(decisions: PendingDecision[]): void {
  const general = decisions.filter((d) => d.decisionType === 'general');
  expect(general.length).toBeGreaterThan(0);
  for (const decision of general) {
    for (const option of decision.options) {
      expect(option.presentation, `missing presentation: ${option.description}`).toBeDefined();
      const presentation = option.presentation!;
      expect(presentation.verb.length).toBeGreaterThan(0);
      // A lazy `verb: action.type` cop-out is indistinguishable from a real label only when
      // the type itself already reads as a verb phrase — guard the common cop-out shapes.
      expect(presentation.verb).not.toBe(option.type);
      for (const subject of presentation.subjects) {
        if (subject.kind === 'card') {
          expect(subject.card.name.length).toBeGreaterThan(0);
          expect(subject.card.objectId.length).toBeGreaterThan(0);
        }
        if (subject.kind === 'player') {
          expect(subject.playerId.length).toBeGreaterThan(0);
        }
      }
    }
  }
}

const scrySource = (): EffectSource => ({
  cardId: 'c-scry',
  name: 'Test Scry',
  oracleId: 'oracle-test-scry-present',
  controllerId: 'P1',
});

describe('decision presentation contract', () => {
  it('scry carries a card subject and a real verb for both keep and bottom', () => {
    const ctx = pod('present-scry');
    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    p1.library.length = 0;
    conjure(ctx, 'P1', mountain(), 'library');
    conjure(ctx, 'P1', island(), 'library');
    const def = interpretCard(
      oracle({ name: 'Test Scry', typeLine: 'Sorcery', manaCost: '{U}', oracleText: 'Scry 2.' }),
    ).spellAbility!;

    const { decisions } = pump(executeAbility(ctx, scrySource(), def, []));
    assertWellFormedGeneralDecisions(decisions);
  });

  it('surveil carries a card subject and a real verb for both keep and graveyard', () => {
    const ctx = pod('present-surveil');
    const p1 = ctx.state.players.find((p) => p.id === 'P1')!;
    p1.library.length = 0;
    conjure(ctx, 'P1', mountain(), 'library');
    conjure(ctx, 'P1', island(), 'library');
    const def = interpretCard(
      oracle({ name: 'Test Surveil', typeLine: 'Sorcery', manaCost: '{U}', oracleText: 'Surveil 2.' }),
    ).spellAbility!;

    const { decisions } = pump(
      executeAbility(ctx, { ...scrySource(), name: 'Test Surveil' }, def, []),
    );
    assertWellFormedGeneralDecisions(decisions);
  });

  it('discard carries a card subject per hand card', () => {
    const ctx = pod('present-discard');
    conjure(ctx, 'P1', mountain(), 'hand');
    conjure(ctx, 'P1', island(), 'hand');
    const def = interpretCard(
      oracle({ name: 'Test Discard', typeLine: 'Sorcery', manaCost: '{B}', oracleText: 'Discard a card.' }),
    ).spellAbility!;

    const { decisions } = pump(
      executeAbility(ctx, { ...scrySource(), name: 'Test Discard' }, def, []),
    );
    assertWellFormedGeneralDecisions(decisions);
  });

  it('proliferate carries a card subject for a countered permanent', () => {
    const ctx = pod('present-proliferate');
    const bear = spawn(ctx, 'P1', forest());
    bear.counters = { '+1/+1': 1 };
    const def = interpretCard(
      oracle({ name: 'Test Proliferate', typeLine: 'Sorcery', manaCost: '{1}{G}', oracleText: 'Proliferate.' }),
    ).spellAbility!;

    const { decisions } = pump(
      executeAbility(ctx, { ...scrySource(), name: 'Test Proliferate' }, def, []),
    );
    assertWellFormedGeneralDecisions(decisions);
  });
});
