import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '../../packages/shared/src';
import { describeAnswer, enumerateAnswers, matchesAnswer, namesOf } from './answers';
import { buildAnswer } from './answers';
import { loadCases } from './case';
import { openCase } from './play';

const byId = (id: string) => {
  const benchCase = loadCases().find((candidate) => candidate.id === id);
  if (benchCase === undefined) throw new Error(`no case ${id}`);
  return benchCase;
};

describe('answers by name', () => {
  it('describes an attack declaration without object ids', () => {
    const { engine, request } = openCase(byId('lethal-alpha-strike'));
    const names = namesOf(engine.getState());
    const response = buildAnswer(
      { choose: 'Declare attackers', assign: { 'Colossal Dreadmaw': 'P3', 'Serra Angel': 'P4' } },
      request,
      engine.getState(),
    );
    expect(response).not.toBeNull();
    const described = describeAnswer(request, response!, names);
    expect(described.text).toBe(
      'Attack: Colossal Dreadmaw → P3, Serra Angel → P4 (Kalonian Tusker stays home)',
    );
    expect(described.key).not.toMatch(/o-\d+/);
  });

  it('matches wildcards: * is anything, + is anything but holding back, - is holding back', () => {
    const { engine, request } = openCase(byId('lethal-alpha-strike'));
    const names = namesOf(engine.getState());
    const answer = buildAnswer(
      { choose: 'Declare attackers', assign: { 'Colossal Dreadmaw': 'P3' } },
      request,
      engine.getState(),
    )!;
    const matches = (assign: Record<string, string>) =>
      matchesAnswer({ choose: 'Declare attackers', assign }, request, answer, names);
    expect(matches({ 'Colossal Dreadmaw': 'P3' })).toBe(true);
    expect(matches({ 'Colossal Dreadmaw': '+', 'Serra Angel': '-' })).toBe(true);
    expect(matches({ 'Serra Angel': '*' })).toBe(true);
    expect(matches({ 'Serra Angel': '+' })).toBe(false);
    expect(matches({ 'Colossal Dreadmaw': 'P4' })).toBe(false);
    expect(matches({ 'Shivan Dragon': '*' })).toBe(false);
  });

  it('names a target by card name and refuses one the engine does not offer', () => {
    const { engine, request } = openCase(byId('removal-on-the-lethal-attacker'));
    const state = engine.getState();
    const response = buildAnswer(
      { choose: 'Cast Swords to Plowshares', targets: ['Shivan Dragon'] },
      request,
      state,
    )!;
    expect(describeAnswer(request, response, namesOf(state)).text).toBe(
      'Cast Swords to Plowshares ({W}) → Shivan Dragon',
    );
    expect(() =>
      buildAnswer({ choose: 'Cast Swords to Plowshares', targets: ['Plains'] }, request, state),
    ).toThrow(/Plains/);
    expect(buildAnswer({ choose: 'Cast Counterspell' }, request, state)).toBeNull();
  });

  it('describes an illegal action id as illegal', () => {
    const { engine, request } = openCase(byId('hold-the-counter'));
    const described = describeAnswer(
      request,
      { requestId: request.requestId, actionId: 99 },
      namesOf(engine.getState()),
    );
    expect(described.text).toBe('(illegal) actionId 99');
  });

  it('enumerates every answer, or reports that there are too many', () => {
    const request = {
      requestId: 'r',
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass' },
        {
          id: 1,
          type: 'castSpell',
          description: 'Cast',
          targets: [
            { slot: 0, options: ['a', 'b'] },
            { slot: 1, options: ['c', 'd', 'e'] },
          ],
        },
      ],
    } as unknown as DecisionRequest;
    expect(enumerateAnswers(request, 100)).toHaveLength(7);
    expect(enumerateAnswers(request, 5)).toBeNull();
  });
});
