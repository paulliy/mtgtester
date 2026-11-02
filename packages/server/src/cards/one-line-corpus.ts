/**
 * The one-line probe corpus (ADR 0038 decision 5): each EDHREC ready-list card reduced to the
 * single rules line that blocks it, placed on a synthetic card. Built offline from the committed
 * ready list by `scripts/one-line-corpus.ts`, because CI has no Scryfall bank; the snapshot nets
 * (`scripts/interpret-corpus.ts`) and `edhrec:triage` read it.
 */

import type { OracleCard } from '@mtg/shared';

export const ONE_LINE_CORPUS_PATH = 'packages/engine/tests/fixtures/one-line-corpus.json';

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
