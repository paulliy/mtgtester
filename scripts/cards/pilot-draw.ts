/**
 * The phase 6 pilot draw (ADR 0033; card authoring plan, phase 6 step 1): 20 cards the engine does
 * not model, by one rule, split 10 and 10 between the new workflow and the current one.
 *
 * The rule, over the Scryfall bank: commander-legal cards with an EDHREC rank that no fixture or
 * pin already holds; not an adventure or omen card, because 46 of the 52 unmodeled pinned cards
 * wait on that one missing spell-face feature and the pilot would measure it instead of the
 * workflow; not modeled by the interpreter. The 20 with the best EDHREC rank are drawn, and each
 * arm is the 10 that sort first or last by the hash of the seed and the card's name.
 */
import { createHash } from 'node:crypto';
import type { OracleCard } from '../../packages/shared/src';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import { toOracleCard, type RawScryfallCard } from '../../packages/server/src/cards/scryfall';

export const PILOT_SEED = 'adr-0033-phase-6-pilot';
export const PILOT_SIZE = 20;
const SPELL_FACE_LAYOUTS = new Set(['adventure', 'omen']);

export type PilotArm = 'new' | 'current';

export interface PilotCard {
  name: string;
  edhrecRank: number;
  arm: PilotArm;
  /** Why the interpreter does not model it, as drawn. */
  reasons: string[];
}

export function drawPilot(
  bank: ReadonlyArray<RawScryfallCard & { edhrec_rank?: number }>,
  pinned: ReadonlySet<string>,
  seed = PILOT_SEED,
): PilotCard[] {
  const drawn: Array<Omit<PilotCard, 'arm'>> = [];
  const candidates = bank
    .filter(
      (raw) =>
        raw.legalities?.['commander'] === 'legal' &&
        typeof raw.edhrec_rank === 'number' &&
        !SPELL_FACE_LAYOUTS.has(raw.layout ?? 'normal') &&
        !pinned.has(raw.name),
    )
    .sort((a, b) => a.edhrec_rank! - b.edhrec_rank! || a.name.localeCompare(b.name));
  for (const raw of candidates) {
    if (drawn.length === PILOT_SIZE) break;
    const card: OracleCard | null = toOracleCard(raw);
    if (card === null || card.isBasicLand) continue;
    const definition = interpretCard(card);
    if (definition.modeled) continue;
    drawn.push({
      name: raw.name,
      edhrecRank: raw.edhrec_rank!,
      reasons: definition.unmodeledReasons,
    });
  }
  const order = (name: string) => createHash('sha256').update(`${seed}\u0000${name}`).digest('hex');
  const shuffled = [...drawn].sort((a, b) => order(a.name).localeCompare(order(b.name)));
  const arms = new Map(
    shuffled.map(
      (card, index) => [card.name, index < drawn.length / 2 ? 'new' : 'current'] as const,
    ),
  );
  return drawn.map((card) => ({ ...card, arm: arms.get(card.name)! }));
}
