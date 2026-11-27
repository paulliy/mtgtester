import { describe, expect, it } from 'vitest';
import type { DecisionRequest, PlayerId } from '@mtg/shared';
import { Engine, runToCompletionAsync } from '@mtg/engine';
import { decide, Rng } from '@mtg/bot';
import { loadDecks, pod } from '../cli/fuzz-plan';
import { knowledgeFor } from './bot-tactician';
import { assemblePrompt } from './context';
import { COMPACT_OBSERVATION_PRIMER_TEXT, compactTacticianPayload } from './observation-compact';
import { loadAiConfig } from './config';

describe('compactTacticianPayload', () => {
  it('groups the battlefield by controller and merges identical permanents', () => {
    const payload = compactTacticianPayload({
      battlefield: [
        { id: 'o1', controller: 'P1', name: 'Plains', tapped: true, type: 'Basic Land — Plains' },
        { id: 'o2', controller: 'P1', name: 'Plains', tapped: true, type: 'Basic Land — Plains' },
        { id: 'o3', controller: 'P1', name: 'Plains', tapped: false, type: 'Basic Land — Plains' },
        {
          id: 'o4',
          controller: 'P2',
          name: 'Soldier',
          tapped: false,
          type: 'Token Creature — Soldier',
          p: 1,
          t: 1,
          text: 'Lifelink',
        },
        {
          id: 'o5',
          controller: 'P2',
          name: 'Soldier',
          tapped: false,
          type: 'Token Creature — Soldier',
          p: 1,
          t: 1,
        },
        {
          id: 'o6',
          controller: 'P2',
          name: 'Soldier',
          tapped: false,
          type: 'Token Creature — Soldier',
          p: 2,
          t: 2,
        },
      ],
    });
    expect(payload.battlefield).toEqual({
      P1: [
        { ids: ['o1', 'o2'], name: 'Plains', tapped: true },
        { id: 'o3', name: 'Plains' },
      ],
      P2: [
        {
          ids: ['o4', 'o5'],
          name: 'Soldier',
          type: 'Token Creature — Soldier',
          p: 1,
          t: 1,
          text: 'Lifelink',
        },
        { id: 'o6', name: 'Soldier', type: 'Token Creature — Soldier', p: 2, t: 2 },
      ],
    });
  });

  it('keeps the ids that tell legal options apart and drops UI-only fields', () => {
    const payload = compactTacticianPayload({
      legalActions: [
        {
          id: 0,
          type: 'tapCost',
          description: 'Tap Soldier',
          interaction: { kind: 'choice', subjectId: 'o-509' },
        },
        {
          id: 1,
          type: 'activateAbility',
          description: 'Mosswort Bridge: {G}, {T}: Play the exiled card.',
          interaction: { kind: 'source', sourceId: 'o-449', sourceCardId: 'c-48', abilityIndex: 0 },
          data: {
            sourceName: 'Mosswort Bridge',
            sourceZone: 'battlefield',
            abilityDescription: '{G}, {T}: Play the exiled card.',
          },
        },
        {
          id: 2,
          type: 'castSpell',
          description: 'Cast Dawn of Hope ({1}{W})',
          interaction: { kind: 'source', sourceId: 'o-405' },
          data: {
            sourceName: 'Dawn of Hope',
            manaCost: '{1}{W}',
            paymentSourceIds: ['o-455'],
            paymentSourceNames: ['Forest'],
          },
        },
        {
          id: 3,
          type: 'attackDeclaration',
          description: 'Declare attackers',
          interaction: { kind: 'choice', targetSlots: [{ slot: 0, options: ['P2'] }] },
          targets: [{ slot: 0, options: ['P2'] }],
        },
        {
          id: 4,
          type: 'placeTrigger',
          description: 'Dawn of Hope trigger',
          interaction: { kind: 'order', subjectIds: ['c-218'] },
        },
        { id: 5, type: 'pass', description: 'Pass priority', interaction: { kind: 'immediate' } },
      ],
    });
    expect(payload.legalActions).toEqual([
      { id: 0, type: 'tapCost', description: 'Tap Soldier', subjectId: 'o-509' },
      {
        id: 1,
        type: 'activateAbility',
        description: 'Mosswort Bridge: {G}, {T}: Play the exiled card.',
        sourceId: 'o-449',
        data: { sourceZone: 'battlefield' },
      },
      {
        id: 2,
        type: 'castSpell',
        description: 'Cast Dawn of Hope ({1}{W})',
        sourceId: 'o-405',
        data: { manaCost: '{1}{W}', paymentSourceNames: ['Forest'] },
      },
      {
        id: 3,
        type: 'attackDeclaration',
        description: 'Declare attackers',
        targets: [{ slot: 0, options: ['P2'] }],
      },
      { id: 4, type: 'placeTrigger', description: 'Dawn of Hope trigger', subjectIds: ['c-218'] },
      { id: 5, type: 'pass', description: 'Pass priority' },
    ]);
  });

  it('keeps target slots that differ from targets, as targets', () => {
    const payload = compactTacticianPayload({
      legalActions: [
        {
          id: 0,
          type: 'x',
          description: 'x',
          interaction: { kind: 'choice', targetSlots: [{ slot: 0, options: ['a'] }] },
        },
      ],
    });
    expect(payload.legalActions).toEqual([
      { id: 0, type: 'x', description: 'x', targets: [{ slot: 0, options: ['a'] }] },
    ]);
  });

  it('drops bookkeeping log lines and writes opponents graveyards as names', () => {
    const payload = compactTacticianPayload({
      recentLog: [
        'T6 -- stepBegin step=draw',
        'T6 P1 tapForMana source=Forest',
        'T6 P1 castSpell name=Sol Ring',
        'T6 -- resolved name=Sol Ring',
      ],
      opponents: [{ seat: 'P2', graveyard: [{ id: 'o1', name: 'Swamp' }] }],
    });
    expect(payload.recentLog).toEqual(['T6 P1 castSpell name=Sol Ring']);
    expect(payload.opponents).toEqual([{ seat: 'P2', graveyard: ['Swamp'] }]);
  });
});

describe('assemblePrompt with compactObservation, on real games', () => {
  it('keeps every permanent id and legal action id, leaves the request and view untouched, and says how it is written', async () => {
    const decks = await loadDecks();
    const chosen = pod(decks, 1).decks;
    const engine = new Engine({
      gameId: 'compact-observation',
      seed: 'compact-observation',
      players: chosen.map((deck, i) => ({
        id: `P${i + 1}`,
        deckId: `d${i + 1}`,
        commanders: deck.commanders,
        cards: deck.cards,
      })),
      turnCap: 40,
    });
    const knowledge = knowledgeFor(engine);
    let checked = 0;
    let shorter = 0;
    const provider = {
      decide(request: DecisionRequest) {
        const view = engine.view(request.decidingPlayer);
        const before = structuredClone({ request, view });
        const full = assemblePrompt(request, view);
        const compact = assemblePrompt(request, view, undefined, { compactObservation: true });
        // The payload holds the request's own action objects, which the provider reads afterwards.
        expect({ request, view }).toEqual(before);
        const observation = JSON.parse(compact.messages.at(-1)!.content) as {
          battlefield: Record<string, Array<{ id?: string; ids?: string[] }>>;
          legalActions: Array<{ id: number }>;
        };
        const ids = Object.values(observation.battlefield)
          .flat()
          .flatMap((row) => row.ids ?? [row.id]);
        expect(ids.sort()).toEqual(view.battlefield.map((perm) => perm.id).sort());
        expect(observation.legalActions.map((action) => action.id)).toEqual(
          request.legalActions.map((action) => action.id),
        );
        expect(compact.messages[0]!.content).toContain(COMPACT_OBSERVATION_PRIMER_TEXT.trim());
        checked++;
        if (compact.estimatedTokens < full.estimatedTokens) shorter++;
        return Promise.resolve(decide(request, view, new Rng(request.requestId), { knowledge }));
      },
    };
    await runToCompletionAsync(engine, (_seat: PlayerId) => provider, { maxDecisions: 5_000 });
    expect(checked).toBeGreaterThan(100);
    expect(shorter / checked).toBeGreaterThan(0.9);
  }, 60_000);
});

describe('tacticianCompactObservationEnabled', () => {
  it('is on for the Messages API and off for OpenAI-format providers unless set', () => {
    expect(
      loadAiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' })
        .tacticianCompactObservationEnabled,
    ).toBe(true);
    expect(loadAiConfig({}).tacticianCompactObservationEnabled).toBe(false);
    expect(
      loadAiConfig({
        AI_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'k',
        AI_TACTICIAN_COMPACT_OBSERVATION_ENABLED: 'false',
      }).tacticianCompactObservationEnabled,
    ).toBe(false);
  });
});
