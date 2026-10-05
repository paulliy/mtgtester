import type { ProviderKind, SeatControllerKind } from '@mtg/shared';

/**
 * The `random` provider kind is a historical wire name: those seats run the seeded heuristic bot
 * (`HeuristicDecisionProvider`), not random choices. Only the labels say what players get.
 */
export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  random: 'Built-in bots',
  ai: 'AI bots',
};

const CONTROLLER_LABELS: Record<SeatControllerKind, string> = {
  human: 'you',
  random: 'built-in bot',
  ai: 'AI bot',
};

export function controllerLabel(kind: SeatControllerKind): string {
  return CONTROLLER_LABELS[kind];
}
