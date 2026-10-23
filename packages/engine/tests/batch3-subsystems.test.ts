import { describe, expect, it } from 'vitest';
import { executeAbility } from '../src/effects/resolve';
import { moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { interpretCard } from '../src/cards/interpret';

function setupGame() {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(6, forest) })),
      { seed: 'batch3-test' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

describe('Batch 3 subsystems and card overrides', () => {
  it('exileUntilSourceLeaves exiles target and returns it when source leaves battlefield', () => {
    const ctx = setupGame();
    const target = spawn(
      ctx,
      'P2',
      oracle({ name: 'Sol Ring', typeLine: 'Artifact', manaCost: '{1}' }),
    );
    const tribunal = spawn(
      ctx,
      'P1',
      oracle({ name: 'Conclave Tribunal', typeLine: 'Enchantment', manaCost: '{3}{W}' }),
    );

    pump(
      executeAbility(
        ctx,
        {
          cardId: tribunal.cardId,
          name: tribunal.name,
          oracleId: tribunal.oracleId,
          controllerId: tribunal.controllerId,
        },
        {
          kind: 'triggered',
          targets: [{ kind: 'nonlandPermanent', controller: 'opponent' }],
          effects: [{ op: 'exileUntilSourceLeaves', targetSlot: 0 }],
          description: 'Exile until leaves',
        },
        [target.id],
      ),
    );

    expect(ctx.state.battlefield.find((p) => p.id === target.id)).toBeUndefined();
    expect(ctx.state.exiledUntilLeaves[tribunal.cardId]).toHaveLength(1);

    // Tribunal leaves battlefield
    pump(moveObject(ctx, tribunal, { zone: 'graveyard' }));

    // Target returned to battlefield
    const returned = ctx.state.battlefield.find((p) => p.cardId === target.cardId);
    expect(returned).toBeDefined();
    expect(returned?.controllerId).toBe('P2');
  });

  it('Path to Exile exiles target and target controller searches for basic land', () => {
    const ctx = setupGame();
    const p2 = ctx.state.players.find((p) => p.id === 'P2')!;
    p2.library = [
      {
        id: '200',
        cardId: 'f1',
        oracleId: 'oracle-forest',
        ownerId: 'P2',
        name: 'Forest',
        typeLine: 'Basic Land — Forest',
        oracleText: '',
        manaCost: null,
        isToken: false,
        isCommander: false,
        zone: 'library',
      },
    ];
    const bear = spawn(ctx, 'P2', oracle({ name: 'Bear', typeLine: 'Creature', manaCost: '{1}' }));
    const path = spawn(
      ctx,
      'P1',
      oracle({ name: 'Path to Exile', typeLine: 'Instant', manaCost: '{W}' }),
    );

    pump(
      executeAbility(
        ctx,
        {
          cardId: path.cardId,
          name: path.name,
          oracleId: path.oracleId,
          controllerId: path.controllerId,
        },
        {
          kind: 'spell',
          targets: [{ kind: 'creature' }],
          effects: [{ op: 'exileTargetAndControllerMaySearchBasicLandTapped', targetSlot: 0 }],
          description: 'Path to Exile',
        },
        [bear.id],
      ),
      () => ({ index: 0, targets: new Map() }),
    );

    expect(ctx.state.battlefield.find((p) => p.id === bear.id)).toBeUndefined();
    const searchedForest = ctx.state.battlefield.find(
      (p) => p.name === 'Forest' && p.controllerId === 'P2',
    );
    expect(searchedForest).toBeDefined();
    expect(searchedForest?.tapped).toBe(true);
  });

  it('Populate creates a copy of a controlled token creature', () => {
    const ctx = setupGame();
    const token = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Cat Beast',
        typeLine: 'Creature — Cat Beast',
        manaCost: '',
        power: '2',
        toughness: '2',
      }),
    );
    token.isToken = true;

    const source = spawn(
      ctx,
      'P1',
      oracle({ name: 'Rootborn Defenses', typeLine: 'Instant', manaCost: '{2}{W}' }),
    );

    pump(
      executeAbility(
        ctx,
        {
          cardId: source.cardId,
          name: source.name,
          oracleId: source.oracleId,
          controllerId: source.controllerId,
        },
        {
          kind: 'spell',
          targets: [],
          effects: [{ op: 'populate' }],
          description: 'Populate',
        },
        [],
      ),
    );

    const tokens = ctx.state.battlefield.filter(
      (p) => p.controllerId === 'P1' && p.isToken && p.name === 'Cat Beast',
    );
    expect(tokens).toHaveLength(2);
  });

  it('models all 5 Batch 3 cards', () => {
    const tribunal = interpretCard(
      oracle({
        oracleId: 'e938ee4c-d5df-4d93-bd61-9e518fb1dc30',
        name: 'Conclave Tribunal',
        typeLine: 'Enchantment',
        manaCost: '{3}{W}',
        oracleText:
          'Convoke\nWhen Conclave Tribunal enters, exile target nonland permanent an opponent controls until Conclave Tribunal leaves the battlefield.',
      }),
    );
    // Restored in coverage PR02: convoke is a real payment (pr02-card-coverage.test.ts).
    expect(tribunal.modeled).toBe(true);
    expect(tribunal.ruleStatics).toContainEqual({ kind: 'convoke' });

    const champion = interpretCard(
      oracle({
        oracleId: 'c549b0fd-1e08-4873-952e-a14dc45a0fd2',
        name: 'Champion of Lambholt',
        typeLine: 'Creature — Human Warrior',
        manaCost: '{1}{G}{G}',
        oracleText:
          "Creatures with power less than this creature's power can't block creatures you control.\nWhenever another creature you control enters, put a +1/+1 counter on this creature.",
      }),
    );
    // Restored in coverage PR07: a rule static of the Champion, not a name check
    // (pr07-card-coverage.test.ts).
    expect(champion.modeled).toBe(true);
    expect(champion.ruleStatics).toMatchObject([{ kind: 'cantBlockCreatures' }]);

    const curse = interpretCard(
      oracle({
        oracleId: 'b6689782-08d8-48e1-a05d-cd040dfe85bc',
        name: 'Curse of Bounty',
        typeLine: 'Enchantment — Aura Curse',
        manaCost: '{1}{G}',
        oracleText:
          'Enchant player\nWhenever enchanted player is attacked, untap all nonland permanents you control. Each opponent attacking that player untaps all nonland permanents they control.',
      }),
    );
    // Restored in coverage PR05: the curse controller and an attacking opponent both untap
    // (pr05-card-coverage.test.ts).
    expect(curse.modeled).toBe(true);
    expect(curse.unmodeledReasons).toEqual([]);

    const path = interpretCard(
      oracle({
        oracleId: 'd683d985-9888-4d21-8b5f-69e69ce4a03b',
        name: 'Path to Exile',
        typeLine: 'Instant',
        manaCost: '{W}',
        oracleText:
          'Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle.',
      }),
    );
    expect(path.modeled).toBe(true);

    const rootborn = interpretCard(
      oracle({
        oracleId: '04046ae4-5c51-434b-930c-f3b1d348bf4b',
        name: 'Rootborn Defenses',
        typeLine: 'Instant',
        manaCost: '{2}{W}',
        oracleText: 'Populate. Creatures you control gain indestructible until end of turn.',
      }),
    );
    expect(rootborn.modeled).toBe(true);
  });
});
