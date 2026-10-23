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

/** Public reasons to reconsider an action. Object ids distinguish new interaction from passes. */
export function smartYieldContexts(state: PlayerBoardState, action?: LegalAction): string[] {
  const you = state.viewerSeat;
  const yours = new Set(state.battlefield.filter((p) => p.controller === you).map((p) => p.id));
  const source = action?.interaction?.kind === 'source' ? action.interaction.sourceId : null;
  const effectOps = action?.data?.['abilityEffectOps'];
  // Only classify a known value-only ability as utility. Unknown/compound effects
  // (including team protection from a noncombatant source) keep conservative stops.
  const utility =
    action?.type === 'activateAbility' &&
    Array.isArray(effectOps) &&
    effectOps.length > 0 &&
    effectOps.every(
      (op: unknown) => typeof op === 'string' && ['draw', 'scry', 'searchLibrary'].includes(op),
    );
  // Untargeted interaction can include sweepers. Keep those response opportunities conservative.
  const contexts = state.stack
    .filter(
      (item) => item.controller !== you || item.targets.some((id) => id === you || yours.has(id)),
    )
    // A utility permanent is worth reconsidering when it is threatened,
    // not whenever another permanent is targeted. Untargeted effects remain conservative.
    .filter(
      (item) =>
        !utility ||
        item.targets.length === 0 ||
        item.targets.some((id) => id === source || id === you),
    )
    .map((item) => `stack:${item.id}`);
  // Offer draw/filter/ramp once at the last opponent's end step, when the player
  // can use spare mana before untapping. Do not interrupt each opponent's turn.
  const yourIndex = state.turnOrder.indexOf(you);
  const beforeYou =
    state.turnOrder[(yourIndex + state.turnOrder.length - 1) % state.turnOrder.length];
  if (
    utility &&
    yourIndex >= 0 &&
    state.activePlayer !== you &&
    state.activePlayer === beforeYou &&
    state.phase === 'ending' &&
    state.step === 'end'
  )
    contexts.push(`end:${state.turnNumber}:${state.activePlayer}`);
  if (state.phase !== 'combat') return contexts;
  // Damage is already dealt at the normal damage checkpoint. Only first strike leaves
  // another damage step to respond before; don't ask again at end of combat.
  if (
    !['beginCombat', 'declareAttackers', 'declareBlockers', 'firstStrikeCombatDamage'].includes(
      state.step ?? '',
    )
  )
    return contexts;
  const participants = state.battlefield.filter(
    (p) =>
      (state.step === 'beginCombat' &&
        state.activePlayer === you &&
        p.controller === you &&
        p.power !== null &&
        !p.tapped &&
        (!p.summoningSick || p.keywords.includes('haste'))) ||
      (p.attacking !== null && (p.controller === you || p.attacking === you)) ||
      (p.blocking !== null &&
        (p.controller === you ||
          state.battlefield.some(
            (attacker) => attacker.id === p.blocking && attacker.controller === you,
          ))),
  );
  if (participants.length === 0) return contexts;
  if (action !== undefined) {
    const slots =
      action.targets ??
      (action.interaction?.kind === 'source' ? action.interaction.targetSlots : undefined) ??
      [];
    // An activation may protect its source even when its target is a different permanent
    // (e.g. Kogla). Otherwise use the actual legal targets, never card-text guesses.
    const relevant = participants.some(
      (p) =>
        p.id === source ||
        slots.some(
          (slot) =>
            slot.options.includes(p.id) ||
            (p.attacking !== null && slot.options.includes(p.attacking)) ||
            (p.attackingPlaneswalker != null && slot.options.includes(p.attackingPlaneswalker)),
        ),
    );
    if ((utility || slots.length > 0) && !relevant) return contexts;
  }
  const combat = participants
    .map((p) => [
      p.id,
      p.attacking,
      p.attackingPlaneswalker ?? null,
      p.blocking,
      p.blockedBy,
      p.damageMarked,
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  contexts.push(
    `combat:${state.turnNumber}:${state.activePlayer}:${state.step}:${JSON.stringify(combat)}`,
  );
  return contexts;
}

export function smartYieldStops(state: PlayerBoardState, action?: LegalAction): boolean {
  return smartYieldContexts(state, action).length > 0;
}

export function isPlayerActionYielded(
  action: LegalAction,
  preferences: ReadonlyMap<string, IgnoredPlayerAbility>,
  state: PlayerBoardState,
  dismissed: ReadonlySet<string> = new Set(),
): boolean {
  const key = playerYieldKey(action);
  const preference = key === null ? undefined : preferences.get(key);
  return (
    preference !== undefined &&
    (preference.mode !== 'smart' ||
      smartYieldContexts(state, action).every((context) => dismissed.has(context)))
  );
}

/** Session-only memory of declined opportunities; preferences still survive across turns. */
export class SmartYieldMemory {
  private turn: number | null = null;
  private readonly dismissed = new Map<string, Set<string>>();

  private forTurn(state: PlayerBoardState): void {
    if (this.turn === state.turnNumber) return;
    this.turn = state.turnNumber;
    this.dismissed.clear();
  }

  isYielded(
    action: LegalAction,
    preferences: ReadonlyMap<string, IgnoredPlayerAbility>,
    state: PlayerBoardState,
  ): boolean {
    this.forTurn(state);
    const key = playerYieldKey(action);
    return isPlayerActionYielded(
      action,
      preferences,
      state,
      key === null ? undefined : this.dismissed.get(key),
    );
  }

  dismiss(
    actions: readonly LegalAction[],
    preferences: ReadonlyMap<string, IgnoredPlayerAbility>,
    state: PlayerBoardState,
  ): void {
    this.forTurn(state);
    for (const action of actions) {
      const key = playerYieldKey(action);
      if (key === null || preferences.get(key)?.mode !== 'smart') continue;
      const seen = this.dismissed.get(key) ?? new Set<string>();
      for (const context of smartYieldContexts(state, action)) seen.add(context);
      this.dismissed.set(key, seen);
    }
  }

  resume(key: string): void {
    this.dismissed.delete(key);
  }
}
