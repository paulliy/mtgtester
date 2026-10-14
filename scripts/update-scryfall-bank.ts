import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const BANK_PATH = 'data/scryfall-oracle-cards.json';
const TEMP_PATH = `${BANK_PATH}.tmp`;
const USER_AGENT = 'mtg-commander-sim/0.1';

interface ScryfallBulkEntry {
  type: string;
  jsonl_download_uri?: string;
  updated_at?: string;
}

interface ScryfallBulkMetadata {
  data?: ScryfallBulkEntry[];
}

interface ScryfallCard {
  id: string;
  oracle_id?: string;
  updated_at?: string;
  [key: string]: unknown;
}

function decodeCards(compressed: ArrayBuffer): ScryfallCard[] {
  const text = gunzipSync(Buffer.from(compressed)).toString('utf8');
  const cards: ScryfallCard[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      cards.push(JSON.parse(line) as ScryfallCard);
    } catch (error) {
      throw new Error(`Invalid Scryfall JSONL at line ${index + 1}`, { cause: error });
    }
  }
  return cards;
}

async function main(): Promise<void> {
  const response = await fetch('https://api.scryfall.com/bulk-data', {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok) throw new Error(`Scryfall bulk metadata request failed: ${response.status}`);

  const metadata = (await response.json()) as ScryfallBulkMetadata;
  const bulk = metadata.data?.find((entry) => entry.type === 'oracle_cards');
  if (!bulk?.jsonl_download_uri) {
    throw new Error('Scryfall did not provide an oracle_cards JSONL download URL');
  }

  const download = await fetch(bulk.jsonl_download_uri, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!download.ok) throw new Error(`Scryfall bulk download failed: ${download.status}`);
  const remoteCards = decodeCards(await download.arrayBuffer());

  let existingCards: ScryfallCard[] = [];
  try {
    existingCards = JSON.parse(await readFile(BANK_PATH, 'utf8')) as ScryfallCard[];
    if (!Array.isArray(existingCards)) throw new Error(`${BANK_PATH} is not a JSON array`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    console.log('No existing card bank found; creating it from the current Scryfall snapshot.');
  }

  const previousByOracleId = new Map(
    existingCards
      .filter((card) => card.oracle_id)
      .map((card) => [card.oracle_id!, card]),
  );
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  const merged = remoteCards.map((remote) => {
    if (!remote.oracle_id) return remote;
    const previous = previousByOracleId.get(remote.oracle_id);
    if (!previous) {
      added += 1;
      return remote;
    }

    // Scryfall's updated_at is the fast path; compare full records when it is unavailable.
    if (
      previous.updated_at &&
      remote.updated_at &&
      previous.updated_at === remote.updated_at
    ) {
      unchanged += 1;
      return previous;
    }
    if (JSON.stringify(previous) === JSON.stringify(remote)) {
      unchanged += 1;
      return previous;
    }
    changed += 1;
    return remote;
  });

  await mkdir('data', { recursive: true });
  try {
    await writeFile(TEMP_PATH, `${JSON.stringify(merged)}\n`, 'utf8');
    // Verify the complete output before replacing the working bank.
    const verified = JSON.parse(await readFile(TEMP_PATH, 'utf8')) as unknown;
    if (!Array.isArray(verified) || verified.length !== remoteCards.length) {
      throw new Error('Generated card bank failed validation');
    }
    await rename(TEMP_PATH, BANK_PATH);
  } catch (error) {
    await rm(TEMP_PATH, { force: true });
    throw error;
  }

  console.log(
    `Updated ${BANK_PATH}: ${added} added, ${changed} changed, ${unchanged} unchanged, ` +
      `${Math.max(0, previousByOracleId.size - unchanged - changed)} removed from Scryfall snapshot ` +
      `(bulk updated ${bulk.updated_at ?? 'date unknown'}).`,
  );
}

await main();
