/**
 * Commander banned-list parsing (brief §3, §8.3). The authoritative source is
 * `docs/rules/commander-banned-list.md`, where each individually banned card is an `#### Name`
 * heading. We parse those headings into a normalized lookup set. Category bans (ante,
 * Conspiracy type, "removed from constructed") are handled separately via card data, since they
 * aren't enumerable from the markdown alone — see `validate.ts`.
 */

import { strictKey } from '../cards/normalize';

export interface BannedList {
  /** True if a card name (any apostrophe/case variant) is individually banned. */
  isBanned(name: string): boolean;
  /** The banned names as written in the source, for display/tests. */
  readonly names: string[];
}

/** Build a banned list from the markdown body of `commander-banned-list.md`. */
export function parseBannedList(markdown: string): BannedList {
  const names: string[] = [];
  const keys = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^####\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const name = match[1]?.trim();
    if (!name) continue;
    names.push(name);
    keys.add(strictKey(name));
  }
  return {
    names,
    isBanned: (name: string) => keys.has(strictKey(name)),
  };
}

/** A banned list from names already parsed elsewhere (a table worker gets them from its host). */
export function bannedListFromNames(names: readonly string[]): BannedList {
  const keys = new Set(names.map((name) => strictKey(name)));
  return { names: [...names], isBanned: (name: string) => keys.has(strictKey(name)) };
}
