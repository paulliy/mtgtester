import { describe, it, expect } from 'vitest';
import { parsePlaintextDeck } from './plaintext';

describe('parsePlaintextDeck', () => {
  it('parses sections, quantities, and strips set/foil annotations', () => {
    const deck = parsePlaintextDeck(
      `Commander
1 Atraxa, Praetors' Voice

Deck
1 Sol Ring (C21) 250 *F*
1x Arcane Signet
3 Forest
# a comment
// another comment

Companion
1 Lutri, the Spellchaser

Sideboard
1 Ignored Card`,
    );

    expect(deck.sourceType).toBe('plaintext');
    expect(deck.commanderNames).toEqual(["Atraxa, Praetors' Voice"]);
    expect(deck.companionName).toBe('Lutri, the Spellchaser');
    expect(deck.cards).toContainEqual({ name: 'Sol Ring', quantity: 1 });
    expect(deck.cards).toContainEqual({ name: 'Arcane Signet', quantity: 1 });
    expect(deck.cards).toContainEqual({ name: 'Forest', quantity: 3 });
    // Sideboard entries are ignored (Commander has no sideboard beyond the companion).
    expect(deck.cards.find((c) => c.name === 'Ignored Card')).toBeUndefined();
  });

  it('supports an inline "Commander: Name" designation', () => {
    const deck = parsePlaintextDeck(`Commander: Krenko, Mob Boss\n1 Goblin Warrens`);
    expect(deck.commanderNames).toEqual(['Krenko, Mob Boss']);
    expect(deck.cards).toEqual([{ name: 'Goblin Warrens', quantity: 1 }]);
  });

  it('keeps both commanders of a partner pair, from a section or inline lines', () => {
    const section = parsePlaintextDeck(
      `Commanders\n1 Tymna the Weaver\n1 Thrasios, Triton Hero\n\nDeck\n1 Sol Ring`,
    );
    expect(section.commanderNames).toEqual(['Tymna the Weaver', 'Thrasios, Triton Hero']);
    const inline = parsePlaintextDeck(
      `Commander: Wilson, Refined Grizzly\nCommander: Raised by Giants\n1 Sol Ring`,
    );
    expect(inline.commanderNames).toEqual(['Wilson, Refined Grizzly', 'Raised by Giants']);
    expect(inline.cards).toEqual([{ name: 'Sol Ring', quantity: 1 }]);
  });

  it('merges duplicate lines of the same card', () => {
    const deck = parsePlaintextDeck(`Deck\n1 Forest\n1 Forest`);
    expect(deck.cards).toEqual([{ name: 'Forest', quantity: 2 }]);
  });
});
