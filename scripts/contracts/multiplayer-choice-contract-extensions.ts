import { deriveCardCapabilities } from '../../packages/engine/src/cards/capabilities';
import type { PrimitiveContractExtension, PrimitiveCase } from './primitive-contracts';
import {
  boundedChoiceSpell,
  CHOICE_SPELL_KINDS,
  supportsBoundedChoiceSpell,
} from './bounded-choice-spells';
import {
  boundedMultiplayerPermanent,
  MULTIPLAYER_PERMANENT_KINDS,
  supportsBoundedMultiplayerPermanent,
} from './bounded-multiplayer-permanents';

const compositions = [
  ...CHOICE_SPELL_KINDS.map((kind) => ({
    kind,
    definition: boundedChoiceSpell(kind),
    supports: (definition: Parameters<typeof supportsBoundedChoiceSpell>[0]) =>
      supportsBoundedChoiceSpell(definition, kind),
    file: 'packages/engine/tests/bounded-choice-spells-contract.test.ts',
    suite: 'independent bounded multiplayer choice spell compositions',
  })),
  ...MULTIPLAYER_PERMANENT_KINDS.map((kind) => ({
    kind,
    definition: boundedMultiplayerPermanent(kind),
    supports: (definition: Parameters<typeof supportsBoundedMultiplayerPermanent>[0]) =>
      supportsBoundedMultiplayerPermanent(definition, kind),
    file: 'packages/engine/tests/bounded-multiplayer-permanents-contract.test.ts',
    suite: 'independent bounded multiplayer permanent compositions',
  })),
].map((entry) => ({ ...entry, capabilities: deriveCardCapabilities(entry.definition) }));

export const MULTIPLAYER_CHOICE_CONTRACT_EXTENSIONS: readonly PrimitiveContractExtension[] = [
  ...new Set(compositions.flatMap((entry) => entry.capabilities)),
]
  .sort()
  .map((capability) => {
    const consumers = compositions.filter((entry) => entry.capabilities.includes(capability));
    return {
      capability,
      scope: `exact independent executable composition(s): ${consumers.map((entry) => entry.kind).join(', ')}; all costs, targets, modes, types, values, token specifications, alternate abilities and rule statics fixed, with only root names/identifiers and descriptive labels variable`,
      cases: consumers.flatMap((entry) =>
        (['positive', 'negative'] as const).map((role): PrimitiveCase => ({
          id: `multiplayer-choice-${capability.replaceAll('.', '-')}-${entry.kind}-${role}`,
          role,
          file: entry.file,
          titlePath: [entry.suite, `${capability} / ${entry.kind}: ${role}`],
        })),
      ),
      supports: (definition) => consumers.some((entry) => entry.supports(definition)),
    };
  });
