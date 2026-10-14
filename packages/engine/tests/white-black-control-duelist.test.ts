import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { computeCharacteristics } from '../src/effects/continuous';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlDuelistOverrides } from '../src/cards/overrides/white-black-control-duelist';
import { runCombatPhase } from '../src/combat/combat';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import {
  conjure,
  copies,
  declareAttacks,
  doom,
  gameConfig,
  oracle,
  pick,
  pump,
  spawn,
  swamp,
  plains,
} from './fixtures';

const cards = JSON.parse(
  readFileSync('packages/server/fixtures/white-black-control-oracle.json', 'utf8'),
) as OracleCard[];
const heritage: OracleCard = (() => {
  const card = cards.find((candidate) => candidate.name === "Duelist's Heritage");
  if (card === undefined) throw new Error("Missing pinned Oracle card: Duelist's Heritage");
  return card;
})();

// The existing registry contains explicit containment; install the replacement locally until
// the root registry is wired to the new deck registration. Once wired, use its normal entry.
if (!interpretCard(heritage).modeled) registerWhiteBlackControlDuelistOverrides();

const regularAttacker = (name: string) =>
  oracle({
    name,
    typeLine: 'Creature — Soldier',
    manaCost: '{1}{W}',
    power: '2',
    toughness: '2',
  });

function context(): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, plains) })),
      {
        seed: 'white-black-control-duelist',
      },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}

/** Cast the real pinned card using ordinary priority, mana payment, and stack resolution. */
function castHeritage(ctx: GameContext): void {
  for (let i = 0; i < 3; i++) spawn(ctx, 'P1', plains());
  conjure(ctx, 'P1', heritage, 'hand');
  let cast = false;
  pump(runPrioritySequence(ctx), (decision) => {
    if (decision.player === 'P1' && decision.decisionType === 'priority' && !cast) {
      const index = decision.options.findIndex(
        (option) =>
          option.type === 'castSpell' && option.description.includes("Duelist's Heritage"),
      );
      if (index >= 0) {
        cast = true;
        return { index, targets: new Map() };
      }
    }
    return pick(decision, /Pass|does not/i);
  });
  expect(cast).toBe(true);
  expect(ctx.state.battlefield.some((permanent) => permanent.name === "Duelist's Heritage")).toBe(
    true,
  );
}

function hasDoubleStrike(ctx: GameContext, permanentId: string): boolean {
  const permanent = ctx.state.battlefield.find((candidate) => candidate.id === permanentId);
  return (
    permanent !== undefined &&
    computeCharacteristics(ctx, permanent).keywords.includes('double strike')
  );
}

describe("Duelist's Heritage — pinned Oracle clause: one-or-more creatures attack", () => {
  it('models the exact pinned Oracle text', () => {
    const definition = interpretCard(heritage);
    expect(definition.modeled).toBe(true);
    expect(definition.unmodeledReasons).toEqual([]);
    expect(definition.triggers).toHaveLength(1);
    expect(definition.triggers[0]?.trigger).toMatchObject({
      when: 'attacks',
      subject: { kind: 'permanent' },
      aggregate: true,
    });
  });

  it('puts one optional target trigger on the stack when several creatures attack', () => {
    const ctx = context();
    castHeritage(ctx);
    const first = spawn(ctx, 'P1', regularAttacker('First Attacker'));
    const second = spawn(ctx, 'P1', regularAttacker('Second Attacker'));
    ctx.state.phase = 'combat';

    const { decisions } = pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (_id, subject) =>
          subject.name === first.name || subject.name === second.name ? 'P2' : null,
        );
      if (decision.decisionType === 'chooseTargets') {
        return { index: 0, targets: new Map([[0, first.id]]) };
      }
      if (decision.options.some((option) => option.description === 'Yes'))
        return pick(decision, /Yes|have/i);
      return pick(decision, /Pass|does not/i);
    });

    const targetChoices = decisions.filter((decision) => decision.decisionType === 'chooseTargets');
    expect(targetChoices).toHaveLength(1);
    expect(targetChoices[0]?.options[0]?.targets?.[0]?.options).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    expect(hasDoubleStrike(ctx, first.id)).toBe(true);
    expect(hasDoubleStrike(ctx, second.id)).toBe(false);
  });

  it('allows the controller to decline the optional trigger', () => {
    const ctx = context();
    castHeritage(ctx);
    const attacker = spawn(ctx, 'P1', regularAttacker('Declined Attacker'));
    ctx.state.phase = 'combat';

    const { decisions } = pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (_id, subject) =>
          subject.name === attacker.name ? 'P2' : null,
        );
      if (decision.options.some((option) => option.description === 'Yes'))
        return pick(decision, /No|decline/i);
      return pick(decision, /Pass|does not/i);
    });

    expect(
      decisions.some((decision) => decision.options.some((option) => option.description === 'Yes')),
    ).toBe(true);
    expect(hasDoubleStrike(ctx, attacker.id)).toBe(false);
  });

  it('can target an opponent creature that is attacking and excludes a nonattacking creature', () => {
    const ctx = context();
    castHeritage(ctx);
    const opponentAttacker = spawn(ctx, 'P2', regularAttacker('Opponent Attacker'));
    const secondOpponentAttacker = spawn(ctx, 'P2', regularAttacker('Second Opponent Attacker'));
    const idleCreature = spawn(ctx, 'P2', regularAttacker('Idle Creature'));
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    ctx.state.phase = 'combat';

    const { decisions } = pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (_id, subject) =>
          subject.name === opponentAttacker.name || subject.name === secondOpponentAttacker.name
            ? 'P1'
            : null,
        );
      if (decision.decisionType === 'chooseTargets') {
        const options = decision.options[0]?.targets?.[0]?.options ?? [];
        expect(options).toContain(opponentAttacker.id);
        expect(options).toContain(secondOpponentAttacker.id);
        expect(options).not.toContain(idleCreature.id);
        return { index: 0, targets: new Map([[0, opponentAttacker.id]]) };
      }
      if (decision.options.some((option) => option.description === 'Yes'))
        return pick(decision, /Yes|have/i);
      return pick(decision, /Pass|does not/i);
    });

    expect(decisions.some((decision) => decision.decisionType === 'chooseTargets')).toBe(true);
    expect(hasDoubleStrike(ctx, opponentAttacker.id)).toBe(true);
  });

  it('fizzles if the chosen attacker leaves before the trigger resolves', () => {
    const ctx = context();
    castHeritage(ctx);
    const attacker = spawn(ctx, 'P2', regularAttacker('Removed Attacker'));
    spawn(ctx, 'P2', swamp());
    conjure(ctx, 'P2', doom(), 'hand');
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    ctx.state.phase = 'combat';

    let doomCast = false;
    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (_id, subject) =>
          subject.name === attacker.name ? 'P1' : null,
        );
      if (decision.decisionType === 'chooseTargets')
        return { index: 0, targets: new Map([[0, attacker.id]]) };
      if (decision.options.some((option) => option.description === 'Yes'))
        return pick(decision, /Yes|have/i);
      if (
        decision.decisionType === 'priority' &&
        decision.player === 'P2' &&
        ctx.state.step === 'declareAttackers'
      ) {
        const index = decision.options.findIndex(
          (option) => option.type === 'castSpell' && option.description.includes('Test Doom'),
        );
        if (index >= 0) {
          doomCast = true;
          return { index, targets: new Map([[0, attacker.id]]) };
        }
      }
      return pick(decision, /Pass|does not/i);
    });

    expect(doomCast).toBe(true);
    expect(ctx.state.battlefield.some((permanent) => permanent.id === attacker.id)).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'fizzle')).toBe(true);
  });
});
