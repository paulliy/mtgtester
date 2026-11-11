/** XMage checkout indexes and Oracle-line matching shared by the pilot and the agreement check. */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractCard, type XAbility, type XField } from './extract';

export function loadXmageCommit(xmage: string): string {
  return execFileSync('git', ['-C', xmage, 'rev-parse', '--short=8', 'HEAD']).toString().trim();
}

export interface XmageIndex {
  /** Card name → `<letter>/<ClassName>` under Mage.Sets/src/mage/cards. */
  lookup: (name: string) => string | undefined;
  subtypes: Record<string, string>;
  staticFilters: Record<string, XField>;
  tokenSource: (cls: string) => string | undefined;
  cardSource: (cls: string) => string | undefined;
}

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

export function loadXmage(xmage: string): XmageIndex {
  const read = (...p: string[]) => readFileSync(join(xmage, ...p), 'utf8');
  const setDir = join(xmage, 'Mage.Sets/src/mage/sets');
  const classByName = new Map<string, string>();
  const SET_CARD = /SetCardInfo\("((?:[^"\\]|\\.)*)",.*?mage\.cards\.(\w)\.(\w+)\.class/g;
  for (const f of readdirSync(setDir)) {
    for (const m of readFileSync(join(setDir, f), 'utf8').matchAll(SET_CARD)) {
      const name = m[1]!.replace(/\\"/g, '"');
      if (!classByName.has(name)) classByName.set(name, `${m[2]}/${m[3]}`);
    }
  }
  const classByFolded = new Map([...classByName].map(([k, v]) => [fold(k), v]));
  const lookup = (name: string) =>
    classByName.get(name) ??
    classByFolded.get(fold(name)) ??
    classByFolded.get(fold(name.split(' // ')[0]!));

  const subtypes: Record<string, string> = {};
  for (const m of read('Mage/src/main/java/mage/constants/SubType.java').matchAll(
    /^\s{4}([A-Z0-9_]+)\("([^"]+)"/gm,
  ))
    subtypes[m[1]!] = m[2]!;
  const staticFilters = extractCard(
    read('Mage/src/main/java/mage/filter/StaticFilters.java'),
  ).fields;

  const optional = (p: string) => (existsSync(join(xmage, p)) ? read(p) : undefined);
  return {
    lookup,
    subtypes,
    staticFilters,
    tokenSource: (cls) => optional(`Mage/src/main/java/mage/game/permanent/token/${cls}.java`),
    cardSource: (cls) => optional(`Mage.Sets/src/mage/cards/${cls}.java`),
  };
}

/** Oracle line or XMage comment as a set of comparable words. */
function lineWords(text: string, name: string): Set<string> {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let t = text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&mdash;|--/g, '—');
  t = t.replace(new RegExp(esc(name), 'g'), '~');
  const first = name.split(',')[0]!;
  if (first !== name) t = t.replace(new RegExp(esc(first), 'g'), '~');
  t = t
    .replace(
      /\bthis (creature|artifact|enchantment|land|permanent|equipment|aura|spacecraft|vehicle|card|spell)\b/gi,
      '~',
    )
    .replace(/\{tap\}/gi, '{T}')
    .replace(/enters the battlefield under your control/gi, 'you control enters')
    .replace(/enters? the battlefield/gi, 'enters')
    .replace(/converted mana cost/gi, 'mana value')
    .toLowerCase();
  return new Set(t.split(/[^a-z0-9{}~+/-]+/).filter(Boolean));
}

function similarity(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

/** The single XMage ability whose comment is clearly the Oracle line, or null. */
export function matchAbility(abilities: XAbility[], line: string, name: string): XAbility | null {
  const target = lineWords(line, name);
  const scored = abilities
    .filter((a) => a.comment)
    .map((a) => ({ a, s: similarity(target, lineWords(a.comment, name)) }))
    .sort((x, y) => y.s - x.s);
  const best = scored[0];
  if (!best || best.s < 0.6) return null;
  if (scored[1] && best.s - scored[1].s < 0.15) return null;
  // The comment must not describe much more than the line: a spell's comment often covers
  // several Oracle lines ("Scry 1. Draw a card."), and translating it for one line would add
  // the others' effects twice.
  const words = lineWords(best.a.comment, name);
  let extra = 0;
  for (const w of words) if (!target.has(w)) extra++;
  if (extra / words.size > 0.25) return null;
  return best.a;
}
