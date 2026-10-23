import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { computeTargetOptions } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { createGame } from '../src/state/game';
import { runPrioritySequence } from '../src/turn/priority';
import { copies, conjure, forest, gameConfig, oracle, pump } from './fixtures';

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/combat-trigger-oracle.json'), 'utf8'),
) as { cards: { card: OracleCard }[] };
const pinned = (name: string) => fixture.cards.find(({ card }) => card.name === name)!.card;
const pod = () => {
  const ctx = createGame(gameConfig([0, 1, 2].map(() => ({ cards: copies(24, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  return ctx;
};

describe('fixed-count wheel grammar', () => {
  it.each(['Dragon Mage', 'Runehorn Hellkite'])(
    'parses the pinned %s without its override',
    (name) => {
      const card = pinned(name);
      // Runehorn's graveyard exile cost still needs its override; isolate its printed effect.
      const def = interpretCard(
        name === 'Dragon Mage'
          ? { ...card, oracleId: `unregistered-${card.oracleId}` }
          : oracle({
              name: 'Runehorn wheel effect witness',
              typeLine: 'Sorcery',
              oracleText: card.oracleText.split(': ')[1]!,
            }),
      );
      expect(def.modeled).toBe(true);
      const ability = name === 'Dragon Mage' ? def.triggers[0] : def.spellAbility;
      expect(ability?.effects).toEqual([
        { op: 'eachPlayerDiscardHandThenDraw', count: { kind: 'const', n: 7 } },
      ]);
    },
  );
  it('casts a wheel, discards every hand, and draws exactly seven for every player', () => {
    const ctx = pod();
    const clause = pinned('Dragon Mage').oracleText.split(', ').slice(1).join(', ');
    const card = oracle({
      name: 'Fixed wheel grammar witness',
      typeLine: 'Sorcery',
      manaCost: '{0}',
      oracleText: clause,
    });
    const wheel = conjure(ctx, 'P1', card, 'hand');
    const discarded = ctx.state.players.map((player) => conjure(ctx, player.id, forest(), 'hand'));
    const before = ctx.state.players.map((player) => player.library.length);
    pump(
      applyPriorityAction(
        ctx,
        ctx.state.players[0]!,
        { kind: 'castSpell', objectId: wheel.id, fromCommand: false },
        { index: 0, targets: new Map() },
      ),
    );
    pump(runPrioritySequence(ctx));
    for (const [i, player] of ctx.state.players.entries()) {
      expect(player.hand).toHaveLength(7);
      expect(player.library).toHaveLength(before[i]! - 7);
      expect(player.graveyard.some((card) => card.cardId === discarded[i]!.cardId)).toBe(true);
    }
  });
  it('preserves the greatest-discarded count and rejects unknown fixed amounts', () => {
    expect(interpretCard(pinned('Windfall')).spellAbility?.effects).toEqual([
      { op: 'eachPlayerDiscardHandThenDraw', greatestDiscarded: true },
    ]);
    expect(
      interpretCard(
        oracle({
          name: 'Unknown wheel amount',
          typeLine: 'Sorcery',
          oracleText: 'Each player discards their hand, then draws some cards.',
        }),
      ).modeled,
    ).toBe(false);
  });
});

describe('player token beneficiary grammar', () => {
  for (const beneficiary of ['player', 'opponent'] as const) {
    it(`allows the printed target ${beneficiary} scope through normal casting`, () => {
      const ctx = pod();
      const card = oracle({
        name: `Token ${beneficiary} grammar witness`,
        typeLine: 'Sorcery',
        manaCost: '{0}',
        oracleText: `Target ${beneficiary} creates a 1/1 white Soldier creature token.`,
      });
      const obj = conjure(ctx, 'P1', card, 'hand');
      const def = interpretCard(card);
      const legal = computeTargetOptions(ctx, def.spellAbility!.targets[0]!, 'P1');
      expect(legal.includes('P1')).toBe(beneficiary === 'player');
      expect(legal).toContain('P2');
      const target = beneficiary === 'player' ? 'P1' : 'P2';
      pump(
        applyPriorityAction(
          ctx,
          ctx.state.players[0]!,
          { kind: 'castSpell', objectId: obj.id, fromCommand: false },
          { index: 0, targets: new Map([[0, target]]) },
        ),
      );
      pump(runPrioritySequence(ctx));
      expect(
        ctx.state.battlefield.filter((p) => p.name === 'Soldier' && p.controllerId === target),
      ).toHaveLength(1);
    });
  }
  it('keeps the opponent-only restriction on the real Hunted Phantasm', () => {
    const def = interpretCard(pinned('Hunted Phantasm'));
    expect(def.triggers[0]?.targets).toEqual([{ kind: 'player', controller: 'opponent' }]);
  });
});

describe('event scope validation', () => {
  it('rejects the event-only Aura count outside a permanent event, including nested values', () => {
    const base = interpretCard(
      oracle({
        name: 'Event value scope witness',
        typeLine: 'Sorcery',
        oracleText: 'Draw a card.',
      }),
    );
    for (const count of [
      { kind: 'aurasYouControlledAttachedToTriggerObject' as const },
      {
        kind: 'plus' as const,
        of: { kind: 'aurasYouControlledAttachedToTriggerObject' as const },
        n: 1,
      },
    ]) {
      const def = {
        ...base,
        spellAbility: {
          kind: 'spell' as const,
          targets: [],
          effects: [{ op: 'draw' as const, count }],
        },
      };
      expect(
        validateCardDefinition(def).some((issue) =>
          issue.message.includes('owning permanent event scope'),
        ),
      ).toBe(true);
    }
  });
  it('accepts a permanent death scope and rejects an event-only qualifier on other events', () => {
    const base = interpretCard(oracle({ name: 'Event qualifier scope witness' }));
    const ability = {
      kind: 'triggered' as const,
      trigger: {
        when: 'dies' as const,
        subject: {
          kind: 'permanent' as const,
          selector: { kind: 'type' as const, value: 'Creature' },
        },
      },
      targets: [],
      effects: [
        {
          op: 'draw' as const,
          count: { kind: 'aurasYouControlledAttachedToTriggerObject' as const },
        },
      ],
    };
    expect(validateCardDefinition({ ...base, triggers: [ability] })).toEqual([]);
    const invalid = {
      ...ability,
      trigger: { ...ability.trigger, eventCondition: { kind: 'yourTurn' as const } },
    };
    expect(
      validateCardDefinition({ ...base, triggers: [invalid] }).some((issue) =>
        issue.path.endsWith('eventCondition'),
      ),
    ).toBe(true);
  });
  it('rejects interactive conditions at the attack-event qualification boundary', () => {
    const base = interpretCard(oracle({ name: 'Interactive event qualifier witness' }));
    const def = {
      ...base,
      triggers: [
        {
          kind: 'triggered' as const,
          trigger: {
            when: 'attacks' as const,
            subject: { kind: 'self' as const },
            eventCondition: { kind: 'mayPayLife' as const, n: 2 },
          },
          targets: [],
          effects: [{ op: 'draw' as const, count: { kind: 'const' as const, n: 1 } }],
        },
      ],
    };
    expect(
      validateCardDefinition(def).some((issue) => issue.message.includes('choice condition')),
    ).toBe(true);
  });
});
