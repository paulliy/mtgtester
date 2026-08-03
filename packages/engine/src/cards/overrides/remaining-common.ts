import type { CardDefinition } from '../definition';
import type { TokenSpec } from '../ability';
import type { CardOverride } from './index';
import { registerOverride } from './index';

/** Register the real Scryfall id and the stable fixture id used by unit tests. */
export function registerRemainingOverride(
  oracleId: string,
  name: string,
  handledLines: string[],
  def: Partial<CardDefinition>,
): void {
  const override: CardOverride = { oracleId, name, handledLines, def };
  registerOverride(override);
  registerOverride({
    ...override,
    oracleId: `oracle-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
  });
}

export const INKLING_TOKEN: TokenSpec = {
  name: 'Inkling',
  typeLine: 'Creature — Inkling',
  types: ['Creature'],
  subtypes: ['Inkling'],
  colors: ['W', 'B'],
  power: 2,
  toughness: 1,
  keywords: ['flying'],
};

export const ASSASSIN_TOKEN: TokenSpec = {
  name: 'Assassin',
  typeLine: 'Creature — Assassin',
  types: ['Creature'],
  subtypes: ['Assassin'],
  colors: ['B'],
  power: 1,
  toughness: 1,
  keywords: ['deathtouch', 'haste'],
};

export const NECRON_WARRIOR_TOKEN: TokenSpec = {
  name: 'Necron Warrior',
  typeLine: 'Artifact Creature — Necron',
  types: ['Artifact', 'Creature'],
  subtypes: ['Necron'],
  colors: ['B'],
  power: 2,
  toughness: 2,
};
