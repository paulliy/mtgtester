import { describe, expect, it } from 'vitest';
import type { ManaAbilitySpec } from '../src/cards/ability';
import type { CardDefinition } from '../src/cards/definition';
import { payManaCost } from '../src/effects/resolve';
import { parseManaCost } from '../src/mana/cost';
import { createGame } from '../src/state/game';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function setup(ability: ManaAbilitySpec, keywords: CardDefinition['keywords'] = []) {
  const ctx = createGame(gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }]));
  const player = ctx.state.players[0]!;
  const permanent = spawn(
    ctx,
    player.id,
    oracle({ name: 'Mana order probe', typeLine: 'Artifact' }),
  );
  ctx.defs.set(permanent.oracleId, {
    ...ctx.defs.get(permanent.oracleId)!,
    manaAbilities: [ability],
    keywords,
  });
  const pay = () => pump(payManaCost(ctx, player, parseManaCost('{G}').cost!));
  return { ctx, player, permanent, pay };
}

describe('independent mana activation order contracts', () => {
  it('pays life before the mana ability gains life', () => {
    const { ctx, player, pay } = setup({
      costs: [{ kind: 'tap' }, { kind: 'payLife', amount: 2 }],
      units: [['G']],
      onActivate: [{ op: 'gainLife', amount: { kind: 'const', n: 3 } }],
    });
    player.life = 2;
    pay();
    expect(player.life).toBe(3);
    expect(
      ctx.state.eventLog
        .filter((event) => ['lifeLoss', 'lifeGain'].includes(event.type))
        .map((event) => event.type),
    ).toEqual(['lifeLoss', 'lifeGain']);
    expect(ctx.state.eventLog.find((event) => event.type === 'lifeLoss')?.payload['life']).toBe(0);
  });

  it('evaluates a rider against the graveyard after sacrificing its source', () => {
    const { player, permanent, pay } = setup({
      costs: [{ kind: 'sacrificeSelf' }],
      units: [['G']],
      onActivate: [{ op: 'gainLife', amount: { kind: 'cardTypesInAllGraveyards' } }],
    });
    player.life = 10;
    pay();
    expect(player.graveyard.some((card) => card.cardId === permanent.cardId)).toBe(true);
    expect(player.life).toBe(11);
  });

  it('cannot put counters on a battlefield object sacrificed to activate the ability', () => {
    const { ctx, permanent, pay } = setup({
      costs: [{ kind: 'sacrificeSelf' }],
      units: [['G']],
      onActivate: [{ op: 'putCounters', target: 'source', counter: '+1/+1', count: 1 }],
    });
    pay();
    expect(permanent.counters['+1/+1']).toBeUndefined();
    expect(ctx.state.eventLog.filter((event) => event.type === 'counters')).toEqual([]);
  });

  it('damage uses the sacrificed source’s last known lifelink', () => {
    const { player, pay } = setup(
      {
        costs: [{ kind: 'sacrificeSelf' }],
        units: [['G']],
        onActivate: [{ op: 'damageController', amount: 2 }],
      },
      ['lifelink'],
    );
    player.life = 10;
    pay();
    expect(player.life).toBe(10);
  });

  it('damage uses infect rather than charging life', () => {
    const { player, pay } = setup(
      {
        costs: [{ kind: 'tap' }],
        units: [['G']],
        onActivate: [{ op: 'damageController', amount: 2 }],
      },
      ['infect'],
    );
    player.life = 10;
    pay();
    expect(player.life).toBe(10);
    expect(player.poisonCounters).toBe(2);
  });

  it('a life-loss floor cannot reduce an activation’s life payment', () => {
    const { ctx, player, pay } = setup({
      costs: [{ kind: 'tap' }, { kind: 'payLife', amount: 2 }],
      units: [['G']],
    });
    player.life = 2;
    ctx.state.lifeFloorPlayers[player.id] = true;
    pay();
    expect(player.life).toBe(0);
  });

  it('mana damage may put life below zero before the next state-based-action check', () => {
    const { player, pay } = setup({
      costs: [{ kind: 'tap' }],
      units: [['G']],
      onActivate: [{ op: 'damageController', amount: 2 }],
    });
    player.life = 1;
    pay();
    expect(player.life).toBe(-1);
    expect(player.hasLost).toBe(false);
  });
});
