/**
 * The anti-cheat boundary (brief §7.1, §12): a `PlayerView` never contains another
 * player's hand, any library order (including the viewer's own), or another player's
 * decklist.
 */

import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine';
import { buildPlayerView } from '../src/view/view';
import { createGame } from '../src/state/game';
import { commanderFor, conjure, copies, forest, gameConfig, oracle, spawn } from './fixtures';

function secretPod(): ReturnType<typeof gameConfig> {
  const secret = (name: string): ReturnType<typeof oracle> =>
    oracle({
      name,
      typeLine: 'Creature — Test Secret',
      manaCost: '{1}',
      power: '1',
      toughness: '1',
    });
  return gameConfig(
    [
      {
        commander: commanderFor('G', 'Viewer General'),
        cards: [...copies(10, forest), secret('Own Tech Alpha')],
      },
      {
        commander: commanderFor('R', 'Enemy General Two'),
        cards: [...copies(10, forest), secret('Secret Sauce Two')],
      },
      {
        commander: commanderFor('U', 'Enemy General Three'),
        cards: [...copies(10, forest), secret('Secret Sauce Three')],
      },
      {
        commander: commanderFor('B', 'Enemy General Four'),
        cards: [...copies(10, forest), secret('Secret Sauce Four')],
      },
    ],
    { seed: 'visibility' },
  );
}

describe('PlayerView visibility (brief §7.1)', () => {
  it('contains no opponent hands, no opponent decklists, and no library order', () => {
    const engine = new Engine(secretPod());
    // Advance into the game so hands exist.
    const step = engine.advance();
    expect(step.kind).toBe('decision');

    const view = engine.view('P1');
    const json = JSON.stringify(view);

    // Opponent deck/hand/library contents never appear — not anywhere in the payload.
    expect(json).not.toContain('Secret Sauce Two');
    expect(json).not.toContain('Secret Sauce Three');
    expect(json).not.toContain('Secret Sauce Four');

    // Opponents are reported as counts, not contents.
    for (const opp of view.opponents) {
      expect(typeof opp.handSize).toBe('number');
      expect(typeof opp.librarySize).toBe('number');
      expect(json).not.toContain('"hand":undefined');
    }
    expect(view.opponents).toHaveLength(3);

    // The viewer's OWN decklist is visible (contents), including cards still in-library.
    expect(json).toContain('Own Tech Alpha');
    // But no structure carries the viewer's library ORDER: the deck list is in fixed
    // decklist order (commanders first, then the configured card order), independent of
    // the shuffled library.
    expect(view.deck[0]?.name).toBe('Viewer General');
    const deckNames = view.deck.map((c) => c.name);
    expect(deckNames.slice(1, 11)).toEqual(Array.from({ length: 10 }, () => 'Forest'));
    expect((view as unknown as Record<string, unknown>)['library']).toBeUndefined();

    // Commanders everywhere are public.
    expect(json).toContain('Enemy General Two');
  });

  it('never leaks drawn/bottomed card identities through the recent log', () => {
    const ctx = createGame(secretPod());
    ctx.state.currentTurnPlayer = 'P1';
    const p2 = ctx.state.players.find((p) => p.id === 'P2');
    if (p2 === undefined) throw new Error('no P2');
    // Simulate P2 having drawn their secret card: event log carries it internally.
    conjure(
      ctx,
      'P2',
      oracle({
        name: 'Deep Secret',
        typeLine: 'Instant',
        power: null,
        toughness: null,
        oracleText: 'Draw a card.',
        manaCost: '{U}',
      }),
      'hand',
    );
    ctx.state.eventLog.push({
      sequence: ctx.state.nextEventSequence++,
      turn: 1,
      phase: 'beginning',
      step: 'draw',
      actorSeat: 'P2',
      type: 'draw',
      payload: { player: 'P2', cardId: 'x', name: 'Deep Secret' },
    });
    ctx.state.eventLog.push({
      sequence: ctx.state.nextEventSequence++,
      turn: 1,
      phase: 'beginning',
      step: 'draw',
      actorSeat: 'P2',
      type: 'zoneChange',
      payload: { cardId: 'x', name: 'Deep Secret', from: 'library', to: 'hand', owner: 'P2' },
    });

    const view = buildPlayerView(ctx, 'P1');
    expect(JSON.stringify(view)).not.toContain('Deep Secret');
  });

  it('redacts an unrevealed tutor result from opponents while preserving the public search', () => {
    const ctx = createGame(secretPod());
    ctx.state.eventLog.push({
      sequence: ctx.state.nextEventSequence++,
      turn: 1,
      phase: 'precombatMain',
      step: null,
      actorSeat: 'P2',
      type: 'searchFound',
      payload: { player: 'P2', name: 'Private Tutor Result', to: 'hand' },
    });

    const opponentLog = buildPlayerView(ctx, 'P1').recentLog.join('\n');
    expect(opponentLog).toContain('searchFound');
    expect(opponentLog).not.toContain('Private Tutor Result');
    expect(buildPlayerView(ctx, 'P2').recentLog.join('\n')).toContain('Private Tutor Result');
  });

  it("exposes battlefield rules text, but never a face-down permanent's (§7.1, §7.4)", () => {
    const ctx = createGame(secretPod());
    const menace = oracle({
      name: 'Public Threat',
      typeLine: 'Creature — Test Ogre',
      manaCost: '{2}{R}',
      power: '3',
      toughness: '3',
      oracleText: 'Trample',
    });
    const hidden = oracle({
      name: 'Morph Target',
      typeLine: 'Creature — Test Shapeshifter',
      manaCost: '{2}{U}',
      power: '2',
      toughness: '2',
      oracleText: 'When this creature is turned face up, draw three cards.',
    });

    // An opponent's ordinary permanent: its text box is public, so the AI must see it —
    // otherwise it can read the name "Blood Moon" and not know what it does.
    spawn(ctx, 'P2', menace);
    const facedown = spawn(ctx, 'P2', hidden);
    facedown.statuses.push('faceDown');

    const view = buildPlayerView(ctx, 'P1');
    const shown = view.battlefield.find((p) => p.name === 'Public Threat');
    const concealed = view.battlefield.find((p) => p.id === facedown.id);

    expect(shown?.oracleText).toBe('Trample');
    expect(shown?.typeLine).toBe('Creature — Test Ogre');
    expect(shown?.keywords).toEqual(['trample']);

    // Face down: identity withheld. The permanent is still visible as an object.
    expect(concealed).toBeDefined();
    expect(concealed?.name).toBe('Face-down permanent');
    expect(concealed?.oracleText).toBeUndefined();
    expect(concealed?.typeLine).toBeUndefined();
    // Keywords are part of that identity: a face-down creature must not report the abilities of
    // the card it actually is, the same way it does not report its text box (ADR 0023 item 20).
    expect(concealed?.keywords).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('turned face up');
  });

  it('projects GRANTED keywords, not just printed ones (ADR 0023 item 20)', () => {
    // The whole reason this is a projection and not something the reader re-derives from
    // `oracleText`: layer 6 grants keywords that appear nowhere in the permanent's own text.
    const ctx = createGame(secretPod());
    const anthem = oracle({
      name: 'Trample Anthem',
      typeLine: 'Enchantment',
      manaCost: '{2}{G}',
      power: null,
      toughness: null,
      oracleText: 'Creatures you control have trample.',
    });
    const vanilla = oracle({
      name: 'Plain Beast',
      typeLine: 'Creature — Test Beast',
      manaCost: '{2}{G}',
      power: '3',
      toughness: '3',
      oracleText: '',
    });
    spawn(ctx, 'P2', anthem);
    spawn(ctx, 'P2', vanilla);

    const beast = buildPlayerView(ctx, 'P1').battlefield.find((p) => p.name === 'Plain Beast');
    expect(beast?.oracleText).toBe('');
    expect(beast?.keywords).toContain('trample');
  });

  it('includes power and toughness for creature cards in hand', () => {
    const ctx = createGame(secretPod());
    const bearCard = oracle({
      name: 'Forest Bear',
      typeLine: 'Creature — Bear',
      manaCost: '{1}{G}',
      power: '2',
      toughness: '2',
      oracleText: '',
    });
    const spellCard = oracle({
      name: 'Forest Spell',
      typeLine: 'Sorcery',
      manaCost: '{G}',
      power: null,
      toughness: null,
      oracleText: 'Gain 3 life.',
    });

    conjure(ctx, 'P1', bearCard, 'hand');
    conjure(ctx, 'P1', spellCard, 'hand');

    const view = buildPlayerView(ctx, 'P1');
    const bearInHand = view.hand.find((c) => c.name === 'Forest Bear');
    const spellInHand = view.hand.find((c) => c.name === 'Forest Spell');

    expect(bearInHand?.power).toBe(2);
    expect(bearInHand?.toughness).toBe(2);
    expect(spellInHand?.power).toBeUndefined();
    expect(spellInHand?.toughness).toBeUndefined();
  });

  it('shows exile publicly, except a face-down card stays hidden from everyone but its owner', () => {
    const ctx = createGame(secretPod());
    const ordinary = conjure(
      ctx,
      'P2',
      oracle({ name: 'Public Exile Card', typeLine: 'Instant', power: null, toughness: null }),
      'exile',
    );
    const hidden = conjure(
      ctx,
      'P2',
      oracle({ name: 'Hidden Away Card', typeLine: 'Instant', power: null, toughness: null }),
      'exile',
    );
    hidden.attachedToCardId = 'some-hideaway-source';
    void ordinary;

    const ownerView = buildPlayerView(ctx, 'P2');
    const viewerView = buildPlayerView(ctx, 'P1');

    expect(ownerView.exile.find((c) => c.id === hidden.id)?.name).toBe('Hidden Away Card');
    expect(viewerView.exile.find((c) => c.id === hidden.id)?.name).toBe('Face-down card');

    // The ordinary (not face-down) exiled card is visible to everyone.
    expect(viewerView.exile.some((c) => c.name === 'Public Exile Card')).toBe(true);
    expect(JSON.stringify(viewerView)).not.toContain('Hidden Away Card');
  });
});
