/**
 * "As this enters, choose a creature type." (R.1) — Cavern of Souls, Herald's Horn,
 * Patchwork Banner.
 *
 * Two things had to exist for these:
 *
 * 1. **A domain for the choice.** `entersChoosingOption` was a closed printed list (Caged Sun's
 *    five colors), and the ETB prompt renders one option per entry. A creature-type domain is
 *    not printed and cannot be — CR 614.1c allows any of ~280 types, and the protocol has no
 *    free-text decision. So the domain is COMPUTED from the controller's decklist plus the
 *    current battlefield. That is a deliberate rules deviation, documented on
 *    `creatureTypeChoicesFor`, and these tests pin its shape so the deviation stays visible.
 * 2. **A subtype-aware selector.** The existing `chosenType` (Cloud Key) matches
 *    `candidate.types` — CARD types. Against "Elf" it would compare to ["Creature"] and never
 *    match, so `chosenSubtype` is a separate selector rather than a widening of that one.
 *
 * Oracle text below is verbatim (Scryfall bulk, checked 2026-09-04).
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { computePriorityOptions, costReductionFor } from '../src/actions/legal';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { creatureTypeChoicesFor, playerById } from '../src/state/objects';
import { manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, registerDef, spawn } from './fixtures';

const patchworkBanner = () =>
  oracle({
    name: 'Test Banner',
    typeLine: 'Artifact',
    manaCost: '{3}',
    power: null,
    toughness: null,
    oracleText:
      'As this artifact enters, choose a creature type.\nCreatures you control of the chosen type get +1/+1.\n{T}: Add one mana of any color.',
  });

const heraldsHorn = () =>
  oracle({
    name: 'Test Horn',
    typeLine: 'Artifact',
    manaCost: '{3}',
    power: null,
    toughness: null,
    oracleText:
      "As this artifact enters, choose a creature type.\nCreature spells you cast of the chosen type cost {1} less to cast.\nAt the beginning of your upkeep, look at the top card of your library. If it's a creature card of the chosen type, you may reveal it and put it into your hand.",
  });

const cavernOfSouls = () =>
  oracle({
    name: 'Test Cavern',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText:
      "As this land enters, choose a creature type.\n{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a creature spell of the chosen type, and that spell can't be countered.",
  });

const elf = () =>
  oracle({
    name: 'Test Elf',
    typeLine: 'Creature — Elf Druid',
    manaCost: '{1}{G}',
    power: '1',
    toughness: '1',
    subtypes: ['Elf', 'Druid'],
    colors: ['G'],
    oracleText: '',
  });

const goblin = () =>
  oracle({
    name: 'Test Goblin',
    typeLine: 'Creature — Goblin',
    manaCost: '{R}',
    power: '1',
    toughness: '1',
    subtypes: ['Goblin'],
    colors: ['R'],
    oracleText: '',
  });

function pod(seed = 'chosen-type'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
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

describe('as-enters creature type choice', () => {
  it('models all three cards from their printed text', () => {
    for (const card of [patchworkBanner(), heraldsHorn(), cavernOfSouls()]) {
      const def = interpretCard(card);
      expect(def.modeled, `${card.name}: ${JSON.stringify(def.unmodeledReasons)}`).toBe(true);
      expect(def.entersChoosingOption).toEqual({
        prompt: 'choose a creature type',
        domain: 'creatureType',
      });
    }
  });

  it('offers types from the decklist and the battlefield, and nothing else', () => {
    const ctx = pod();
    const player = ctx.state.players[0]!;

    // Empty to start: the pod's decks are basic lands, which have no creature types.
    expect(creatureTypeChoicesFor(ctx, player.id)).toEqual([]);

    // A card in the DECKLIST counts even though no copy is on the battlefield — this is the
    // half that lets a player name a type they have not drawn yet.
    const elfCard = elf();
    registerDef(ctx, elfCard);
    player.decklistOracleIds.push(elfCard.oracleId);
    expect(creatureTypeChoicesFor(ctx, player.id).map((o) => o.key)).toEqual(['Druid', 'Elf']);

    // An OPPONENT's creature on the battlefield counts too: naming their type is a real play.
    spawn(ctx, 'P2', goblin());
    expect(creatureTypeChoicesFor(ctx, player.id).map((o) => o.key)).toEqual([
      'Druid',
      'Elf',
      'Goblin',
    ]);
  });

  it('reads a changeling as its printed type, not all 324', () => {
    // CR 702.73 — "this card is every creature type". Reading computed subtypes here would
    // offer every creature type in the game and make the choice unusable, which is the exact
    // failure this domain exists to avoid. Every option is equivalent against a changeling
    // anyway: it is hit whichever type you name.
    const ctx = pod();
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Changeling',
        typeLine: 'Creature — Shapeshifter',
        manaCost: '{2}',
        power: '2',
        toughness: '2',
        subtypes: ['Shapeshifter'],
        oracleText: 'Changeling (This card is every creature type.)',
      }),
    );
    expect(creatureTypeChoicesFor(ctx, 'P1').map((o) => o.key)).toEqual(['Shapeshifter']);
  });

  it('sorts the domain, so the option list is deterministic', () => {
    const ctx = pod();
    spawn(ctx, 'P1', goblin());
    spawn(ctx, 'P1', elf());
    const keys = creatureTypeChoicesFor(ctx, 'P1').map((o) => o.key);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('the chosen type in selectors', () => {
  it('Patchwork Banner pumps only creatures of the chosen type', () => {
    const ctx = pod();
    const banner = spawn(ctx, 'P1', patchworkBanner());
    banner.chosenOption = 'Elf';
    const anElf = spawn(ctx, 'P1', elf());
    const aGoblin = spawn(ctx, 'P1', goblin());
    const theirElf = spawn(ctx, 'P2', elf());

    expect(computeCharacteristics(ctx, anElf).power).toBe(2);
    expect(computeCharacteristics(ctx, aGoblin).power).toBe(1);
    // "Creatures YOU control" — an opponent's Elf is not pumped.
    expect(computeCharacteristics(ctx, theirElf).power).toBe(1);
  });

  it('pumps nothing while no type has been chosen', () => {
    const ctx = pod();
    spawn(ctx, 'P1', patchworkBanner()); // no chosenOption recorded
    const anElf = spawn(ctx, 'P1', elf());
    expect(computeCharacteristics(ctx, anElf).power).toBe(1);
  });

  it("Herald's Horn reduces only creature spells of the chosen type", () => {
    const ctx = pod();
    const horn = spawn(ctx, 'P1', heraldsHorn());
    horn.chosenOption = 'Elf';

    const elfCard = elf();
    const goblinCard = goblin();
    registerDef(ctx, elfCard);
    registerDef(ctx, goblinCard);

    // The reduction reads the HORN's chosen option, not the spell's — the per-entry re-source
    // in `costReductionFor`.
    expect(costReductionFor(ctx, 'P1', elfCard.oracleId, 'elf-1').generic).toBe(1);
    expect(costReductionFor(ctx, 'P1', goblinCard.oracleId, 'goblin-1').generic).toBe(0);
  });

  it("Cavern of Souls' restricted mana names the chosen type", () => {
    const ctx = pod();
    const cavern = spawn(ctx, 'P1', cavernOfSouls());
    cavern.chosenOption = 'Elf';

    const sources = manaSourcesFor(ctx, 'P1').filter((s) => s.cardId === cavern.cardId);
    // Two abilities that are NOT interchangeable: plain {C}, and any-color restricted mana that
    // also makes the spell uncounterable. Collapsing them would let the restricted mana pay for
    // anything.
    expect(sources).toHaveLength(2);
    const restricted = sources.find((s) => s.restriction !== undefined);
    expect(restricted).toBeDefined();
    expect(restricted!.uncounterableSpell).toBe(true);
    expect(restricted!.units[0]!.length).toBe(5);
  });

  it("Cavern of Souls' restricted mana pays only for a creature spell of the chosen type", () => {
    const ctx = pod();
    const cavern = spawn(ctx, 'P1', cavernOfSouls());
    cavern.chosenOption = 'Elf';
    const oneDrop = (name: string, subtype: string) =>
      conjure(
        ctx,
        'P1',
        oracle({
          name,
          typeLine: `Creature — ${subtype}`,
          manaCost: '{G}',
          power: '1',
          toughness: '1',
          subtypes: [subtype],
          colors: ['G'],
          oracleText: '',
        }),
        'hand',
      );
    oneDrop('Test Green Elf', 'Elf');
    oneDrop('Test Green Goblin', 'Goblin');
    // The choice is read from the Cavern, not from the spell: only the Elf can be paid for.
    const casts = computePriorityOptions(ctx, playerById(ctx, 'P1'))
      .map((option) => option.description)
      .filter((description) => description.startsWith('Cast '));
    expect(casts).toEqual(['Cast Test Green Elf ({G})']);
  });
});
