/**
 * The combat lane (proposal: "Combat, in one lane"): combat drawn as one column per attacker,
 * grouped by what it attacks, with the creatures blocking it underneath and a line saying what
 * will happen. It replaces the combat strip's prose and its legend; the board keeps the real tiles.
 *
 * Pure: it reads the board the server sent and, while you are declaring, your unconfirmed plan.
 * The outcome lines are a preview for the reader, never a rules decision: they cover plain combat
 * damage with first strike, double strike, deathtouch, indestructible, trample and infect, and say
 * nothing when a creature has protection or the attacker has to split its damage between blockers.
 * Effects outside the creatures themselves (a Fog, a pump spell) are not known here, which is why
 * the lane calls them "if nothing changes" rather than results.
 */
import type { Phase, Step } from '@mtg/shared';

export interface LanePermanent {
  id: string;
  name: string;
  controller: string;
  power: number | null;
  toughness: number | null;
  damageMarked: number;
  tapped: boolean;
  keywords: readonly string[];
  attacking: string | null;
  attackingPlaneswalker?: string | null;
  blocking: string | null;
  blockedBy: readonly string[];
  scryfallId?: string | null;
  imageFace?: 'front' | 'back';
}

export interface LaneSeat {
  seat: string;
  label: string;
  life: number;
}

/** Your declaration while you compose it, as `combatPlan` holds it. */
export interface LanePlan {
  kind: 'attackers' | 'blockers';
  /** subject -> chosen defender (attackers) or attacker (blockers). */
  assignment: ReadonlyMap<string, string>;
  /** Every subject's legal options; a target nobody can choose is not offered as a slot. */
  options: readonly (readonly string[])[];
}

export interface LaneInput {
  phase: Phase;
  step: Step | null;
  priorityPlayer: string | null;
  viewerSeat: string | null;
  permanents: readonly LanePermanent[];
  seats: readonly LaneSeat[];
  plan: LanePlan | null;
}

export interface LaneCard {
  id: string;
  name: string;
  power: number | null;
  toughness: number | null;
  damageMarked: number;
  tapped: boolean;
  /** Chosen in your plan, not yet declared. */
  pending: boolean;
  /** Was in this combat and has left the battlefield since. */
  gone: boolean;
  scryfallId: string | null;
  imageFace: 'front' | 'back';
}

export interface LaneOutcome {
  text: string;
  tone: 'neutral' | 'danger';
  /** Damage a blocked trampler pushes through to what it attacks. */
  trampled?: number;
  /** `trampled` is the most it can be: the attacker may assign more of it to the blocker. */
  upTo?: boolean;
  /** The attacker divides its damage among several blockers, so what reaches the player is unknown. */
  split?: boolean;
}

export interface LanePair {
  attacker: LaneCard;
  blockers: LaneCard[];
  /** True when your plan may put a blocker on this attacker. */
  blockable: boolean;
  outcome: LaneOutcome | null;
}

export interface LaneGroup {
  /** The seat or permanent attacked: what a click on the group assigns to. */
  targetId: string;
  /** "P3" or "Jace, Vryn's Prodigy". */
  label: string;
  /** The attacked player's seat, or the controller of the attacked permanent. */
  seat: string | null;
  /** The attacked player's life now, for a seat group. */
  life: number | null;
  /** What that life would be after this combat's damage, when there is any to come. */
  lifeAfter: number | null;
  /** True when that number assumes nothing is blocked yet. */
  ifUnblocked: boolean;
  /** `lifeAfter` is the lowest it can go, because some trample damage is the attacker's choice. */
  atLowest: boolean;
  /** You attack this group's target, or block for it. */
  yours: boolean;
  /** Your plan can send a creature here. */
  droppable: boolean;
  pairs: LanePair[];
}

export interface LaneModel {
  kind: 'attackers' | 'blockers' | 'declared';
  title: string;
  hint: string | null;
  beats: string[];
  /** Index into `beats` of where combat is now. */
  beat: number;
  groups: LaneGroup[];
}

const FIRST = 'first strike';
const DOUBLE = 'double strike';

function has(p: LanePermanent, keyword: string): boolean {
  return p.keywords.includes(keyword);
}

function card(p: LanePermanent, pending = false): LaneCard {
  return {
    id: p.id,
    name: p.name,
    power: p.power,
    toughness: p.toughness,
    damageMarked: p.damageMarked,
    tapped: p.tapped,
    pending,
    gone: false,
    scryfallId: p.scryfallId ?? null,
    imageFace: p.imageFace ?? 'front',
  };
}

/** "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

type DamageStep = 'first' | 'regular';

/** Which combat damage steps are still to come, given where the turn is. */
export function damageStepsLeft(step: Step | null, priorityPlayer: string | null): DamageStep[] {
  if (step === 'endCombat') return [];
  if (step === 'combatDamage') return priorityPlayer === null ? ['regular'] : [];
  if (step === 'firstStrikeCombatDamage') {
    return priorityPlayer === null ? ['first', 'regular'] : ['regular'];
  }
  return ['first', 'regular'];
}

function dealsIn(p: LanePermanent, step: DamageStep): boolean {
  if (has(p, DOUBLE)) return true;
  return step === 'first' ? has(p, FIRST) : !has(p, FIRST);
}

interface Fighter {
  p: LanePermanent;
  /** Toughness left. */
  hp: number;
  /** Took deathtouch damage. */
  touched: boolean;
  /** -1/-1 counters from infect damage, which shrink power too and kill through indestructible. */
  shrunk: number;
  dead: boolean;
}

function fighter(p: LanePermanent): Fighter {
  return {
    p,
    hp: (p.toughness ?? 0) - p.damageMarked,
    touched: false,
    shrunk: 0,
    dead: false,
  };
}

function powerOf(f: Fighter): number {
  return Math.max(0, (f.p.power ?? 0) - f.shrunk);
}

function hit(target: Fighter, source: LanePermanent, amount: number): void {
  if (amount <= 0) return;
  target.hp -= amount;
  if (has(source, 'infect')) target.shrunk += amount;
  if (has(source, 'deathtouch')) target.touched = true;
}

function settle(f: Fighter): void {
  if (f.dead) return;
  // Zero toughness is not destruction, so indestructible doesn't save it.
  if ((f.p.toughness ?? 0) - f.shrunk <= 0) f.dead = true;
  else if (has(f.p, 'indestructible')) return;
  else if (f.hp <= 0 || f.touched) f.dead = true;
}

/** Damage the attacker deals per step to whatever is in front of it. */
function strikes(p: LanePermanent, steps: readonly DamageStep[]): number {
  return steps.filter((step) => dealsIn(p, step)).length * Math.max(0, p.power ?? 0);
}

/**
 * What an attacker and its blockers will do to each other if nothing changes, or null when that
 * can't be told from the board (protection, or damage split between several blockers before the
 * outcome is settled). `victim` names who an unblocked attacker hits. `wasBlocked` says the
 * attacker was blocked, for when `blockers` is empty because they have all left: it stays
 * blocked, and only trample gets its damage through.
 */
export function predictOutcome(
  attacker: LanePermanent,
  blockers: readonly LanePermanent[],
  victim: string,
  steps: readonly DamageStep[],
  blocksKnown: boolean,
  wasBlocked = false,
): LaneOutcome | null {
  if (steps.length === 0) return null;
  const fighters = [attacker, ...blockers];
  if (fighters.some((p) => p.keywords.some((k) => k.startsWith('protection')))) return null;

  if (blockers.length === 0) {
    if (!blocksKnown) return null;
    const unit = has(attacker, 'infect') ? ' poison' : '';
    if (wasBlocked) {
      // With no blocker left, a trampler assigns all its damage to the player.
      const amount = has(attacker, 'trample') ? strikes(attacker, steps) : 0;
      if (amount === 0) return { text: 'blocked', tone: 'neutral', trampled: 0 };
      return {
        text: `blocker gone, ${amount}${unit} tramples over`,
        tone: 'danger',
        trampled: amount,
      };
    }
    const amount = strikes(attacker, steps);
    if (amount === 0) return { text: 'no damage', tone: 'neutral' };
    return { text: `${amount}${unit} to ${victim}`, tone: 'danger' };
  }

  const a = fighter(attacker);
  const bs = blockers.map(fighter);
  let trampled = 0;
  /** Part of `trampled` is the controller's choice: they may put more than lethal on a blocker. */
  let upTo = false;
  /** The attacker's controller divides its damage among several blockers as they like. */
  let split = false;
  for (const [i, step] of steps.entries()) {
    if (a.dead && bs.every((b) => b.dead)) break;
    // A split earlier than the last step leaves later damage unknown too.
    if (split) return null;
    // Damage within a step is dealt at once: work it all out, then see who died.
    const attackerDeals = !a.dead && dealsIn(attacker, step) ? powerOf(a) : 0;
    for (const b of bs) {
      if (!b.dead && dealsIn(b.p, step)) hit(a, b.p, powerOf(b));
    }
    if (attackerDeals > 0) {
      const alive = bs.filter((b) => !b.dead);
      if (alive.length === 1) {
        const b = alive[0]!;
        // Trample: lethal to the blocker first (1 is lethal with deathtouch), the rest goes on.
        const lethal = has(attacker, 'deathtouch') ? 1 : Math.max(0, b.hp);
        const toBlocker = has(attacker, 'trample')
          ? Math.min(attackerDeals, lethal)
          : attackerDeals;
        hit(b, attacker, toBlocker);
        if (attackerDeals > toBlocker) upTo = true;
        trampled += attackerDeals - toBlocker;
      } else if (alive.length > 1) {
        // Any division is legal (it need not kill each in turn), so which blockers die is the
        // controller's choice: say only that it splits, and what happens to the attacker.
        split = true;
        if (i < steps.length - 1 && steps.slice(i + 1).some((next) => dealsIn(attacker, next)))
          return null;
      } else if (has(attacker, 'trample')) {
        // Every blocker is gone: a trampler assigns it all to the player.
        trampled += attackerDeals;
      }
    }
    settle(a);
    for (const b of bs) settle(b);
  }

  if (split) {
    const text = a.dead
      ? `${attacker.name} dies, splitting its damage`
      : `${attacker.name} splits its damage`;
    return { text, tone: a.dead ? 'danger' : 'neutral', trampled: 0, split: true };
  }
  const dead = [a, ...bs].filter((f) => f.dead).map((f) => f.p.name);
  const all = 1 + bs.length;
  let text: string;
  if (dead.length === 0) text = all === 2 ? 'both survive' : 'all survive';
  else if (dead.length === all) text = all === 2 ? 'both die' : 'all die';
  else text = `${listNames(dead)} ${dead.length === 1 ? 'dies' : 'die'}`;
  if (trampled > 0) text += `, ${upTo ? 'up to ' : ''}${trampled} tramples over`;
  return {
    text,
    tone: dead.length > 0 || trampled > 0 ? 'danger' : 'neutral',
    trampled,
    ...(upTo ? { upTo } : {}),
  };
}

function beatsFor(
  input: LaneInput,
  fighters: readonly LanePermanent[],
): {
  beats: string[];
  beat: number;
} {
  const strikeFirst =
    input.step === 'firstStrikeCombatDamage' ||
    fighters.some((p) => has(p, FIRST) || has(p, DOUBLE));
  const beats = strikeFirst
    ? ['Attack', 'Block', 'First strike', 'Damage']
    : ['Attack', 'Block', 'Damage'];
  const last = beats.length - 1;
  let beat = 0;
  if (input.plan?.kind === 'blockers' || input.step === 'declareBlockers') beat = 1;
  if (input.step === 'firstStrikeCombatDamage') beat = 2;
  if (input.step === 'combatDamage' || input.step === 'endCombat') beat = last;
  return { beats, beat };
}

/**
 * The lane for the board as it stands, or null outside combat and when there is nothing to draw
 * (no attackers chosen or declared).
 */
export function buildCombatLane(input: LaneInput): LaneModel | null {
  if (input.phase !== 'combat') return null;
  const byId = new Map(input.permanents.map((p) => [p.id, p]));
  const lifeOf = (seat: string) => input.seats.find((s) => s.seat === seat)?.life ?? null;
  const declared = input.permanents.filter((p) => p.attacking !== null);
  const plan = input.plan;

  // Choosing attackers: one group per target anyone can attack, filled from your plan.
  if (plan?.kind === 'attackers' && declared.length === 0) {
    const targets: string[] = [];
    for (const options of plan.options) {
      for (const option of options) if (!targets.includes(option)) targets.push(option);
    }
    const groups: LaneGroup[] = targets.map((targetId) => {
      const walker = byId.get(targetId);
      const seat = walker !== undefined ? walker.controller : targetId;
      const sent = [...plan.assignment]
        .filter(([, to]) => to === targetId)
        .map(([from]) => byId.get(from))
        .filter((p): p is LanePermanent => p !== undefined);
      const life = walker === undefined ? lifeOf(targetId) : null;
      // Infect damage gives poison counters instead of costing life.
      const damage = sent
        .filter((p) => !has(p, 'infect'))
        .reduce((sum, p) => sum + strikes(p, ['first', 'regular']), 0);
      const known = walker !== undefined || input.seats.some((s) => s.seat === targetId);
      return {
        targetId,
        label: walker !== undefined ? walker.name : known ? targetId : 'Attacking',
        seat: known ? seat : null,
        life,
        lifeAfter: life !== null && damage > 0 ? life - damage : null,
        ifUnblocked: true,
        atLowest: false,
        yours: true,
        droppable: true,
        pairs: sent.map((p) => ({
          attacker: card(p, true),
          blockers: [],
          blockable: false,
          outcome: null,
        })),
      };
    });
    return {
      kind: 'attackers',
      title: 'Choose attackers',
      hint: 'Click a creature, then a player. Click it in the lane to send it home.',
      ...beatsFor(input, []),
      groups,
    };
  }

  if (declared.length === 0) return null;

  const steps = damageStepsLeft(input.step, input.priorityPlayer);
  const blocksPending =
    input.step === 'declareAttackers' ||
    (input.step === 'declareBlockers' && input.priorityPlayer === null && plan === null);
  const blockable = new Set(plan?.kind === 'blockers' ? plan.options.flat() : []);
  const plannedOn = (attackerId: string): LanePermanent[] =>
    plan?.kind === 'blockers'
      ? [...plan.assignment]
          .filter(([, to]) => to === attackerId)
          .map(([from]) => byId.get(from))
          .filter((p): p is LanePermanent => p !== undefined)
      : [];

  const declaredBlockedOf = (p: LanePermanent) => p.blockedBy.length > 0;
  const waitingOnOthers = (p: LanePermanent) =>
    plan?.kind === 'blockers' && !blockable.has(p.id) && !declaredBlockedOf(p);

  const groups = new Map<string, LaneGroup>();
  const fighters: LanePermanent[] = [];
  for (const attacker of declared) {
    const walker =
      attacker.attackingPlaneswalker != null ? byId.get(attacker.attackingPlaneswalker) : undefined;
    const targetId = walker?.id ?? attacker.attacking!;
    let group = groups.get(targetId);
    if (group === undefined) {
      group = {
        targetId,
        label: walker !== undefined ? walker.name : targetId,
        seat: attacker.attacking,
        life: walker === undefined ? lifeOf(targetId) : null,
        lifeAfter: null,
        ifUnblocked: false,
        atLowest: false,
        yours: false,
        droppable: false,
        pairs: [],
      };
      groups.set(targetId, group);
    }
    const planned = plannedOn(attacker.id);
    const blockers =
      planned.length > 0
        ? planned
        : attacker.blockedBy
            .map((id) => byId.get(id))
            .filter((p): p is LanePermanent => p !== undefined);
    fighters.push(attacker, ...blockers);
    // While you block, another defender's attackers are still waiting on their own blocks.
    const othersBlocking = waitingOnOthers(attacker);
    const blocksKnown = !blocksPending && !othersBlocking;
    const victim = walker !== undefined ? walker.name : targetId;
    const declaredBlocked = declaredBlockedOf(attacker);
    // Blocked by a creature that has since left: still blocked, so only trample gets through.
    const outcome = predictOutcome(attacker, blockers, victim, steps, blocksKnown, declaredBlocked);
    group.pairs.push({
      attacker: card(attacker),
      blockers: blockers.map((b) => card(b, planned.length > 0)),
      blockable: blockable.has(attacker.id),
      outcome,
    });
    if (blockable.has(attacker.id)) group.yours = true;
    if (plan?.kind !== 'blockers' && attacker.controller === input.viewerSeat) group.yours = true;
  }

  // Life after damage, for each attacked player with damage still to come.
  for (const group of groups.values()) {
    if (group.life === null || steps.length === 0) continue;
    let damage = 0;
    let guessed = blocksPending;
    /** Some trample damage is the attacker's choice, so the total is the most it can be. */
    let lowest = false;
    /** Some change to this player's life can't be told yet: show no number rather than a wrong one. */
    let unknown = false;
    for (const attacker of declared) {
      const target = attacker.attackingPlaneswalker ?? attacker.attacking;
      if (target !== group.targetId || has(attacker, 'infect')) continue;
      if (waitingOnOthers(attacker)) guessed = true;
      const planned = plannedOn(attacker.id);
      const blocked = blocksPending ? false : planned.length > 0 || attacker.blockedBy.length > 0;
      if (!blocked) damage += strikes(attacker, steps);
      else {
        const blockers =
          planned.length > 0
            ? planned
            : attacker.blockedBy
                .map((id) => byId.get(id))
                .filter((p): p is LanePermanent => p !== undefined);
        // The defender gains life from its lifelink blockers' damage, which isn't modelled here.
        if (blockers.some((b) => b.controller === group.seat && has(b, 'lifelink'))) unknown = true;
        const outcome = predictOutcome(attacker, blockers, '', steps, true, true);
        // How much a trampler gets past several blockers (or protection) is not known yet.
        if (has(attacker, 'trample') && (outcome === null || outcome.split === true))
          unknown = true;
        damage += outcome?.trampled ?? 0;
        if (outcome?.upTo === true) lowest = true;
      }
    }
    if (damage > 0 && !unknown) {
      group.lifeAfter = group.life - damage;
      group.ifUnblocked = guessed;
      group.atLowest = !guessed && lowest;
    }
  }

  const ordered = [...groups.values()].sort((a, b) => Number(b.yours) - Number(a.yours));
  const { beats, beat } = beatsFor(input, fighters);
  if (plan?.kind === 'blockers') {
    return {
      kind: 'blockers',
      title: 'Declare blockers',
      hint: 'Click your creature, then the attacker it blocks.',
      beats,
      beat,
      groups: ordered,
    };
  }
  const title = blocksPending
    ? 'Attackers declared'
    : input.step === 'firstStrikeCombatDamage'
      ? 'First strike damage'
      : input.step === 'combatDamage'
        ? 'Damage'
        : input.step === 'endCombat'
          ? 'End of combat'
          : 'Blocks are in';
  return { kind: 'declared', title, hint: null, beats, beat, groups: ordered };
}

/**
 * Keeps the creatures that left the battlefield during combat damage in the lane, struck through,
 * so the damage beat shows who fell instead of an attacker quietly vanishing.
 */
export function withDeparted(
  next: LaneModel,
  previous: LaneModel | null,
  present: ReadonlySet<string>,
): LaneModel {
  if (previous === null) return next;
  const groups = next.groups.map((group) => ({ ...group, pairs: [...group.pairs] }));
  for (const old of previous.groups) {
    for (const pair of old.pairs) {
      const goneBlockers = pair.blockers
        .filter((b) => !present.has(b.id))
        .map((b) => ({ ...b, gone: true, pending: false }));
      const shown = next.groups.some((g) =>
        g.pairs.some((p) => p.attacker.id === pair.attacker.id),
      );
      if (shown) {
        if (goneBlockers.length === 0) continue;
        for (const group of groups) {
          const at = group.pairs.findIndex((p) => p.attacker.id === pair.attacker.id);
          if (at < 0) continue;
          const current = group.pairs[at]!;
          group.pairs[at] = { ...current, blockers: [...current.blockers, ...goneBlockers] };
        }
        continue;
      }
      let group = groups.find((g) => g.targetId === old.targetId);
      if (group === undefined) {
        group = { ...old, pairs: [], lifeAfter: null };
        groups.push(group);
      }
      // Still on the battlefield but out of combat (regenerated, or removed by an effect).
      if (present.has(pair.attacker.id)) {
        group.pairs.push({
          ...pair,
          attacker: { ...pair.attacker, pending: false },
          blockers: [...pair.blockers.filter((b) => present.has(b.id)), ...goneBlockers],
          blockable: false,
          outcome: { text: `${pair.attacker.name} was removed from combat`, tone: 'neutral' },
        });
        continue;
      }
      group.pairs.push({
        ...pair,
        attacker: { ...pair.attacker, gone: true, pending: false },
        blockers: [...pair.blockers.filter((b) => present.has(b.id)), ...goneBlockers],
        blockable: false,
        outcome: pair.outcome,
      });
    }
  }
  // A gone creature's outcome is the fact itself.
  for (const group of groups) {
    group.pairs = group.pairs.map((pair) => {
      const fallen = [pair.attacker, ...pair.blockers].filter((c) => c.gone).map((c) => c.name);
      if (fallen.length === 0) return pair;
      return {
        ...pair,
        outcome: { text: `${listNames(fallen)} left the battlefield`, tone: 'danger' },
      };
    });
  }
  return { ...next, groups };
}

/** The one line the lane folds into after combat. */
export function combatRecap(
  last: LaneModel,
  attacker: string | null,
  lifeBefore: ReadonlyMap<string, number>,
  seats: readonly LaneSeat[],
  viewerSeat: string | null,
): string {
  const who = (seat: string | null) => (seat !== null && seat === viewerSeat ? 'you' : seat);
  const targets = last.groups.map((g) => (g.seat === g.targetId ? who(g.seat) : g.label));
  const parts: string[] = [];
  const subject = attacker === viewerSeat ? 'You' : (attacker ?? 'Someone');
  parts.push(`${subject} attacked ${listNames(targets.filter((t): t is string => t !== null))}`);
  const fallen: string[] = [];
  for (const group of last.groups) {
    for (const pair of group.pairs) {
      for (const c of [pair.attacker, ...pair.blockers]) if (c.gone) fallen.push(c.name);
    }
  }
  if (fallen.length > 0) parts.push(`${listNames(fallen)} left the battlefield`);
  for (const seat of seats) {
    const before = lifeBefore.get(seat.seat);
    if (before === undefined || before === seat.life) continue;
    const name = seat.seat === viewerSeat ? 'You' : seat.seat;
    parts.push(`${name} ${before} → ${seat.life}`);
  }
  if (parts.length === 1) parts.push('no damage to players');
  return parts.join(' · ');
}
