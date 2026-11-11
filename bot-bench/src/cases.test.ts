import { describe, expect, it } from 'vitest';
import { loadCases, parseBenchCase } from './case';
import { localActorFactory } from './models';
import { openCase, playCase, scriptedActor } from './play';
import { scoreRun } from './score';
import { verifyCase } from './verify';

const cases = loadCases();

describe('committed benchmark cases', () => {
  it('cover one-decision and whole-turn tactician play', () => {
    expect(cases.filter((benchCase) => benchCase.scope === 'single').length).toBeGreaterThanOrEqual(
      6,
    );
    expect(cases.filter((benchCase) => benchCase.scope === 'turn').length).toBeGreaterThanOrEqual(
      3,
    );
    expect(new Set(cases.map((benchCase) => benchCase.id)).size).toBe(cases.length);
  });

  it.each(cases.map((benchCase) => [benchCase.id, benchCase] as const))(
    '%s: the engine agrees with the reference',
    async (_id, benchCase) => {
      expect(await verifyCase(benchCase)).toEqual([]);
    },
    // Every legal answer is played out; a 64-way attack declaration takes a few seconds.
    60_000,
  );

  it.each(cases.map((benchCase) => [benchCase.id, benchCase] as const))(
    '%s: the same policy gets the same run twice',
    async (_id, benchCase) => {
      const play = () =>
        playCase(benchCase, localActorFactory({ id: 'h', kind: 'local', policy: 'heuristic' }));
      const [first, second] = [await play(), await play()];
      expect(second.decisions.map((decision) => decision.actionKey)).toEqual(
        first.decisions.map((decision) => decision.actionKey),
      );
      expect(second.after).toEqual(first.after);
      expect(second.log).toEqual(first.log);
    },
  );

  it('shows the tested seat only what its PlayerView holds', () => {
    for (const benchCase of cases) {
      const { view, request } = openCase(benchCase);
      expect(view.seat).toBe(benchCase.actor);
      expect(request.decidingPlayer).toBe(benchCase.actor);
      // Opponents are counts, never hands.
      for (const opponent of view.opponents) expect(opponent).not.toHaveProperty('hand');
    }
  });
});

describe('parseBenchCase', () => {
  const valid = () => structuredClone(cases[0]!) as unknown as Record<string, unknown>;

  it('accepts a committed case', () => {
    expect(parseBenchCase(valid()).id).toBe(cases[0]!.id);
  });

  it('refuses an unknown field', () => {
    expect(() => parseBenchCase({ ...valid(), hint: 'attack P3' })).toThrow(/unknown field "hint"/);
  });

  it('refuses an unknown field inside the position, through the engine parser', () => {
    const json = valid();
    (json['position'] as Record<string, unknown>)['seats'] = { P1: { lives: 3 } };
    expect(() => parseBenchCase(json)).toThrow(/unknown field "lives"/);
  });

  it('refuses a reference with no best answer', () => {
    const json = valid();
    const reference = json['reference'] as { options: Array<{ grade: string }> };
    for (const option of reference.options) if (option.grade === 'best') option.grade = 'good';
    expect(() => parseBenchCase(json)).toThrow(/needs an option graded best/);
  });

  it('refuses a card the engine does not model', async () => {
    const json = valid();
    (json['position'] as { seats: Record<string, { hand?: string[] }> }).seats['P4'] = {
      hand: ['Steel Leaf Champion'],
    };
    const parsed = parseBenchCase(json);
    expect(() => openCase(parsed)).toThrow(/does not model/);
  });
});

describe('the decision cap', () => {
  it('holds the tested seat still past the cap instead of letting the table play it', async () => {
    const overrun = loadCases().find((benchCase) => benchCase.id === 'overrun-for-the-kill')!;
    const capped = { ...overrun, maxActorDecisions: 1 };
    // The seat plays its land, then is cut off: the table must not cast Overrun and attack for it.
    const played = await playCase(capped, scriptedActor([{ choose: 'Play Forest' }]).factory);
    expect(played.termination).toBe('decision_cap');
    expect(played.decisions).toHaveLength(1);
    expect(played.log.join('\n')).not.toMatch(/Overrun/);
    expect(scoreRun(capped, played).score).toBeLessThan(0.5);
  });
});
