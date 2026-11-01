import type { CardDefinition } from '../cards/definition';

/**
 * A test-only hook (ADR 0034 decision 5): IR mutation installs a transform that changes one card's
 * final definition, then runs that card's tests. It applies where a definition enters a game or a
 * test: the exported `interpretCard` (once, not in its recursive calls for split halves and
 * synthetic faces) and `createGame`'s `customDefinitions`. With no transform installed it returns
 * the definition unchanged.
 */
export type DefinitionTransform = (definition: CardDefinition) => CardDefinition;

let installed: DefinitionTransform | null = null;

/** Install `transform`, or remove the current one with `null`. Returns the one it replaced. */
export function installDefinitionTransform(
  transform: DefinitionTransform | null,
): DefinitionTransform | null {
  const previous = installed;
  installed = transform;
  return previous;
}

export function transformDefinition(definition: CardDefinition): CardDefinition {
  return installed === null ? definition : installed(definition);
}
