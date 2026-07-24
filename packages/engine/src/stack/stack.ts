/**
 * Stack resolution (CR 608, brief §5.5). LIFO: the top (last-pushed) object resolves once
 * all players pass in succession. Target legality is rechecked on resolution; a spell or
 * ability whose targets are ALL illegal doesn't resolve — it fizzles (CR 608.2b).
 */

import type { GameGen } from '../decisions';
import { effectTargetKind } from '../cards/definition';
import { isTargetStillLegal, resolveEffects } from '../effects/resolve';
import { emit, debug } from '../log/log';
import { moveObject } from '../state/objects';
import { getDefByOracleId } from '../state/queries';
import type { EngineStackObject, GameContext } from '../state/types';

/** Resolve the top object of the stack. Caller guarantees the stack is nonempty. */
export function* resolveTopOfStack(ctx: GameContext): GameGen<void> {
  const s = ctx.state;
  const top = s.stack.pop();
  if (top === undefined) throw new Error('engine bug: resolveTopOfStack on empty stack');

  debug(ctx, 'stack', `resolving: ${top.description}`, { targets: top.targets });

  // Optional ("you may") triggered ability: the yes/no choice is made on resolution.
  if (top.kind === 'triggeredAbility' && top.triggerSpec?.optional === true) {
    const outcome = yield {
      decisionType: 'optionalTrigger',
      player: top.controllerId,
      prompt: `${top.description} — use this ability?`,
      options: [
        { type: 'acceptTrigger', description: 'Yes' },
        { type: 'declineTrigger', description: 'No' },
      ],
    };
    if (outcome.index === 1) {
      emit(ctx, 'triggerDeclined', { description: top.description }, top.controllerId);
      return;
    }
  }

  // Fizzle check (CR 608.2b): if the object has targets and every one is now illegal,
  // it doesn't resolve. Spell cards go to the graveyard.
  if (top.targets.length > 0) {
    const kinds = top.effects
      .map((e) => effectTargetKind(e))
      .filter((k): k is NonNullable<typeof k> => k !== null);
    const anyLegal = top.targets.some((t, i) => {
      const kind = kinds[i];
      return kind !== undefined && isTargetStillLegal(ctx, t, kind, top.controllerId);
    });
    if (!anyLegal) {
      emit(ctx, 'fizzle', { description: top.description }, top.controllerId);
      debug(ctx, 'stack', `${top.description} fizzles — all targets illegal`);
      if (top.card !== null) {
        yield* moveObject(ctx, top.card, { zone: 'graveyard' });
      }
      return;
    }
  }

  yield* resolveEffects(
    ctx,
    {
      cardId: top.sourceCardId,
      name: top.card?.name ?? top.description,
      oracleId: top.sourceOracleId,
      controllerId: top.controllerId,
    },
    top.effects,
    top.targets,
  );

  // Destination (CR 608.3): permanent spells enter the battlefield under their caster;
  // instants/sorceries go to their owner's graveyard.
  if (top.kind === 'spell' && top.card !== null) {
    yield* finishSpellCard(ctx, top);
  }
  emit(ctx, 'resolved', { description: top.description }, top.controllerId);
}

function* finishSpellCard(ctx: GameContext, spell: EngineStackObject): GameGen<void> {
  const card = spell.card;
  if (card === null) return;
  const def = getDefByOracleId(ctx, card.oracleId, card.name);
  if (def.types.some((t) => ['Creature', 'Artifact', 'Enchantment'].includes(t))) {
    yield* moveObject(ctx, card, { zone: 'battlefield', controllerId: spell.controllerId });
  } else {
    yield* moveObject(ctx, card, { zone: 'graveyard' });
  }
}
