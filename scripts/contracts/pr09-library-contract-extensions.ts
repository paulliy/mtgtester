import { deriveCardCapabilities } from '../../packages/engine/src/cards/capabilities';
import type { PrimitiveCase, PrimitiveContractExtension } from './primitive-contracts';
import {
  BOUNDED_PR09_LIBRARY,
  matchesBoundedPr09Library,
  type Pr09LibraryCompositionId,
} from './bounded-pr09-library';

const suite = 'independent bounded PR09 library compositions';
const compositionFiles = 'packages/engine/tests/pr09-library-composition-contract.test.ts';
const capabilitySlug = (capability: string) =>
  capability
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const entries = BOUNDED_PR09_LIBRARY.map(({ id, definition }) => ({
  id,
  definition,
  capabilities: deriveCardCapabilities(definition),
}));

/** Only capabilities in these literal, independently-executed definitions are offered here. */
export const PR09_LIBRARY_CONTRACT_EXTENSIONS: readonly PrimitiveContractExtension[] = [
  ...new Set(entries.flatMap((entry) => entry.capabilities)),
]
  .sort()
  .map((capability) => {
    const consumers = entries.filter((entry) => entry.capabilities.includes(capability));
    return {
      capability,
      scope: `exact independent PR09 compositions: ${consumers.map((entry) => entry.id).join(', ')}; all costs, types, trigger heads, filters, targets, effects, values, keywords and statics are fixed; root identity fields and ability descriptions may vary`,
      cases: consumers.flatMap(({ id }): PrimitiveCase[] =>
        (['positive', 'negative'] as const).map((role) => ({
          id: `pr09-library-${capabilitySlug(capability)}-${id}-${role}`,
          role,
          file: compositionFiles,
          titlePath: [suite, `${capability} / ${id}: ${role}`],
        })),
      ),
      supports: (definition) =>
        consumers.some(({ id }) =>
          matchesBoundedPr09Library(definition, id as Pr09LibraryCompositionId),
        ),
    };
  });
