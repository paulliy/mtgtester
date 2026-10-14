import { triggered } from '../templates';
import { ZOMBIE_2_2_BLACK } from '../tokens';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlCurseOverrides(): void {
  replaceCard('6cbd36d9-de47-41b0-9ef4-a72ca01adccd', 'Curse of Disturbance', [
    'unrecognized rules text: "Whenever enchanted player is attacked, create a 2/2 black Zombie creature token. Each opponent attacking that player does the same."',
  ], { triggers: [triggered({ when: 'enchantedPlayerAttacked', subject: { kind: 'self' } }, {
    effects: [{ op: 'createToken', spec: ZOMBIE_2_2_BLACK, count: constant(1) },
      { op: 'createTokenForPlayer', target: 'eventPlayer', spec: ZOMBIE_2_2_BLACK, count: constant(1), opponentsOnly: true }],
    description: 'Create a Zombie; each opponent attacking enchanted player creates one',
  })] }, 'Preserves enchant player and fires once for the attacked player, with the attacking player captured independently of attacker count.');
}
