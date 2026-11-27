import { describe, expect, it } from 'vitest';
import type { DecisionRequest, PlayerView } from '@mtg/shared';
import { CardGlossary } from './card-glossary';
import { assemblePrompt } from './context';
import { preparePromptForCaching } from './prompt-cache';

describe('CardGlossary', () => {
  it('repeats earlier messages byte for byte and adds one message for new names only', () => {
    const glossary = new CardGlossary();
    expect(glossary.cover('Sol Ring', '{T}: Add {C}{C}.')).toBe(true);
    const first = glossary.flush();
    expect(first).toEqual([
      { role: 'user', content: '{"cardText":{"Sol Ring":"{T}: Add {C}{C}."}}' },
    ]);

    expect(glossary.cover('Sol Ring', '{T}: Add {C}{C}.')).toBe(true);
    expect(glossary.cover('Llanowar Elves', '{T}: Add {G}.')).toBe(true);
    const second = glossary.flush();
    expect(second.slice(0, 1)).toEqual(first);
    expect(second[1]).toEqual({
      role: 'user',
      content: '{"cardText":{"Llanowar Elves":"{T}: Add {G}."}}',
    });

    expect(glossary.cover('Sol Ring', '{T}: Add {C}{C}.')).toBe(true);
    expect(glossary.cover('Llanowar Elves', '{T}: Add {G}.')).toBe(true);
    expect(glossary.flush()).toEqual(second);
  });

  it('refuses a listed name with different text, so the caller keeps that text inline', () => {
    const glossary = new CardGlossary();
    glossary.cover('Clone', 'You may have this enter as a copy of a creature.');
    expect(glossary.cover('Clone', 'Flying')).toBe(false);
    expect(glossary.flush()).toEqual([
      {
        role: 'user',
        content: '{"cardText":{"Clone":"You may have this enter as a copy of a creature."}}',
      },
    ]);
  });

  it('restarts from the cards in view once text out of view outweighs the ratio', () => {
    const glossary = new CardGlossary(0.5);
    glossary.cover('Gone', 'x'.repeat(100));
    glossary.cover('Kept', 'y'.repeat(100));
    glossary.flush();
    // Only "Kept" in view: 104 stale chars against 104 live is over half, so it restarts.
    glossary.cover('Kept', 'y'.repeat(100));
    expect(glossary.flush()).toEqual([
      { role: 'user', content: JSON.stringify({ cardText: { Kept: 'y'.repeat(100) } }) },
    ]);
    // A restarted name that comes back is listed again, after the restarted message.
    glossary.cover('Kept', 'y'.repeat(100));
    expect(glossary.cover('Gone', 'x'.repeat(100))).toBe(true);
    expect(glossary.flush()).toHaveLength(2);
  });

  it('keeps out-of-view cards while they stay under the ratio', () => {
    const glossary = new CardGlossary(0.5);
    glossary.cover('Gone', 'x');
    glossary.cover('Kept', 'y'.repeat(100));
    const first = glossary.flush();
    glossary.cover('Kept', 'y'.repeat(100));
    expect(glossary.flush()).toEqual(first);
  });
});

function view(): PlayerView {
  return {
    seat: 'P1',
    life: 40,
    hand: [
      {
        id: 'c1',
        name: 'Llanowar Elves',
        manaCost: '{G}',
        typeLine: 'Creature — Elf Druid',
        oracleText: '{T}: Add {G}.',
      },
    ],
    graveyard: [],
    exile: [],
    commanders: [],
    availableMana: {},
    manaSources: [],
    opponents: [],
    battlefield: [
      {
        id: 'p1',
        controller: 'P1',
        name: 'Sol Ring',
        typeLine: 'Artifact',
        tapped: false,
        status: [],
        oracleText: '{T}: Add {C}{C}.',
      },
      { id: 'p2', controller: 'P1', name: 'Forest', tapped: false, status: [] },
    ],
    stack: [],
    recentLog: [],
  } as unknown as PlayerView;
}

const request: DecisionRequest = {
  requestId: 'g1-t1-d1',
  gameId: 'g1',
  turn: 1,
  activePlayer: 'P1',
  decidingPlayer: 'P1',
  phase: 'precombatMain',
  step: null,
  decisionType: 'priority',
  prompt: 'You have priority.',
  legalActions: [{ id: 0, type: 'pass', description: 'Pass' }],
};

describe('assemblePrompt with a card glossary', () => {
  it('moves hand and battlefield text into glossary messages ahead of the observation', () => {
    const prompt = assemblePrompt(request, view(), undefined, { cardGlossary: new CardGlossary() });
    expect(prompt.glossaryMessageCount).toBe(1);
    expect(prompt.messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(prompt.messages[0]!.content).toContain('cardText');
    expect(JSON.parse(prompt.messages[1]!.content)).toEqual({
      cardText: { 'Llanowar Elves': '{T}: Add {G}.', 'Sol Ring': '{T}: Add {C}{C}.' },
    });
    const observation = JSON.parse(prompt.messages[2]!.content);
    expect(observation.you.hand[0]).not.toHaveProperty('text');
    expect(observation.you.hand[0].type).toBe('Creature — Elf Druid');
    expect(observation.battlefield[0]).not.toHaveProperty('text');
    expect(observation.battlefield[0].type).toBe('Artifact');
  });

  it('sends the same prompt as before without a glossary', () => {
    const prompt = assemblePrompt(request, view());
    expect(prompt).not.toHaveProperty('glossaryMessageCount');
    expect(prompt.messages).toHaveLength(2);
    expect(prompt.messages[0]!.content).not.toContain('cardText');
    const observation = JSON.parse(prompt.messages[1]!.content);
    expect(observation.you.hand[0].text).toBe('{T}: Add {G}.');
    expect(observation.battlefield[0].text).toBe('{T}: Add {C}{C}.');
  });

  it('is not used with the budgeter, which must see all the text it limits', () => {
    const prompt = assemblePrompt(request, view(), undefined, {
      cardGlossary: new CardGlossary(),
      useBudgeter: true,
    });
    expect(prompt).not.toHaveProperty('glossaryMessageCount');
    expect(JSON.parse(prompt.messages.at(-1)!.content).battlefield[0].text).toBe(
      '{T}: Add {C}{C}.',
    );
  });

  it('sits between the stable prefix and the observation in the cache layout', () => {
    const prompt = preparePromptForCaching(
      assemblePrompt(request, view(), undefined, { cardGlossary: new CardGlossary() }),
      { role: 'tactician', staticContext: { deck: 'constants' } },
    );
    expect(prompt.promptCache?.prefixMessageCount).toBe(2);
    expect(prompt.glossaryMessageCount).toBe(1);
    expect(prompt.messages[2]!.content).toContain('cardText');
    expect(prompt.messages.at(-1)!.content).toContain('battlefield');
  });
});

describe('assemblePrompt with a stable system primer', () => {
  const attack: DecisionRequest = {
    ...request,
    decisionType: 'declareAttackers',
    legalActions: [{ id: 0, type: 'pass', description: 'No attack' }],
  };

  it('keeps the system prompt the same across decision types and sends the rest after the state', () => {
    const priority = assemblePrompt(request, view(), undefined, { stableSystemPrimer: true });
    const attacking = assemblePrompt(attack, view(), undefined, { stableSystemPrimer: true });
    expect(attacking.messages[0]).toEqual(priority.messages[0]);
    expect(attacking.messages.map((m) => m.role)).toEqual(['system', 'user', 'system']);
    // The same instructions as the one-piece primer, split in two.
    const whole = assemblePrompt(attack, view()).messages[0]!.content;
    expect(`${attacking.messages[0]!.content}\n\n${attacking.messages[2]!.content}`).toBe(whole);
  });

  it('adds no trailing message when the decision needs only the common section', () => {
    const priority = assemblePrompt(request, view(), undefined, { stableSystemPrimer: true });
    expect(priority.messages).toEqual(assemblePrompt(request, view()).messages);
  });

  it('leaves the observation as the dynamic message in the cache layout', () => {
    const prompt = preparePromptForCaching(
      assemblePrompt(attack, view(), undefined, {
        stableSystemPrimer: true,
        cardGlossary: new CardGlossary(),
      }),
      { role: 'tactician', staticContext: { deck: 'constants' } },
    );
    expect(prompt.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'user',
      'user',
      'system',
    ]);
    expect(prompt.messages[3]!.content).toContain('battlefield');
    expect(prompt.messages[4]!.content).not.toContain('battlefield');
  });
});
