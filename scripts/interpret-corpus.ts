/**
 * The one-line probe corpus and its outcome snapshot (ADR 0038 decision 5).
 *
 * Each row is a ready-list card reduced to the single rules line that blocks it, placed on a
 * synthetic card. `oneLineOutcomes` runs every row through the production `interpretCard` and
 * records, per row, whether the line is still blocked and a hash of the whole definition. A
 * parser refactor must leave the outcomes unchanged; a coverage change shows up as rows that
 * turned `modeled`, which is that change's measured yield.
 */

import { createHash } from 'node:crypto';
import type { OracleCard } from '../packages/shared/src';
import { interpretCard } from '../packages/engine/src/cards/interpret';
import { canonicalDefinition } from '../packages/engine/src/cards/interpret-snapshot';

export const ONE_LINE_CORPUS_PATH = 'packages/engine/tests/fixtures/one-line-corpus.json';
export const ONE_LINE_OUTCOMES_PATH = 'packages/engine/tests/fixtures/one-line-outcomes.tsv';

export interface OneLineCorpusRow {
  /** EDHREC rank in the frozen ranking. */
  rank: number;
  name: string;
  /** Guessed by `probeTypeLine`; the real type line is not committed. */
  typeLine: string;
  /** The blocking line as the ready list prints it, with the card's own name as `~`. */
  line: string;
}

/** A type line that puts `line` where the parser would meet it on a real card. */
export function probeTypeLine(line: string, kind: 'land' | 'nonland'): string {
  if (kind === 'land') return 'Land';
  const l = line.toLowerCase();
  if (/^equip\b|equipped creature/.test(l)) return 'Artifact — Equipment';
  if (/^enchanted |^enchant /.test(l)) return 'Enchantment — Aura';
  if (/this artifact/.test(l)) return 'Artifact';
  if (/this enchantment/.test(l)) return 'Enchantment';
  if (/this land/.test(l)) return 'Land';
  if (
    /^(when|whenever|at the beginning|as long as|[^:]*:)/.test(l) ||
    /\b(you control|creatures|spells you cast) .*(get|have|cost)/.test(l) ||
    /this creature|^~ /.test(l) ||
    /^[a-z]+( \d+| \{[^}]+\})*$/.test(l)
  ) {
    return 'Creature — Human';
  }
  return 'Sorcery';
}

const CARD_TYPES = ['Artifact', 'Creature', 'Enchantment', 'Land', 'Sorcery'];

/** The synthetic card for one corpus row. */
export function corpusCard(row: OneLineCorpusRow): OracleCard {
  const [left, right] = row.typeLine.split(' — ');
  const types = (left ?? '').split(' ').filter((word) => CARD_TYPES.includes(word));
  const isCreature = types.includes('Creature');
  const manaCost = types.includes('Land') ? null : isCreature ? '{2}{G}' : '{2}';
  const id = `corpus-${row.rank}`;
  return {
    oracleId: id as OracleCard['oracleId'],
    scryfallId: id,
    name: row.name,
    manaCost: manaCost as OracleCard['manaCost'],
    cmc: manaCost === null ? 0 : 3,
    colors: isCreature ? ['G'] : [],
    colorIdentity: isCreature ? ['G'] : [],
    typeLine: row.typeLine,
    supertypes: [],
    types: types as OracleCard['types'],
    subtypes: right === undefined ? [] : right.split(' '),
    oracleText: row.line.replace(/~/g, row.name),
    power: isCreature ? '2' : null,
    toughness: isCreature ? '2' : null,
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: false,
  };
}

/**
 * One TSV row per corpus row, in rank order: rank, outcome, definition hash. The outcome is
 * `blocked` when the only reason is the corpus line itself, `modeled` when there are no reasons,
 * and the reasons as JSON otherwise.
 */
export function oneLineOutcomes(rows: readonly OneLineCorpusRow[]): string {
  const out = ['rank\toutcome\tdefinition'];
  for (const row of [...rows].sort((a, b) => a.rank - b.rank)) {
    const def = interpretCard(corpusCard(row));
    const reasons = def.unmodeledReasons;
    const outcome =
      reasons.length === 0
        ? 'modeled'
        : reasons.length === 1 && reasons[0] === `unrecognized rules text: "${row.line}"`
          ? 'blocked'
          : JSON.stringify(reasons);
    const hash = createHash('sha256')
      .update(JSON.stringify(canonicalDefinition(def)))
      .digest('hex')
      .slice(0, 16);
    out.push(`${row.rank}\t${outcome}\t${hash}`);
  }
  return `${out.join('\n')}\n`;
}
