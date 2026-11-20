/**
 * A compact game trace for reviewing bot play after the fact (`bot-gauntlet --trace-dir`): for the
 * traced seats, every decision that had a real choice (the pick and what it passed over), and the
 * public table once per turn. One JSON object per line; the first line is `kind: 'game'`, the last
 * is `kind: 'end'`.
 *
 * It is smaller than `decision-trace.ts` (no full menus, no forced decisions) so that hundreds of
 * games can be kept and read by a reviewer.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import type { DecisionRequest, DecisionResponse, PlayerId, PlayerView } from '@mtg/shared';
import { nameOf } from './decision-trace';

const MAX_ALTERNATIVES = 12;

export class GameTrace {
  private lastTurn = -1;
  private readonly seats: Set<PlayerId>;

  constructor(
    private readonly path: string,
    seats: readonly PlayerId[],
    private readonly view: (seat: PlayerId) => PlayerView,
    header: Record<string, unknown>,
  ) {
    this.seats = new Set(seats);
    writeFileSync(path, `${JSON.stringify({ kind: 'game', traced: [...seats], ...header })}\n`);
  }

  private write(line: object): void {
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
  }

  /** Called after each decision is submitted. */
  decision(request: DecisionRequest, response: DecisionResponse): void {
    if (request.turn !== this.lastTurn) {
      this.lastTurn = request.turn;
      this.table(request.turn, request.activePlayer);
    }
    const seat = request.decidingPlayer;
    if (!this.seats.has(seat)) return;
    const real = request.legalActions.filter((a) => a.type !== 'pass');
    const chosen = request.legalActions.find((a) => a.id === response.actionId);
    // A lone pass, or one non-pass action with no pass beside it, is not a choice.
    if (request.legalActions.length < 2 && (response.targets ?? []).length === 0) return;
    if (real.length === 0) return;
    const view = this.view(seat);
    const targets = (response.targets ?? []).map((t) => nameOf(String(t.choice), view));
    const alternatives = [
      ...new Set(
        request.legalActions.filter((a) => a.id !== response.actionId).map((a) => a.description),
      ),
    ];
    this.write({
      kind: 'decision',
      turn: request.turn,
      active: request.activePlayer,
      step: request.step ?? request.phase,
      seat,
      type: request.decisionType,
      chose: chosen?.description ?? `action ${response.actionId}`,
      ...(targets.length > 0 && { targets }),
      ...(alternatives.length > 0 && {
        over: alternatives.slice(0, MAX_ALTERNATIVES),
        ...(alternatives.length > MAX_ALTERNATIVES && {
          more: alternatives.length - MAX_ALTERNATIVES,
        }),
      }),
    });
  }

  /** The public table, plus each traced seat's hand, at the first decision of a turn. */
  private table(turn: number, active: PlayerId): void {
    const [first] = this.seats;
    if (first === undefined) return;
    const view = this.view(first);
    const seats: Record<string, unknown> = {};
    const all: Array<{ seat: PlayerId; life: number; hand: number }> = [
      { seat: view.seat, life: view.life, hand: view.hand.length },
      ...view.opponents.map((o) => ({ seat: o.seat, life: o.life, hand: o.handSize })),
    ];
    for (const { seat, life, hand } of all) {
      const permanents = view.battlefield.filter((p) => p.controller === seat);
      const lands = permanents.filter((p) => (p.typeLine ?? '').includes('Land')).length;
      seats[seat] = {
        life,
        hand,
        lands,
        board: permanents
          .filter((p) => !(p.typeLine ?? '').includes('Land'))
          .map((p) =>
            p.power === undefined || p.power === null
              ? p.name
              : `${p.name} ${p.power}/${p.toughness ?? '?'}`,
          ),
      };
    }
    const hands: Record<string, string[]> = {};
    for (const seat of this.seats) hands[seat] = this.view(seat).hand.map((c) => c.name);
    this.write({ kind: 'turn', turn, active, seats, hands });
  }

  end(
    winner: PlayerId | null,
    life: Record<string, number>,
    turns: number,
    haltReason: string | null,
  ): void {
    this.write({ kind: 'end', winner, life, turns, ...(haltReason && { haltReason }) });
  }
}
