import { describe, expect, it } from 'vitest';
import { cardTypesInAllGraveyards } from '../src/cards/value';
import { computeCharacteristics } from '../src/effects/continuous';
import { resolveTopOfStack } from '../src/stack/stack';
import { moveObject } from '../src/state/objects';
import { cardZoneCandidate } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { conjure, oracle, pump, spawn } from './fixtures';
import {
  activateOption,
  asActive,
  bear,
  castFromHand,
  labShock,
  p,
  pinned,
  pinnedDefinition,
  pod,
  putPendingTriggersOnStack,
  settle,
} from './pr10-helpers';

/** P1 controls Biotransference. */
function withBiotransference(seed: string) {
  const ctx = pod(seed);
  const enchantment = spawn(ctx, 'P1', pinned('Biotransference'));
  return { ctx, enchantment };
}
const necrons = (ctx: GameContext, playerId: string) =>
  ctx.state.battlefield.filter(
    (permanent) => permanent.isToken && permanent.controllerId === playerId,
  );

describe('PR10.03 Biotransference', () => {
  it('pr10-biotransference-pinned-oracle-supported — both lines are modeled', () => {
    const def = pinnedDefinition('Biotransference');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.triggers).toHaveLength(1);
  });

  it("pr10-biotransference-battlefield — your creatures are artifacts; an opponent's are not", () => {
    const { ctx } = withBiotransference('pr10-bio-battlefield');
    const mine = spawn(ctx, 'P1', bear('Bio Bear'));
    const theirs = spawn(ctx, 'P2', bear('Bio Rival'));
    expect(computeCharacteristics(ctx, mine).types).toEqual(['Creature', 'Artifact']);
    expect(computeCharacteristics(ctx, theirs).types).toEqual(['Creature']);
  });

  it('pr10-biotransference-cards — creature cards you own off the battlefield are artifact cards', () => {
    const { ctx, enchantment } = withBiotransference('pr10-bio-cards');
    const inHand = conjure(ctx, 'P1', bear('Bio Hand Bear'), 'hand');
    const inGraveyard = conjure(ctx, 'P1', bear('Bio Grave Bear'), 'graveyard');
    const rival = conjure(ctx, 'P2', bear('Bio Rival Bear'), 'graveyard');
    const types = (card: typeof inHand, owner: string) => cardZoneCandidate(ctx, card, owner).types;
    expect(types(inHand, 'P1')).toContain('Artifact');
    expect(types(inGraveyard, 'P1')).toContain('Artifact');
    expect(types(rival, 'P2')).not.toContain('Artifact');
    // Creature, plus Artifact from P1's graveyard creature card.
    expect(cardTypesInAllGraveyards(ctx)).toBe(2);
    pump(moveObject(ctx, enchantment, { zone: 'graveyard' }));
    expect(types(inGraveyard, 'P1')).not.toContain('Artifact');
    // Biotransference itself is now an Enchantment card in the graveyard.
    expect(cardTypesInAllGraveyards(ctx)).toBe(2);
  });

  it('pr10-biotransference-creature-spell — casting a creature spell is casting an artifact spell', () => {
    const { ctx } = withBiotransference('pr10-bio-cast');
    const life = p(ctx, 'P1').life;
    castFromHand(ctx, 'P1', bear('Bio Cast Bear'));
    putPendingTriggersOnStack(ctx);
    const asked: string[] = [];
    settle(ctx, (decision) => {
      asked.push(decision.decisionType);
      return { index: 0, targets: new Map() };
    });
    // The trigger is mandatory: no "use this ability?" yes/no is asked.
    expect(asked).not.toContain('optionalTrigger');
    expect(p(ctx, 'P1').life).toBe(life - 1);
    const tokens = necrons(ctx, 'P1');
    expect(tokens.map((token) => token.name)).toEqual(['Necron Warrior']);
    const chars = computeCharacteristics(ctx, tokens[0]!);
    expect([chars.power, chars.toughness, chars.colors]).toEqual([2, 2, ['B']]);
  });

  it('pr10-biotransference-noncreature-spell — an instant is not an artifact spell', () => {
    const { ctx } = withBiotransference('pr10-bio-instant');
    const life = p(ctx, 'P1').life;
    castFromHand(ctx, 'P1', labShock(), new Map([[0, 'P2']]));
    putPendingTriggersOnStack(ctx);
    settle(ctx);
    expect(p(ctx, 'P1').life).toBe(life);
    expect(necrons(ctx, 'P1')).toHaveLength(0);
  });

  it("pr10-biotransference-opponents-spell — an opponent's creature spell doesn't trigger it", () => {
    const { ctx } = withBiotransference('pr10-bio-opponent');
    const life = p(ctx, 'P1').life;
    const restore = asActive(ctx, 'P2');
    castFromHand(ctx, 'P2', bear('Rival Cast Bear'));
    putPendingTriggersOnStack(ctx);
    settle(ctx);
    restore();
    expect(p(ctx, 'P1').life).toBe(life);
    expect(necrons(ctx, 'P1')).toHaveLength(0);
  });

  it('pr10-biotransference-trazyn — Trazyn has the abilities of creature cards in your graveyard', () => {
    const { ctx } = withBiotransference('pr10-bio-trazyn');
    castFromHand(ctx, 'P1', pinned('Trazyn the Infinite'));
    pump(resolveTopOfStack(ctx));
    settle(ctx);
    const trazyn = ctx.state.battlefield.find((perm) => perm.name === 'Trazyn the Infinite')!;
    trazyn.summoningSick = false;
    conjure(
      ctx,
      'P1',
      oracle({
        name: 'Bio Healer',
        typeLine: 'Creature — Human Cleric',
        power: '1',
        toughness: '1',
        oracleText: '{T}: You gain 2 life.',
      }),
      'graveyard',
    );
    expect(activateOption(ctx, 'P1', trazyn)).toBeDefined();
  });
});
