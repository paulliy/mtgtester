/**
 * The card bank benchmark positions draw from: the two Oracle fixtures the repo already pins
 * (`coverage-oracle.json`, then `edhrec-pinned-oracle.json`). A position may only name a card the
 * engine models, so a case never runs on an approximated card.
 */
import { readFileSync } from 'node:fs';
import { interpretCard } from '../../packages/engine/src';
import type { OracleCard } from '../../packages/shared/src';

const FIXTURES = new URL('../../packages/server/fixtures/', import.meta.url);

let bank: Map<string, OracleCard> | null = null;
const modeled = new Map<string, boolean>();

function load(): Map<string, OracleCard> {
  if (bank !== null) return bank;
  const coverage = JSON.parse(
    readFileSync(new URL('coverage-oracle.json', FIXTURES), 'utf8'),
  ) as OracleCard[];
  const ranked = JSON.parse(
    readFileSync(new URL('edhrec-pinned-oracle.json', FIXTURES), 'utf8'),
  ) as Array<{ card: OracleCard }>;
  bank = new Map();
  // The coverage fixture wins a name both files hold: it is the one the coverage contract hashes.
  for (const { card } of ranked) bank.set(card.name, card);
  for (const card of coverage) bank.set(card.name, card);
  return bank;
}

/** A pinned, modeled card by exact name. Throws on a name the bank lacks or the engine cannot model. */
export function benchCard(name: string): OracleCard {
  const card = load().get(name);
  if (card === undefined)
    throw new Error(`"${name}" is not in the pinned Oracle fixtures (packages/server/fixtures)`);
  let ok = modeled.get(name);
  if (ok === undefined) {
    ok = interpretCard(card).modeled;
    modeled.set(name, ok);
  }
  if (!ok) throw new Error(`"${name}" is pinned but the engine does not model it`);
  return card;
}
