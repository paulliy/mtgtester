/**
 * Table talk on the spectator board (ADR 0035): which deals are in force at a point in the log,
 * and how each seat's side of one reads. Derived from the talk lines alone, so scrubbing back in
 * the timeline shows the deals as they stood then.
 */
import type { Deal, DealObligation, PlayerId, TableTalkLine } from '@mtg/shared';

export interface DealInForce {
  deal: Deal;
  /** Parties released from their side because the other party took the lead. */
  freed: PlayerId[];
}

/**
 * `base` plus the lines of `extra` it does not already hold, in the order they were said. Lines
 * are ordered by their anchor; lines sharing one keep `base`'s order first, so pass the server's
 * history as `base` when it arrives after live lines (a reload): it holds every earlier line in
 * order, and live lines only ever follow it. The same line can come from both, so equal lines are
 * dropped.
 */
export function mergeTalk(
  base: readonly TableTalkLine[],
  extra: readonly TableTalkLine[],
): TableTalkLine[] {
  const seen = new Set(base.map((line) => JSON.stringify(line)));
  const fresh = extra.filter((line) => !seen.has(JSON.stringify(line)));
  // Array.prototype.sort is stable, so equal anchors keep the order above.
  return [...base, ...fresh].sort((a, b) => a.sequence - b.sequence);
}

/**
 * Deals in force once every talk line at or before `upTo` has been said (`null`: all of them).
 * A deal is in force from the answer that accepts it until it is broken or ends.
 */
export function dealsInForce(talk: readonly TableTalkLine[], upTo: number | null): DealInForce[] {
  const offered = new Map<string, Deal>();
  const inForce = new Map<string, DealInForce>();
  for (const line of talk) {
    if (upTo !== null && line.sequence > upTo) continue;
    const m = line.message;
    switch (m.kind) {
      case 'proposal':
        offered.set(m.deal.id, m.deal);
        break;
      case 'response': {
        if (m.counter !== undefined) offered.set(m.counter.id, m.counter);
        const deal = offered.get(m.dealId);
        if (m.answer === 'accept' && deal !== undefined) {
          inForce.set(deal.id, { deal, freed: [] });
        }
        break;
      }
      case 'released': {
        const entry = inForce.get(m.dealId);
        if (entry !== undefined && !entry.freed.includes(m.seat)) entry.freed.push(m.seat);
        break;
      }
      case 'breach':
      case 'dealEnded':
        inForce.delete(m.dealId);
        break;
      case 'threatCall':
      case 'withdrawn':
        // An offer leaving the table puts no deal in force and ends none.
        break;
    }
  }
  return [...inForce.values()];
}

function promise(o: DealObligation): string {
  switch (o.kind) {
    case 'noAttack':
      return `won't attack ${o.against}`;
    case 'noTarget':
      return `won't target ${o.against}`;
    case 'noCounter':
      return `won't counter ${o.against}`;
    case 'attackPlayer':
      return `attacks ${o.target}`;
  }
}

/** One short line per deal a seat is in, from that seat's side: "with P3: won't attack P3". */
export function dealLinesFor(seat: PlayerId, deals: readonly DealInForce[]): string[] {
  return deals
    .filter(({ deal }) => deal.parties.includes(seat))
    .map(({ deal, freed }) => {
      const other = deal.parties[0] === seat ? deal.parties[1] : deal.parties[0];
      const owed = freed.includes(seat)
        ? 'released'
        : deal.obligations
            .filter((o) => o.by === seat)
            .map(promise)
            .join(', ') || 'owes nothing';
      return `with ${other}: ${owed}`;
    });
}

/** An obligation in words, naming seats by `name` (the seat id by default). */
export function describeObligation(
  o: DealObligation,
  name: (seat: PlayerId) => string = (seat) => seat,
): string {
  const by = name(o.by);
  // A seat the viewer calls "you" reads as the sentence's object in lower case, and "you" takes
  // the plain verb: "you attack P4", "P3 won't attack you", "your spells".
  const them = (seat: PlayerId) => (name(seat) === 'You' ? 'you' : name(seat));
  switch (o.kind) {
    case 'noAttack':
      return `${by} won't attack ${them(o.against)}`;
    case 'noTarget':
      return `${by} won't target ${them(o.against)}`;
    case 'noCounter': {
      const whose = them(o.against);
      return `${by} won't counter ${whose === 'you' ? 'your' : `${whose}'s`} spells`;
    }
    case 'attackPlayer':
      return `${by} ${by === 'You' ? 'attack' : 'attacks'} ${them(o.target)}`;
  }
}

/** A deal's length in words. */
export function describeRounds(rounds: number): string {
  return rounds === 1 ? 'for 1 round' : `for ${rounds} rounds`;
}
