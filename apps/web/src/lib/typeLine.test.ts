import { describe, expect, it } from 'vitest';
import { splitTypeLine } from './typeLine';

describe('splitTypeLine', () => {
  it('splits supertypes, types and subtypes', () => {
    expect(splitTypeLine('Legendary Creature — Elder Dragon')).toEqual({
      supertypes: ['Legendary'],
      types: 'Creature',
      subtypes: 'Elder Dragon',
    });
    expect(splitTypeLine('Basic Land — Swamp')).toEqual({
      supertypes: ['Basic'],
      types: 'Land',
      subtypes: 'Swamp',
    });
  });

  it('keeps several card types together and allows no subtypes', () => {
    expect(splitTypeLine('Artifact Creature — Golem')).toEqual({
      supertypes: [],
      types: 'Artifact Creature',
      subtypes: 'Golem',
    });
    expect(splitTypeLine('Artifact')).toEqual({ supertypes: [], types: 'Artifact', subtypes: '' });
  });

  it('shows the first face of a two-faced line', () => {
    expect(splitTypeLine('Instant // Land').types).toBe('Instant');
  });

  it('copes with a missing line', () => {
    expect(splitTypeLine(undefined)).toEqual({ supertypes: [], types: '', subtypes: '' });
  });
});
