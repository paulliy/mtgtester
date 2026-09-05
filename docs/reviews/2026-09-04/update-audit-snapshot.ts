import { readFileSync, writeFileSync } from 'node:fs';
import { overrideSnapshot } from '../../../packages/engine/src/cards/overrides/snapshot';
const path = 'packages/engine/tests/fixtures/override-defs.json';
const before = readFileSync(path, 'utf8');
writeFileSync('docs/reviews/2026-09-04/override-defs-before-audit-fixes.json', before);
const prior = JSON.parse(before) as { oracleId: string; name: string }[];
const current = JSON.parse(overrideSnapshot()) as typeof prior;
const names = new Set(['Pearl-Ear, Imperial Advisor', 'Killian, Decisive Mentor', "Sage's Reverie", 'Sage’s Reverie', 'Spirit Mantle', 'Scriv, the Obligator', "Songbirds' Blessing", 'Songbirds’ Blessing', 'Promise of Loyalty', 'Sram, Senior Edificer']);
const byId = new Map(current.map(entry => [entry.oracleId, entry]));
let changed = 0;
const next = prior.map(entry => {
  const updated = byId.get(entry.oracleId);
  if (updated && names.has(updated.name)) { changed++; return updated; }
  return entry;
});
writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
console.log(`Updated only ${changed} audited registrations; unrelated baseline entries preserved.`);
