import { POISON_LOSS, COMMANDER_DAMAGE_LOSS } from '../sba/thresholds';
/** This adapter only projects public semantic capabilities. No name/text inference. */
import type {
  PublicPermanentCapabilities,
  PublicThreatFacts,
  PublicStackImpact,
} from '@mtg/shared';
import type { EnginePermanent, EngineStackObject, GameContext } from '../state/types';
import { activatingAbilitiesBlockedFor } from '../state/queries';
import type { Characteristics } from '../cards/continuous-types';
import { computeCharacteristics } from '../effects/continuous';

export function permanentCapabilities(
  ctx: GameContext,
  perm: EnginePermanent,
  chars: Characteristics,
): PublicPermanentCapabilities {
  const unsupported: string[] = [];
  const hidden = perm.faceDown || perm.statuses.includes('faceDown');
  const engines: PublicPermanentCapabilities['engines'] = [];
  const mana: PublicPermanentCapabilities['mana'] = [];
  if (!hidden) {
    for (const ability of chars.manaAbilities) {
      // General payment feasibility can depend on private cards. Only project this closed,
      // unconditional tap-only subset; complex sources stay explicitly unsupported.
      if (
        ability.condition ||
        ability.conditionalUnits ||
        ability.amount ||
        ability.dynamic ||
        ability.onActivate?.length ||
        (ability.costs ?? [{ kind: 'tap' }]).some((c) => c.kind !== 'tap') ||
        (ability.costs !== undefined && ability.costs.length !== 1)
      ) {
        unsupported.push('complex-mana');
        continue;
      }
      mana.push({
        units: ability.units.map((unit) => [...unit]),
        available:
          !activatingAbilitiesBlockedFor(ctx, perm.controllerId, perm) &&
          !perm.tapped &&
          !(
            chars.types.includes('Creature') &&
            perm.summoningSick &&
            !chars.keywords.includes('haste')
          ),
        restricted: ability.restriction !== undefined,
      });
    }
    for (const ability of chars.triggers) {
      const trigger = ability.trigger;
      if (
        !trigger ||
        trigger.condition ||
        ability.optional ||
        ability.targets.length ||
        !['upkeep', 'endStep', 'drawStep', 'precombatMain'].includes(trigger.when) ||
        !('player' in trigger) ||
        trigger.player !== 'you' ||
        ability.effects.some(
          (e) => (e.op !== 'draw' && e.op !== 'createToken') || e.count.kind !== 'const',
        )
      ) {
        unsupported.push('conditional-or-complex-engine');
        continue;
      }
      for (const effect of ability.effects) {
        if (
          (effect.op === 'draw' || effect.op === 'createToken') &&
          effect.count.kind === 'const'
        ) {
          engines.push({
            kind: effect.op === 'draw' ? 'draw' : 'tokens',
            amount: Math.max(0, effect.count.n),
            horizon: 'controller-turn',
          });
        }
      }
    }
    if (chars.activatedAbilities?.length) unsupported.push('activated-abilities');
    if (!ctx.defs.get(perm.oracleId)?.modeled) unsupported.push('unmodeled-card');
  } else unsupported.push('face-down-abilities');
  return {
    creature: chars.types.includes('Creature'),
    attacking: perm.attacking,
    cantBlock: !hidden && !chars.loseAbilities && perm.cantBlock === true,
    cantBeBlocked:
      !hidden && (chars.cantBeBlocked || (!chars.loseAbilities && perm.cantBeBlocked === true)),
    commanderId:
      !hidden && ctx.state.players.some((p) => p.commanderCardIds.includes(perm.cardId))
        ? perm.cardId
        : null,
    mana,
    engines,
    unsupported: [...new Set(unsupported)],
  };
}

export function stackImpacts(ctx: GameContext, so: EngineStackObject): PublicStackImpact[] {
  const ability = so.ability;
  const source = ctx.state.battlefield.find((p) => p.cardId === so.sourceCardId);
  // Infect changes player damage into poison. This life-impact-only adapter must abstain
  // instead of claiming lethal life damage from a known poison source.
  const nonLifeDamageSource =
    source !== undefined &&
    (source.faceDown ||
      source.statuses.includes('faceDown') ||
      computeCharacteristics(ctx, source).keywords.includes('infect'));
  // No conditional/mixed sequences: earlier effects could change the amount or target.
  if (
    !ability ||
    ability.optional ||
    ability.trigger?.condition ||
    ability.effects.some(
      (e) =>
        (e.op !== 'dealDamage' && e.op !== 'loseLifeTarget') ||
        (e.op === 'dealDamage' && (e.source !== undefined || nonLifeDamageSource)) ||
        e.amount.kind !== 'const' ||
        typeof e.target !== 'number',
    )
  )
    return [];
  return ability.effects.flatMap((effect) => {
    if (
      (effect.op !== 'dealDamage' && effect.op !== 'loseLifeTarget') ||
      effect.amount.kind !== 'const' ||
      typeof effect.target !== 'number'
    )
      return [];
    const recipient = so.targets[effect.target];
    if (!recipient || !ctx.state.turnOrder.includes(recipient)) return [];
    return [
      {
        source: so.id,
        recipient,
        amount: Math.max(0, effect.amount.n),
        kind: effect.op === 'dealDamage' ? ('damage' as const) : ('life-loss' as const),
      },
    ];
  });
}

export function publicThreatFacts(ctx: GameContext): PublicThreatFacts {
  const s = ctx.state;
  const pressure: PublicThreatFacts['pressure'] = [];
  // Scan a bounded tail, not the entire ever-growing event log. Missing history is explicit.
  const tail = s.eventLog.slice(-512);
  for (const e of tail) {
    if (e.type !== 'damage') continue;
    const { controller, target, amount, combat } = e.payload;
    if (
      typeof controller !== 'string' ||
      typeof target !== 'string' ||
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !s.players.some((p) => p.id === controller) ||
      !s.players.some((p) => p.id === target)
    )
      continue;
    pressure.push({
      sequence: e.sequence,
      turn: e.turn,
      actor: controller,
      recipient: target,
      amount,
      kind: combat === true ? 'combat' : 'noncombat',
    });
  }
  return {
    sequence: s.nextEventSequence - 1,
    turn: s.turnNumber,
    phase: s.phase,
    step: s.step,
    activePlayer: s.turnOrder[s.activePlayerIndex] ?? '',
    turnOrder: [...s.turnOrder],
    pressure: pressure.slice(-64),
    pressureTruncated: s.eventLog.length > 512 || pressure.length > 64,
    players: s.players
      .filter((p) => !p.hasLost)
      .map((p) => ({
        seat: p.id,
        poison: p.poisonCounters,
        commanderDamage: { ...p.commanderDamageTaken },
      })),
    rules: { poisonLoss: POISON_LOSS, commanderDamageLoss: COMMANDER_DAMAGE_LOSS },
    unsupported: [
      'combo-search',
      'alternative-wins',
      'known-opponent-hand-identities',
      'future-mana',
      'conditional-engines',
      'combat-taxes-and-restrictions',
      'damage-replacements',
      'plan-specific-interference',
      'non-damage-pressure-history',
      'floating-mana-and-activation-riders',
    ],
  };
}
