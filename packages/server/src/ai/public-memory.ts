import type { GameEvent, PlayerId } from '@mtg/shared';

export type PublicMemoryKind =
  | 'engine'
  | 'cardUsed'
  | 'commanderCast'
  | 'tutor'
  | 'wipe'
  | 'elimination'
  | 'aggression'
  | 'intervention';

export interface PublicMemoryEntry {
  kind: PublicMemoryKind;
  actor: PlayerId | null;
  affectedSeat?: PlayerId;
  card?: string;
  detail: string;
  sourceEventSequence: number;
  lastSeenTurn: number;
  /** A revealed card that later moved to a hidden zone is historical knowledge, not current state. */
  knowledge: 'public_now' | 'historical_public';
}

export interface PublicMemorySnapshot {
  version: 'public-memory-v1';
  throughEventSequence: number;
  entries: PublicMemoryEntry[];
}

const PRIVATE_EVENT_TYPES = new Set(['decision', 'draw', 'bottomedCards']);
const INTERVENTION_TYPES = new Set([
  'counterSpell',
  'destroy',
  'exile',
  'returnToHand',
  'graveyardToHand',
  'graveyardToBattlefield',
  'fight',
]);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function publicEvent(event: GameEvent): boolean {
  if (PRIVATE_EVENT_TYPES.has(event.type)) return false;
  if (event.type === 'zoneChange') {
    return event.payload['from'] !== 'library' && event.payload['to'] !== 'library';
  }
  return true;
}

function remembered(event: GameEvent): PublicMemoryEntry | null {
  if (!publicEvent(event)) return null;
  const p = event.payload;
  const actor = event.actorSeat;
  const base = {
    actor,
    sourceEventSequence: event.sequence,
    lastSeenTurn: event.turn,
    knowledge: 'public_now' as const,
  };

  if (event.type === 'zoneChange') {
    const name = text(p['name']);
    const from = text(p['from']);
    const to = text(p['to']);
    if (
      name === undefined ||
      name === 'Face-down permanent' ||
      from === undefined ||
      to === undefined
    )
      return null;
    const owner = text(p['owner']);
    const commanderCast = from === 'command' && to === 'stack';
    const used =
      ['stack', 'battlefield'].includes(to) && ['hand', 'command', 'graveyard'].includes(from);
    if (!commanderCast && !used) return null;
    return {
      ...base,
      kind: commanderCast ? 'commanderCast' : 'cardUsed',
      ...(owner === undefined ? {} : { affectedSeat: owner }),
      card: name,
      detail: `${name} moved from ${from} to ${to}`,
    };
  }

  if (event.type === 'searchFound') {
    const player = text(p['player']);
    const name = text(p['name']);
    const destination = text(p['to']) ?? 'unknown destination';
    if (player === undefined) return null;
    const publicDestination = ['battlefield', 'graveyard', 'exile', 'stack'].includes(destination);
    const revealed = p['revealed'] === true;
    const publicName = publicDestination || revealed ? name : undefined;
    return {
      ...base,
      kind: 'tutor',
      affectedSeat: player,
      ...(publicName === undefined ? {} : { card: publicName }),
      detail: `${player} searched for ${publicName ?? 'a hidden card'} to ${destination}`,
      knowledge: revealed && !publicDestination ? 'historical_public' : 'public_now',
    };
  }

  if (event.type === 'playerEliminated') {
    const player = text(p['player']);
    if (player === undefined) return null;
    return {
      ...base,
      kind: 'elimination',
      affectedSeat: player,
      detail: `${player} was eliminated${text(p['reason']) ? `: ${text(p['reason'])}` : ''}`,
    };
  }

  if (event.type === 'damage') {
    const target = text(p['target']);
    const controller = text(p['controller']);
    const amount = typeof p['amount'] === 'number' ? p['amount'] : undefined;
    if (target === undefined || controller === undefined || !/^P\d+$/.test(target)) return null;
    return {
      ...base,
      kind: 'aggression',
      actor: controller,
      affectedSeat: target,
      detail: `${controller} dealt ${amount ?? 'some'} damage to ${target}`,
    };
  }

  if (INTERVENTION_TYPES.has(event.type)) {
    const card = text(p['source']) ?? text(p['by']);
    const target = text(p['target']) ?? text(p['countered']) ?? text(p['first']);
    return {
      ...base,
      kind: 'intervention',
      ...(card === undefined ? {} : { card }),
      detail: `${event.type}${card ? ` by ${card}` : ''}${target ? ` affecting ${target}` : ''}`,
    };
  }

  if (event.type === 'resolved') {
    const description = text(p['description']);
    if (description === undefined) return null;
    return { ...base, kind: 'engine', detail: `${description} resolved` };
  }

  return null;
}

/** Bounded structured memory. It never parses prose logs and ignores private event classes. */
export class PublicMemoryTracker {
  private readonly entries: PublicMemoryEntry[] = [];
  private throughSequence = 0;

  constructor(private readonly limit = 64) {}

  observe(events: readonly GameEvent[]): void {
    for (const event of events) {
      if (event.sequence <= this.throughSequence) continue;
      this.throughSequence = event.sequence;
      const entry = remembered(event);
      if (entry !== null) {
        this.entries.push(entry);
        if (event.type === 'destroy' && entry.kind === 'intervention') {
          const destroyed = this.entries.filter(
            (candidate) =>
              candidate.kind === 'intervention' &&
              candidate.lastSeenTurn === entry.lastSeenTurn &&
              candidate.card === entry.card,
          ).length;
          if (destroyed >= 3) {
            const existing = this.entries.find(
              (candidate) =>
                candidate.kind === 'wipe' &&
                candidate.lastSeenTurn === entry.lastSeenTurn &&
                candidate.card === entry.card,
            );
            const detail = `${entry.card ?? 'A public effect'} destroyed at least ${destroyed} permanents`;
            if (existing === undefined) {
              this.entries.push({ ...entry, kind: 'wipe', detail });
            } else {
              existing.detail = detail;
              existing.sourceEventSequence = entry.sourceEventSequence;
            }
          }
        }
      }
    }
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  snapshot(): PublicMemorySnapshot {
    return {
      version: 'public-memory-v1',
      throughEventSequence: this.throughSequence,
      entries: this.entries.map((entry) => ({ ...entry })),
    };
  }
}
