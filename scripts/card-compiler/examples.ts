/**
 * Worked examples for the compiler prompt: modeled cards whose rules text is closest to the line
 * being compiled, each shown as Oracle text beside the behavior the engine actually runs for it.
 * The bank is every modeled card in the pinned pool (parser output plus authored overrides), so
 * it grows on its own as coverage grows.
 */
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import { behaviorOf, pinnedPool } from './lib';

export interface Example {
  name: string;
  typeLine: string;
  oracleText: string;
  behavior: Record<string, unknown>;
  size: number;
  vector: Map<string, number>;
}

function normalize(text: string, name: string): string {
  let out = text.toLowerCase();
  for (const part of [name, ...name.split(/ \/\/ |, /)])
    if (part.length > 2) out = out.split(part.toLowerCase()).join('~');
  return out
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\{[0-9x]+\}/g, '{n}')
    .replace(/\b(one|two|three|four|five|six|seven|\d+)\b/g, 'n')
    .replace(/[^a-z~{}/+\-\s]/g, ' ');
}

function tokens(text: string): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const out = [...words];
  for (let index = 0; index + 1 < words.length; index++)
    out.push(`${words[index]} ${words[index + 1]}`);
  return out;
}

let bank: Example[] | undefined;
let documentFrequency: Map<string, number> | undefined;

function vectorize(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  const total = bank?.length ?? 1;
  let norm = 0;
  for (const [token, count] of counts) {
    const idf = Math.log((total + 1) / ((documentFrequency?.get(token) ?? 0) + 1)) + 1;
    const weight = count * idf;
    counts.set(token, weight);
    norm += weight * weight;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [token, weight] of counts) counts.set(token, weight / norm);
  return counts;
}

export function exampleBank(): Example[] {
  if (bank !== undefined) return bank;
  const raw: Omit<Example, 'vector'>[] = [];
  for (const { card } of pinnedPool()) {
    if (card.isBasicLand || (card.oracleText ?? '').length === 0) continue;
    const definition = interpretCard(card);
    if (!definition.modeled) continue;
    const behavior = behaviorOf(definition);
    const size = JSON.stringify(behavior).length;
    // Very large definitions crowd the prompt and teach little; skip them as examples.
    if (size > 6_000 || Object.keys(behavior).length === 0) continue;
    raw.push({
      name: card.name,
      typeLine: card.typeLine,
      oracleText: card.oracleText ?? '',
      behavior,
      size,
    });
  }
  documentFrequency = new Map();
  const texts = raw.map((example) => normalize(example.oracleText, example.name));
  for (const text of texts)
    for (const token of new Set(tokens(text)))
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  bank = raw.map((example) => ({ ...example, vector: new Map() }));
  bank.forEach((example, index) => (example.vector = vectorize(texts[index]!)));
  return bank;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let sum = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [token, weight] of small) sum += weight * (large.get(token) ?? 0);
  return sum;
}

/** The `count` modeled cards most similar to `lines`, excluding `exclude`, within a size budget. */
export function nearestExamples(
  lines: string[],
  cardName: string,
  options: { count?: number; budgetChars?: number; exclude?: string } = {},
): Example[] {
  const all = exampleBank();
  const query = vectorize(normalize(lines.join(' '), cardName));
  const scored = all
    .filter((example) => example.name !== (options.exclude ?? cardName))
    .map((example) => ({ example, score: cosine(query, example.vector) }))
    .sort((a, b) => b.score - a.score);
  const picked: Example[] = [];
  let used = 0;
  for (const { example } of scored) {
    if (picked.length >= (options.count ?? 6)) break;
    if (used + example.size > (options.budgetChars ?? 14_000)) continue;
    picked.push(example);
    used += example.size;
  }
  return picked;
}
