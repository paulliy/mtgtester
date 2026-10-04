import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { resolveTopOfStack } from '../src/stack/stack';
import { priorityCheckpoint } from '../src/sba/sba';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { ofType } from '../src/cards/selector';
import { buildGuardedCandidateDefinition } from '../src/testing/candidate-definition';
import { copies, gameConfig, oracle, pump, registerCustomDef, spawn, conjure } from './fixtures';

const toxicDeluge = () =>
  oracle({
    oracleId: 'afaef788-34d1-460b-b884-9d7ae6ddeb18',
    name: 'Toxic Deluge',
    manaCost: '{2}{B}',
    typeLine: 'Sorcery',
    oracleText:
      'As an additional cost to cast this spell, pay X life.\nAll creatures get -X/-X until end of turn.',
  });

function setup(life = 10) {
  const ctx = createGame(
    gameConfig(
      [
        { id: 'P1', cards: copies(6, () => oracle({ name: 'P1 Card' })) },
        { id: 'P2', cards: copies(6, () => oracle({ name: 'P2 Card' })) },
      ],
      { seed: `toxic-deluge-${life}` },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
  player.life = life;
  const spell = conjure(ctx, 'P1', toxicDeluge(), 'hand');
  registerCustomDef(
    ctx,
    buildGuardedCandidateDefinition(
      toxicDeluge(),
      [
        'unrecognized rules text: "As an additional cost to cast this spell, pay X life."',
        'unrecognized rules text: "All creatures get -X/-X until end of turn."',
      ],
      {
        announcesX: true,
        spellAdditionalCosts: [{ kind: 'payLifeValue', amount: { kind: 'xValue' } }],
        spellAbility: {
          kind: 'spell',
          targets: [],
          effects: [
            {
              op: 'pumpEachUntilEot',
              selector: ofType('Creature'),
              power: 0,
              toughness: { kind: 'negate', of: { kind: 'xValue' } },
            },
          ],
          description: 'All creatures get -X/-X until end of turn',
        },
      },
    ),
  );
  const own = spawn(
    ctx,
    'P1',
    oracle({ name: 'Own Bear', typeLine: 'Creature', power: '2', toughness: '2' }),
  );
  const opposing = spawn(
    ctx,
    'P2',
    oracle({ name: 'Opposing Bear', typeLine: 'Creature', power: '4', toughness: '4' }),
  );
  addMana(player, [{ symbol: 'B' }, { symbol: 'C' }, { symbol: 'C' }]);
  return { ctx, player, spell, own, opposing };
}

describe('Toxic Deluge', () => {
  it('announces X, pays X life before priority, and applies -X/-X to all creatures', () => {
    const { ctx, player, own, opposing } = setup();
    const options = computePriorityOptions(ctx, player).filter(
      (option) => option.type === 'castSpell',
    );
    const cast = options.find(
      (option) => (option.payload as PriorityActionPayload & { x?: number }).x === 3,
    );
    expect(cast).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, cast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(player.life).toBe(7);
    expect(ctx.state.stack[0]?.announcedX).toBe(3);
    pump(resolveTopOfStack(ctx));
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === own.cardId)).toBe(false);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === opposing.cardId)).toBe(
      true,
    );
  });

  it('offers X=0 and rejects an X greater than the caster life total', () => {
    const { ctx, player } = setup(2);
    const xs = computePriorityOptions(ctx, player)
      .filter((option) => option.type === 'castSpell')
      .map((option) => option.payload)
      .map((payload) => (payload as PriorityActionPayload & { x?: number }).x);
    expect(xs).toContain(0);
    expect(xs).toContain(2);
    expect(xs).not.toContain(3);
  });
});
