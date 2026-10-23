import { describe, expect, it } from 'vitest';
import {
  boundedChoiceSpell,
  CHOICE_SPELL_KINDS,
  supportsBoundedChoiceSpell,
  type ChoiceSpellKind,
} from '../../../scripts/contracts/bounded-choice-spells';
import { deriveCardCapabilities } from '../src/cards/capabilities';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { changeController, moveObject, playerById } from '../src/state/objects';
import { runPrioritySequence } from '../src/turn/priority';
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
import { cloneContractContext } from './helpers/contract-harness';

function setup(kind: ChoiceSpellKind, funded: boolean, overload = false) {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed: `independent-${kind}` },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  const definition = boundedChoiceSpell(kind);
  const card = conjure(
    ctx,
    'P1',
    oracle({
      oracleId: definition.oracleId,
      name: definition.name,
      typeLine: definition.typeLine,
      manaCost: '{W}',
    }),
    'hand',
  );
  registerCustomDef(ctx, definition);
  const victim = spawn(
    ctx,
    'P2',
    oracle({
      name: 'Independent opponent victim',
      typeLine: 'Creature — Bear',
      power: '4',
      toughness: '8',
    }),
  );
  const keeper = spawn(
    ctx,
    'P1',
    oracle({
      name: 'Independent keeper',
      typeLine: 'Artifact Creature — Bear',
      power: '2',
      toughness: '2',
    }),
  );
  const ownVictim = spawn(
    ctx,
    'P1',
    oracle({ name: 'Independent own victim', typeLine: 'Creature — Bear' }),
  );
  if (kind === 'owner-library') {
    changeController(ctx, keeper, 'P2');
    keeper.attacking = 'P3';
    victim.attacking = 'P1';
  }
  if (kind === 'greatest-damage')
    for (let n = 0; n < 2; n++)
      conjure(
        ctx,
        'P1',
        oracle({
          name: `Independent earlier spell ${n}`,
          typeLine: n === 0 ? 'Instant' : 'Sorcery',
          oracleText: 'You gain 1 life.',
        }),
        'graveyard',
      );
  if (funded) {
    const cost = overload ? definition.alternativeCasts![0]!.manaCost : definition.manaCost!;
    const symbols = Object.entries(cost.colored).flatMap(([symbol, n]) =>
      Array.from({ length: n }, () => symbol as 'W' | 'U' | 'B' | 'R' | 'G'),
    );
    addMana(playerById(ctx, 'P1'), [
      ...symbols.map((symbol) => ({ symbol })),
      ...Array.from({ length: cost.generic }, () => ({ symbol: 'C' as const })),
    ]);
  }
  const options = () =>
    computePriorityOptions(ctx, playerById(ctx, 'P1')).filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return (
        payload.kind === 'castSpell' &&
        payload.objectId === card.id &&
        (payload.alternativeCast === 'overload') === overload
      );
    });
  return { ctx, card, definition, victim, keeper, ownVictim, options };
}

function contractIt(title: string, run: () => void) {
  const kind = title.split(':')[0] as ChoiceSpellKind;
  for (const capability of deriveCardCapabilities(boundedChoiceSpell(kind)))
    it(`${capability} / ${title}`, run);
}

describe('independent bounded multiplayer choice spell compositions', () => {
  for (const kind of CHOICE_SPELL_KINDS) {
    contractIt(`${kind}: positive`, () => {
      for (const overload of kind === 'exile-search' ? [false, true] : [false]) {
        const { ctx, card, definition, victim, keeper, ownVictim, options } = setup(
          kind,
          true,
          overload,
        );
        expect(supportsBoundedChoiceSpell(definition, kind)).toBe(true);
        const option = options()[0]!;
        expect(option).toBeDefined();
        pump(
          applyPriorityAction(ctx, playerById(ctx, 'P1'), option.payload as PriorityActionPayload, {
            index: 0,
            targets: kind === 'exile-search' && !overload ? new Map([[0, victim.id]]) : new Map(),
          }),
        );
        expect(ctx.state.stack).toHaveLength(1);
        expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
        pump(runPrioritySequence(ctx), (decision) => ({
          index: Math.max(
            0,
            decision.options.findIndex((option) => option.type === 'pass'),
          ),
          targets: new Map(),
        }));
        expect(ctx.state.stack).toHaveLength(0);
        expect(playerById(ctx, 'P1').graveyard.some((entry) => entry.cardId === card.cardId)).toBe(
          true,
        );
        if (kind === 'type-retention') {
          expect(ctx.state.battlefield).toContain(keeper);
          expect(ctx.state.battlefield).not.toContain(ownVictim);
          expect(ctx.state.battlefield).toContain(victim);
        } else if (kind === 'owner-library') {
          expect(playerById(ctx, 'P1').library[0]!.cardId).toBe(keeper.cardId);
          expect(playerById(ctx, 'P2').library[0]!.cardId).toBe(victim.cardId);
          expect(ctx.state.battlefield).toContain(ownVictim);
        } else if (kind === 'exile-search') {
          expect(ctx.state.exile.some((entry) => entry.cardId === victim.cardId)).toBe(true);
          expect(ctx.state.battlefield).toContain(keeper);
          expect(
            ctx.state.battlefield.some(
              (entry) => entry.controllerId === 'P2' && entry.name === 'Forest' && entry.tapped,
            ),
          ).toBe(true);
        } else {
          expect(ctx.state.exile.some((entry) => entry.cardId === victim.cardId)).toBe(true);
          expect(playerById(ctx, 'P2').life).toBe(36);
          expect(playerById(ctx, 'P3').life).toBe(40);
          expect(ctx.state.battlefield).toContain(keeper);
        }
      }
    });
    contractIt(`${kind}: negative`, () => {
      const { ctx, definition, options } = setup(kind, false);
      const before = cloneContractContext(ctx);
      expect(options()).toEqual([]);
      expect(ctx.state).toEqual(before.state);
      const extended = structuredClone(definition);
      extended.spellAbility!.effects.push({ op: 'gainLife', amount: { kind: 'const', n: 1 } });
      expect(supportsBoundedChoiceSpell(extended, kind)).toBe(false);
      const changed = structuredClone(definition);
      changed.manaCost!.generic++;
      expect(supportsBoundedChoiceSpell(changed, kind)).toBe(false);
      const wrongType = structuredClone(definition);
      wrongType.types = ['Creature'];
      expect(supportsBoundedChoiceSpell(wrongType, kind)).toBe(false);
      const funded = setup(kind, true);
      if (kind === 'owner-library') {
        funded.keeper.attacking = null;
        funded.victim.attacking = null;
      }
      if (kind === 'type-retention')
        pump(moveObject(funded.ctx, funded.ownVictim, { zone: 'hand' }));
      if (kind === 'greatest-damage')
        pump(moveObject(funded.ctx, playerById(funded.ctx, 'P1').graveyard[0]!, { zone: 'exile' }));
      const offered = funded.options()[0]!;
      pump(
        applyPriorityAction(
          funded.ctx,
          playerById(funded.ctx, 'P1'),
          offered.payload as PriorityActionPayload,
          {
            index: 0,
            targets: kind === 'exile-search' ? new Map([[0, funded.victim.id]]) : new Map(),
          },
        ),
      );
      if (kind === 'exile-search') pump(moveObject(funded.ctx, funded.victim, { zone: 'hand' }));
      pump(runPrioritySequence(funded.ctx));
      if (kind === 'owner-library' || kind === 'type-retention')
        expect(funded.ctx.state.battlefield).toEqual(
          expect.arrayContaining([funded.keeper, funded.victim]),
        );
      if (kind === 'exile-search') {
        expect(funded.ctx.state.exile).toEqual([]);
        expect(funded.ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(false);
      }
      if (kind === 'greatest-damage') {
        expect(funded.ctx.state.exile.some((card) => card.cardId === funded.victim.cardId)).toBe(
          true,
        );
        expect(playerById(funded.ctx, 'P2').life).toBe(40);
      }
    });
  }
});
