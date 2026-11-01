import { describe, expect, it } from 'vitest';
import type { DecisionRequest, LegalAction } from './protocol';
import {
  buttonLabel,
  costChips,
  entryFor,
  panelButtonText,
  pendingLabel,
  promptOf,
} from './actionPresentation';

const cast: LegalAction = { id: 4, type: 'castSpell', description: 'Cast Opt (1 mana)' };

function request(presentation: DecisionRequest['presentation']): DecisionRequest {
  return {
    requestId: 'r',
    gameId: 'g',
    turn: 1,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'You have priority (precombatMain). Choose an action.',
    legalActions: [cast],
    ...(presentation === undefined ? {} : { presentation }),
  };
}

describe('server presentation lookup', () => {
  const sent = request({
    layout: 'priority',
    playerPrompt: 'You have priority (Main phase 1). Choose an action.',
    actions: {
      4: {
        verb: 'Cast',
        subjects: [],
        label: 'Play Ondu Skyruins',
        summary: 'Play Ondu Skyruins',
        costLabels: ['{U}'],
        entryNote: 'enters tapped',
        targetHint: 'reduced for target slot 2',
      },
    },
  });

  it('joins the label, the entry note and the target hint', () => {
    expect(buttonLabel(cast, entryFor(sent, cast))).toBe(
      'Play Ondu Skyruins (enters tapped) — reduced for target slot 2',
    );
    expect(costChips(entryFor(sent, cast))).toEqual(['{U}']);
    expect(pendingLabel(cast, entryFor(sent, cast))).toBe('Play Ondu Skyruins');
    expect(promptOf(sent)).toBe('You have priority (Main phase 1). Choose an action.');
  });

  it('shows the engine description and no chips when the server sent no entry', () => {
    const bare = request(undefined);
    expect(entryFor(bare, cast)).toBeUndefined();
    expect(buttonLabel(cast, undefined)).toBe('Cast Opt (1 mana)');
    expect(costChips(undefined)).toEqual([]);
    expect(pendingLabel(cast, undefined)).toBe('Cast Opt (1 mana)');
    expect(promptOf(bare)).toBe('You have priority (precombatMain). Choose an action.');
  });
});

describe('panelButtonText', () => {
  it('shows the engine description for a priority option, whose verb is only its kind', () => {
    const sent = request({
      layout: 'priority',
      actions: { 4: { verb: 'Cast', subjects: [] } },
    });
    expect(panelButtonText(sent, cast)).toBe('Cast Opt (1 mana)');
  });

  it('shows the verb of a choice decision, and the description when it has none', () => {
    const choice = request({
      layout: 'cards',
      actions: { 4: { verb: 'Discard', subjects: [] } },
    });
    expect(panelButtonText(choice, cast)).toBe('Discard');
    expect(panelButtonText(request({ layout: 'choices' }), cast)).toBe('Cast Opt (1 mana)');
    expect(panelButtonText(request(undefined), cast)).toBe('Cast Opt (1 mana)');
  });
});
