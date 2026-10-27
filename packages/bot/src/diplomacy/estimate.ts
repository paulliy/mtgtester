import type { PermanentView, PlayerId, PlayerView } from '@mtg/shared';
import { WEIGHTS } from '../weights';

/**
 * A public-information estimate of the whole table from one seat's `PlayerView` (ADR 0031
 * decisions 7-10): each living seat's position in LEP, its rough win share, who leads, and where
 * each seat's attacks are likely to go.
 *
 * Only public fields are read. The viewer's own hand counts by size, exactly as an opponent's
 * does, so the estimate is the same whichever seat builds it (up to commander damage, which only
 * the danger checks use), and a bot can run it "from the other side" to predict a counterparty.
 */
export interface SeatEstimate {
  seat: PlayerId;
  life: number;
  poison: number;
  handSize: number;
  /** Total power of creatures that could attack on this seat's next turn. */
  attackPower: number;
  boardValue: number;
  position: number;
  winShare: number;
}

export interface TableEstimate {
  viewer: PlayerId;
  /** Living seats, viewer first, then opponents in the view's (APNAP) order. */
  seats: SeatEstimate[];
  bySeat: Map<PlayerId, SeatEstimate>;
  /** The seat named as leader (decision 9), or null when nobody stands out. */
  leader: PlayerId | null;
  /** Commander damage each opponent's commanders have dealt to the viewer. */
  commanderDamageToViewer: Map<PlayerId, number>;
}

const D = WEIGHTS.deals;
const C = WEIGHTS.combat;

/** CR 903.10a: 21 combat damage from one commander loses the game. */
const COMMANDER_DAMAGE_LETHAL = 21;

function isCreature(p: PermanentView): boolean {
  if (p.typeLine !== undefined) return p.typeLine.includes('Creature');
  return p.power !== undefined && p.power !== null;
}

function isLand(p: PermanentView): boolean {
  return p.typeLine?.includes('Land') ?? false;
}

/** Same shape as combat search's creature value, so a body is priced the same everywhere. */
export function creatureWorth(p: PermanentView): number {
  return (
    C.creatureBaseValue +
    Math.max(0, p.power ?? 0) * C.creaturePowerValue +
    Math.max(0, p.toughness ?? 0) * C.creatureToughnessValue +
    (p.keywords?.length ?? 0) * C.keywordValue
  );
}

function canAttack(p: PermanentView): boolean {
  if (!isCreature(p)) return false;
  if (p.keywords?.some((k) => k.toLowerCase() === 'defender') === true) return false;
  return (p.power ?? 0) > 0;
}

/**
 * Life as position: every point counts, and a point at or below the danger threshold counts
 * `lowLifeMultiplier` times, because those are the points that decide whether a seat survives.
 */
export function lifeValue(life: number): number {
  const L = Math.max(0, life);
  const danger = WEIGHTS.dangerousLifeThreshold;
  return L + (D.lowLifeMultiplier - 1) * Math.min(L, danger);
}

/** Position lost by a seat at `life` taking `damage`. */
export function lifeLoss(life: number, damage: number): number {
  return lifeValue(life) - lifeValue(life - Math.max(0, damage));
}

function softmax(values: readonly number[], temperature: number): number[] {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp((v - max) / temperature));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export function estimateTable(view: PlayerView): TableEstimate {
  const living: { seat: PlayerId; life: number; poison: number; handSize: number }[] = [
    { seat: view.seat, life: view.life, poison: 0, handSize: view.hand.length },
    ...view.opponents.map((o) => ({
      seat: o.seat,
      life: o.life,
      poison: o.poisonCounters,
      handSize: o.handSize,
    })),
  ];

  const seats: SeatEstimate[] = living.map((s) => {
    let boardValue = 0;
    let attackPower = 0;
    for (const p of view.battlefield) {
      if (p.controller !== s.seat) continue;
      if (isCreature(p)) boardValue += creatureWorth(p);
      else if (isLand(p)) boardValue += D.landValue;
      else boardValue += D.noncreaturePermanentValue;
      if (canAttack(p)) attackPower += p.power ?? 0;
    }
    const position =
      lifeValue(s.life) +
      boardValue +
      s.handSize * D.cardInHandValue -
      s.poison * D.poisonCounterValue;
    return { ...s, attackPower, boardValue, position, winShare: 0 };
  });

  const shares = softmax(
    seats.map((s) => s.position),
    D.winShareTemperature,
  );
  seats.forEach((s, i) => (s.winShare = shares[i] ?? 0));

  let leader: PlayerId | null = null;
  if (seats.length > 1) {
    const mean = 1 / seats.length;
    const top = seats.reduce((a, b) => (b.winShare > a.winShare ? b : a));
    if (top.winShare >= D.leaderShareRatio * mean) leader = top.seat;
  }

  return {
    viewer: view.seat,
    seats,
    bySeat: new Map(seats.map((s) => [s.seat, s])),
    leader,
    commanderDamageToViewer: new Map(
      view.opponents.map((o) => [o.seat, o.commanderDamageDealtToYou]),
    ),
  };
}

/**
 * What `damage` to `defender` is worth to whoever deals it (decision 16), in the same LEP as the
 * rest of the bot: the position the defender loses at `opponentLifePointValue`, weighted up for a
 * seat ahead of the field, plus combat search's lethal term when the damage eliminates them. The same function scores the bot's own attack targets and predicts
 * everyone else's, so the model of the table and the bot's own play agree.
 */
export function damageValue(table: TableEstimate, defender: PlayerId, damage: number): number {
  const s = table.bySeat.get(defender);
  if (s === undefined || damage <= 0) return 0;
  const n = table.seats.length;
  const focus = Math.max(0, 1 + D.leaderFocus * (s.winShare * n - 1));
  const lethal = damage >= s.life ? C.lethalSwingValue * C.opponentLifePointValue : 0;
  return C.opponentLifePointValue * lifeLoss(s.life, damage) * focus + lethal;
}

/**
 * Predicted share of `attacker`'s pressure going at each of its opponents, optionally with some
 * defenders ruled out (a `noAttack` obligation). Empty when nobody is left to attack.
 */
export function attackPreference(
  table: TableEstimate,
  attacker: PlayerId,
  excluded: ReadonlySet<PlayerId> = new Set(),
): Map<PlayerId, number> {
  const a = table.bySeat.get(attacker);
  const defenders = table.seats.filter((s) => s.seat !== attacker && !excluded.has(s.seat));
  if (a === undefined || defenders.length === 0) return new Map();
  const power = Math.max(1, a.attackPower);
  const weights = softmax(
    defenders.map((d) => damageValue(table, d.seat, power)),
    D.attackPreferenceTemperature,
  );
  return new Map(defenders.map((d, i) => [d.seat, weights[i] ?? 0]));
}

/** Damage `attacker` is predicted to send at `defender` on its next turn, with no deals. */
export function pressureOn(table: TableEstimate, attacker: PlayerId, defender: PlayerId): number {
  const a = table.bySeat.get(attacker);
  if (a === undefined) return 0;
  return a.attackPower * (attackPreference(table, attacker).get(defender) ?? 0);
}

/**
 * Whether `seat` is in danger: low life, within one swing of some opponent's full attack, or
 * close to commander-damage death. Commander damage is only known for the viewer.
 */
export function inDanger(table: TableEstimate, seat: PlayerId): boolean {
  const s = table.bySeat.get(seat);
  if (s === undefined) return false;
  if (s.life <= WEIGHTS.dangerousLifeThreshold) return true;
  if (table.seats.some((o) => o.seat !== seat && o.attackPower >= s.life)) return true;
  if (seat === table.viewer) {
    for (const dealt of table.commanderDamageToViewer.values()) {
      if (dealt >= D.commanderDamageDanger) return true;
    }
  }
  return false;
}

/** Whether `attacker`'s full attack could kill `defender` (life or commander damage). */
export function couldKill(table: TableEstimate, attacker: PlayerId, defender: PlayerId): boolean {
  const a = table.bySeat.get(attacker);
  const d = table.bySeat.get(defender);
  if (a === undefined || d === undefined) return false;
  if (a.attackPower >= d.life) return true;
  if (defender === table.viewer) {
    const dealt = table.commanderDamageToViewer.get(attacker) ?? 0;
    if (dealt > 0 && a.attackPower >= COMMANDER_DAMAGE_LETHAL - dealt) return true;
  }
  return false;
}
