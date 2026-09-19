import type { AbilityCost } from '../cards/definition';
import { computeCharacteristics, matchesSelector } from '../effects/continuous';
import { allowanceFor, manaSourcesFor } from '../state/queries';
import type { EnginePermanent, EnginePlayerState, GameContext } from '../state/types';
import { planPayment, type ParsedManaCost } from './cost';

/** Reserve distinct permanents for tap costs before asking the mana solver to spend them. */
export function activationManaSources(
  ctx: GameContext,
  player: EnginePlayerState,
  source: EnginePermanent,
  costs: readonly AbilityCost[],
  mana: ParsedManaCost,
  x = 0,
  unavailable: readonly string[] = [],
): ReturnType<typeof manaSourcesFor> | null {
  const sources = manaSourcesFor(ctx, player.id);
  const excluded = new Set(unavailable);
  if (costs.some((c) => c.kind === 'tap' || c.kind === 'sacrificeSelf' || c.kind === 'exileSelf'))
    excluded.add(source.cardId);
  const taps = costs.filter((c) =>
    ['tapOther', 'tapOthers', 'tapXOthers', 'tapCreaturesTotalPower'].includes(c.kind),
  );
  const candidates = ctx.state.battlefield.filter(
    (p) => p.controllerId === player.id && p.id !== source.id && !p.tapped,
  );
  const allows = allowanceFor(ctx, player.id, {
    kind: 'activateAbility',
    sourceOracleId: source.oracleId,
  });
  function visit(index: number): ReturnType<typeof manaSourcesFor> | null {
    const cost = taps[index];
    if (cost === undefined) {
      const usable = sources.filter((s) => !excluded.has(s.cardId));
      return planPayment(mana, player.manaEntries, usable, allows, player.life) === null
        ? null
        : usable;
    }
    const crew = cost.kind === 'tapCreaturesTotalPower';
    const required =
      cost.kind === 'tapOthers'
        ? cost.count
        : cost.kind === 'tapXOthers'
          ? x
          : crew
            ? cost.minPower
            : 1;
    const options = candidates.filter(
      (p) =>
        !excluded.has(p.cardId) &&
        (crew
          ? computeCharacteristics(ctx, p).types.includes('Creature')
          : 'selector' in cost &&
            matchesSelector(ctx, p, cost.selector, {
              cardId: source.cardId,
              controllerId: player.id,
            })),
    );
    function choose(start: number, remaining: number): ReturnType<typeof manaSourcesFor> | null {
      if (remaining <= 0) return visit(index + 1);
      for (let i = start; i < options.length; i++) {
        const p = options[i]!;
        const value = crew ? Math.max(0, computeCharacteristics(ctx, p).power ?? 0) : 1;
        if (value === 0) continue;
        excluded.add(p.cardId);
        const result = choose(i + 1, remaining - value);
        excluded.delete(p.cardId);
        if (result !== null) return result;
      }
      return null;
    }
    return choose(0, required);
  }
  return visit(0);
}
