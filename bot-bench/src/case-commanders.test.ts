/**
 * Commander seats in bench positions: a seat names its commander(s), which start on its
 * battlefield or wait in the command zone with commander status, so the views show them.
 */
import { describe, expect, it } from 'vitest';
import { loadCases, parseBenchCase, type BenchCase } from './case';
import { openCase } from './play';

const base = (): BenchCase =>
  structuredClone(loadCases().find((c) => c.id === 'swords-the-commander')!);

/** A case as raw JSON, loose enough to write a malformed commander map into. */
interface RawCase {
  position: { commanders?: unknown; seats: Record<string, { hand?: string[] }> };
}

const parse = (mutate: (json: RawCase) => void) => {
  const json = base() as unknown as RawCase;
  mutate(json);
  return () => parseBenchCase(json, 'case');
};

describe('commander seats', () => {
  it('parses a commander map and refuses a malformed one', () => {
    expect(parse(() => undefined)).not.toThrow();
    expect(parse((j) => (j.position.commanders = { P5: ['Talrand, Sky Summoner'] }))).toThrow(
      'unknown field "P5"',
    );
    expect(parse((j) => (j.position.commanders = { P2: [] }))).toThrow('at least 1');
    expect(parse((j) => (j.position.commanders = { P2: ['A', 'B', 'C'] }))).toThrow('two partners');
    expect(parse((j) => (j.position.commanders = { P2: ['A', 'A'] }))).toThrow('repeats');
    expect(
      parse((j) => {
        j.position.seats['P1']!.hand = ['Swords to Plowshares', 'Grizzly Bears'];
        j.position.commanders = { P1: ['Grizzly Bears'] };
      }),
    ).toThrow("must be on P1's battlefield or in the command zone");
  });

  it('a battlefield commander is on the battlefield with commander status, seen by every seat', () => {
    const benchCase = base();
    const { engine, view } = openCase(benchCase);
    expect(view.opponents.find((o) => o.seat === 'P2')?.commanders).toEqual([
      expect.objectContaining({ name: 'Talrand, Sky Summoner', zone: 'battlefield', castCount: 0 }),
    ]);
    expect(engine.view('P2').commanders).toEqual([
      expect.objectContaining({ name: 'Talrand, Sky Summoner', zone: 'battlefield' }),
    ]);
    // The commander came from the command zone; its library holds no second copy.
    const p2 = engine.getState().players.find((p) => p.id === 'P2')!;
    expect(p2.commandZone).toEqual([]);
    expect(p2.library.some((card) => card.name === 'Talrand, Sky Summoner')).toBe(false);
    expect(
      engine.getState().battlefield.filter((p) => p.name === 'Talrand, Sky Summoner'),
    ).toHaveLength(1);
  });

  it('a commander named nowhere else waits in the command zone', () => {
    const benchCase = base();
    benchCase.position.commanders = { ...benchCase.position.commanders, P3: ['Krenko, Mob Boss'] };
    const { engine, view } = openCase(parseBenchCase(benchCase));
    expect(view.opponents.find((o) => o.seat === 'P3')?.commanders).toEqual([
      expect.objectContaining({ name: 'Krenko, Mob Boss', zone: 'command' }),
    ]);
    const p3 = engine.getState().players.find((p) => p.id === 'P3')!;
    expect(p3.commandZone.map((card) => card.name)).toEqual(['Krenko, Mob Boss']);
  });

  it('a position without commanders seats none', () => {
    const benchCase = loadCases().find((c) => c.id === 'shock-the-other-threat')!;
    const { view } = openCase(benchCase);
    expect(view.commanders).toEqual([]);
    expect(view.opponents.every((o) => o.commanders.length === 0)).toBe(true);
  });
});
