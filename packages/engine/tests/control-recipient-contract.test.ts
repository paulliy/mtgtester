import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '../src/cards/definition';
import type { TargetSpec } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { activated } from '../src/cards/templates';
import { constant } from '../src/cards/value';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

const probe = () =>
  oracle({ name: 'Control Recipient Probe', typeLine: 'Artifact', manaCost: '{0}' });
function malformed(
  recipient: unknown,
  targets: TargetSpec[] = [{ kind: 'player' }],
): CardDefinition {
  return {
    ...interpretCard(probe()),
    activatedAbilities: [
      {
        ...activated({ costs: [], effects: [], targets }),
        ability: {
          kind: 'activated',
          targets,
          effects: [{ op: 'gainControlTarget', target: 'source', recipient }],
        },
      },
    ],
  } as unknown as CardDefinition;
}
describe('independent control recipient and timing contracts', () => {
  it('rejects a recipient attached to an effect that does not implement it', () => {
    const definition = malformed({ targetPlayer: 0 });
    Object.assign(definition.activatedAbilities[0]!.ability, {
      effects: [{ op: 'draw', count: constant(1), recipient: { targetPlayer: 0 } }],
    });
    expect(
      validateCardDefinition(definition).some((issue) => issue.path.endsWith('.recipient')),
    ).toBe(true);
  });
  it.each([
    null,
    'source',
    {},
    [],
    { targetPlayer: -1 },
    { targetPlayer: 0.5 },
    { targetPlayer: NaN },
    { targetPlayer: Number.MAX_SAFE_INTEGER + 1 },
    { targetPlayer: 1 },
    { targetPlayer: 0, extra: true },
  ])('rejects malformed recipient %j', (recipient) => {
    expect(
      validateCardDefinition(malformed(recipient)).some((issue) =>
        issue.path.includes('.recipient'),
      ),
    ).toBe(true);
  });
  it('requires an ordinary player slot and rejects a variable-count player slot', () => {
    expect(validateCardDefinition(malformed({ targetPlayer: 0 }))).toEqual([]);
    for (const targets of [
      [{ kind: 'creature' }],
      [{ kind: 'player', count: { min: 0, max: 1 } }],
    ] as TargetSpec[][]) {
      expect(
        validateCardDefinition(malformed({ targetPlayer: 0 }, targets)).some((issue) =>
          issue.path.endsWith('.recipient.targetPlayer'),
        ),
      ).toBe(true);
    }
  });
  it.each([null, 0, 'opponentsTurn', ['any'], { toString: () => 'any' }])(
    'rejects unknown activated timing %j',
    (timing) => {
      const definition = {
        ...interpretCard(probe()),
        activatedAbilities: [
          { ...activated({ costs: [], effects: [{ op: 'draw', count: constant(1) }] }), timing },
        ],
      } as unknown as CardDefinition;
      expect(
        validateCardDefinition(definition).some((issue) => issue.path.endsWith('.timing')),
      ).toBe(true);
    },
  );
  it.each(['battlefield', 'hand', 'graveyard'] as const)(
    'your-turn timing in %s allows combat and a nonempty stack, then rejects another active player',
    (zone) => {
      const ctx = createGame(
        gameConfig(
          [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
          { seed: `your-turn-${zone}` },
        ),
      );
      ctx.state.currentTurnPlayer = 'P1';
      ctx.state.activePlayerIndex = 0;
      ctx.state.phase = 'combat';
      ctx.state.step = 'combatDamage';
      const card = probe();
      const object =
        zone === 'battlefield' ? spawn(ctx, 'P1', card) : conjure(ctx, 'P1', card, zone);
      registerCustomDef(ctx, {
        ...interpretCard(card),
        activatedAbilities: [
          activated({
            zone,
            costs: [],
            timing: 'yourTurn',
            effects: [{ op: 'draw', count: constant(1) }],
          }),
        ],
      });
      const instant = conjure(
        ctx,
        'P1',
        oracle({
          name: 'Stack Timing Witness',
          typeLine: 'Instant',
          manaCost: '{0}',
          oracleText: 'You gain 1 life.',
        }),
        'hand',
      );
      const player = playerById(ctx, 'P1');
      const cast = computePriorityOptions(ctx, player).find((option) => {
        const p = option.payload as PriorityActionPayload;
        return p.kind === 'castSpell' && p.objectId === instant.id;
      })!;
      pump(
        applyPriorityAction(ctx, player, cast.payload as PriorityActionPayload, {
          index: 0,
          targets: new Map(),
        }),
      );
      expect(ctx.state.stack).toHaveLength(1);
      const offered = () =>
        computePriorityOptions(ctx, player).some((option) => {
          const p = option.payload as PriorityActionPayload;
          return p.kind === 'activateAbility' && p.objectId === object.id;
        });
      expect(offered()).toBe(true);
      ctx.state.activePlayerIndex = 1;
      ctx.state.currentTurnPlayer = 'P2';
      expect(offered()).toBe(false);
    },
  );
});
