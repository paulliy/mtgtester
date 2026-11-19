/**
 * The soundness guard for the free text check: every single-step change to a settled patch that
 * still validates must stop it from settling. If the renderer ignored a field, or two different
 * IR shapes rendered to the same English, a wrong patch could settle with no model check and no
 * one would notice; this finds that by construction.
 *
 * Mutations, applied one at a time to a copy of the patch:
 * - a number: add one, and subtract one when above zero;
 * - a boolean: flip it;
 * - a string: swap it for each other value the same key takes anywhere in the corpus (the
 *   committed trial patches plus the modeled pool), so enum swaps stay plausible;
 * - an array element: drop it, and swap it with its neighbour;
 * - an object key: delete it;
 * - a missing key: add it, with each of a few values it takes on other nodes of the same shape
 *   (the same `op`, `kind`, `when` or `layer`) in the corpus, so a restriction the renderer would
 *   ignore (an `allowSelf`, a `condition`, a `duration`) is tried on every node that could hold it.
 *
 * `description` keys are skipped (free text the engine never reads). A mutant that the validator
 * rejects, or that interprets to the same card as the original, is not a wrong patch and is
 * skipped too: only valid patches that mean something else must fail to settle.
 */
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { validateCardDefinition } from '../../packages/engine/src/cards/authoring-validation';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import { applyPatch, behaviorOf, cardByName, pinnedPool, type CompileTarget } from './lib';
import { textCheck } from './render';
import type { TrialPatch } from './settle';

type Node = Record<string, unknown>;
type Path = (string | number)[];

export interface PatchMutant {
  label: string;
  def: Partial<CardDefinition>;
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SKIPPED_KEYS = new Set(['description']);

export interface Vocabulary {
  /** Every string value each key takes, for plausible enum swaps. */
  strings: Map<string, Set<string>>;
  /** For each node shape, each key some node of that shape has, with sample values (JSON). */
  keys: Map<string, Map<string, Set<string>>>;
}

/**
 * The shape a node's keys depend on: its `op`, `kind`, `when` or `layer`. The definition itself is
 * the `root` shape, so a patch also gets top-level keys other cards have, such as a scalar that
 * would replace the parsed card's value.
 */
function shapeOf(node: Node, root = false): string | null {
  if (root) return 'root';
  for (const key of ['op', 'kind', 'when', 'layer'])
    if (typeof node[key] === 'string' || typeof node[key] === 'number')
      return `${key}:${String(node[key])}`;
  return null;
}

const SAMPLES_PER_KEY = 3;

export function mutationVocabulary(defs: unknown[]): Vocabulary {
  const strings = new Map<string, Set<string>>();
  const keys = new Map<string, Map<string, Set<string>>>();
  const visit = (value: unknown, key: string | null, root = false): void => {
    if (Array.isArray(value)) for (const item of value) visit(item, key);
    else if (isNode(value)) {
      const shape = shapeOf(value, root);
      if (shape !== null) {
        if (!keys.has(shape)) keys.set(shape, new Map());
        const known = keys.get(shape)!;
        for (const [childKey, child] of Object.entries(value)) {
          if (SKIPPED_KEYS.has(childKey) || child === undefined) continue;
          if (!known.has(childKey)) known.set(childKey, new Set());
          const samples = known.get(childKey)!;
          if (samples.size < SAMPLES_PER_KEY) samples.add(JSON.stringify(child));
          // A flag is also tried with its other value: `false` on a patch can clear a parsed `true`.
          if (typeof child === 'boolean') samples.add(JSON.stringify(!child));
        }
      }
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    } else if (typeof value === 'string' && key !== null && !SKIPPED_KEYS.has(key)) {
      if (!strings.has(key)) strings.set(key, new Set());
      strings.get(key)!.add(value);
    }
  };
  for (const def of defs) visit(def, null, true);
  return { strings, keys };
}

function at(root: unknown, path: Path): unknown {
  let node = root;
  for (const step of path) node = (node as Record<string | number, unknown>)[step];
  return node;
}

const label = (path: Path): string =>
  path.map((step) => (typeof step === 'number' ? `[${step}]` : `.${step}`)).join('');

/** Every single-step mutant of `def`. `maxSwaps` limits how many swaps a string gets. */
export function patchMutants(
  def: Partial<CardDefinition>,
  vocabulary: Vocabulary,
  maxSwaps = 12,
): PatchMutant[] {
  const out: PatchMutant[] = [];
  const add = (path: Path, what: string, change: (parent: Node | unknown[]) => void): void => {
    const copy = structuredClone(def) as unknown;
    change(at(copy, path.slice(0, -1)) as Node | unknown[]);
    out.push({ label: `${label(path)}: ${what}`, def: copy as Partial<CardDefinition> });
  };
  const visit = (value: unknown, path: Path): void => {
    const key = path.at(-1);
    if (typeof key === 'string' && SKIPPED_KEYS.has(key)) return;
    if (typeof value === 'number' && path.length > 0) {
      add(path, `${value} + 1`, (parent) => {
        (parent as Node)[key as string] = value + 1;
      });
      if (value > 0)
        add(path, `${value} - 1`, (parent) => {
          (parent as Node)[key as string] = value - 1;
        });
    } else if (typeof value === 'boolean') {
      add(path, `flip ${value}`, (parent) => {
        (parent as Node)[key as string] = !value;
      });
    } else if (typeof value === 'string' && typeof key === 'string') {
      const others = [...(vocabulary.strings.get(key) ?? [])]
        .filter((other) => other !== value)
        .sort();
      for (const other of others.slice(0, maxSwaps))
        add(path, `"${value}" -> "${other}"`, (parent) => {
          (parent as Node)[key] = other;
        });
    } else if (Array.isArray(value)) {
      value.forEach((_, index) => {
        add([...path, index], 'drop', (parent) => {
          (parent as unknown[]).splice(index, 1);
        });
        if (index + 1 < value.length)
          add([...path, index], `swap with [${index + 1}]`, (parent) => {
            const list = parent as unknown[];
            [list[index], list[index + 1]] = [list[index + 1], list[index]];
          });
        visit(value[index], [...path, index]);
      });
    } else if (isNode(value)) {
      const shape = shapeOf(value, path.length === 0);
      for (const [childKey, samples] of shape === null ? [] : (vocabulary.keys.get(shape) ?? []))
        if (!(childKey in value))
          for (const sample of samples)
            add([...path, childKey], `add ${sample.slice(0, 60)}`, (parent) => {
              (parent as Node)[childKey] = JSON.parse(sample);
            });
      for (const [childKey, child] of Object.entries(value)) {
        if (SKIPPED_KEYS.has(childKey)) continue;
        add([...path, childKey], 'delete', (parent) => {
          delete (parent as Node)[childKey];
        });
        visit(child, [...path, childKey]);
      }
    }
  };
  visit(def, []);
  return out;
}

/** Lists whose order means nothing: selector parts, keywords, a card's abilities, mana units. */
const UNORDERED = new Set([
  'of',
  'keywords',
  'unit',
  'units',
  'triggers',
  'activatedAbilities',
  'manaAbilities',
  'staticEffects',
  'ruleStatics',
]);

/**
 * A definition with the differences that mean nothing removed, for telling a mutant that changed
 * the card from one that only restated it. Each rule names an equivalence the engine guarantees:
 * - `false` flags, empty lists and `timing: 'any'` are the defaults;
 * - a token's `typeLine` is display text derived from its types (`tokens.ts`);
 * - selector parts, keywords, a card's abilities and mana units are sets;
 * - a sacrifice cost only offers the controller's permanents and excludes the source unless
 *   `allowSelf` is set (`sacrificeCandidateAllowed`), so an `other` part restates that, and its
 *   count defaults to one;
 * - `countPermanents` with scope `you` counts only the controller's permanents, so a "you
 *   control" part of its selector restates the scope.
 */
export function canonicalDefinition(definition: unknown): string {
  const isPart = (part: unknown, kind: string, extra?: [string, unknown]): boolean =>
    isNode(part) && part['kind'] === kind && (extra === undefined || part[extra[0]] === extra[1]);
  const dropParts = (selector: unknown, drop: (part: unknown) => boolean): unknown => {
    if (!isNode(selector) || selector['kind'] !== 'allOf' || !Array.isArray(selector['of']))
      return selector;
    const of = selector['of'].filter((part) => !drop(part));
    return of.length === 1 ? of[0] : { ...selector, of };
  };
  const canon = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value)) {
      const items = value.map((item) => canon(item, key === 'units' ? 'unit' : undefined));
      return key !== undefined && UNORDERED.has(key)
        ? items.map((item) => JSON.stringify(item)).sort()
        : items;
    }
    if (!isNode(value)) return value;
    let node = value;
    if (node['kind'] === 'sacrificeOther') {
      if (node['allowSelf'] !== true)
        node = { ...node, selector: dropParts(node['selector'], (part) => isPart(part, 'other')) };
      // One permanent is the default count.
      if (node['count'] === 1) node = { ...node, count: undefined };
    }
    if (node['kind'] === 'countPermanents' && node['scope'] === 'you')
      node = {
        ...node,
        selector: dropParts(node['selector'], (part) => isPart(part, 'controller', ['who', 'you'])),
      };
    const out: Node = {};
    for (const childKey of Object.keys(node).sort()) {
      const child = node[childKey];
      if (child === undefined || child === false || SKIPPED_KEYS.has(childKey)) continue;
      if (Array.isArray(child) && child.length === 0) continue;
      if (childKey === 'timing' && child === 'any') continue;
      if (childKey === 'typeLine') continue;
      out[childKey] = canon(child, childKey);
    }
    return out;
  };
  return JSON.stringify(canon(definition));
}

/** One settled patch (or pool card) to attack, and how to tell whether a mutant is a real card. */
export interface MutationCase {
  name: string;
  def: Partial<CardDefinition>;
  lines: string[];
  oracleText: string;
  /** The mutant's canonical definition when it is a valid card, or null when it is not. */
  interpret: (def: Partial<CardDefinition>) => string | null;
}

/**
 * The mutants that still settle and mean something else: each one is a wrong patch the free
 * check would pass. `label` names the case and the mutation.
 */
export function survivingMutants(cases: MutationCase[], vocabulary: Vocabulary): string[] {
  const survivors: string[] = [];
  for (const item of cases) {
    if (textCheck(item.def, item.lines, item.name, item.oracleText).verdict !== 'match') continue;
    const original = item.interpret(item.def);
    if (original === null) continue;
    for (const mutant of patchMutants(item.def, vocabulary)) {
      if (textCheck(mutant.def, item.lines, item.name, item.oracleText).verdict !== 'match')
        continue;
      const changed = item.interpret(mutant.def);
      if (changed === null || changed === original) continue;
      survivors.push(`${item.name} ${mutant.label}`);
    }
  }
  return survivors;
}

/** The committed trial patches as mutation cases, validated as the compiler applies them. */
export function trialCases(patches: TrialPatch[]): MutationCase[] {
  return patches.map((patch) => {
    const card = cardByName(patch.name);
    const target: CompileTarget = {
      name: patch.name,
      rank: 0,
      oracleId: card.oracleId,
      card,
      reasons: [],
      lines: patch.handledLines,
    };
    return {
      name: patch.name,
      def: patch.def,
      lines: patch.handledLines,
      oracleText: patch.oracleText,
      interpret: (def) => {
        const result = applyPatch(target, def);
        return result.ok ? canonicalDefinition(result.definition) : null;
      },
    };
  });
}

/** Modeled pool cards as mutation cases: the parser's behavior, validated as a whole card. */
export function poolCases(): MutationCase[] {
  const cases: MutationCase[] = [];
  for (const { card } of pinnedPool()) {
    const oracleText = card.oracleText ?? '';
    if (oracleText === '') continue;
    const definition = interpretCard(card);
    if (!definition.modeled) continue;
    cases.push({
      name: card.name,
      def: behaviorOf(definition) as Partial<CardDefinition>,
      lines: oracleText.split('\n'),
      oracleText,
      interpret: (def) => {
        const whole = { ...definition, ...def } as CardDefinition;
        try {
          return validateCardDefinition(whole).length === 0 ? canonicalDefinition(whole) : null;
        } catch {
          return null;
        }
      },
    });
  }
  return cases;
}
