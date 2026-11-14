import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlAvenOverrides } from '../src/cards/overrides/white-black-control-aven';
import { registerWhiteBlackControlTergridOverrides } from '../src/cards/overrides/white-black-control-tergrid';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import type { EngineCardObject, EnginePlayerState, GameContext } from '../src/state/types';
import { priorityCheckpoint } from '../src/sba/sba';
import { queueSpellCopy } from '../src/stack/copy';
import { resolveTopOfStack } from '../src/stack/stack';
import { copies, conjure, gameConfig, oracle, pump, spawn, swamp, editableDef } from './fixtures';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/white-black-control-oracle.json'), 'utf8'),
) as { cards: PinnedCard[] };
const pinnedEntry = fixture.cards.find((candidate) => candidate.card.name === 'Aven Interrupter');
if (pinnedEntry === undefined) throw new Error('Missing pinned Oracle card: Aven Interrupter');
const aven = pinnedEntry.card;
const AVEN_SHA256 = '861efb2a0c89250b158e9f1b6ba71dbd3744cd4d72591457b2739ae8251c4000';

beforeAll(() => {
  registerWhiteBlackControlAvenOverrides();
  registerWhiteBlackControlTergridOverrides();
});

function pod(seed = 'white-black-control-aven'): GameContext {
  const game = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(12, swamp) })),
      { seed },
    ),
  );
  game.state.currentTurnPlayer = 'P2';
  game.state.activePlayerIndex = 1;
  game.state.turnNumber = 3;
  game.state.phase = 'precombatMain';
  game.state.step = null;
  return game;
}

function player(game: GameContext, id: string): EnginePlayerState {
  const result = game.state.players.find((candidate) => candidate.id === id);
  if (result === undefined) throw new Error(`Missing player ${id}`);
  return result;
}

function simpleSpell(
  name: string,
  options: { manaCost?: string; oracleText?: string; typeLine?: string } = {},
): OracleCard {
  const typeLine = options.typeLine ?? 'Instant';
  const types = typeLine
    .split(' — ')[0]!
    .split(/\s+/)
    .filter((type) => type !== '');
  const manaCost = options.manaCost ?? '{U}';
  return oracle({
    name,
    typeLine,
    types,
    manaCost,
    cmc: 1,
    colors: manaCost.includes('R') ? ['R'] : ['U'],
    oracleText: options.oracleText ?? 'Draw a card.',
    power: null,
    toughness: null,
  });
}

function setPriority(game: GameContext, playerId: string): void {
  game.state.priorityPlayerIndex = game.state.turnOrder.indexOf(playerId);
}

function castFrom(
  game: GameContext,
  playerId: string,
  object: EngineCardObject,
  predicate: (payload: Extract<PriorityActionPayload, { kind: 'castSpell' }>) => boolean = () =>
    true,
  answer: (decision: { options: { description: string }[] }) => number = () => 0,
): void {
  const caster = player(game, playerId);
  setPriority(game, playerId);
  const option = computePriorityOptions(game, caster).find((candidate) => {
    if (candidate.type !== 'castSpell') return false;
    const payload = candidate.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>;
    return payload.objectId === object.id && predicate(payload);
  });
  expect(option, `priority offers ${object.name} to ${playerId}`).toBeDefined();
  pump(
    applyPriorityAction(game, caster, option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
    (decision) => ({ index: answer(decision), targets: new Map() }),
  );
}

function resolveAvenAndTrigger(game: GameContext, targetId: string): void {
  pump(resolveTopOfStack(game));
  pump(priorityCheckpoint(game), (decision) => {
    if (decision.decisionType === 'chooseTargets')
      return { index: 0, targets: new Map([[0, targetId]]) };
    return { index: 0, targets: new Map() };
  });
  expect(game.state.stack.at(-1)?.kind).toBe('triggeredAbility');
  pump(resolveTopOfStack(game));
}

function castTargetAndAven(game: GameContext, target: EngineCardObject): void {
  const avenObject = conjure(game, 'P1', aven, 'hand');
  addMana(player(game, 'P2'), [{ symbol: 'U' }]);
  addMana(player(game, 'P1'), [{ symbol: 'C' }, { symbol: 'W' }, { symbol: 'W' }]);

  castFrom(game, 'P2', target);
  const targetSpell = game.state.stack.find(
    (entry) => entry.kind === 'spell' && entry.card?.cardId === target.cardId,
  );
  expect(targetSpell, 'opponent spell is waiting on the stack').toBeDefined();
  castFrom(game, 'P1', avenObject);
  resolveAvenAndTrigger(game, targetSpell!.id);
}

function plottedSpell(
  game: GameContext,
  ownerId = 'P2',
  card = simpleSpell('Plotted Test Instant'),
): EngineCardObject {
  const object = conjure(game, ownerId, card, 'exile');
  object.plottedTurn = game.state.turnNumber - 1;
  return object;
}

function activateMain(game: GameContext, playerId: string, turn = 4): void {
  game.state.currentTurnPlayer = playerId;
  game.state.activePlayerIndex = game.state.turnOrder.indexOf(playerId);
  game.state.turnNumber = turn;
  game.state.phase = 'precombatMain';
  game.state.step = null;
  game.state.priorityPlayerIndex = game.state.activePlayerIndex;
}

function spellOption(game: GameContext, playerId: string, object: EngineCardObject, plot = false) {
  return computePriorityOptions(game, player(game, playerId)).find((option) => {
    if (option.type !== 'castSpell') return false;
    const payload = option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>;
    return payload.objectId === object.id && (payload.plotCast === true) === plot;
  });
}

describe('Aven Interrupter — pinned plot and cast tax', () => {
  it('pins Oracle and normally casts Aven with flash to exile and plot an opposing spell without countering it', () => {
    expect(pinnedEntry.sha256).toBe(AVEN_SHA256);
    expect(aven.oracleText).toContain('It becomes plotted.');
    expect(interpretCard(aven).modeled).toBe(true);

    const game = pod('aven-normal-flash');
    const target = conjure(game, 'P2', simpleSpell('Opposing Draw Spell'), 'hand');
    castTargetAndAven(game, target);

    const exiled = game.state.exile.find((object) => object.cardId === target.cardId);
    expect(exiled?.ownerId).toBe('P2');
    expect(exiled?.plottedTurn).toBe(3);
    expect(game.state.stack.some((entry) => entry.card?.cardId === target.cardId)).toBe(false);
    expect(game.state.battlefield.some((permanent) => permanent.name === aven.name)).toBe(true);
  });

  it('offers an owner-only later-turn plot cast as a sorcery, previews the {2} Aven tax, and pays it with the additional cost', () => {
    const game = pod('aven-plot-tax-additional');
    const target = conjure(
      game,
      'P2',
      simpleSpell('Discard Cost Spell', {
        oracleText: 'As an additional cost to cast this spell, discard a card.\nDraw a card.',
      }),
      'hand',
    );
    const discard = conjure(
      game,
      'P2',
      simpleSpell('Additional Cost Card', { typeLine: 'Sorcery' }),
      'hand',
    );
    const secondDiscard = conjure(
      game,
      'P2',
      simpleSpell('Second Additional Cost Card', { typeLine: 'Sorcery' }),
      'hand',
    );
    castTargetAndAven(game, target);
    activateMain(game, 'P2');
    addMana(player(game, 'P2'), [{ symbol: 'C' }, { symbol: 'C' }]);

    const plotted = game.state.exile.find((object) => object.cardId === target.cardId)!;
    const option = spellOption(game, 'P2', plotted, true);
    expect(option, 'later-turn plot permission is represented on the cast payload').toBeDefined();
    expect(option?.data?.['manaCost']).toBe('{2}');
    expect(option?.data?.['instantSpeed']).toBe(false);
    expect(
      (option?.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).plotCast,
    ).toBe(true);
    expect(spellOption(game, 'P1', plotted, true)).toBeUndefined();

    castFrom(game, 'P2', plotted, (payload) => payload.plotCast === true);
    expect(player(game, 'P2').manaEntries).toHaveLength(0);
    expect(
      player(game, 'P2').graveyard.some(
        (object) => object.cardId === discard.cardId || object.cardId === secondDiscard.cardId,
      ),
    ).toBe(true);
    expect(game.state.stack.at(-1)?.card?.castFromZone).toBe('exile');
  });

  it('does not offer plot in the same turn, off-turn, or while the stack is nonempty', () => {
    const game = pod('aven-plot-timing');
    const card = simpleSpell('Plot Timing Instant');
    const object = plottedSpell(game, 'P2', card);

    activateMain(game, 'P2', 3);
    object.plottedTurn = 3;
    expect(spellOption(game, 'P2', object, true)).toBeUndefined();

    activateMain(game, 'P1', 4);
    expect(spellOption(game, 'P2', object, true)).toBeUndefined();

    activateMain(game, 'P2', 4);
    expect(spellOption(game, 'P2', object, true)).toBeDefined();
    game.state.stack.push({
      id: 'test-pending-spell',
      sourceId: 'test-pending-spell',
      controllerId: 'P1',
      kind: 'spell',
      description: 'Pending spell',
      spellDefinition: game.defs.get(object.oracleId)!,
      targets: [],
      card: null,
      ability: null,
      sourceOracleId: 'pending',
      sourceCardId: 'pending',
      isCommanderCast: false,
    });
    expect(spellOption(game, 'P2', object, true)).toBeUndefined();
  });

  it('exiles an uncounterable spell because this ability exiles instead of countering', () => {
    const game = pod('aven-uncounterable');
    const target = conjure(game, 'P2', simpleSpell('Uncounterable Spell'), 'hand');
    editableDef(game, target.oracleId).spellCantBeCountered = true;
    castTargetAndAven(game, target);
    expect(
      game.state.exile.some(
        (object) => object.cardId === target.cardId && object.plottedTurn === 3,
      ),
    ).toBe(true);
  });

  it('makes a targeted spell copy cease to exist without creating a plotted card', () => {
    const game = pod('aven-copy');
    const target = conjure(game, 'P2', simpleSpell('Copied Opposing Spell'), 'hand');
    addMana(player(game, 'P2'), [{ symbol: 'U' }]);
    castFrom(game, 'P2', target);
    const original = game.state.stack.find(
      (entry) => entry.kind === 'spell' && entry.card?.cardId === target.cardId,
    )!;
    const copy = queueSpellCopy(game, original, 'P2');
    const avenObject = conjure(game, 'P1', aven, 'hand');
    addMana(player(game, 'P1'), [{ symbol: 'C' }, { symbol: 'W' }, { symbol: 'W' }]);
    castFrom(game, 'P1', avenObject);
    resolveAvenAndTrigger(game, copy.id);

    expect(game.state.stack.some((entry) => entry.id === copy.id)).toBe(false);
    expect(game.state.stack.some((entry) => entry.id === original.id)).toBe(true);
    expect(game.state.exile.some((object) => object.cardId === target.cardId)).toBe(false);
  });

  it('clears plot permission when the exiled card leaves and returns to exile as a new incarnation', () => {
    const game = pod('aven-plot-incarnation');
    const target = conjure(game, 'P2', simpleSpell('Plot Incarnation Spell'), 'hand');
    castTargetAndAven(game, target);
    const first = game.state.exile.find((object) => object.cardId === target.cardId)!;
    const graveyard = pump(moveObject(game, first, { zone: 'graveyard' })).value!;
    const returned = pump(moveObject(game, graveyard, { zone: 'exile' })).value!;
    expect(returned.id).not.toBe(first.id);
    expect((returned as EngineCardObject).plottedTurn).toBeUndefined();
    activateMain(game, 'P2', 4);
    expect(spellOption(game, 'P2', returned, true)).toBeUndefined();
  });

  it('adds {2} for opposing graveyard and exile casts, but not hand casts or the source controller', () => {
    const game = pod('aven-zone-tax');
    spawn(game, 'P1', aven);
    activateMain(game, 'P2');
    const card = simpleSpell('Taxed Test Sorcery', { typeLine: 'Sorcery' });
    const hand = conjure(game, 'P2', card, 'hand');
    const exile = conjure(game, 'P2', card, 'exile');
    exile.playableUntilEotBy = 'P2';
    const grave = conjure(game, 'P2', card, 'graveyard');
    editableDef(game, grave.oracleId).castFromGraveyard = true;
    const ownExile = conjure(game, 'P1', card, 'exile');
    ownExile.playableUntilEotBy = 'P1';
    addMana(player(game, 'P2'), [
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'U' },
    ]);
    addMana(player(game, 'P1'), [{ symbol: 'U' }]);

    expect(spellOption(game, 'P2', hand)?.data?.['manaCost']).toBe('{U}');
    expect(spellOption(game, 'P2', exile)?.data?.['manaCost']).toBe('{2}{U}');
    expect(spellOption(game, 'P2', grave)?.data?.['manaCost']).toBe('{2}{U}');
    activateMain(game, 'P1');
    expect(spellOption(game, 'P1', ownExile)?.data?.['manaCost']).toBe('{U}');
  });

  it('keeps X at zero on a plotted X spell and rejects a combined alternate cost', () => {
    const game = pod('aven-plot-x');
    spawn(game, 'P1', aven);
    activateMain(game, 'P2', 4);
    const xSpell = simpleSpell('Plotted X Spell', { manaCost: '{X}{R}', typeLine: 'Sorcery' });
    const plotted = plottedSpell(game, 'P2', xSpell);
    addMana(player(game, 'P2'), [{ symbol: 'C' }, { symbol: 'C' }]);
    const option = spellOption(game, 'P2', plotted, true);
    expect(option).toBeDefined();
    expect((option!.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).x ?? 0).toBe(
      0,
    );

    castFrom(game, 'P2', plotted, (payload) => payload.plotCast === true);
    expect(game.state.stack.at(-1)?.card?.announcedX ?? 0).toBe(0);

    const second = plottedSpell(game, 'P2', simpleSpell('Invalid Alternative Plot Spell'));
    const payload: PriorityActionPayload = {
      kind: 'castSpell',
      objectId: second.id,
      fromCommand: false,
      fromExile: true,
      plotCast: true,
      alternativeCast: 'energy',
    };
    setPriority(game, 'P2');
    expect(() =>
      pump(
        applyPriorityAction(game, player(game, 'P2'), payload, { index: 0, targets: new Map() }),
      ),
    ).toThrow(/plot cannot combine alternative costs/);
  });

  it('offers a plotted MDFC back face and applies the opposing Aven tax to its free plot cast', () => {
    const lanternEntry = fixture.cards.find(
      (candidate) => candidate.card.name === "Tergrid, God of Fright // Tergrid's Lantern",
    );
    expect(lanternEntry?.sha256).toBe(
      '390005effb7682d435bd1fffe5b17fd1603da3e0bac9a3fcb43d7c3f04d1d9f4',
    );
    const lanternCard = lanternEntry!.card;
    const game = pod('aven-plotted-mdfc-back');
    const target = conjure(game, 'P2', lanternCard, 'hand');
    addMana(player(game, 'P2'), [
      { symbol: 'B' },
      { symbol: 'C' },
      { symbol: 'C' },
      { symbol: 'C' },
    ]);
    castFrom(game, 'P2', target, (payload) => payload.alternativeCast === 'mdfc');
    const backSpell = game.state.stack.find(
      (entry) => entry.kind === 'spell' && entry.card?.cardId === target.cardId,
    );
    expect(backSpell?.description).toBe("Tergrid's Lantern");

    const avenObject = conjure(game, 'P1', aven, 'hand');
    addMana(player(game, 'P1'), [{ symbol: 'C' }, { symbol: 'W' }, { symbol: 'W' }]);
    castFrom(game, 'P1', avenObject);
    resolveAvenAndTrigger(game, backSpell!.id);
    const plotted = game.state.exile.find((object) => object.cardId === target.cardId)!;
    expect(plotted.plottedTurn).toBe(3);

    activateMain(game, 'P2', 4);
    addMana(player(game, 'P2'), [{ symbol: 'C' }, { symbol: 'C' }]);
    const plotOption = computePriorityOptions(game, player(game, 'P2')).find((option) => {
      if (option.type !== 'castSpell') return false;
      const payload = option.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>;
      return (
        payload.objectId === plotted.id &&
        payload.plotCast === true &&
        payload.alternativeCast === 'mdfc'
      );
    });
    expect(plotOption).toBeDefined();
    expect(plotOption?.data?.['manaCost']).toBe('{2}');
    expect(
      (plotOption?.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>)
        .alternativeCast,
    ).toBe('mdfc');
    castFrom(
      game,
      'P2',
      plotted,
      (payload) => payload.plotCast === true && payload.alternativeCast === 'mdfc',
    );
    expect(game.state.stack.at(-1)?.description).toBe("Tergrid's Lantern");
    expect(game.state.stack.at(-1)?.spellDefinition?.types).toContain('Artifact');
    expect(player(game, 'P2').manaEntries).toHaveLength(0);
  });
});
