import { triggered } from '../templates';
import { replaceCard } from './index';

export function registerWhiteBlackControlCloakOverrides(): void {
  replaceCard('5d258409-28d3-4eac-9f1a-3e494db818bf', 'Cloak of Confusion', [
    'unrecognized rules text: "Whenever enchanted creature attacks and isn\'t blocked, you may have it assign no combat damage this turn. If you do, defending player discards a card at random."',
  ], { triggers: [triggered({ when: 'attacksUnblocked', subject: { kind: 'permanent', selector: { kind: 'attachedToSource' } },
    defendingPlayerIsEventPlayer: true }, {
    effects: [{ op: 'mayForgoTriggerObjectCombatDamageForRandomDiscard' }],
    description: 'Enchanted creature may assign no combat damage this turn; defending player discards at random',
  })] }, 'Triggers after blocker declaration only for the unblocked enchanted attacker; the chosen prohibition lasts for every combat damage step of this turn.');
}
