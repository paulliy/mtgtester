import { activated, counterSpellTarget, spell, TAP, targetSlots } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlProtectionStackOverrides(): void {
  const creature = targetSlots({ creature: { kind: 'creature', controller: 'you' } });
  const returnedSpell = targetSlots({ spell: counterSpellTarget('spell') });
  const counteredSpell = targetSlots({ spell: { ...counterSpellTarget('spell'), spellTargetsPermanentYouControl: true } });
  replaceCard('60433b48-d27f-413c-905c-43839b1943f1', 'Mother of Runes', [
    'unrecognized rules text: "{T}: Target creature you control gains protection from the color of your choice until end of turn."',
  ], { activatedAbilities: [activated({ costs: [TAP], targets: creature.targets,
    effects: [{ op: 'grantChosenColorProtectionUntilEot', target: creature.slot.creature }], description: 'Target creature you control gains protection from a color of your choice until end of turn' })] },
  'Choose one of the five colors at resolution, using the ordinary tap activation and creature target.');
  replaceCard('d54e4e37-042b-44a5-918d-757308545d4d', 'Sejiri Shelter // Sejiri Glacier', [
    'unrecognized rules text: "Target creature you control gains protection from the color of your choice until end of turn."',
  ], { spellAbility: spell({ targets: creature.targets,
    effects: [{ op: 'grantChosenColorProtectionUntilEot', target: creature.slot.creature }], description: 'Target creature you control gains protection from a color of your choice until end of turn' }) },
  'Models the protection spell while preserving the parsed tapped white-mana land back face.');
  replaceCard('f0449cbd-855c-4c20-a1f5-f76a395d8d39', 'Reprieve', [
    'unrecognized rules text: "Return target spell to its owner\'s hand."',
  ], { spellAbility: spell({ targets: returnedSpell.targets, effects: [
    { op: 'returnSpellToOwnerHand', target: returnedSpell.slot.spell }, { op: 'draw', count: constant(1) },
  ], description: 'Return target spell to its owner\'s hand. Draw a card' }) },
  'Returns a stack spell rather than countering it, including uncounterable spells; retains the draw clause.');
  replaceCard('f5822e53-ddec-4c77-bcf4-091e35c1e731', 'Rebuff the Wicked', [
    'unrecognized rules text: "Counter target spell that targets a permanent you control."',
  ], { spellAbility: spell({ targets: counteredSpell.targets,
    effects: [{ op: 'counter', target: counteredSpell.slot.spell }], description: 'Counter target spell that targets a permanent you control' }) },
  'Checks the target spell\'s current ordinary and counted targets at announcement and resolution.');
}
