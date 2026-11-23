import { describe, expect, it } from 'vitest';
import { commanderObjectIds } from './commanderIds';

describe('commanderObjectIds', () => {
  const seats = [
    { seat: 'P1', commanders: [{ objectId: 'obj-1' }, { objectId: null }] },
    { seat: 'P2', commanders: [{ objectId: 'obj-2' }] },
  ];

  it('collects the battlefield commanders of every seat', () => {
    expect([...commanderObjectIds(seats)].sort()).toEqual(['obj-1', 'obj-2']);
  });

  it("marks P1's commander in P2's panel after P2 takes control of it", () => {
    // The spectator board puts obj-1 under its controller, P2; the frame must still find it.
    const p2Panel = [{ id: 'obj-1', controller: 'P2' }];
    const ids = commanderObjectIds(seats);
    expect(p2Panel.filter((permanent) => ids.has(permanent.id))).toHaveLength(1);
  });
});
