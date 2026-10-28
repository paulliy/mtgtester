// ADR 0034 decision 2: an `EngineInvariantError` halts the game with its site, or rethrows under
// `strictInvariants`. No engine path raises one yet, so the game loop is replaced with one that
// throws at once.
import { describe, expect, it, vi } from 'vitest';
import { EngineInvariantError } from '../src/errors';
import { forestsPod, makeEngine } from './fixtures';

vi.mock('../src/flow/game', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/flow/game')>();
  const { EngineInvariantError: InvariantError } = await import('../src/errors');
  return {
    ...actual,
    // eslint-disable-next-line require-yield
    *playGame() {
      throw new InvariantError('test.site', 'a binding was never set');
    },
  };
});

describe('EngineInvariantError (ADR 0034 decision 2)', () => {
  it('halts the game with the site, and emits engineHalt', () => {
    const engine = makeEngine(forestsPod(8), { seed: 'invariant-1' });
    const step = engine.advance();

    expect(step.kind).toBe('gameOver');
    if (step.kind !== 'gameOver') return;
    expect(step.result.halted).toBe(true);
    expect(step.result.haltSite).toBe('test.site');
    expect(step.result.haltReason).toBe(
      'Engine invariant violated at test.site: a binding was never set',
    );
    const halt = engine.eventsSince(0).find((event) => event.type === 'engineHalt');
    expect(halt?.payload).toMatchObject({ site: 'test.site' });
    // A finished engine keeps returning the same result.
    expect(engine.advance()).toEqual(step);
  });

  it('rethrows under strictInvariants so the failing test points at the site', () => {
    const engine = makeEngine(forestsPod(8), { seed: 'invariant-2', strictInvariants: true });

    expect(() => engine.advance()).toThrow(EngineInvariantError);
  });
});
