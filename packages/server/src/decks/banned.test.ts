import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { parseBannedList, loadBannedList } from './banned';

describe('parseBannedList', () => {
  it('reads #### headings and matches regardless of apostrophe style', () => {
    const list = parseBannedList(
      `Intro text.\n\n#### Channel\nblah\n\n#### Yawgmoth’s Bargain\nblah`,
    );
    expect(list.names).toEqual(['Channel', 'Yawgmoth’s Bargain']);
    expect(list.isBanned('channel')).toBe(true);
    expect(list.isBanned("Yawgmoth's Bargain")).toBe(true); // straight apostrophe query
    expect(list.isBanned('Sol Ring')).toBe(false);
  });
});

describe('loadBannedList — real reference doc', () => {
  const list = loadBannedList(resolve('docs/rules/commander-banned-list.md'));

  it('parses the full individual ban list', () => {
    // 44 individually named cards on the mtgcommander.net list (Phase-0 snapshot).
    expect(list.names.length).toBeGreaterThanOrEqual(40);
  });

  it('includes well-known bans and excludes a staple', () => {
    expect(list.isBanned('Channel')).toBe(true);
    expect(list.isBanned("Emrakul, the Aeon's Torn")).toBe(true);
    expect(list.isBanned('Golos, Tireless Pilgrim')).toBe(true);
    expect(list.isBanned('Sol Ring')).toBe(false);
  });
});
