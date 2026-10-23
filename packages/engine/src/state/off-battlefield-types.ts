/**
 * Card types of an object that is not on the battlefield — a spell, or a card in a hand, library,
 * graveyard, exile or the command zone. Nothing in the layer system reaches these objects (CR
 * 611.3c), so their types are printed, except where a static ability says otherwise:
 * Biotransference's "the same is true for creature spells you control and creature cards you own
 * that aren't on the battlefield" (an `alsoTypesOffBattlefield` rule static).
 */
import type { PlayerId } from '@mtg/shared';
import { selectedPermanentDefinition } from '../cards/spell-faces';
import { computeCharacteristics, inLayerPass } from '../effects/continuous';
import type { GameContext } from './types';

/**
 * `types` (the object's printed card types) plus what each `alsoTypesOffBattlefield` static of
 * `holderId` adds. `holderId` is the spell's controller, or the card's owner.
 *
 * A source that has lost its abilities adds nothing. Inside a layer pass (a graveyard card-type
 * count in layer 7a) that cannot be asked without recursing, so there the printed ability is used.
 */
export function offBattlefieldTypes(
  ctx: GameContext,
  types: readonly string[],
  holderId: PlayerId | string,
): readonly string[] {
  let result: string[] | undefined;
  for (const perm of ctx.state.battlefield) {
    if (perm.controllerId !== holderId || perm.faceDown) continue;
    const printed = ctx.defs.get(perm.oracleId);
    if (printed === undefined) continue;
    const def = selectedPermanentDefinition(printed, perm.face);
    const statics =
      perm.transformed && def.backFace !== undefined ? def.backFace.ruleStatics : def.ruleStatics;
    for (const rs of statics) {
      if (rs.kind !== 'alsoTypesOffBattlefield' || !(result ?? types).includes(rs.ifType)) continue;
      if (!inLayerPass() && computeCharacteristics(ctx, perm).loseAbilities === true) continue;
      result ??= [...types];
      for (const type of rs.addTypes) if (!result.includes(type)) result.push(type);
    }
  }
  return result ?? types;
}
