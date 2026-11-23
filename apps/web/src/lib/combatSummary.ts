/**
 * The board's combat strip in words (Decktank board design, docs/design/decktank/Board.dc.html):
 * a label for where combat is ("Combat · blockers"), one line per attacker saying whom it attacks
 * and how it stands ("Broodcaller Scourge 5/7 → P2 Queen Marchesa · waiting for blocks"), and the
 * chip each attacked seat wears ("Under attack · 5 incoming"). The arrows on the board draw the
 * same thing; this is the version a screen reader and a glance can both use.
 *
 * Pure: it reads the board the server sent and, while you are declaring, your unconfirmed plan.
 * It decides nothing about legality.
 */
import type { Phase, Step } from '@mtg/shared';

export interface CombatPermanent {
  id: string;
  name: string;
  controller: string;
  power: number | null;
  toughness: number | null;
  attacking: string | null;
  attackingPlaneswalker?: string | null;
  blocking: string | null;
  blockedBy: readonly string[];
}

export interface CombatSeat {
  seat: string;
  label: string;
}

/** Your declaration while it is still being composed: subject id -> chosen target id. */
export interface CombatPlanView {
  kind: 'attackers' | 'blockers';
  assignment: ReadonlyMap<string, string>;
  /** How many creatures could be assigned at all. */
  subjects: number;
}

export interface CombatSummaryInput {
  phase: Phase;
  step: Step | null;
  /** Null while no one holds priority, as while a declaration is being made. */
  priorityPlayer: string | null;
  permanents: readonly CombatPermanent[];
  seats: readonly CombatSeat[];
  plan: CombatPlanView | null;
}

export interface CombatSummary {
  label: string;
  lines: string[];
  /** Seat -> its chip text, for each seat creatures are attacking. */
  attacked: Map<string, string>;
}

function pt(p: CombatPermanent): string {
  return p.power === null ? '' : ` ${p.power}/${p.toughness}`;
}

function seatName(seats: readonly CombatSeat[], id: string): string {
  const seat = seats.find((s) => s.seat === id);
  return seat === undefined ? id : `${seat.seat} ${seat.label}`;
}

/** Names in a list read as English: "A", "A and B", "A, B and C". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Collapses repeated names ("Dragon token, Dragon token") into "Dragon token ×2". */
function countedNames(names: string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
}

/**
 * The strip's contents, or null outside combat and when there is nothing to say (beginning of
 * combat with no attackers chosen yet, or a combat in which nobody attacked).
 */
export function summarizeCombat(input: CombatSummaryInput): CombatSummary | null {
  if (input.phase !== 'combat') return null;
  const byId = new Map(input.permanents.map((p) => [p.id, p]));
  const attackers = input.permanents.filter((p) => p.attacking !== null);
  const attacked = new Map<string, string>();

  // Choosing attackers: the plan, before anything is declared.
  if (input.plan?.kind === 'attackers' && attackers.length === 0) {
    const chosen = [...input.plan.assignment.keys()]
      .map((id) => byId.get(id))
      .filter((p): p is CombatPermanent => p !== undefined);
    const lines =
      chosen.length === 0
        ? ['Click a creature, then the player it attacks.']
        : [
            `${chosen.length} selected: ${countedNames(chosen.map((p) => p.name)).join(', ')}. Click a creature to add or remove it.`,
          ];
    return { label: 'Combat · choose attackers', lines, attacked };
  }

  if (attackers.length === 0) return null;

  const step = input.step;
  const blocksPending = step === 'declareAttackers' || (step === 'declareBlockers' && input.priorityPlayer === null);
  const damageStep = step === 'combatDamage' || step === 'firstStrikeCombatDamage';
  const label =
    input.plan?.kind === 'blockers'
      ? 'Combat · declare blockers'
      : blocksPending
        ? 'Combat · blockers'
        : damageStep
          ? 'Combat · damage'
          : step === 'endCombat'
            ? 'Combat · end'
            : 'Combat · blocks declared';

  const lines: string[] = [];
  const incoming = new Map<string, number>();
  const unblockedAt = new Map<string, number>();
  for (const attacker of attackers) {
    const seat = attacker.attacking!;
    const walker =
      attacker.attackingPlaneswalker != null ? byId.get(attacker.attackingPlaneswalker) : undefined;
    const target = walker !== undefined ? walker.name : seatName(input.seats, seat);
    const power = Math.max(0, attacker.power ?? 0);
    incoming.set(seat, (incoming.get(seat) ?? 0) + power);
    let state: string;
    const planned =
      input.plan?.kind === 'blockers'
        ? [...input.plan.assignment].filter(([, to]) => to === attacker.id).map(([from]) => from)
        : [];
    if (planned.length > 0) {
      state = `blocked by ${listNames(planned.map((id) => byId.get(id)?.name ?? id))}, not confirmed`;
    } else if (blocksPending) {
      state = 'waiting for blocks';
    } else if (attacker.blockedBy.length > 0) {
      const blockers = attacker.blockedBy
        .map((id) => byId.get(id))
        .filter((p): p is CombatPermanent => p !== undefined)
        .map((p) => `${p.name}${pt(p)}`);
      state = `blocked by ${listNames(blockers.length > 0 ? blockers : ['a creature that left'])}`;
    } else {
      state = `unblocked, ${power} damage`;
      unblockedAt.set(seat, (unblockedAt.get(seat) ?? 0) + 1);
    }
    lines.push(`${attacker.name}${pt(attacker)} → ${target} · ${state}`);
  }

  for (const [seat, power] of incoming) {
    const count = attackers.filter((a) => a.attacking === seat).length;
    if (blocksPending || input.plan?.kind === 'blockers') {
      attacked.set(seat, `Under attack · ${power} incoming`);
    } else if ((unblockedAt.get(seat) ?? 0) === 0) {
      attacked.set(seat, count === 1 ? 'Under attack · blocked' : 'Under attack · all blocked');
    } else {
      const through = attackers
        .filter((a) => a.attacking === seat && a.blockedBy.length === 0)
        .reduce((sum, a) => sum + Math.max(0, a.power ?? 0), 0);
      attacked.set(seat, `Under attack · ${through} incoming`);
    }
  }
  return { label, lines, attacked };
}
