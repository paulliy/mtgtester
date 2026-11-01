import type { NoopReason } from '../exits';

/**
 * The test-only diagnostics sink (ADR 0034 decision 4). `executeAbility` records each op it runs
 * and `noop` records a rules-sanctioned early exit, charged to the op running at the time. Fuzz
 * reads two things from it: the liveness report, the ops of each card that only ever exited
 * early, and how often each site exits for each reason. Production installs nothing: a game
 * without a sink records nothing and never builds a detail string.
 *
 * Tests pass a sink in `GameConfig.diagnostics`; tools call `installDefaultDiagnostics`, after
 * which every new game gets one. Speculative work records nothing: the payment probe's copies
 * carry no sink, the cast preview drops it, and a rolled-back cast truncates what it recorded.
 */
interface OpRun {
  kind: 'op';
  card: string;
  op: string;
  /** Set when a `noop` ran while this op did. */
  exitedEarly: boolean;
}

interface EarlyExit {
  kind: 'noop';
  card: string | null;
  op: string | null;
  site: string;
  reason: NoopReason;
  detail?: string;
}

export class DiagnosticsSink {
  readonly events: Array<OpRun | EarlyExit> = [];
  /** The op running now; `executeAbility` restores the outer one when an ability ends. */
  current: OpRun | null = null;

  enterOp(card: string, op: string): void {
    this.current = { kind: 'op', card, op, exitedEarly: false };
    this.events.push(this.current);
  }

  noop(site: string, reason: NoopReason, detail: string | undefined): void {
    if (this.current !== null) this.current.exitedEarly = true;
    this.events.push({
      kind: 'noop',
      card: this.current?.card ?? null,
      op: this.current?.op ?? null,
      site,
      reason,
      ...(detail !== undefined && { detail }),
    });
  }

  /** Where to truncate back to when speculative work is rolled back. */
  mark(): number {
    return this.events.length;
  }

  truncate(mark: number): void {
    this.events.length = mark;
  }

  /** Each card's ops by how often they ran and how often they exited early. */
  opRuns(): Array<{ card: string; op: string; runs: number; earlyExits: number }> {
    const runs = new Map<string, { card: string; op: string; runs: number; earlyExits: number }>();
    for (const event of this.events) {
      if (event.kind !== 'op') continue;
      const key = `${event.card}\u0000${event.op}`;
      const entry = runs.get(key) ?? { card: event.card, op: event.op, runs: 0, earlyExits: 0 };
      entry.runs++;
      if (event.exitedEarly) entry.earlyExits++;
      runs.set(key, entry);
    }
    return [...runs.values()];
  }

  /** How often each site exited for each reason. */
  exits(): Array<{ site: string; reason: NoopReason; count: number }> {
    const counts = new Map<string, { site: string; reason: NoopReason; count: number }>();
    for (const event of this.events) {
      if (event.kind !== 'noop') continue;
      const key = `${event.site}\u0000${event.reason}`;
      const entry = counts.get(key) ?? { site: event.site, reason: event.reason, count: 0 };
      entry.count++;
      counts.set(key, entry);
    }
    return [...counts.values()];
  }
}

let installed: DiagnosticsSink[] | null = null;

/**
 * Give every game created from now on its own sink, collected in the returned list, until
 * `restore` is called. Tools only (fuzz); production never calls it.
 */
export function installDefaultDiagnostics(): { sinks: DiagnosticsSink[]; restore: () => void } {
  const previous = installed;
  const sinks: DiagnosticsSink[] = [];
  installed = sinks;
  return {
    sinks,
    restore: () => {
      installed = previous;
    },
  };
}

/** A new sink for a game being created, when `installDefaultDiagnostics` is in effect. */
export function defaultDiagnostics(): DiagnosticsSink | undefined {
  if (installed === null) return undefined;
  const sink = new DiagnosticsSink();
  installed.push(sink);
  return sink;
}
