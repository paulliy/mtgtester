/**
 * Freeze EDHREC's popularity ranking and the 200-card staple list taken from it.
 *
 *   bun run edhrec:fetch                 # fetch, then write both files
 *   bun run edhrec:fetch --share 0.99    # keep the cards filling 99% of slots instead of 95%
 *   bun run edhrec:fetch --average-decks 200
 *                                        # only: the top 200 commanders' average decks, for
 *                                        # bun run deck-coverage (then run deck-coverage --pin)
 *
 * Reads EDHREC's "Top Cards (past 2 years)" and "Top Lands" JSON pages one at a time, with a pause
 * between requests, and writes:
 *
 * - `packages/server/fixtures/edhrec-ranking.json`: every card inside the slot share, ranked.
 * - `packages/server/fixtures/edh-staples-200.txt`: the 200 most-included nonland cards, which is
 *   EDHREC's own top-cards ranking. `bun run staples` measures them.
 *
 * This is the only coverage command that uses the network. After a fetch, pin any new staple in
 * the Oracle fixture and the coverage contract (see docs/plans/edh-staple-coverage.md), then run
 * `bun run edhrec:ready-list`.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AVERAGE_DECKS_PATH,
  parseAverageDeckPage,
  renderAverageDecks,
  type AverageDeck,
  type EdhrecAverageDeckPage,
  type EdhrecCommanderView,
} from '../cards/edhrec-average-decks';
import {
  cutAtSlotShare,
  DEFAULT_SLOT_SHARE,
  rankEdhrecCards,
  topNonlandNames,
  type EdhrecCardView,
  type EdhrecRanking,
} from '../cards/edhrec-ranking';

const BASE = 'https://json.edhrec.com/pages/';
const NONLAND_FIRST = 'top/year.json';
const LANDS_FIRST = 'top/lands.json';
const RANKING_PATH = 'packages/server/fixtures/edhrec-ranking.json';
const STAPLES_PATH = 'packages/server/fixtures/edh-staples-200.txt';
const STAPLE_COUNT = 200;
const PAUSE_MS = 250;
const USER_AGENT = 'mtg-commander-sim/0.1';

interface EdhrecPage {
  cardviews?: EdhrecCardView[];
  more?: string;
  container?: { json_dict?: { cardlists?: { cardviews: EdhrecCardView[]; more?: string }[] } };
}

class NotFound extends Error {}

/** One page, retried with backoff on network errors and server errors; a 404 fails at once. */
async function getPage<Page = EdhrecPage>(path: string): Promise<Page> {
  for (let attempt = 1; ; attempt++) {
    let failure: string;
    try {
      const response = await fetch(BASE + path, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (response.ok) return (await response.json()) as Page;
      if (response.status === 404) throw new NotFound(`EDHREC ${path}: HTTP 404`);
      failure = `HTTP ${response.status}`;
    } catch (err) {
      if (err instanceof NotFound) throw err;
      failure = (err as Error).message;
    }
    if (attempt === 4) throw new Error(`EDHREC ${path}: ${failure}`);
    await Bun.sleep(2000 * 2 ** attempt);
  }
}

/** Follow one paginated list from its first page; the first page nests its list, later ones do not. */
async function readList(first: string): Promise<EdhrecCardView[]> {
  const page = await getPage(first);
  const lists = page.container?.json_dict?.cardlists;
  if (lists?.length !== 1) throw new Error(`EDHREC ${first}: expected one card list`);
  const views = [...lists[0]!.cardviews];
  let next = lists[0]!.more;
  while (next) {
    await Bun.sleep(PAUSE_MS);
    const more = await getPage(next);
    if (!more.cardviews) throw new Error(`EDHREC ${next}: no cardviews`);
    views.push(...more.cardviews);
    next = more.more;
    if (views.length % 5000 < 100) console.error(`  ${first}: ${views.length} cards …`);
  }
  return views;
}

function shareArg(): number {
  const slot = process.argv.indexOf('--share');
  if (slot < 0) return DEFAULT_SLOT_SHARE;
  const value = Number(process.argv[slot + 1]);
  if (!(value > 0 && value <= 1)) throw new Error('--share needs a number in (0, 1]');
  return value;
}

const COMMANDERS_FIRST = 'commanders/year.json';

interface CommanderPage {
  cardviews?: EdhrecCommanderView[];
  more?: string;
  container?: {
    json_dict?: { cardlists?: { cardviews: EdhrecCommanderView[]; more?: string }[] };
  };
}

/** The top `top` commanders of the past two years, in EDHREC's order. */
async function topCommanders(top: number): Promise<EdhrecCommanderView[]> {
  const first = await getPage<CommanderPage>(COMMANDERS_FIRST);
  const list = first.container?.json_dict?.cardlists?.[0];
  if (list === undefined) throw new Error(`EDHREC ${COMMANDERS_FIRST}: no commander list`);
  const views = [...list.cardviews];
  let next = list.more;
  while (views.length < top && next) {
    await Bun.sleep(PAUSE_MS);
    const more = await getPage<CommanderPage>(next);
    if (!more.cardviews) throw new Error(`EDHREC ${next}: no cardviews`);
    views.push(...more.cardviews);
    next = more.more;
  }
  return views.slice(0, top);
}

/**
 * Snapshot the average deck of each of the top `top` commanders. A commander whose page fails is
 * reported and skipped, so one odd page does not lose the whole run.
 */
async function fetchAverageDecks(top: number): Promise<void> {
  console.error(`Fetching the top ${top} EDHREC commanders …`);
  const commanders = await topCommanders(top);
  const decks: AverageDeck[] = [];
  for (const [position, view] of commanders.entries()) {
    await Bun.sleep(PAUSE_MS);
    try {
      const page = await getPage<EdhrecAverageDeckPage>(`average-decks/${view.sanitized}.json`);
      decks.push({
        rank: position + 1,
        slug: view.sanitized,
        decks: view.num_decks,
        ...parseAverageDeckPage(view.sanitized, page),
      });
    } catch (err) {
      console.error(`  ✗ ${view.name}: ${(err as Error).message}`);
    }
    if ((position + 1) % 25 === 0) console.error(`  ${position + 1}/${commanders.length} …`);
  }
  // Never overwrite a good snapshot with an empty one (a changed page shape fails every deck).
  if (decks.length === 0)
    throw new Error('no average deck could be read; the fixture is unchanged');
  writeFileSync(
    resolve(AVERAGE_DECKS_PATH),
    renderAverageDecks({
      source: `${BASE}average-decks/<slug>.json, top ${top} of ${BASE}${COMMANDERS_FIRST}`,
      fetchedAt: new Date().toISOString().slice(0, 10),
      decks,
    }),
  );
  console.log(`Wrote ${decks.length} average decks to ${AVERAGE_DECKS_PATH}.`);
  console.log('Next: bun run deck-coverage --pin, then bun run deck-coverage.');
}

function averageDecksArg(): number | undefined {
  const slot = process.argv.indexOf('--average-decks');
  if (slot < 0) return undefined;
  const value = Number(process.argv[slot + 1]);
  if (!(Number.isInteger(value) && value > 0)) throw new Error('--average-decks needs a count');
  return value;
}

async function main(): Promise<void> {
  const averageDecks = averageDecksArg();
  if (averageDecks !== undefined) {
    await fetchAverageDecks(averageDecks);
    return;
  }
  const share = shareArg();
  console.error('Fetching EDHREC top cards …');
  const nonland = await readList(NONLAND_FIRST);
  console.error('Fetching EDHREC top lands …');
  const lands = await readList(LANDS_FIRST);

  const totalDecks = Math.max(...[...nonland, ...lands].map((view) => view.potential_decks));
  const rows = rankEdhrecCards(nonland, lands);
  const { cards, totalSlots } = cutAtSlotShare(rows, share);
  const meta: Omit<EdhrecRanking, 'cards'> = {
    sources: [BASE + NONLAND_FIRST, BASE + LANDS_FIRST],
    fetchedAt: new Date().toISOString().slice(0, 10),
    totalDecks,
    totalSlots,
    rankedCards: rows.length,
    slotShare: share,
  };

  // One card per line, as Prettier prints it, keeps the diff of a refresh readable.
  const body = cards
    .map((row) => `    [${row.map((v) => JSON.stringify(v)).join(', ')}]`)
    .join(',\n');
  const head = JSON.stringify(meta, null, 2).replace(/\n}$/, ',\n  "cards": [\n');
  writeFileSync(resolve(RANKING_PATH), `${head}${body}\n  ]\n}\n`);
  writeFileSync(resolve(STAPLES_PATH), `${topNonlandNames(rows, STAPLE_COUNT).join('\n')}\n`);

  console.log(
    `${rows.length} ranked cards over ${totalDecks} decks; ${cards.length} fill ${(share * 100).toFixed(0)}% of slots.`,
  );
  console.log(`Wrote ${RANKING_PATH} and ${STAPLES_PATH}.`);
}

await main();
