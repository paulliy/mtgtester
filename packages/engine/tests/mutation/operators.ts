/**
 * IR mutation operators (ADR 0034 decision 5). `cardMutants(definition)` lists, in a fixed order,
 * every single-step change the table below makes to a card's final definition; `mutate` applies
 * one by index to a fresh copy. The order depends only on the definition's shape, so the runner
 * and the in-test hook agree on what index `n` means, and each mutant's label says where it is.
 *
 * | IR shape                   | Mutations                                                        |
 * | -------------------------- | ---------------------------------------------------------------- |
 * | effect list                | drop each effect                                                 |
 * | trigger                    | drop `condition` or `eventCondition`; widen the subject selector |
 * | target slot                | widen the filter to the slot's kind                              |
 * | `optional`                 | flip it                                                          |
 * | constant `Value`           | add one; subtract one when above zero                            |
 * | modes                      | drop each mode                                                   |
 * | activated or mana ability  | drop each non-mana cost; drop each mana ability                  |
 * | static effect, rule static | drop each entry                                                  |
 * | replacement field          | flip a set `entersTapped`; remove `entersWithCounters`           |
 * | keyword flag               | drop each keyword                                                |
 *
 * Abilities, values and definitions are found anywhere in the tree (a back face, an Adventure, a
 * room door, a token a spell creates), so a nested ability is mutated like a top-level one.
 */
import type { CardDefinition } from '../../src/cards/definition';

type Path = readonly (string | number)[];
type Node = Record<string, unknown>;

export interface Mutant {
  /** `<path>: <operator>`, e.g. `triggers[0].effects[1]: drop effect`. */
  label: string;
  /** The top-level part of the card it changes: `spellAbility`, `triggers[0]`, `keywords`, … */
  part: string;
  path: Path;
  /** Changes the node at `path`, in place. */
  apply: (node: Node) => void;
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAbility = (value: Node): boolean =>
  (value['kind'] === 'spell' || value['kind'] === 'triggered' || value['kind'] === 'activated') &&
  Array.isArray(value['effects']) &&
  Array.isArray(value['targets']);

/** A definition-shaped node: the card itself, a face, a door, a token's definition. */
const isDefinition = (value: Node): boolean =>
  Array.isArray(value['staticEffects']) &&
  Array.isArray(value['keywords']) &&
  Array.isArray(value['triggers']);

const formatPath = (path: Path): string =>
  path
    .map((step, index) =>
      typeof step === 'number' ? `[${step}]` : index === 0 ? step : `.${step}`,
    )
    .join('');

function removeAt(list: unknown[], index: number): void {
  list.splice(index, 1);
}

function abilityMutants(node: Node, path: Path, add: AddMutant): void {
  const effects = node['effects'] as unknown[];
  effects.forEach((_, index) =>
    add(path, `drop effect ${index}`, (ability) =>
      removeAt(ability['effects'] as unknown[], index),
    ),
  );
  const targets = node['targets'] as Node[];
  targets.forEach((target, index) => {
    const narrowing = ['filter', 'controller', 'tapState'].filter((key) => key in target);
    if (narrowing.length === 0) return;
    add(path, `widen target ${index} to its kind (drop ${narrowing.join(', ')})`, (ability) => {
      const slot = (ability['targets'] as Node[])[index]!;
      for (const key of narrowing) delete slot[key];
    });
  });
  if (node['kind'] === 'triggered' || 'optional' in node)
    add(path, `flip optional to ${node['optional'] !== true}`, (ability) => {
      if (ability['optional'] === true) delete ability['optional'];
      else ability['optional'] = true;
    });
  const trigger = node['trigger'];
  if (isNode(trigger)) {
    for (const key of ['condition', 'eventCondition'])
      if (key in trigger)
        add(path, `drop trigger ${key}`, (ability) => {
          delete (ability['trigger'] as Node)[key];
        });
    const subject = trigger['subject'];
    if (isNode(subject) && isNode(subject['selector'])) {
      const selector = subject['selector'];
      if (
        selector['kind'] === 'allOf' &&
        Array.isArray(selector['of']) &&
        selector['of'].length > 1
      )
        selector['of'].forEach((_, index) =>
          add(path, `widen trigger subject (drop condition ${index})`, (ability) => {
            const of = (((ability['trigger'] as Node)['subject'] as Node)['selector'] as Node)[
              'of'
            ] as unknown[];
            removeAt(of, index);
          }),
        );
    }
  }
  const modes = node['modes'];
  if (isNode(modes) && Array.isArray(modes['options']) && modes['options'].length > 1) {
    const count = modes['options'].length;
    for (let index = 0; index < count; index++)
      add(path, `drop mode ${index}`, (ability) => {
        const changed = ability['modes'] as Node;
        removeAt(changed['options'] as unknown[], index);
        const left = count - 1;
        changed['maxChoices'] = Math.min(changed['maxChoices'] as number, left);
        changed['minChoices'] = Math.min(changed['minChoices'] as number, left);
      });
  }
}

function definitionMutants(node: Node, path: Path, add: AddMutant): void {
  (node['keywords'] as unknown[]).forEach((keyword, index) =>
    add(
      path,
      `drop keyword ${String(keyword)}`,
      (definition) => removeAt(definition['keywords'] as unknown[], index),
      'keywords',
    ),
  );
  for (const list of ['staticEffects', 'ruleStatics', 'manaAbilities'])
    if (Array.isArray(node[list]))
      (node[list] as unknown[]).forEach((_, index) =>
        add(
          path,
          `drop ${list}[${index}]`,
          (definition) => removeAt(definition[list] as unknown[], index),
          `${list}[${index}]`,
        ),
      );
  // The replacement field is there only when set: every definition carries `entersTapped: false`.
  if (node['entersTapped'] === true)
    add(
      path,
      'flip entersTapped to false',
      (definition) => {
        definition['entersTapped'] = false;
      },
      'entersTapped',
    );
  if (node['entersWithCounters'] !== undefined)
    add(
      path,
      'remove entersWithCounters',
      (definition) => {
        delete definition['entersWithCounters'];
      },
      'entersWithCounters',
    );
  if (node['optionalAdditionalCost'] !== undefined) {
    add(
      path,
      'remove optionalAdditionalCost',
      (definition) => {
        delete definition['optionalAdditionalCost'];
      },
      'optionalAdditionalCost',
    );
    if ((node['optionalAdditionalCost'] as Node)['repeatable'] === true)
      add(
        path,
        'drop optionalAdditionalCost repeatable',
        (definition) => {
          delete (definition['optionalAdditionalCost'] as Node)['repeatable'];
        },
        'optionalAdditionalCost',
      );
  }
  if (node['entersUnlessDiscard'] !== undefined)
    add(
      path,
      'remove entersUnlessDiscard',
      (definition) => {
        delete definition['entersUnlessDiscard'];
      },
      'entersUnlessDiscard',
    );
  if (Array.isArray(node['activatedAbilities']))
    (node['activatedAbilities'] as Node[]).forEach((activated, abilityIndex) =>
      (activated['costs'] as Node[]).forEach((cost, costIndex) => {
        if (cost['kind'] === 'mana') return;
        add(
          path,
          `drop activatedAbilities[${abilityIndex}] cost ${costIndex} (${String(cost['kind'])})`,
          (definition) =>
            removeAt(
              (definition['activatedAbilities'] as Node[])[abilityIndex]!['costs'] as unknown[],
              costIndex,
            ),
          `activatedAbilities[${abilityIndex}]`,
        );
      }),
    );
}

/**
 * Records a mutant of the node at `path`. `part` names the card-level part a mutant of the card
 * itself changes; a nested mutant's part is the top-level field (and index) it sits under.
 */
type AddMutant = (
  path: Path,
  operator: string,
  change: (node: Node) => void,
  part?: string,
) => void;

/** Every mutant of a definition, in a fixed order. */
export function cardMutants(definition: CardDefinition): Mutant[] {
  const mutants: Mutant[] = [];
  const add: AddMutant = (path, operator, change, part) =>
    mutants.push({
      label: `${formatPath(path) || '(card)'}: ${operator}`,
      part:
        path.length === 0 ? part! : formatPath(path.slice(0, typeof path[1] === 'number' ? 2 : 1)),
      path,
      apply: change,
    });
  const visit = (value: unknown, path: Path): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    if (!isNode(value)) return;
    if (isDefinition(value)) definitionMutants(value, path, add);
    if (isAbility(value)) abilityMutants(value, path, add);
    if (value['kind'] === 'const' && typeof value['n'] === 'number') {
      add(path, `const ${value['n']} + 1`, (node) => {
        node['n'] = (node['n'] as number) + 1;
      });
      if (value['n'] > 0)
        add(path, `const ${value['n']} - 1`, (node) => {
          node['n'] = (node['n'] as number) - 1;
        });
    }
    for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
  };
  visit(definition, []);
  return mutants;
}

/** A copy of `definition` with mutant `index` applied. */
export function mutate(definition: CardDefinition, index: number): CardDefinition {
  const mutant = cardMutants(definition)[index];
  if (mutant === undefined) throw new Error(`${definition.name}: no mutant ${index}`);
  const copy = structuredClone(definition) as unknown as Node;
  let node: unknown = copy;
  for (const step of mutant.path) node = (node as Record<string | number, unknown>)[step];
  mutant.apply(node as Node);
  return copy as unknown as CardDefinition;
}

/**
 * The card's top-level parts (each ability, static, replacement field and keyword list) that no
 * mutant changes. ADR 0034 decision 5: every one yields at least one mutant.
 */
export function unmutatedParts(definition: CardDefinition): string[] {
  const parts: string[] = [];
  const node = definition as unknown as Node;
  for (const key of [
    'triggers',
    'activatedAbilities',
    'staticEffects',
    'ruleStatics',
    'manaAbilities',
  ])
    (node[key] as unknown[] | undefined)?.forEach((_, index) => parts.push(`${key}[${index}]`));
  // An Aura's spell, or one made only of keywords (cascade, rebound), does nothing itself.
  if (definition.spellAbility !== null && definition.spellAbility.effects.length > 0)
    parts.push('spellAbility');
  if (definition.keywords.length > 0) parts.push('keywords');
  if (definition.entersTapped) parts.push('entersTapped');
  if (definition.entersWithCounters !== undefined) parts.push('entersWithCounters');
  const covered = new Set(cardMutants(definition).map((mutant) => mutant.part));
  return parts.filter((part) => !covered.has(part));
}
