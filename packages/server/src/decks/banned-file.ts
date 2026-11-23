/** Load the banned list from `docs/rules/commander-banned-list.md` on disk. */

import { readFileSync } from 'node:fs';
import { parseBannedList, type BannedList } from './banned';

/** Read and parse the banned-list markdown at `path`. */
export function loadBannedList(path: string): BannedList {
  return parseBannedList(readFileSync(path, 'utf8'));
}
