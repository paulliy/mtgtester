import type { PlayerView } from '@mtg/shared';
import type { UrgentEvent } from './types';

/** Closed supported scopes only. Possibility is never labeled forced/proven. */
export function detectUrgency(view: PlayerView): UrgentEvent[] {
  const events: UrgentEvent[] = [];
  const life = new Map([
    [view.seat, view.life],
    ...view.opponents.map((o) => [o.seat, o.life] as [string, number]),
  ]);
  // Evaluate each stack object separately. A different controller's beneficial intervention
  // is not charged to them as a threat; no generic 'counter the highest-ranked player' rule.
  for (const item of view.stack) {
    const totals = new Map<string, number>();
    for (const impact of item.impacts ?? [])
      totals.set(impact.recipient, (totals.get(impact.recipient) ?? 0) + impact.amount);
    for (const [recipient, amount] of totals) {
      if (recipient === item.controller || amount < (life.get(recipient) ?? Infinity)) continue;
      events.push({
        controller: item.controller,
        affected: [recipient],
        sources: [item.id],
        urgency: 1,
        outcome: 'elimination',
        deadline: 'before-stack-resolution',
        deadlineOrder: 0,
        search: 'possible',
        forced: false,
        assumptions: [
          'Supported constant targeted damage/life loss if this object resolves unchanged.',
          'Counters, damage replacements, prevention and other stack objects may change the outcome.',
        ],
      });
    }
  }
  const facts = view.threatFacts;
  if (
    !facts ||
    facts.phase !== 'combat' ||
    !['declareBlockers', 'firstStrikeCombatDamage', 'combatDamage'].includes(facts.step ?? '')
  )
    return events;
  // Narrow current-combat detector: only actually declared, unblocked damage. This avoids
  // inventing attack legality or claiming bounded block search proves a forced kill.
  for (const actor of facts.turnOrder) {
    for (const [recipient, hp] of life) {
      if (recipient === actor) continue;
      const attackers = view.battlefield.filter(
        (p) =>
          p.controller === actor && p.capabilities?.attacking === recipient && !p.blockedBy?.length,
      );
      let regularDamage = 0;
      let poisonDamage = 0;
      let commanderLethal = false;
      const target = facts.players.find((p) => p.seat === recipient);
      for (const p of attackers) {
        const first = p.keywords?.includes('first strike');
        const double = p.keywords?.includes('double strike');
        const strikes = facts.step === 'combatDamage' ? (first && !double ? 0 : 1) : double ? 2 : 1;
        const amount = Math.max(0, p.power ?? 0) * strikes;
        if (p.keywords?.includes('infect')) poisonDamage += amount;
        else regularDamage += amount;
        const commander = p.capabilities?.commanderId;
        if (
          commander &&
          amount + (target?.commanderDamage[commander] ?? 0) >= facts.rules.commanderDamageLoss
        )
          commanderLethal = true;
      }
      if (
        regularDamage >= hp ||
        poisonDamage + (target?.poison ?? 0) >= facts.rules.poisonLoss ||
        commanderLethal
      ) {
        events.push({
          controller: actor,
          affected: [recipient],
          sources: attackers.map((p) => p.id),
          urgency: 2,
          outcome: 'elimination',
          deadline: 'before-combat-damage',
          deadlineOrder: 1,
          search: 'possible',
          forced: false,
          assumptions: [
            'Declared unblocked attackers remain unchanged through the remaining damage steps.',
            'No prevention, replacement, removal, new blocks or other responses.',
          ],
        });
      }
    }
  }
  return events;
}
