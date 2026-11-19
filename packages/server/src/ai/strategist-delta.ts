import type { BotSteering, PlayerView } from '@mtg/shared';

/**
 * Delta prompts for the bot-led strategist (hill-climb S6). The strategist has no memory between
 * calls, so "send only what changed" cannot mean dropping the board. It means: hand the strategist
 * its own last conclusions (intent and knobs), say what moved since, and stop re-sending what those
 * conclusions were already drawn from: the rules text of cards it was shown at its last plan.
 * Every delta-mode prompt, full or delta, also uses a compact layout (`compactStrategistPayload`)
 * that drops what the strategist cannot use at all.
 *
 * A seat gets a full prompt for its first plan and again after `refreshEvery` delta plans in a
 * row, so an omission can never compound for long. Model-led tactics are not touched.
 */

/** What a seat's last installed plan was drawn from. */
export interface StrategistDeltaBase {
  turn: number;
  intent: string;
  steering: BotSteering;
  /** Every card name the strategist was shown, in hand, on the battlefield or as a commander. */
  knownNames: string[];
  /** Life per seat. */
  life: Record<string, number>;
  /** Battlefield copies per `controller name`, so the delta can say what left. */
  permanents: Record<string, number>;
}

export interface StrategistDeltaInput {
  base: StrategistDeltaBase;
  /** What woke the strategist (`P2 life`, `reuse limit`, ...), from `tableChangeReasons`. */
  wake: readonly string[];
}

/**
 * Log kinds that carry no strategic information: turn structure and mana bookkeeping. The engine
 * keeps the last 15 visible events, and about two thirds of them are these.
 */
const LOG_NOISE: ReadonlySet<string> = new Set([
  'phaseBegin',
  'stepBegin',
  'untap',
  'turnBegin',
  'turnEnd',
  'tapForMana',
  'tap',
  'combatDamageStep',
  // Repeats the castSpell or triggerOnStack line before it; a counter has its own event.
  'resolved',
]);

/** Most names `leftBattlefield` lists; a board wipe is still clear from the first few. */
const LEFT_LIMIT = 20;

function permanentKey(controller: string, name: string): string {
  return `${controller} ${name}`;
}

/** The base a seat's next delta prompt is measured from, taken from the view its plan saw. */
export function deltaBaseFrom(
  view: PlayerView,
  turn: number,
  intent: string,
  steering: BotSteering,
): StrategistDeltaBase {
  const names = new Set<string>();
  for (const card of view.hand) names.add(card.name);
  for (const perm of view.battlefield) names.add(perm.name);
  for (const commander of view.commanders) names.add(commander.name);
  for (const opponent of view.opponents) {
    for (const commander of opponent.commanders) names.add(commander.name);
  }
  const permanents: Record<string, number> = {};
  for (const perm of view.battlefield) {
    const key = permanentKey(perm.controller, perm.name);
    permanents[key] = (permanents[key] ?? 0) + 1;
  }
  return {
    turn,
    intent,
    steering,
    knownNames: [...names].sort(),
    life: Object.fromEntries([
      [view.seat, view.life],
      ...view.opponents.map((o): [string, number] => [o.seat, o.life]),
    ]),
    permanents,
  };
}

type Entry = Record<string, unknown>;

const isRecord = (value: unknown): value is Entry =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A plain land row the grouped `lands` list can stand in for without losing anything. */
function plainLand(entry: Entry): boolean {
  const type = entry['type'];
  return (
    typeof type === 'string' &&
    type.includes('Land') &&
    !type.includes('Creature') &&
    entry['p'] === undefined &&
    entry['status'] === undefined &&
    entry['keywords'] === undefined
  );
}

const names = (zone: unknown): unknown =>
  Array.isArray(zone) ? zone.map((card) => (isRecord(card) ? card['name'] : card)) : zone;

/**
 * The compact observation every delta-mode prompt uses, full or delta. It drops only what the
 * strategist cannot use: object ids (its knobs name cards), `tapped: false`, one row per basic
 * land, one mana-source row per land, turn-structure log lines and the one-item action menu.
 * Nothing about the game state is lost, so a refresh prompt is as complete as today's.
 */
export function compactStrategistPayload(payload: Entry): Entry {
  const ctx = payload['ctx'];
  if (isRecord(ctx)) {
    // The request id and the fixed task line are bookkeeping; the strategist is always the
    // active seat, so `dp` repeats `ap`.
    delete ctx['reqId'];
    delete ctx['prompt'];
    if (ctx['dp'] === ctx['ap']) delete ctx['dp'];
  }
  const you = payload['you'];
  if (isRecord(you)) {
    if (Array.isArray(you['hand'])) {
      for (const card of you['hand']) if (isRecord(card)) delete card['id'];
    }
    if (you['graveyard'] !== undefined) you['graveyard'] = names(you['graveyard']);
    if (Array.isArray(you['manaSources'])) {
      const merged = new Map<string, Entry>();
      for (const source of you['manaSources']) {
        if (!isRecord(source)) continue;
        const key = JSON.stringify([source['name'], source['symbols']]);
        const row = merged.get(key);
        if (row === undefined) merged.set(key, { ...source });
        else row['count'] = Number(row['count'] ?? 1) + Number(source['count'] ?? 1);
      }
      you['manaSources'] = [...merged.values()];
    }
  }
  if (Array.isArray(payload['opponents'])) {
    for (const opponent of payload['opponents']) {
      if (isRecord(opponent) && opponent['graveyard'] !== undefined) {
        opponent['graveyard'] = names(opponent['graveyard']);
      }
    }
  }
  if (payload['publicExile'] !== undefined) payload['publicExile'] = names(payload['publicExile']);

  if (Array.isArray(payload['battlefield'])) {
    const rows: Record<string, Entry[]> = {};
    const lands: Record<string, Record<string, number>> = {};
    const untapped: Record<string, Record<string, number>> = {};
    const landText: Record<string, unknown> = {};
    for (const perm of payload['battlefield']) {
      if (!isRecord(perm)) continue;
      const controller = String(perm['controller']);
      if (!plainLand(perm)) {
        const { id: _id, controller: _controller, tapped, ...rest } = perm;
        (rows[controller] ??= []).push(tapped === true ? { ...rest, tapped: true } : rest);
        continue;
      }
      const name = String(perm['name']);
      const counts = (lands[controller] ??= {});
      counts[name] = (counts[name] ?? 0) + 1;
      // Per name, not per player: a tapped Island and an untapped Forest are not the same table as
      // the reverse, since opponents' colors and utility lands matter for threats and held mana.
      if (perm['tapped'] !== true) {
        const open = (untapped[controller] ??= {});
        open[name] = (open[name] ?? 0) + 1;
      }
      if (perm['text'] !== undefined) landText[name] ??= perm['text'];
    }
    payload['battlefield'] = rows;
    payload['lands'] = lands;
    payload['untappedLands'] = untapped;
    if (Object.keys(landText).length > 0) payload['landText'] = landText;
  }

  if (Array.isArray(payload['recentLog'])) {
    payload['recentLog'] = payload['recentLog'].filter(
      (line) => typeof line !== 'string' || !LOG_NOISE.has(line.split(' ')[2] ?? ''),
    );
  }

  // One fixed item ("Return the turn strategy"); the primer already says to answer actionId 0.
  delete payload['legalActions'];
  return payload;
}

/**
 * Rewrite a compacted bot-led strategist payload into its delta form against the seat's last
 * plan: rules text only for cards new since then, decisions only from that turn on, and a
 * `sinceYourLastPlan` block with the old intent and knobs and what moved. Mutates `payload`.
 */
export function applyStrategistDelta(
  payload: Entry,
  view: PlayerView,
  delta: StrategistDeltaInput,
): Entry {
  const { base } = delta;
  const known = new Set(base.knownNames);
  const dropKnownText = (entry: unknown): void => {
    if (isRecord(entry) && typeof entry['name'] === 'string' && known.has(entry['name'])) {
      delete entry['text'];
    }
  };

  const dropKnownCommanderText = (commanders: unknown): void => {
    if (!Array.isArray(commanders)) return;
    for (const commander of commanders) {
      if (isRecord(commander) && known.has(String(commander['name']))) {
        delete commander['oracleText'];
      }
    }
  };

  const you = payload['you'];
  if (isRecord(you)) {
    if (Array.isArray(you['hand'])) you['hand'].forEach(dropKnownText);
    dropKnownCommanderText(you['commanders']);
  }
  if (Array.isArray(payload['opponents'])) {
    for (const opponent of payload['opponents']) {
      if (isRecord(opponent)) dropKnownCommanderText(opponent['commanders']);
    }
  }
  const battlefield = payload['battlefield'];
  if (isRecord(battlefield)) {
    for (const rows of Object.values(battlefield))
      if (Array.isArray(rows)) rows.forEach(dropKnownText);
  }
  const landText = payload['landText'];
  if (isRecord(landText)) {
    for (const name of Object.keys(landText)) if (known.has(name)) delete landText[name];
    if (Object.keys(landText).length === 0) delete payload['landText'];
  }

  if (Array.isArray(payload['yourRecentDecisions'])) {
    payload['yourRecentDecisions'] = payload['yourRecentDecisions'].filter(
      (decision) => !isRecord(decision) || (decision['turn'] as number) >= base.turn,
    );
  }

  const seats: Array<[string, number]> = [
    [view.seat, view.life],
    ...view.opponents.map((o): [string, number] => [o.seat, o.life]),
  ];
  const present = new Set(seats.map(([seat]) => seat));
  const now: Record<string, number> = {};
  for (const perm of view.battlefield) {
    const key = permanentKey(perm.controller, perm.name);
    now[key] = (now[key] ?? 0) + 1;
  }
  const left: string[] = [];
  for (const [key, was] of Object.entries(base.permanents)) {
    const space = key.indexOf(' ');
    const controller = key.slice(0, space);
    // A player who left the game took their board along; `tableChanges` already says so.
    if (!present.has(controller)) continue;
    const gone = was - (now[key] ?? 0);
    if (gone <= 0) continue;
    const label = `${key.slice(space + 1)} (${controller})`;
    left.push(gone === 1 ? label : `${label} x${gone}`);
  }
  const life: Record<string, number> = {};
  for (const [seat, value] of seats) {
    const was = base.life[seat];
    if (was !== undefined && was !== value) life[seat] = value - was;
  }

  payload['sinceYourLastPlan'] = {
    turn: base.turn,
    intent: base.intent,
    steering: base.steering,
    ...(delta.wake.length > 0 ? { tableChanges: [...delta.wake] } : {}),
    ...(Object.keys(life).length > 0 ? { lifeChanges: life } : {}),
    ...(left.length > 0
      ? {
          leftBattlefield:
            left.length > LEFT_LIMIT
              ? [...left.slice(0, LEFT_LIMIT), `and ${left.length - LEFT_LIMIT} more`]
              : left,
        }
      : {}),
  };
  return payload;
}

/** Appended to the bot-led strategist primer when delta prompts are on. */
export const STRATEGIST_DELTA_PRIMER_TEXT = `

When the observation has sinceYourLastPlan, you have planned this seat before: it holds your last
intent and knobs, set on that turn, and what changed since. Rules text is left out for cards you
were shown then (judge them by name and your earlier plan); cards new since then carry their text.
battlefield lists nonland permanents by controller (untapped unless marked tapped); lands counts
each player's lands by name, untappedLands counts the untapped ones by name, and landText holds rules
text for lands that have any. Keep knobs that still fit; change what
the new state calls for.`;
