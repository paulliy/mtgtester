/**
 * EDHREC coverage plan, Phase 4 batch 5: value phrases, qualified target nouns, tap and untap of
 * any target, "all" subjects, historic spells, basic land types in a search, Devoid, and statics
 * the layer engine must be able to evaluate. The runner scenarios of Fungal Sprouting, Arbor Elf,
 * Doom Blade, Muscle Sliver, Selfless Savior, Wasteland, Geier Reach Sanitarium and Death's
 * Shadow drive the productions through the engine; this file covers the edges (D1).
 */
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { candidateOf, computeCharacteristics } from '../src/effects/continuous';
import { selectMatches } from '../src/cards/selector';
import type { Selector } from '../src/cards/selector';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, spawn } from './fixtures';

function pod(seed: string): GameContext {
  return createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
}
const creature = (name: string, oracleText: string, extra: Partial<OracleCard> = {}): OracleCard =>
  oracle({
    name,
    typeLine: 'Creature — Human',
    manaCost: '{1}',
    power: '1',
    toughness: '1',
    oracleText,
    ...extra,
  });
const spell = (oracleText: string, manaCost = '{1}'): OracleCard =>
  oracle({ name: 'P5 Spell', typeLine: 'Sorcery', manaCost, oracleText });

describe('Phase 4 batch 5: value phrases', () => {
  it('reads greatest power, your life total, cards in your hand and opponents you have', () => {
    const effects = (text: string) => interpretCard(spell(text)).spellAbility?.effects;
    expect(
      effects(
        'Create X 1/1 green Saproling creature tokens, where X is the greatest power among creatures you control.',
      )?.[0],
    ).toMatchObject({ count: { kind: 'greatestPowerAmong', scope: 'you' } });
    expect(
      effects('Create X 1/1 white Bird creature tokens, where X is your life total.')?.[0],
    ).toMatchObject({ count: { kind: 'lifeTotal', scope: 'you' } });
    expect(effects('You gain 1 life for each card in your hand.')?.[0]).toMatchObject({
      amount: { kind: 'countCardsInZone', zone: 'hand', owner: 'you' },
    });
    expect(effects('Draw cards equal to the number of opponents you have.')?.[0]).toMatchObject({
      count: { kind: 'countOpponents' },
    });
  });

  it('"gets -X/-X, where X is your life total" keeps the sign and is read by the layers', () => {
    const card = creature('P5 Shadow', 'This creature gets -X/-X, where X is your life total.', {
      power: '13',
      toughness: '13',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    const ctx = pod('p5-shadow');
    ctx.state.players.find((p) => p.id === 'P1')!.life = 5;
    const shadow = spawn(ctx, 'P1', card);
    expect(computeCharacteristics(ctx, shadow).power).toBe(8);
  });

  it('a static counting cards in a graveyard is evaluated by the layer engine', () => {
    const card = creature(
      'P5 Wight',
      'This creature gets +1/+1 for each creature card in your graveyard.',
    );
    expect(interpretCard(card).modeled).toBe(true);
    const ctx = pod('p5-wight');
    const wight = spawn(ctx, 'P1', card);
    conjure(ctx, 'P1', creature('P5 Dead A', ''), 'graveyard');
    conjure(ctx, 'P1', creature('P5 Dead B', ''), 'graveyard');
    conjure(ctx, 'P2', creature('P5 Theirs', ''), 'graveyard');
    expect(computeCharacteristics(ctx, wight).power).toBe(3);
  });

  it('a static whose value the layer engine cannot evaluate is refused, not modeled', () => {
    const def = interpretCard(
      creature('P5 Elder', 'This creature gets +1/+1 for each color among permanents you control.'),
    );
    expect(def.modeled).toBe(false);
  });
});

describe('Phase 4 batch 5: target nouns and subjects', () => {
  it('reads qualifiers on a target noun', () => {
    const target = (text: string) => interpretCard(spell(text)).spellAbility?.targets[0];
    expect(target('Destroy target nonblack creature.')).toEqual({
      kind: 'creature',
      filter: { kind: 'not', of: { kind: 'color', value: 'B' } },
    });
    expect(target('Destroy target nonbasic land.')).toEqual({
      kind: 'land',
      filter: { kind: 'not', of: { kind: 'supertype', value: 'Basic' } },
    });
    expect(target('Untap target Forest.')).toEqual({
      kind: 'permanent',
      filter: { kind: 'subtype', value: 'Forest' },
    });
    expect(target('Tap target creature with power 4 or greater.')).toEqual({
      kind: 'creature',
      filter: { kind: 'powerAtLeast', n: 4 },
    });
  });

  it('"artifact, enchantment, or creature with flying" restricts only the creature', () => {
    const target = interpretCard(
      spell('Destroy target artifact, enchantment, or creature with flying.'),
    ).spellAbility!.targets[0]!;
    const ctx = pod('p5-broken-wings');
    const source = { cardId: 'p5-source', controllerId: 'P1' };
    const matches = (card: OracleCard): boolean => {
      const perm = spawn(ctx, 'P2', card);
      return selectMatches(
        candidateOf(ctx, perm, computeCharacteristics(ctx, perm)),
        target.filter as Selector,
        source,
      );
    };
    const artifact = oracle({ name: 'P5 Relic', typeLine: 'Artifact', oracleText: '' });
    expect(matches(artifact)).toBe(true);
    expect(matches(creature('P5 Bear', ''))).toBe(false);
    expect(matches(creature('P5 Bird', 'Flying'))).toBe(true);
  });

  it('refuses an unknown qualifier rather than dropping it', () => {
    expect(interpretCard(spell('Destroy target gleaming creature.')).modeled).toBe(false);
  });

  it('"another target creature you control" excludes the source', () => {
    const def = interpretCard(
      creature(
        'P5 Savior',
        'Sacrifice this creature: Another target creature you control gains indestructible until end of turn.',
      ),
    );
    expect(def.activatedAbilities[0]!.ability.targets).toEqual([
      { kind: 'creature', filter: { kind: 'other' }, controller: 'you' },
    ]);
  });

  it('"All Sliver creatures" reaches Slivers on every side', () => {
    const def = interpretCard(
      creature('P5 Muscle', 'All Sliver creatures get +1/+1.', { typeLine: 'Creature — Sliver' }),
    );
    expect(def.staticEffects[0]!.affects).toEqual({
      kind: 'allOf',
      of: [
        { kind: 'subtype', value: 'Sliver' },
        { kind: 'type', value: 'Creature' },
      ],
    });
  });

  it('a historic spell is an artifact, a legendary or a Saga (CR 700.6)', () => {
    const def = interpretCard(
      creature('P5 Familiar', 'Whenever you cast a historic spell, scry 1.'),
    );
    expect(def.triggers[0]!.trigger).toMatchObject({
      filter: {
        kind: 'anyOf',
        of: [
          { kind: 'type', value: 'Artifact' },
          { kind: 'supertype', value: 'Legendary' },
          { kind: 'subtype', value: 'Saga' },
        ],
      },
    });
  });

  it('a search for "a basic Forest, Island, or Mountain card" finds only those basics', () => {
    const def = interpretCard(
      oracle({
        name: 'P5 Landscape',
        typeLine: 'Land',
        oracleText:
          '{T}, Sacrifice this land: Search your library for a basic Forest, Island, or Mountain card, put it onto the battlefield tapped, then shuffle.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(JSON.stringify(def.activatedAbilities[0]!.ability.effects)).toContain(
      '{"kind":"subtype","value":"Island"}',
    );
  });
});

describe('Phase 4 batch 5: Devoid and player clauses', () => {
  it('Devoid is read only when the card data already lists it colorless (CR 702.114a)', () => {
    const colorless = creature('P5 Void', 'Devoid', { manaCost: '{U}', colors: [] });
    expect(interpretCard(colorless).modeled).toBe(true);
    const colored = creature('P5 Blue', 'Devoid', { manaCost: '{U}', colors: ['U'] });
    expect(interpretCard(colored).modeled).toBe(false);
  });

  it('"each player draws a card, then discards a card" keeps the order and the subject', () => {
    const def = interpretCard(spell('Each player draws a card, then discards a card.'));
    expect(def.spellAbility!.effects).toEqual([
      { op: 'eachPlayerDraws', scope: 'all', count: { kind: 'const', n: 1 } },
      { op: 'discardEachPlayer', scope: 'all', count: { kind: 'const', n: 1 } },
    ]);
  });
});

describe('Phase 4 batch 5: contained cards', () => {
  it('faeburrow-elder-static-contained', async () => {
    const { readFileSync } = await import('node:fs');
    const cards = JSON.parse(
      readFileSync(
        new URL('../../server/fixtures/edhrec-pinned-oracle.json', import.meta.url),
        'utf8',
      ),
    ) as { card: OracleCard }[];
    const def = interpretCard(cards.find(({ card }) => card.name === 'Faeburrow Elder')!.card);
    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons.join('; ')).toContain(
      'static value the layer engine cannot evaluate',
    );
  });
});
