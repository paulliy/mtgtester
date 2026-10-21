import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import { addMana } from '../src/mana/pool';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { buildPlayerBoardState } from '../src/view/spectator';
import { runPrioritySequence } from '../src/turn/priority';
import { presentedCard } from '../src/present';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const pins = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { card: OracleCard }[];
  }
).cards;
/** Locate a real pinned definition rather than authoring a test-only spell. */
function pinned(name: string): OracleCard {
  const pin = pins.find((entry) => entry.card.name === name);
  if (!pin) throw new Error(`Missing PR08 pin: ${name}`);
  return pin.card;
}

describe('PR08 opponent permanent choices', () => {
  for (const spellName of ["Council's Judgment", 'Tragic Arrogance']) {
    it(`${spellName} keeps face-down identity out of the caster's choices`, () => {
      const ctx = createGame(
        gameConfig(
          [0, 1, 2, 3].map(() => ({ cards: copies(10, forest) })),
          { seed: spellName },
        ),
      );
      Object.assign(ctx.state, {
        currentTurnPlayer: 'P1',
        activePlayerIndex: 0,
        turnNumber: 5,
        phase: 'precombatMain',
        step: null,
      });
      const secret = conjure(ctx, 'P2', pinned('Boseiju, Who Endures'), 'hand');
      const hidden = pump(
        moveObject(ctx, secret, { zone: 'battlefield', controllerId: 'P2', faceDown: true }),
      ).value!;
      spawn(ctx, 'P2', oracle({ name: 'Public alternative' }));
      const board = buildPlayerBoardState(ctx, 'P1').battlefield.find((p) => p.id === hidden.id)!;
      expect(board.scryfallId).toBeNull();
      expect(presentedCard(ctx, hidden, undefined, 'P2').scryfallId).toBe(
        pinned('Boseiju, Who Endures').scryfallId,
      );
      const spell = conjure(ctx, 'P1', pinned(spellName), 'hand');
      addMana(
        playerById(ctx, 'P1'),
        ['W', 'W', 'C', 'C', 'C'].map((symbol) => ({ symbol: symbol as 'W' | 'C' })),
      );
      const cast = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'castSpell' && payload.objectId === spell.id;
      });
      expect(cast).toBeDefined();
      pump(
        applyPriorityAction(ctx, playerById(ctx, 'P1'), cast!.payload as PriorityActionPayload, {
          index: 0,
          targets: new Map(),
        }),
      );
      let inspected = 0;
      pump(runPrioritySequence(ctx), (decision) => {
        const pass = decision.options.findIndex((option) => option.type === 'pass');
        if (pass >= 0) return { index: pass, targets: new Map() };
        if (decision.player === 'P1') {
          for (const option of decision.options)
            for (const subject of option.presentation?.subjects ?? []) {
              if (subject.kind !== 'card' || subject.card.objectId !== hidden.id) continue;
              inspected++;
              expect(subject.card).toMatchObject({
                name: 'Face-down permanent',
                scryfallId: null,
                typeLine: 'Creature',
              });
            }
        }
        return { index: spellName === "Council's Judgment" ? 1 : 0, targets: new Map() };
      });
      expect(inspected).toBeGreaterThan(0);
      expect(ctx.state.battlefield).toContain(hidden);
    });
  }
});
