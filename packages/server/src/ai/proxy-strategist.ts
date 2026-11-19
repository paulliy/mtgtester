/**
 * A deterministic stand-in for the bot-led strategist (hill-climb S7), so the bot league can
 * measure what reusing knobs costs without a paid model. It reads the same public table the real
 * strategist sees and sets knobs from it: target the biggest board, attack when ahead, hold back
 * when behind on life, and stop overextending when well ahead on permanents.
 *
 * It is a proxy, not the strategist: a staleness cost it shows is a lower bound on the real one,
 * and the paid `ai-mode-duel` with `AI_STRATEGIST_WAKE_RULE` is the check that counts.
 */

import type { BotSteering, PlayerView } from '@mtg/shared';
import { tableChangeReasons, tableSnapshot, type TableSnapshot, type WakeRule } from './steering';

/** Knobs from the table as `seat` sees it now. */
export function proxyKnobs(view: PlayerView): BotSteering {
  const me = tableSnapshot(view);
  const own = me[view.seat]!;
  const rivals = view.opponents
    .filter((o) => o.life > 0)
    .map((o) => ({ seat: o.seat, ...me[o.seat]! }));
  const threat = (r: (typeof rivals)[number]): number =>
    r.power + 2 * r.nonland + (r.commanderOut ? 5 : 0) + Math.max(0, 20 - r.life) / 2;
  const order = [...rivals].sort((a, b) => threat(b) - threat(a) || a.seat.localeCompare(b.seat));
  const maxPower = Math.max(0, ...rivals.map((r) => r.power));
  const maxNonland = Math.max(0, ...rivals.map((r) => r.nonland));
  const aggression = own.life < 15 ? 0.3 : own.power > maxPower ? 0.8 : 0.5;
  return {
    aggression,
    ...(order.length > 0 ? { targetOrder: order.map((r) => r.seat) } : {}),
    avoidOverextending: own.nonland >= maxNonland + 3,
  };
}

/** When the proxy strategist is asked again: as `StrategyCoordinator` decides it in bot mode. */
export interface ProxySchedule {
  replan: 'everyTurn' | 'onChange';
  rule: WakeRule;
  /** Most own turns knobs are reused in a row (`strategistMaxReuseTurns`). */
  maxReuseTurns: number;
}

/**
 * One seat's proxy strategist: `knobsFor(turn, view)` is called on every decision and asks the
 * proxy at most once per own turn, the way the coordinator reuses knobs under `onChange`.
 */
export class ProxyStrategist {
  calls = 0;
  reused = 0;
  private knobs: BotSteering | undefined;
  private table: TableSnapshot | undefined;
  private reusedTurns = 0;
  private lastTurn = -1;

  constructor(private readonly schedule: ProxySchedule) {}

  knobsFor(turn: number, ownTurn: boolean, view: PlayerView): BotSteering | undefined {
    if (!ownTurn || turn === this.lastTurn) return this.knobs;
    this.lastTurn = turn;
    const now = tableSnapshot(view);
    const reuse =
      this.schedule.replan === 'onChange' &&
      this.table !== undefined &&
      this.reusedTurns < this.schedule.maxReuseTurns &&
      tableChangeReasons(this.table, now, { self: view.seat, rule: this.schedule.rule }).length ===
        0;
    if (reuse) {
      this.reusedTurns++;
      this.reused++;
      return this.knobs;
    }
    this.calls++;
    this.reusedTurns = 0;
    this.table = now;
    this.knobs = proxyKnobs(view);
    return this.knobs;
  }
}
