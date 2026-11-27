import { LOG_NOISE } from './strategist-delta';

/**
 * The compact tactician observation (hill-climb token idea 4). It rewrites only how the state is
 * written, never what it says: every permanent, object id, legal action and log event the model
 * could act on is still there.
 *
 * - `battlefield` becomes rows grouped by controller. `tapped` appears only when true, a basic
 *   land carries no type line (its name is its type), and identical permanents share one row
 *   whose `ids` lists each of them.
 * - `recentLog` drops the turn-structure and bookkeeping lines the strategist's compact layout
 *   already drops (`LOG_NOISE`); `ctx` says where the game is.
 * - each legal action keeps `id`, `type`, `description`, `targets` and its data, minus the fields
 *   that repeat the description or only the UI reads. The object ids that tell two same-named
 *   options apart (`subjectId`, `subjectIds`, `sourceId`) move from `interaction` onto the action.
 * - opponents' graveyards become card names.
 *
 * Replaces the payload's sections with compact copies and returns `payload`; the objects those
 * sections held (the request's legal actions, the view's zones) are left as they were. Card summaries and the budgeter shape the payload differently,
 * so the caller applies this only without them.
 */

type Entry = Record<string, unknown>;

const isRecord = (value: unknown): value is Entry =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Data fields that repeat the description or name an id the model never sees elsewhere. */
const REDUNDANT_DATA_KEYS = [
  'sourceName',
  'sourceOracleId',
  'abilityDescription',
  'paymentSourceIds',
] as const;

/** The primer line that tells the model how a compact observation is written. */
export const COMPACT_OBSERVATION_PRIMER_TEXT = `\n\nCOMPACT STATE: battlefield lists permanents by controller seat; a row with "ids" stands for that many identical permanents; a permanent is untapped unless marked tapped; recentLog leaves out turn-structure and mana-tapping lines.`;

function compactBattlefield(battlefield: unknown[]): Record<string, Entry[]> {
  const rows: Record<string, Entry[]> = {};
  const byKey = new Map<string, Entry>();
  for (const perm of battlefield) {
    if (!isRecord(perm)) continue;
    const { id, controller, tapped, text, ...rest } = perm;
    if (typeof rest['type'] === 'string' && /^Basic\b/.test(rest['type'])) delete rest['type'];
    const row: Entry = tapped === true ? { ...rest, tapped: true } : rest;
    const seat = String(controller);
    // Rules text is sent once per name, on the first copy only, so it cannot tell copies apart.
    const key = JSON.stringify([seat, row]);
    const existing = byKey.get(key);
    if (existing !== undefined) {
      const ids = existing['ids'] as unknown[] | undefined;
      if (ids === undefined) {
        existing['ids'] = [existing['id'], id];
        delete existing['id'];
      } else ids.push(id);
      if (text !== undefined && existing['text'] === undefined) existing['text'] = text;
      continue;
    }
    const entry: Entry = { id, ...row, ...(text === undefined ? {} : { text }) };
    byKey.set(key, entry);
    (rows[seat] ??= []).push(entry);
  }
  return rows;
}

/**
 * A compact copy of one legal action. The payload holds the request's own action objects, which
 * the provider and the engine read after the prompt is built, so they are never modified.
 */
function compactAction(original: Entry): Entry {
  const { interaction, data, ...action } = original;
  if (isRecord(interaction)) {
    for (const key of ['subjectId', 'subjectIds', 'sourceId'] as const) {
      if (interaction[key] !== undefined) action[key] = interaction[key];
    }
    const slots = interaction['targetSlots'];
    if (slots !== undefined && JSON.stringify(slots) !== JSON.stringify(action['targets'])) {
      action['targets'] = slots;
    }
  } else if (interaction !== undefined) action['interaction'] = interaction;
  if (isRecord(data)) {
    const kept = Object.fromEntries(
      Object.entries(data).filter(
        ([key]) => !(REDUNDANT_DATA_KEYS as readonly string[]).includes(key),
      ),
    );
    if (Object.keys(kept).length > 0) action['data'] = kept;
  } else if (data !== undefined) action['data'] = data;
  return action;
}

export function compactTacticianPayload<T extends Entry>(payload: T): T {
  const record = payload as Entry;
  if (Array.isArray(record['battlefield'])) {
    record['battlefield'] = compactBattlefield(record['battlefield']);
  }
  if (Array.isArray(record['recentLog'])) {
    record['recentLog'] = record['recentLog'].filter(
      (line) => typeof line !== 'string' || !LOG_NOISE.has(line.split(' ')[2] ?? ''),
    );
  }
  if (Array.isArray(record['legalActions'])) {
    record['legalActions'] = record['legalActions'].map((action) =>
      isRecord(action) ? compactAction(action) : action,
    );
  }
  if (Array.isArray(record['opponents'])) {
    for (const opponent of record['opponents']) {
      if (!isRecord(opponent) || !Array.isArray(opponent['graveyard'])) continue;
      opponent['graveyard'] = opponent['graveyard'].map((card) =>
        isRecord(card) ? card['name'] : card,
      );
    }
  }
  return payload;
}
