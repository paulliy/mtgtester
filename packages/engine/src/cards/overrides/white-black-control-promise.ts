import { spell } from '../templates';
import { replaceCard } from './index';

export function registerWhiteBlackControlPromiseOverrides(): void {
  replaceCard('e1d294e8-67b1-4a4a-86b8-f98f28a327d9', 'Promise of Loyalty', [
    'unrecognized rules text: "Each player puts a vow counter on a creature they control and sacrifices the rest. Each of those creatures can\'t attack you or planeswalkers you control for as long as it has a vow counter on it."',
  ], { spellAbility: spell({ effects: [{ op: 'eachPlayerKeepsCreatureWithVow' }], description: 'Each player keeps one creature with a vow counter and sacrifices the rest' }) },
  'Uses APNAP creature choices before placing counters and simultaneous sacrifices, with a fixed counter-dependent attack restriction against the caster and their planeswalkers.');
}
