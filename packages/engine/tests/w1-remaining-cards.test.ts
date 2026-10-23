import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { queueTriggersForEvent, queueTriggersForObject } from '../src/state/objects';
import { runPrioritySequence } from '../src/turn/priority';
import { bear, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const oracleCards = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../server/fixtures/coverage-oracle.json'), 'utf8'),
) as OracleCard[];

const modeledNames = [
  'Fumiko the Lowblood',
  'Ghalta and Mavren',
  // Restored in PR11; its behavior tests live in pr11-lifecycle.test.ts.
  'Gut, True Soul Zealot',
  'Nova Flame',
  "Sage's Reverie",
  'Scriv, the Obligator',
  'Will of the Mardu',
] as const;

const names = [...modeledNames] as const;

const cards = new Map(
  names.map((name) => [name, oracleCards.find((candidate) => candidate.name === name)!]),
);
const definitions = new Map([...cards].map(([name, card]) => [name, interpretCard(card)]));

function pod(seed: string) {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

function card(name: (typeof names)[number]): OracleCard {
  return cards.get(name)!;
}

describe('remaining W1 cards', () => {
  it('fully models every leftover W1 fixture', () => {
    for (const name of modeledNames) {
      const definition = definitions.get(name)!;
      expect(definition.unmodeledReasons, name).toEqual([]);
      expect(definition.modeled, name).toBe(true);
    }
  });

  it('gives Fumiko dynamic bushido when blocking or becoming blocked and preserves her attack requirement', () => {
    for (const event of ['blocks', 'becomesBlocked'] as const) {
      const ctx = pod(`fumiko-${event}`);
      const fumiko = spawn(ctx, 'P1', card('Fumiko the Lowblood'));
      const first = spawn(ctx, 'P1', bear());
      const second = spawn(ctx, 'P1', bear());
      const opposing = spawn(ctx, 'P2', bear());
      fumiko.attacking = event === 'becomesBlocked' ? 'P2' : null;
      first.attacking = 'P2';
      second.attacking = 'P3';

      queueTriggersForObject(ctx, event, fumiko);
      pump(runPrioritySequence(ctx));

      const expectedBonus = event === 'becomesBlocked' ? 3 : 2;
      expect(computeCharacteristics(ctx, fumiko).power).toBe(3 + expectedBonus);
      expect(computeCharacteristics(ctx, fumiko).toughness).toBe(2 + expectedBonus);
      expect(computeCharacteristics(ctx, opposing).mustAttackEachCombat).toBe(true);
    }
  });

  it('creates either Ghalta and Mavren token mode from the other attackers', () => {
    const setup = (seed: string) => {
      const ctx = pod(seed);
      ctx.state.combat = { defendingPlayers: ['P2'] };
      const ghalta = spawn(ctx, 'P1', card('Ghalta and Mavren'));
      const large = spawn(
        ctx,
        'P1',
        oracle({ name: 'Large Attacker', power: '5', toughness: '5' }),
      );
      const small = spawn(ctx, 'P1', bear());
      ghalta.attacking = 'P2';
      large.attacking = 'P2';
      small.attacking = 'P2';
      return { ctx, ghalta };
    };

    const dinosaurGame = setup('ghalta-dinosaur');
    const ability = definitions.get('Ghalta and Mavren')!.triggers[0]!;
    pump(executeAbility(dinosaurGame.ctx, dinosaurGame.ghalta, ability, []), () => ({
      index: 0,
      targets: new Map(),
    }));
    const dinosaur = dinosaurGame.ctx.state.battlefield.find(
      (permanent) => permanent.name === 'Dinosaur',
    )!;
    expect(effectiveToken(dinosaurGame.ctx, dinosaur)).toEqual({
      power: 5,
      toughness: 5,
      keyword: true,
      tapped: true,
      attacking: 'P2',
    });

    const vampireGame = setup('ghalta-vampires');
    pump(executeAbility(vampireGame.ctx, vampireGame.ghalta, ability, []), () => ({
      index: 1,
      targets: new Map(),
    }));
    const vampires = vampireGame.ctx.state.battlefield.filter(
      (permanent) => permanent.name === 'Vampire',
    );
    expect(vampires).toHaveLength(2);
    expect(
      vampires.every((permanent) =>
        computeCharacteristics(vampireGame.ctx, permanent).keywords.includes('lifelink'),
      ),
    ).toBe(true);
  });

  it("resolves Nova Flame's counters before target-sourced damage and preserves lifelink", () => {
    const ctx = pod('nova-flame');
    const nova = card('Nova Flame');
    const sourceCreature = spawn(
      ctx,
      'P1',
      oracle({ name: 'Lifelink Adept', power: '2', toughness: '6', oracleText: 'Lifelink' }),
    );
    const victim = spawn(ctx, 'P2', oracle({ name: 'Nova Victim', power: '1', toughness: '8' }));
    const player = ctx.state.players[0]!;
    const beforeLife = player.life;

    pump(
      executeAbility(
        ctx,
        { cardId: 'nova-flame', oracleId: nova.oracleId, name: nova.name, controllerId: 'P1' },
        definitions.get('Nova Flame')!.spellAbility!,
        [sourceCreature.id],
        undefined,
        { x: 3 },
      ),
    );

    expect(sourceCreature.counters['+1/+1']).toBe(3);
    expect(sourceCreature.damageMarked).toBe(0);
    expect(victim.damageMarked).toBe(5);
    expect(player.life).toBe(beforeLife + 5);
  });

  it("counts only the controller's Auras attached to creatures for Sage's Reverie", () => {
    const ctx = pod('sages-reverie');
    const enchanted = spawn(ctx, 'P1', bear());
    const reverie = spawn(ctx, 'P1', card("Sage's Reverie"));
    reverie.attachedTo = enchanted.id;
    const ownAura = spawn(
      ctx,
      'P1',
      oracle({ name: 'Own Aura', typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature' }),
    );
    ownAura.attachedTo = enchanted.id;
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Unattached Aura',
        typeLine: 'Enchantment — Aura',
        oracleText: 'Enchant creature',
      }),
    );
    const opposingAura = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Opposing Aura',
        typeLine: 'Enchantment — Aura',
        oracleText: 'Enchant creature',
      }),
    );
    opposingAura.attachedTo = enchanted.id;

    expect(computeCharacteristics(ctx, enchanted).power).toBe(4);
    expect(computeCharacteristics(ctx, enchanted).toughness).toBe(4);
    const before = ctx.state.players[0]!.hand.length;
    pump(executeAbility(ctx, reverie, definitions.get("Sage's Reverie")!.triggers[0]!, []));
    expect(ctx.state.players[0]!.hand.length).toBe(before + 2);
  });

  it('creates Scriv Contracts and resolves both attack branches from the Aura controller’s view', () => {
    const ctx = pod('scriv');
    const scriv = spawn(ctx, 'P1', card('Scriv, the Obligator'));
    const debtor = spawn(ctx, 'P2', bear());
    const createContract = definitions.get('Scriv, the Obligator')!.triggers[0]!;

    pump(executeAbility(ctx, scriv, createContract, [debtor.id]));
    const contract = ctx.state.battlefield.find((permanent) => permanent.name === 'Contract')!;
    expect(contract.attachedTo).toBe(debtor.id);

    debtor.attacking = 'P3';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: debtor, playerId: 'P2' }]);
    pump(runPrioritySequence(ctx));
    expect(computeCharacteristics(ctx, debtor).power).toBe(4);

    const debtorPlayer = ctx.state.players.find((player) => player.id === 'P2')!;
    const beforeLife = debtorPlayer.life;
    debtor.attacking = 'P1';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: debtor, playerId: 'P2' }]);
    pump(runPrioritySequence(ctx));
    expect(debtorPlayer.life).toBe(beforeLife - 2);
  });

  it('models Will of the Mardu with choose-both for any commander you control (coverage PR01)', () => {
    const definition = definitions.get('Will of the Mardu')!;
    expect(definition.modeled).toBe(true);
    expect(definition.spellAbility?.modes?.maxChoicesIf?.condition).toEqual({
      kind: 'controlsACommander',
    });
  });
});

function effectiveToken(
  ctx: ReturnType<typeof pod>,
  token: ReturnType<typeof spawn>,
): {
  power: number;
  toughness: number;
  keyword: boolean;
  tapped: boolean;
  attacking: string | null;
} {
  const chars = computeCharacteristics(ctx, token);
  return {
    power: chars.power,
    toughness: chars.toughness,
    keyword: chars.keywords.includes('trample'),
    tapped: token.tapped,
    attacking: token.attacking,
  };
}
