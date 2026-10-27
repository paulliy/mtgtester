import type { DealObligation, PlayerId, TableMessage } from '@mtg/shared';

/**
 * Plain sentences for table talk (ADR 0031 decision 1). `name` turns a seat id into what the
 * viewer calls it; the default prints the id.
 */
export type SeatName = (seat: PlayerId) => string;

export function describeObligation(o: DealObligation, name: SeatName = (s) => s): string {
  switch (o.kind) {
    case 'noAttack':
      return `${name(o.by)} won't attack ${name(o.against)}`;
    case 'noTarget':
      return `${name(o.by)} won't target ${name(o.against)} or their things`;
    case 'noCounter':
      return `${name(o.by)} won't target ${name(o.against)}'s spells`;
    case 'attackPlayer':
      return `${name(o.by)} attacks ${name(o.target)} in earnest`;
  }
}

function roundsText(rounds: number): string {
  return rounds === 1 ? 'for a round' : `for ${rounds} rounds`;
}

export function describeMessage(m: TableMessage, name: SeatName = (s) => s): string {
  switch (m.kind) {
    case 'threatCall': {
      const why = m.reasons.map((r) => r.detail).join(', ');
      return `${name(m.from)}: ${name(m.leader)} is the biggest threat${why === '' ? '' : ` (${why})`}.`;
    }
    case 'proposal':
      return `${name(m.from)} to ${name(m.to)}: deal? ${m.deal.obligations
        .map((o) => describeObligation(o, name))
        .join('; ')}, ${roundsText(m.deal.rounds)}.`;
    case 'response':
      if (m.answer === 'accept') return `${name(m.from)}: deal.`;
      if (m.counter === undefined) return `${name(m.from)}: no deal.`;
      return `${name(m.from)}: no. Counter: ${m.counter.obligations
        .map((o) => describeObligation(o, name))
        .join('; ')}, ${roundsText(m.counter.rounds)}.`;
    case 'breach': {
      const why =
        m.reason === 'lethal'
          ? ': nothing personal, it was lethal.'
          : m.reason === 'selfDefense'
            ? ': you were about to beat me.'
            : '.';
      return `${name(m.from)} breaks the deal (${describeObligation(m.obligation, name)})${why}`;
    }
    case 'dealEnded': {
      if (m.outcome === 'kept') return `Deal ${m.dealId} ran its course.`;
      const why =
        m.reason === 'leader'
          ? ': a party took the lead'
          : m.reason === 'lethal'
            ? ': one side could now kill the other'
            : m.reason === 'unmet'
              ? ': the promised attack never came'
              : m.reason === 'partyLeft'
                ? ': a party left the game'
                : '';
      return `Deal ${m.dealId} is off${why}.`;
    }
  }
}
