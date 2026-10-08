import type { IgnoredPlayerAbility, LegalAction, PlayerBoardState } from '@mtg/shared';

/** Identify a spell instance (including its modes/X values) or a printed activation. */
export function playerYieldKey(action: LegalAction): string | null {
  const source = action.interaction;
  if (source?.kind !== 'source') return null;
  if (action.type === 'castSpell') return `spell:${source.sourceId}`;
  if (
    action.type === 'activateAbility' &&
    source.sourceCardId !== undefined &&
    source.abilityIndex !== undefined
  )
    return `${source.sourceCardId}:${source.abilityIndex}`;
  return null;
}

/** Public stack activity may affect you without explicit targets, so stop conservatively. */
export function smartYieldStops(state: PlayerBoardState): boolean {
  const you = state.viewerSeat;
  const yours = new Set(state.battlefield.filter((p) => p.controller === you).map((p) => p.id));
  if (
    state.stack.some(
      (item) => item.controller !== you || item.targets.some((id) => id === you || yours.has(id)),
    )
  )
    return true;
  if (state.phase !== 'combat') return false;
  // Offer combat tricks before committing attackers, and throughout combat involving you.
  if (state.activePlayer === you && state.step === 'beginCombat') return true;
  return state.battlefield.some(
    (p) => p.attacking !== null && (p.controller === you || p.attacking === you),
  );
}

export function isPlayerActionYielded(
  action: LegalAction,
  preferences: ReadonlyMap<string, IgnoredPlayerAbility>,
  state: PlayerBoardState,
): boolean {
  const key = playerYieldKey(action);
  const preference = key === null ? undefined : preferences.get(key);
  return preference !== undefined && (preference.mode !== 'smart' || !smartYieldStops(state));
}
