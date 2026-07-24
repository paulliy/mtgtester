import { describe, it, expect } from 'vitest';
import { ALL_COLORS } from '@mtg/shared';
import { ENGINE_VERSION } from '../src/index';

// Workspace smoke test: proves the package builds and the linkage to @mtg/shared
// resolves. The real engine coverage lives in the sibling test files (brief §12).
describe('@mtg/engine scaffold', () => {
  it('exposes a package marker', () => {
    expect(ENGINE_VERSION).toContain('phase2');
  });

  it('consumes @mtg/shared across the workspace', () => {
    expect(ALL_COLORS).toHaveLength(5);
  });
});
