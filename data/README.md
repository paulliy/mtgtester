# data/

Gitignored working data (brief §3). Nothing in this directory is committed **except this
README** — see the `data/` rule in `.gitignore`.

## scryfall-oracle-cards.json

Scryfall **oracle-cards** bulk data — one Scryfall card object per Oracle ID (~200 MB).
This is the resolution source at deck-import time only: each imported deck's cards are
resolved against it once and persisted into a per-game SQLite card cache (brief §3, §8.2).
**Games read from the cache, never from this file.** It is far too large to load per game.

### Refresh

Scryfall no longer publishes a plain JSON array for bulk data. The `/bulk-data` entry carries
`jsonl_download_uri` (gzipped **JSONL**, one card per line). Refresh the local bank from the repo
root with:

```bash
bun run scryfall:update
```

The script fetches Scryfall's current full bulk snapshot, but merges entries by Oracle ID and
reuses the existing local record when `updated_at` is unchanged. It reports added, changed,
unchanged, and removed entries, validates a temporary output file, then swaps it into place. The
bank is one JSON array, so the output file is still rewritten as a whole. Scryfall does not provide
a change-only bulk feed, so its compressed snapshot must also be downloaded and compared each time.
The command is manual; it is not scheduled or run automatically.

`serve:table` reads `data/table-oracle-cards.json` instead when it exists: the same cards already
converted to engine form, about an eighth of the size. Rebuild it with `bun run table:cards` after
each refresh; the server warns when the bulk file is newer.

The current file was downloaded 2026-08-28 from `oracle-cards-20260828090156.jsonl.gz`
(38,626 cards, 202,879,599 bytes).

`bun run scryfall:update --from <file>.jsonl.gz` builds the bank from a snapshot already
downloaded. The nightly bulk-data job (`.github/workflows/bulk-nightly.yml`) does that with the
checksum-pinned file named by the repository variables `SCRYFALL_BULK_URL` and
`SCRYFALL_BULK_SHA256`, runs the suites that skip without the bank, and runs `bun run bulk-smoke`
against the baseline in `packages/server/fixtures/bulk-population.json`. After moving the pin,
build the bank from the new file and record its baseline with `bun run bulk-smoke --write`.

The baseline is recorded for this pin (2026-11-04). Set these repository variables (Settings,
Secrets and variables, Actions, Variables) for the job to run:

| Variable              | Value                                                                       |
| --------------------- | --------------------------------------------------------------------------- |
| `SCRYFALL_BULK_URL`   | `https://data.scryfall.io/oracle-cards/oracle-cards-20261103220204.jsonl.gz` |
| `SCRYFALL_BULK_SHA256` | `2a21d4d3b31e15b9947cea566eea6fa435bdeefb8e1b1f193f462f61e00fcc7d`          |

That file is 25,308,067 bytes and builds a bank of 39,287 cards whose SHA-256 is
`d6d36538bf62…` (the build is byte-for-byte reproducible). Against it `bulk-smoke` reads 35,460
cards, 7,987 modeled, none throwing and none invalid, and the six bulk-only suites pass 58 tests
with nothing skipped. Scryfall still served the 2026-08-28 snapshot two months later, so a pinned
URL lasts; if one is ever removed, the job's download fails and the pin moves.

### After a refresh

Newer oracle text can make a hand-authored override redundant: Scryfall rewrites older cards
into current templating, the generic parser then reads the line itself, and the override's
`handledLines` claim goes stale (`overrides/index.ts` reports it rather than silently
applying). Re-run `bun run coverage` and `bun run test` after refreshing — the 2026-08-28
refresh stranded five overrides this way (Saheeli, Reckless Fireweaver, Glen Elendra Archmage,
Coercive Impetus, Overflowing Basin). That report is the feature working, not a regression.
