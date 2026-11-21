/**
 * Play styles (`BotSteering.style`): one word from the strategist that shifts how the bot plays.
 * A style fills the knobs the strategist did not set (aggression, hold-up mana, overextending) and
 * scales a few policy weights: what an answer is kept for, what damage at a player is worth, and
 * which card roles the bot values. The values live in `WEIGHTS.styles`; `midrange` changes nothing.
 */
import type { BotSteering, PlayStyle } from '@mtg/shared';
import type { CardRole } from './card-knowledge';
import { WEIGHTS } from './weights';

export interface StyleProfile {
  defaults: Pick<BotSteering, 'aggression' | 'holdUpMana' | 'avoidOverextending'>;
  faceDamage: number;
  counterThreshold: number;
  removalThreshold: number;
  roles: Partial<Record<CardRole, number>>;
}

const MIDRANGE = WEIGHTS.styles.midrange as StyleProfile;

/** The profile for `style`; the plain weights (`midrange`) when none is set. */
export function styleProfile(style: PlayStyle | undefined): StyleProfile {
  return style === undefined ? MIDRANGE : (WEIGHTS.styles[style] as StyleProfile);
}

/** Steering with the style's defaults under it: a knob the strategist set always wins. */
export function resolveSteering(steering: BotSteering | undefined): BotSteering | undefined {
  if (steering?.style === undefined) return steering;
  return { ...styleProfile(steering.style).defaults, ...steering };
}

/** The multiplier a style puts on a role's value; 1 when the style leaves it alone. */
export function roleScale(style: PlayStyle | undefined, role: CardRole): number {
  return styleProfile(style).roles[role] ?? 1;
}
