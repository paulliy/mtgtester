import { describe, expect, it } from 'vitest';
import type { DecisionRequest, PlayerView } from '@mtg/shared';
import { assemblePrompt, assembleStrategistPrompt } from './context';

function fixtureView(): PlayerView {
  return {
    seat: 'P1',
    life: 40,
    hand: [
      {
        id: 'c1',
        name: 'Grizzly Bears',
        manaCost: '{1}{G}',
        typeLine: 'Creature — Bear',
        oracleText: 'Vanilla creature.',
      },
    ],
    deck: [{ id: 'd1', name: 'Forest' }], // decklist contents, name only
    graveyard: [{ id: 'g1', name: 'Giant Growth' }],
    exile: [],
    commanders: [{ name: 'Llanowar Elves', zone: 'command', castCount: 0 }],
    availableMana: { G: 2 },
    manaSources: [{ name: 'Forest', symbols: ['G'], count: 1 }],
    opponents: [
      {
        seat: 'P2',
        life: 40,
        handSize: 7,
        librarySize: 92,
        graveyard: [{ id: 'og1', name: 'Sol Ring' }],
        commanders: [{ name: 'Krenko, Mob Boss', zone: 'command', castCount: 0 }],
        poisonCounters: 0,
        commanderDamageDealtToYou: 0,
      },
    ],
    battlefield: [
      {
        id: 'p1',
        controller: 'P1',
        name: 'Forest',
        tapped: false,
        status: [],
      },
    ],
    stack: [],
    recentLog: ['T1 P1 phaseBegin phase=beginning step=untap'],
  };
}

function fixtureRequest(): DecisionRequest {
  return {
    requestId: 'g1-t1-d1',
    gameId: 'g1',
    turn: 1,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'You have priority. Choose an action.',
    legalActions: [
      { id: 0, type: 'pass', description: 'Pass priority' },
      { id: 1, type: 'castSpell', description: 'Cast Grizzly Bears ({1}{G})' },
    ],
    presentation: {
      layout: 'cards',
      source: { cardId: 'c1', name: 'Grizzly Bears', scryfallId: 'scry-1' },
      actions: {
        1: {
          verb: 'Cast',
          subjects: [
            {
              kind: 'card',
              card: {
                objectId: 'c1',
                name: 'Grizzly Bears',
                scryfallId: 'scry-1',
                typeLine: 'Creature — Bear',
                zone: 'hand',
              },
            },
          ],
        },
      },
    },
  };
}

describe('Context Assembler', () => {
  it('produces valid OpenAI system and user messages', () => {
    const view = fixtureView();
    const req = fixtureRequest();
    const prompt = assemblePrompt(req, view);

    expect(prompt.messages).toHaveLength(2);
    expect(prompt.messages[0]?.role).toBe('system');
    expect(prompt.messages[1]?.role).toBe('user');

    const parsedUser = JSON.parse(prompt.messages[1]!.content);
    expect(parsedUser.ctx.reqId).toBe('g1-t1-d1');
    expect(parsedUser.you.seat).toBe('P1');
    expect(parsedUser.legalActions).toHaveLength(2);
  });

  it('never sends presentation/scryfallId data to the model (browser-only, Workstream 3)', () => {
    const prompt = assemblePrompt(fixtureRequest(), fixtureView());
    const userJson = prompt.messages[1]!.content;
    expect(userJson).not.toContain('presentation');
    expect(userJson).not.toContain('scryfallId');
    expect(userJson).not.toContain('scry-1');

    const strategistPrompt = assembleStrategistPrompt(fixtureRequest(), fixtureView(), []);
    const strategistJson = strategistPrompt.messages[1]!.content;
    expect(strategistJson).not.toContain('presentation');
    expect(strategistJson).not.toContain('scryfallId');
    expect(strategistJson).not.toContain('scry-1');
  });

  it('includes hand oracle text in you section when text is present', () => {
    const prompt = assemblePrompt(fixtureRequest(), fixtureView());
    const parsedUser = JSON.parse(prompt.messages[1]!.content);
    expect(parsedUser.you.hand[0].text).toBe('Vanilla creature.');
  });

  it('includes hand power and toughness in you section when present', () => {
    const view = fixtureView();
    view.hand[0]!.power = 2;
    view.hand[0]!.toughness = 2;
    const prompt = assemblePrompt(fixtureRequest(), view);
    const parsedUser = JSON.parse(prompt.messages[1]!.content);
    expect(parsedUser.you.hand[0].p).toBe(2);
    expect(parsedUser.you.hand[0].t).toBe(2);
  });

  it('excludes library contents and hidden opponent cards from prompt', () => {
    const prompt = assemblePrompt(fixtureRequest(), fixtureView());
    const userContent = prompt.messages[1]!.content;

    // Must not include deck contents or opponent hand contents
    expect(userContent).not.toContain('"deck"');
    expect(userContent).not.toContain('opponentHand');
  });

  it('calculates a positive estimatedToken count', () => {
    const prompt = assemblePrompt(fixtureRequest(), fixtureView());
    expect(prompt.estimatedTokens).toBeGreaterThan(100);
  });

  it('sends battlefield rules text once per name, and never for basics (§7.4)', () => {
    const view = fixtureView();
    view.battlefield = [
      // Two copies of the same token: the text is identical, so it is worth sending once.
      {
        id: 'p2',
        controller: 'P2',
        name: 'Thopter',
        tapped: false,
        status: [],
        oracleText: 'Flying',
      },
      {
        id: 'p3',
        controller: 'P2',
        name: 'Thopter',
        tapped: false,
        status: [],
        oracleText: 'Flying',
      },
      // A basic: its text is reminder text the model already knows.
      {
        id: 'p4',
        controller: 'P1',
        name: 'Forest',
        tapped: false,
        status: [],
        oracleText: '({T}: Add {G}.)',
      },
      // The case that motivated this: a name alone does not tell you what it does.
      {
        id: 'p5',
        controller: 'P3',
        name: 'Blood Moon',
        tapped: false,
        status: [],
        oracleText: 'Nonbasic lands are Mountains.',
      },
    ];

    const parsedUser = JSON.parse(assemblePrompt(fixtureRequest(), view).messages[1]!.content);
    const [thopterA, thopterB, forestPerm, bloodMoon] = parsedUser.battlefield;

    expect(thopterA.text).toBe('Flying');
    expect(thopterB.text).toBeUndefined(); // deduped
    expect(forestPerm.text).toBeUndefined(); // basic
    expect(bloodMoon.text).toBe('Nonbasic lands are Mountains.');
  });

  it('keeps the full ~15-entry recent log the view already trimmed (§7.4)', () => {
    const view = fixtureView();
    view.recentLog = Array.from({ length: 15 }, (_, i) => `T1 P1 event-${i}`);

    const parsedUser = JSON.parse(assemblePrompt(fixtureRequest(), view).messages[1]!.content);
    expect(parsedUser.recentLog).toHaveLength(15);
    expect(parsedUser.recentLog[0]).toBe('T1 P1 event-0');
  });

  it('adds standing intent and seat-local history to tactical prompts', () => {
    const prompt = assemblePrompt(fixtureRequest(), fixtureView(), {
      strategy: {
        intent: 'Develop, then hold interaction.',
        plannedActions: [],
      },
      recentDecisions: [{ turn: 1, phase: 'precombatMain', action: 'Play Forest' }],
    });
    const payload = JSON.parse(prompt.messages[1]!.content);
    expect(payload.turnStrategy.intent).toContain('hold interaction');
    expect(payload.yourRecentDecisions).toHaveLength(1);
    expect(prompt.messages[0]!.content).toContain('TACTICIAN ROLE');
  });

  it('builds strategist context from the same hidden-information-safe PlayerView', () => {
    const prompt = assembleStrategistPrompt(fixtureRequest(), fixtureView(), []);
    const payload = JSON.parse(prompt.messages[1]!.content);
    expect(prompt.messages[0]!.content).toContain('STRATEGIST ROLE');
    expect(payload.opponents[0]).not.toHaveProperty('handCards');
    expect(payload).not.toHaveProperty('gameState');
  });
});

/**
 * ADR 0022 §5 gave the strategist its own deck's archetype. The boundary matters more than the
 * feature: an archetype is derived from a full 99-card list, so it is exactly as private as a
 * decklist. One seat's tag must never reach another seat's prompt.
 */
describe('strategist deck archetype', () => {
  it("tells the strategist what its own deck is built to do", () => {
    const prompt = assembleStrategistPrompt(
      fixtureRequest(),
      fixtureView(),
      [],
      'Gruul dragon tribal aggro',
    );
    const payload = JSON.parse(prompt.messages[1]!.content);

    expect(payload.yourDeckArchetype).toBe('Gruul dragon tribal aggro');
    expect(payload.strategyTask.requirements[0]).toContain('yourDeckArchetype');
  });

  it('omits the field entirely when no archetype is known, rather than sending a placeholder', () => {
    const payload = JSON.parse(
      assembleStrategistPrompt(fixtureRequest(), fixtureView(), []).messages[1]!.content,
    );

    expect(payload).not.toHaveProperty('yourDeckArchetype');
    expect(payload.strategyTask.requirements[0]).not.toContain('yourDeckArchetype');
  });

  it('never carries another seat\'s archetype anywhere in the prompt', () => {
    const prompt = assembleStrategistPrompt(
      fixtureRequest(),
      fixtureView(),
      [],
      'Gruul dragon tribal aggro',
    );
    const whole = prompt.messages.map((message) => message.content).join('\n');

    // The caller passes one seat's tag; nothing in the assembler may invent or echo others.
    expect(whole).not.toContain('Azorius');
    const payload = JSON.parse(prompt.messages[1]!.content) as { opponents: unknown[] };
    for (const opponent of payload.opponents) {
      expect(opponent).not.toHaveProperty('archetype');
      expect(opponent).not.toHaveProperty('deckArchetype');
    }
    expect(prompt.messages[0]!.content).toContain('yourDeckArchetype describes YOUR deck only');
  });
});
