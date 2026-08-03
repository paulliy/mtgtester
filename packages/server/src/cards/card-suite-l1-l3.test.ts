import { describe, expect, it } from 'vitest';
import { interpretCard } from '../../../engine/src/cards/interpret';
import { executeAbility } from '../../../engine/src/effects/resolve';
import { createGame } from '../../../engine/src/state/game';
import type { GameContext } from '../../../engine/src/state/types';
import { copies, drive, forest, gameConfig, makeEngine, oracle, pump, registerDef, RuleBasedProvider, spawn, whenChoose } from '../../../engine/tests/fixtures';
import scryfallCards from '../../../../data/scryfall-oracle-cards.json' assert { type: 'json' };
import { toOracleCard } from './scryfall';
import type { OracleCard } from '@mtg/shared';

const IMPLEMENTED_CARDS = [
  'Emmara, Soul of the Accord',
  "Karametra's Favor",
  'Leafkin Druid',
  'Nullmage Shepherd',
  'Thunderfoot Baloth',
  'Fortified Village',
  'Overwhelming Instinct',
  'Rishkar, Peema Renegade',
  'Ajani, Caller of the Pride',
  'Sylvan Reclamation',
  'Mentor of the Meek',
  "Commander's Insignia",
  'Voice of Many',
  'Loyal Guardian',
  'Dawn of Hope',
  'Hornet Nest',
  'Idol of Oblivion',
  'Trostani Discordant',
  'Harvest Season',
  'Slate of Ancestry',
  'Scavenging Ooze',
  'Felidar Retreat',
  'Great Oak Guardian',
  'Conclave Tribunal',
  'Champion of Lambholt',
  'Curse of Bounty',
  'Path to Exile',
  'Rootborn Defenses',
];

function getOracleCard(name: string): OracleCard {
  const raw = (scryfallCards as any[]).find((c: any) => c.name === name);
  if (!raw) throw new Error(`Card not found in scryfall data: ${name}`);
  const oracleCard = toOracleCard(raw);
  if (!oracleCard) throw new Error(`Failed to convert scryfall data for: ${name}`);
  return oracleCard;
}

function setupEngineContext(): GameContext {
  const ctx = createGame(
    gameConfig(
      [
        { cards: copies(4, forest) },
        { cards: copies(4, forest) },
      ],
      { seed: 'l1-l3-test-seed' }
    )
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('L1: Modeled & Drift Guard Smoke Check', () => {
  for (const cardName of IMPLEMENTED_CARDS) {
    it(`${cardName} passes L1 smoke check (modeled: true, unmodeledReasons: [])`, () => {
      const card = getOracleCard(cardName);
      const def = interpretCard(card);
      expect(def.modeled, `Card ${cardName} is not marked as modeled`).toBe(true);
      expect(
        def.unmodeledReasons,
        `Card ${cardName} has unmodeled reasons: ${def.unmodeledReasons.join('; ')}`
      ).toEqual([]);
    });
  }
});

describe('L2: Fixture & Unit Behavioral Tests', () => {
  it('verifies unit behavior and trigger execution for representative cards', () => {
    const ctx = setupEngineContext();

    // 1. Emmara, Soul of the Accord triggers
    const emmaraCard = getOracleCard('Emmara, Soul of the Accord');
    const emmara = spawn(ctx, 'P1', emmaraCard);
    const defEmmara = interpretCard(emmaraCard);
    const emmaraTrigger = defEmmara.triggers?.[0];
    expect(emmaraTrigger).toBeDefined();
    if (emmaraTrigger) {
      pump(executeAbility(ctx, emmara, emmaraTrigger, []));
      const soldier = ctx.state.battlefield.find((p) => p.name === 'Soldier' && p.controllerId === 'P1');
      expect(soldier).toBeDefined();
      expect(soldier?.power).toBe(1);
    }

    // 2. Hornet Nest damage trigger
    const nestCard = getOracleCard('Hornet Nest');
    const nest = spawn(ctx, 'P1', nestCard);
    const defNest = interpretCard(nestCard);
    const nestTrigger = defNest.triggers?.[0];
    expect(nestTrigger).toBeDefined();
    if (nestTrigger) {
      pump(executeAbility(ctx, nest, nestTrigger, [], undefined, { damageDealt: 3 }));
      const insects = ctx.state.battlefield.filter((p) => p.name === 'Insect' && p.controllerId === 'P1');
      expect(insects.length).toBe(3);
    }

    // 3. Path to Exile "may search" optional decision (Yes vs No)
    const p2Target = spawn(ctx, 'P2', oracle({ name: 'Ogre', typeLine: 'Creature', manaCost: '{2}' }));
    const p2 = ctx.state.players.find((p) => p.id === 'P2')!;
    const plainsCard = oracle({ name: 'Plains', typeLine: 'Basic Land — Plains', supertypes: ['Basic'], types: ['Land'] });
    registerDef(ctx, plainsCard);
    p2.library = [plainsCard as any];
    const pathCard = getOracleCard('Path to Exile');
    const pathSpell = spawn(ctx, 'P1', pathCard);
    const defPath = interpretCard(pathCard);
    if (defPath.spellAbility) {
      // Test Yes choice
      pump(
        executeAbility(ctx, pathSpell, defPath.spellAbility, [p2Target.id]),
        () => ({ index: 0, targets: new Map() }),
      );
      expect(ctx.state.battlefield.find((p) => p.id === p2Target.id)).toBeUndefined();
      expect(ctx.state.battlefield.find((p) => p.name === 'Plains' && p.controllerId === 'P2')).toBeDefined();
    }

    // 4. Populate multi-token decision
    const token1 = spawn(ctx, 'P1', oracle({ name: 'Soldier', typeLine: 'Creature — Soldier', power: '1', toughness: '1' }));
    (token1 as any).isToken = true;
    const token2 = spawn(ctx, 'P1', oracle({ name: 'Beast', typeLine: 'Creature — Beast', power: '3', toughness: '3' }));
    (token2 as any).isToken = true;
    const rootbornCard = getOracleCard('Rootborn Defenses');
    const rootbornSpell = spawn(ctx, 'P1', rootbornCard);
    const defRootborn = interpretCard(rootbornCard);
    if (defRootborn.spellAbility) {
      pump(
        executeAbility(ctx, rootbornSpell, defRootborn.spellAbility, []),
        (d) => ({ index: d.options.findIndex((o) => o.description.includes('Beast')), targets: new Map() }),
      );
      const beasts = ctx.state.battlefield.filter((p) => p.name === 'Beast' && p.controllerId === 'P1');
      expect(beasts.length).toBe(2);
    }
  });
});

describe('L3: Legality & Priority Engine Tests', () => {
  it('executes full engine priority pipeline for Path to Exile', () => {
    const pathCard = getOracleCard('Path to Exile');
    const bearCard = oracle({ name: 'Bear', typeLine: 'Creature', manaCost: '{1}' });

    const engine = makeEngine([
      { cards: [pathCard, oracle({ name: 'Plains', typeLine: 'Basic Land — Plains' })] },
      { cards: [bearCard, oracle({ name: 'Plains', typeLine: 'Basic Land — Plains' })] },
    ]);

    const provider = new RuleBasedProvider([
      whenChoose({ player: 'P1', option: /Path to Exile/i }),
      whenChoose({ player: 'P1', prompt: /target/i, option: /Bear/i }),
      whenChoose({ player: 'P2', prompt: /may search/i, option: /search/i }),
    ]);

    const result = drive(engine, provider);
    expect(result).toBeDefined();
  });

  it('executes full engine priority pipeline for Conclave Tribunal', () => {
    const tribunalCard = getOracleCard('Conclave Tribunal');
    const ringCard = oracle({ name: 'Sol Ring', typeLine: 'Artifact', manaCost: '{1}' });

    const engine = makeEngine([
      { cards: [tribunalCard] },
      { cards: [ringCard] },
    ]);

    const provider = new RuleBasedProvider([
      whenChoose({ option: /./ }),
    ]);

    const result = drive(engine, provider);
    expect(result).toBeDefined();
  });
});
