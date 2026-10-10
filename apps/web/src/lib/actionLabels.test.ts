import { describe, expect, it } from 'vitest';
import type { LegalAction } from '@mtg/shared';
import { actionLabel } from './actionLabels';

function action(over: Partial<LegalAction>): LegalAction {
  return { id: 1, type: 'castSpell', description: 'Cast Something', ...over } as LegalAction;
}

describe('actionLabel', () => {
  it('distinguishes target-dependent prices by their bound target slot, including alternative casts', () => {
    expect(actionLabel(action({ data: { targetReductionSlot: 0 } }))).toBe(
      'Cast — reduced for target slot 1',
    );
    expect(actionLabel(action({ data: { targetReductionSlot: 1 } }))).toBe(
      'Cast — reduced for target slot 2',
    );
    expect(actionLabel(action({ data: { targetReductionSlot: 1, castVariant: 'nonMana' } }))).toBe(
      'Cast for alternative cost — reduced for target slot 2',
    );
  });
  it('names a double-faced land play by its face, never the internal "mdfc" variant', () => {
    const label = actionLabel(
      action({
        type: 'playLand',
        description: 'Play Ondu Skyruins',
        data: { castVariant: 'mdfc', sourceName: 'Ondu Skyruins', entersTapped: true },
      }),
    );
    expect(label).toBe('Play Ondu Skyruins (enters tapped)');
    expect(label).not.toMatch(/mdfc/i);
  });

  it('describes conditional and pay-life land entries', () => {
    expect(
      actionLabel(
        action({
          type: 'playLand',
          data: { castVariant: 'mdfc', sourceName: 'Agadeem, the Undercrypt', payLifeToUntap: 3 },
        }),
      ),
    ).toBe('Play Agadeem, the Undercrypt (enters tapped unless you pay 3 life)');
    expect(
      actionLabel(
        action({
          type: 'playLand',
          data: {
            castVariant: 'mdfc',
            sourceName: 'Turntimber Symbiosis',
            entersTappedConditional: true,
          },
        }),
      ),
    ).toBe('Play Turntimber Symbiosis (may enter tapped)');
  });

  it('gives every alternative cast a readable label instead of its identifier', () => {
    for (const castVariant of [
      'commanderFree',
      'nonMana',
      'energy',
      'overload',
      'adventure',
      'omen',
    ]) {
      const label = actionLabel(action({ data: { castVariant, sourceName: 'Bonecrusher Giant' } }));
      expect(label).not.toBe(castVariant);
      expect(label).not.toBe(castVariant[0]!.toUpperCase() + castVariant.slice(1));
    }
    expect(actionLabel(action({ data: { castVariant: 'energy', energyCost: 4 } }))).toBe(
      'Cast for 4 energy',
    );
  });

  it('names the optional-cost count of a cast (replicate, squad, kicker)', () => {
    expect(
      actionLabel(
        action({
          type: 'castSpell',
          data: { optionalCostCount: 2, optionalMechanic: 'replicate' },
        }),
      ),
    ).toBe('Cast with replicate 2');
    expect(actionLabel(action({ type: 'castSpell', data: {} }))).toBe('Cast');
  });

  it('sentence-cases a mode label taken from a lowercased Oracle bullet', () => {
    expect(actionLabel(action({ data: { modeLabel: 'you gain 2 life' } }))).toBe('You gain 2 life');
  });
});
