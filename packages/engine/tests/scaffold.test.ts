import { describe, it, expect } from 'vitest';
import { ALL_COLORS } from '@mtg/shared';
import { ENGINE_VERSION } from '../src/index';

// Phase 0 smoke test: proves the package builds and the workspace linkage to @mtg/shared
// resolves. Fixture-based rules scenarios (brief §12) begin in Phase 2 under this dir.
describe('@mtg/engine scaffold', () => {
  it('exposes a package marker', () => {
    expect(ENGINE_VERSION).toContain('phase0');
  });

  it('consumes @mtg/shared across the workspace', () => {
    expect(ALL_COLORS).toHaveLength(5);
  });
});
