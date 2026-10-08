import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pump } from './fixtures';
import { computePriorityOptions } from '../src/actions/legal';
import { finishSpellCard } from '../src/stack/stack';

const bloomvineRegent = () =>
  oracle({
    name: 'Bloomvine Regent // Claim Territory',
    manaCost: '{3}{G}{G} // {2}{G}',
    typeLine: 'Creature — Dragon // Sorcery — Omen',
    types: ['Creature'],
    subtypes: ['Dragon'],
    oracleText:
      'Flying\nWhenever this creature or another Dragon you control enters, you gain 3 life.',
    power: '4',
    toughness: '5',
    keywords: ['Flying'],
    layout: 'adventure',
  });

const marangRiverRegent = () =>
  oracle({
    name: 'Marang River Regent // Coil and Catch',
    manaCost: '{4}{U}{U} // {3}{U}',
    typeLine: 'Creature — Dragon // Instant — Omen',
    types: ['Creature'],
    subtypes: ['Dragon'],
    oracleText:
      "Flying\nWhen this creature enters, return up to two other target nonland permanents to their owners' hands.",
    power: '6',
    toughness: '7',
    keywords: ['Flying'],
    layout: 'adventure',
  });

const monsterManual = () =>
  oracle({
    name: 'Monster Manual // Zoological Study',
    manaCost: '{3}{G} // {2}{G}',
    typeLine: 'Artifact — Book // Sorcery — Adventure',
    types: ['Artifact'],
    subtypes: ['Book'],
    oracleText: '{1}{G}, {T}: You may put a creature card from your hand onto the battlefield.',
    layout: 'adventure',
  });

function pod(seed = 'adventures-test'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
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

describe('Increment 18: Adventure & Omen Layouts', () => {
  it.each([bloomvineRegent, marangRiverRegent, monsterManual])(
    'does not certify a card whose spell face was omitted or substituted',
    (card) => {
      const definition = interpretCard(card());
      expect(definition.modeled).toBe(false);
      const ctx = pod();
      ctx.defs.set(definition.oracleId, definition);
      const input = card();
      ctx.state.players[0]!.hand.push({
        id: 'unsupported-face-object',
        cardId: 'unsupported-face-card',
        oracleId: definition.oracleId,
        ownerId: 'P1',
        name: input.name,
        typeLine: input.typeLine,
        oracleText: input.oracleText,
        manaCost: input.manaCost,
        isToken: false,
        isCommander: false,
        zone: 'hand',
      });
      expect(() => computePriorityOptions(ctx, ctx.state.players[0]!)).toThrow('Unmodeled card');
      expect(ctx.state.stack).toHaveLength(0);
    },
  );

  it('Omen spell resolution shuffles card back into owner library', () => {
    const ctx = pod();
    const p1 = ctx.state.players[0]!;
    const def = interpretCard(
      oracle({
        name: 'Synthetic Omen destination',
        typeLine: 'Sorcery',
        manaCost: '{0}',
        oracleText: 'You gain 1 life.',
      }),
    );
    ctx.defs.set(def.oracleId, def);

    const cardData = oracle({
      name: 'Synthetic Omen destination',
      typeLine: 'Sorcery',
      manaCost: '{0}',
      oracleText: 'You gain 1 life.',
    });
    const cardObj = {
      id: 'obj-omen-1',
      cardId: 'c-omen-1',
      oracleId: def.oracleId,
      ownerId: 'P1' as const,
      name: cardData.name,
      typeLine: cardData.typeLine,
      oracleText: cardData.oracleText,
      manaCost: cardData.manaCost,
      isToken: false,
      isCommander: false,
      zone: 'stack' as const,
    };

    const initialLibLength = p1.library.length;

    pump(
      finishSpellCard(ctx, {
        id: 'stack-1',
        sourceId: 'src-1',
        controllerId: 'P1',
        kind: 'spell',
        description: 'Claim Territory',
        targets: [],
        card: cardObj,
        ability: def.spellAbility!,
        sourceOracleId: def.oracleId,
        sourceCardId: 'c-omen-1',
        isCommanderCast: false,
        alternativeCastKind: 'omen',
      }),
    );

    expect(p1.library.length).toBe(initialLibLength + 1);
    expect(p1.library.some((c) => c.cardId === 'c-omen-1')).toBe(true);
  });

  it('Adventure spell resolution moves card to exile with onAdventure=true', () => {
    const ctx = pod();
    const def = interpretCard(
      oracle({
        name: 'Synthetic Adventure destination',
        typeLine: 'Sorcery',
        manaCost: '{0}',
        oracleText: 'You gain 1 life.',
      }),
    );
    ctx.defs.set(def.oracleId, def);

    const cardData = oracle({
      name: 'Synthetic Adventure destination',
      typeLine: 'Sorcery',
      manaCost: '{0}',
      oracleText: 'You gain 1 life.',
    });
    const cardObj = {
      id: 'obj-adv-1',
      cardId: 'c-adv-1',
      oracleId: def.oracleId,
      ownerId: 'P1' as const,
      name: cardData.name,
      typeLine: cardData.typeLine,
      oracleText: cardData.oracleText,
      manaCost: cardData.manaCost,
      isToken: false,
      isCommander: false,
      zone: 'stack' as const,
    };

    // Exercise the destination primitive without claiming a modeled production Adventure.
    pump(
      finishSpellCard(ctx, {
        id: 'stack-2',
        sourceId: 'src-2',
        controllerId: 'P1',
        kind: 'spell',
        description: 'Zoological Study',
        targets: [],
        card: cardObj,
        ability: { kind: 'spell', targets: [], effects: [] },
        sourceOracleId: def.oracleId,
        sourceCardId: 'c-adv-1',
        isCommanderCast: false,
        alternativeCastKind: 'adventure',
      }),
    );

    const inExile = ctx.state.exile.find((c) => c.cardId === 'c-adv-1');
    expect(inExile).toBeDefined();
    expect(inExile?.onAdventure).toBe(true);
  });
});
