/**
 * `CombatSnapshot` and its resolution simulator — ADR 0024 Phase 7a.
 *
 * A minimal, self-contained model of ONE combat phase: just enough to answer "if blocks were
 * declared this way, what dies and how much damage lands?" without cloning the engine. It is
 * deliberately NOT a general game-state clone (ADR 0024 Decision item 2) and holds no reference
 * to engine state; it is built from a `PlayerView`, which is all a bot ever sees (brief §7.1).
 *
 * ## This is a second implementation of rules the engine already owns
 *
 * That is the cost ADR 0024 accepted, and the drift risk it named: every rule below mirrors
 * `packages/engine/src/combat/combat.ts` (`dealCombatDamage`, `dealsInStep`) and
 * `packages/engine/src/sba/sba.ts`'s destruction check. **The parity suite in
 * `packages/server/src/bot/combat-snapshot-parity.test.ts` is what keeps the two honest** — it
 * runs the same board through the real engine and through this simulator and compares. A combat
 * rules change in the engine that is not mirrored here shows up there as a failure, which is the
 * whole point of that suite existing separately from the bot's own tests.
 *
 * Where this file deliberately mirrors engine behavior that departs from the Comprehensive
 * Rules, it says so at the site. The simulator's job is to predict *the engine*, not to be a
 * second opinion about the rules — a search that scores against rules the engine does not have
 * is worse than no search.
 */

/** Keywords that change combat math. Compared lowercase, as `PermanentView.keywords` reports. */
const FIRST_STRIKE = 'first strike';
const DOUBLE_STRIKE = 'double strike';
const DEATHTOUCH = 'deathtouch';
const TRAMPLE = 'trample';
const LIFELINK = 'lifelink';
const INDESTRUCTIBLE = 'indestructible';

export interface SnapshotCreature {
  id: string;
  /** Controller id — lifelink credits this player, and it decides which side a body is on. */
  controller: string;
  power: number;
  toughness: number;
  /**
   * Damage already marked before this combat phase (CR 510.1c's lethal calculation subtracts it).
   *
   * `PlayerView` does not currently project marked damage, so a snapshot built from a view passes
   * 0 — correct for a declare-blockers decision, where no combat damage has been dealt yet, and
   * an underestimate only for a board where something was pinged earlier in the turn. The
   * simulator models it properly regardless, so closing the projection gap needs no change here.
   */
  damageMarked?: number;
  keywords: readonly string[];
}

export interface SnapshotAttacker extends SnapshotCreature {
  /** The player being attacked. */
  defendingPlayer: string;
  /**
   * Blocker ids in the order they were declared (`EnginePermanent.blockedByOrdered`). An empty
   * array means unblocked; a non-empty one means blocked, which stays true for the rest of the
   * combat even after every blocker in it dies (CR 509.1h).
   */
  blockedBy: readonly string[];
  /**
   * The attacker's chosen damage division for the 2+ live blockers case (CR 510.1c-d), keyed by
   * blocker id, plus the defending player's id when trample sends some over the top. Ignored
   * when fewer than two blockers are alive, where the assignment is forced.
   */
  damageDivision?: Readonly<Record<string, number>>;
}

export interface CombatSnapshot {
  attackers: readonly SnapshotAttacker[];
  /** Creatures blocking, each naming the attacker it blocks. */
  blockers: readonly (SnapshotCreature & { blocking: string })[];
}

export interface CombatOutcome {
  /** Ids of creatures destroyed, in no particular order. */
  deaths: readonly string[];
  /** Combat damage dealt to each player, by player id. Absent means none. */
  damageToPlayers: Readonly<Record<string, number>>;
  /** Life gained through lifelink, by controller id. Absent means none. */
  lifeGained: Readonly<Record<string, number>>;
}

interface Working {
  readonly creature: SnapshotCreature;
  damageMarked: number;
  deathtouched: boolean;
  dead: boolean;
}

const has = (c: SnapshotCreature, keyword: string): boolean => c.keywords.includes(keyword);

/** CR 510.5 — does this creature deal damage in the given step? Mirrors `combat.ts::dealsInStep`. */
function dealsInStep(c: SnapshotCreature, step: 'first' | 'regular'): boolean {
  const first = has(c, FIRST_STRIKE);
  const dbl = has(c, DOUBLE_STRIKE);
  return step === 'first' ? first || dbl : dbl || !first;
}

/**
 * Lethal damage for assignment purposes (CR 510.1c): deathtouch makes 1 lethal (CR 702.2b),
 * otherwise it is remaining toughness, never below 1.
 */
function lethalFor(target: Working, attackerHasDeathtouch: boolean): number {
  return attackerHasDeathtouch ? 1 : Math.max(1, target.creature.toughness - target.damageMarked);
}

interface Assignment {
  source: Working;
  targetCreature: Working | null;
  targetPlayer: string | null;
  amount: number;
}

/**
 * Resolve one whole combat phase and report what changed.
 *
 * Both damage steps run (CR 510.5) with a destruction check between them, exactly as the engine
 * interleaves `dealCombatDamage` and the SBA pass: a blocker killed by first strike is gone
 * before the regular step, and cannot deal its own damage.
 */
export function resolveCombatSnapshot(snapshot: CombatSnapshot): CombatOutcome {
  const work = new Map<string, Working>();
  const register = (creature: SnapshotCreature): void => {
    work.set(creature.id, {
      creature,
      damageMarked: creature.damageMarked ?? 0,
      deathtouched: false,
      dead: false,
    });
  };
  for (const attacker of snapshot.attackers) register(attacker);
  for (const blocker of snapshot.blockers) register(blocker);

  const damageToPlayers: Record<string, number> = {};
  const lifeGained: Record<string, number> = {};
  const deaths: string[] = [];

  const live = (id: string): Working | undefined => {
    const entry = work.get(id);
    return entry === undefined || entry.dead ? undefined : entry;
  };

  for (const step of ['first', 'regular'] as const) {
    const assignments: Assignment[] = [];

    for (const attacker of snapshot.attackers) {
      const self = live(attacker.id);
      if (self === undefined || !dealsInStep(attacker, step) || attacker.power <= 0) continue;
      const deathtouch = has(attacker, DEATHTOUCH);
      const trample = has(attacker, TRAMPLE);
      const liveBlockers = attacker.blockedBy
        .map(live)
        .filter((b): b is Working => b !== undefined);

      // Unblocked: the whole power goes to the defending player (CR 510.1a).
      if (attacker.blockedBy.length === 0) {
        assignments.push({
          source: self,
          targetCreature: null,
          targetPlayer: attacker.defendingPlayer,
          amount: attacker.power,
        });
        continue;
      }

      if (liveBlockers.length >= 2 && attacker.damageDivision !== undefined) {
        for (const blocker of liveBlockers) {
          const amount = attacker.damageDivision[blocker.creature.id] ?? 0;
          if (amount > 0) {
            assignments.push({ source: self, targetCreature: blocker, targetPlayer: null, amount });
          }
        }
        const toPlayer = attacker.damageDivision[attacker.defendingPlayer] ?? 0;
        if (toPlayer > 0) {
          assignments.push({
            source: self,
            targetCreature: null,
            targetPlayer: attacker.defendingPlayer,
            amount: toPlayer,
          });
        }
        continue;
      }

      // Exactly one live blocker: forced, except trample splits lethal/excess (CR 702.19b).
      // If no blockers remain, trample sends the remaining power to the defending player — the
      // blocker can die in the first-strike step and still leave a regular-step overflow case.
      const [only] = liveBlockers;
      if (only === undefined) {
        if (trample) {
          assignments.push({
            source: self,
            targetCreature: null,
            targetPlayer: attacker.defendingPlayer,
            amount: attacker.power,
          });
        }
        continue;
      }
      const lethal = lethalFor(only, deathtouch);
      const toBlocker = trample ? Math.min(attacker.power, lethal) : attacker.power;
      assignments.push({
        source: self,
        targetCreature: only,
        targetPlayer: null,
        amount: toBlocker,
      });
      const excess = attacker.power - toBlocker;
      if (excess > 0 && trample) {
        assignments.push({
          source: self,
          targetCreature: null,
          targetPlayer: attacker.defendingPlayer,
          amount: excess,
        });
      }
    }

    for (const blocker of snapshot.blockers) {
      const self = live(blocker.id);
      if (self === undefined || !dealsInStep(blocker, step) || blocker.power <= 0) continue;
      const target = live(blocker.blocking);
      if (target === undefined) continue; // its attacker already left combat
      assignments.push({
        source: self,
        targetCreature: target,
        targetPlayer: null,
        amount: blocker.power,
      });
    }

    // All damage in a step is dealt simultaneously (CR 510.2) — accumulate first, destroy after.
    for (const a of assignments) {
      if (a.targetCreature !== null) {
        a.targetCreature.damageMarked += a.amount;
        if (has(a.source.creature, DEATHTOUCH)) a.targetCreature.deathtouched = true;
      } else if (a.targetPlayer !== null) {
        damageToPlayers[a.targetPlayer] = (damageToPlayers[a.targetPlayer] ?? 0) + a.amount;
      }
      if (has(a.source.creature, LIFELINK)) {
        const controller = a.source.creature.controller;
        lifeGained[controller] = (lifeGained[controller] ?? 0) + a.amount;
      }
    }

    // CR 704.5g/h, mirroring `sba.ts`: lethal marked damage or any deathtouch damage destroys,
    // unless indestructible. Zero or less toughness kills regardless of indestructible (704.5f).
    for (const entry of work.values()) {
      if (entry.dead) continue;
      if (entry.creature.toughness <= 0) {
        entry.dead = true;
        deaths.push(entry.creature.id);
        continue;
      }
      const lethal = entry.damageMarked >= entry.creature.toughness || entry.deathtouched;
      if (lethal && entry.damageMarked > 0 && !has(entry.creature, INDESTRUCTIBLE)) {
        entry.dead = true;
        deaths.push(entry.creature.id);
      }
    }
  }

  return { deaths, damageToPlayers, lifeGained };
}
