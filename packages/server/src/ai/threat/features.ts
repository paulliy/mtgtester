import type { PlayerView, PermanentView, OpponentView } from '@mtg/shared';
import type { Dimension, Feature, Pressure, Status } from './types';
import { recentPressure } from './history';

export const clamp = (value: number): number => Math.min(1, Math.max(0, value));
export function feature(
  view: PlayerView,
  value: number | null,
  status: Status,
  reason: string,
  sources: string[] = [],
  range?: [number, number],
): Feature {
  return {
    value,
    status,
    reason,
    sources,
    sequence: view.threatFacts?.sequence ?? null,
    range: range ?? (value === null ? [0, 1] : [value, value]),
  };
}
const power = (p: PermanentView): number =>
  Math.max(0, p.power ?? 0) * (p.keywords?.includes('double strike') ? 2 : 1);
const creature = (p: PermanentView): boolean => p.capabilities?.creature ?? p.power != null;

/** Estimate one alternative attack, never add alternative defenders together. No legality claim. */
export function pressureMatrix(view: PlayerView): Pressure[] {
  const seats = [view.seat, ...view.opponents.map((o) => o.seat)];
  return seats.flatMap((actor) =>
    seats
      .filter((s) => s !== actor)
      .map((recipient) => {
        const declared = view.battlefield.some(
          (p) => p.controller === actor && p.capabilities?.attacking != null,
        );
        const attackers = view.battlefield.filter(
          (p) =>
            p.controller === actor &&
            creature(p) &&
            (declared
              ? p.capabilities?.attacking === recipient
              : !p.tapped &&
                !p.keywords?.includes('defender') &&
                (!p.status.includes('summoningSick') || p.keywords?.includes('haste'))),
        );
        const blockers = view.battlefield.filter(
          (p) =>
            p.controller === recipient && creature(p) && !p.tapped && !p.capabilities?.cantBlock,
        );
        // A greedy one-blocker screen is a heuristic, not a search proof. Evasion uses computed keywords.
        const available = [...blockers];
        let damage = 0;
        for (const attacker of [...attackers].sort((a, b) => power(b) - power(a))) {
          const i = attacker.capabilities?.cantBeBlocked
            ? -1
            : available.findIndex(
                (b) =>
                  !attacker.keywords?.includes('flying') ||
                  b.keywords?.includes('flying') ||
                  b.keywords?.includes('reach'),
              );
          if (i < 0) damage += power(attacker);
          else {
            const blocker = available.splice(i, 1)[0]!;
            if (attacker.keywords?.includes('trample'))
              damage += Math.max(0, power(attacker) - Math.max(1, blocker.toughness ?? 1));
          }
        }
        return {
          actor,
          recipient,
          damage,
          upperDamage: attackers.reduce((n, p) => n + power(p), 0),
          nextCombatUpperDamage: view.battlefield
            .filter(
              (p) => p.controller === actor && creature(p) && !p.keywords?.includes('defender'),
            )
            .reduce((n, p) => n + power(p), 0),
          historical: recentPressure(
            view.threatFacts?.pressure ?? [],
            actor,
            recipient,
            view.threatFacts?.turn ?? 0,
            seats.length,
          ),
          sources: attackers.map((p) => p.id),
          status: 'estimated' as const,
          assumptions: [
            'Alternative single-defender attack; not simultaneous attacks against every seat.',
            'Greedy blocks; taxes, restrictions, prevention, tricks, infect and full combat search unsupported.',
            'Next-combat upper bound assumes an untap and surviving board, ignores blockers and expiring effects; not current response capacity.',
            declared
              ? 'Only declared attack direction included; block responses remain estimated.'
              : 'Current estimate uses readiness now; next-combat field is a separate upper bound.',
          ],
        };
      }),
  );
}

export function extractFeatures(
  view: PlayerView,
  opponent: OpponentView,
  pressure: Pressure[],
): Record<Dimension, Feature> {
  const board = view.battlefield.filter((p) => p.controller === opponent.seat);
  const manaSources = board
    .filter((p) => p.capabilities?.mana.some((a) => a.available && !a.restricted))
    .map((p) => p.id);
  const missing = board.some((p) => p.capabilities === undefined);
  const engines = board.flatMap((p) =>
    (p.capabilities?.engines ?? []).map((e) => ({ ...e, source: p.id })),
  );
  const engineOutput = engines.reduce((n, e) => n + e.amount * (e.kind === 'draw' ? 2 : 1), 0);
  const combat = Math.max(
    0,
    ...pressure.filter((p) => p.actor === opponent.seat).map((p) => p.damage),
  );
  // Each permanent contributes its best mutually exclusive option ONCE, including rainbow units.
  const mana = board.reduce(
    (sum, p) =>
      sum +
      Math.max(
        0,
        ...(p.capabilities?.mana ?? [])
          .filter((a) => a.available && !a.restricted)
          .map((a) => a.units.length),
      ),
    0,
  );
  const protectedSources = board.filter((p) =>
    p.keywords?.some((k) => ['hexproof', 'indestructible'].includes(k)),
  );
  const incomplete = board.some(
    (p) => p.capabilities === undefined || p.capabilities.unsupported.length > 0,
  );
  return {
    W: feature(
      view,
      null,
      'unsupported',
      'Visible combo and alternative-win search not implemented.',
    ),
    E: feature(
      view,
      missing ? null : clamp(engineOutput / 12),
      missing ? 'unknown' : 'estimated',
      `${engineOutput} weighted periodic output per controller turn.`,
      engines.map((e) => e.source),
      [missing ? 0 : clamp(engineOutput / 12), 1],
    ),
    C: feature(
      view,
      clamp(combat / 40),
      'estimated',
      `${combat} estimated damage in the strongest alternative attack.`,
      pressure.filter((p) => p.actor === opponent.seat).flatMap((p) => p.sources),
      [
        0,
        clamp(
          Math.max(
            0,
            ...pressure.filter((p) => p.actor === opponent.seat).map((p) => p.upperDamage),
          ) / 40,
        ),
      ],
    ),
    M: feature(
      view,
      missing ? null : clamp(mana / 12),
      missing ? 'unknown' : 'estimated',
      `${mana} unconditional unrestricted tap-source mana; colors are alternatives, not extra units.`,
      manaSources,
      [missing ? 0 : clamp(mana / 12), incomplete ? 1 : clamp(mana / 12)],
    ),
    H: feature(
      view,
      clamp(Math.log2(1 + Math.max(0, opponent.handSize)) / 4),
      'estimated',
      `${opponent.handSize} unknown cards; no confirmed interaction or combo.`,
      [],
      [0, 1],
    ),
    R: feature(
      view,
      clamp(protectedSources.length / 4),
      'estimated',
      `${protectedSources.length} protected sources; recovery and protection costs not searched.`,
      protectedSources.map((p) => p.id),
      [0, 1],
    ),
    D: feature(
      view,
      null,
      'unknown',
      'Plan-specific usable interaction not established; open mana is not removal.',
    ),
    L: feature(
      view,
      clamp(Math.max(0, opponent.life) / 40),
      'estimated',
      'Saturated life buffer, not a win condition.',
      [],
      [0, clamp(Math.max(0, opponent.life) / 40)],
    ),
  };
}
