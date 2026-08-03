import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OracleCard, ServerToClientMessage } from '@mtg/shared';
import { RandomDecisionProvider } from '@mtg/engine';
import { executeAbility } from '../../../engine/src/effects/resolve';
import { createGame } from '../../../engine/src/state/game';
import type { GameContext } from '../../../engine/src/state/types';
import { copies, forest, gameConfig, oracle, pump, spawn } from '../../../engine/tests/fixtures';
import { interpretCard } from '../../../engine/src/cards/interpret';
import { MatchSession } from '../match/session';
import type { SeatSetup } from '../match/setup';
import { parsePlaintextDeck } from '../decks/plaintext';
import scryfallCards from '../../../../data/scryfall-oracle-cards.json' assert { type: 'json' };
import { toOracleCard } from './scryfall';

const livingFixture = resolve('packages/server/fixtures/coverage-decks/living-energy.txt');
const livingParsed = parsePlaintextDeck(readFileSync(livingFixture, 'utf8'));
const oracleByName = new Map<string, OracleCard>();
for (const raw of scryfallCards as any[]) {
  const card = toOracleCard(raw);
  if (card !== null) oracleByName.set(card.name, card);
}

function realCard(name: string): OracleCard {
  const card = oracleByName.get(name);
  if (card === undefined) throw new Error(`Card not found in Scryfall data: ${name}`);
  return card;
}

function pod(seats = 3): GameContext {
  const ctx = createGame(
    gameConfig(Array.from({ length: seats }, () => ({ cards: copies(8, forest) })), {
      seed: 'living-energy-focused-test',
    }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

function livingDeckCards(): { commander: OracleCard; cards: OracleCard[] } {
  const commanderName = livingParsed.commanderNames[0];
  if (commanderName === undefined) throw new Error('Living Energy fixture has no commander');
  const cards = livingParsed.cards.flatMap(({ name, quantity }) =>
    Array.from({ length: quantity }, () => realCard(name)),
  );
  return { commander: realCard(commanderName), cards };
}

function livingSeat(seat: string, commander: OracleCard, cards: OracleCard[]): SeatSetup {
  return {
    seat,
    deckSnapshotId: null,
    config: { id: seat, deckId: `living-energy-${seat}`, commanders: [commander], cards },
    summary: {
      seat,
      deckId: `living-energy-${seat}`,
      label: 'Living Energy',
      commanderNames: [commander.name],
      colorIdentity: [...commander.colorIdentity],
      archetypeTag: 'Temur — Living Energy',
    },
  };
}

describe('Living Energy modeled-card and player-experience checks', () => {
  it('models every unique card in the committed deck fixture', () => {
    const names = new Set([
      ...livingParsed.commanderNames,
      ...livingParsed.cards.map((entry) => entry.name),
    ]);
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      const def = interpretCard(realCard(name));
      expect(def.modeled, `${name} is not modeled`).toBe(true);
      expect(def.unmodeledReasons, `${name} still has parser reasons`).toEqual([]);
    }
  });

  it('asks for one aggregated energy amount and applies that amount once', () => {
    const ctx = pod(2);
    const kite = spawn(ctx, 'P1', realCard('Territorial Aetherkite'));
    const opposingCreature = spawn(
      ctx,
      'P2',
      oracle({ name: 'Opposing Creature', typeLine: 'Creature — Test', power: '5', toughness: '5' }),
    );
    ctx.state.players.find((player) => player.id === 'P1')!.energy = 1;

    const trigger = interpretCard(realCard('Territorial Aetherkite')).triggers![0]!;
    const { decisions } = pump(executeAbility(ctx, kite, trigger, []), (decision) => {
      expect(decision.prompt).toContain('one decision');
      expect(decision.options.map((option) => option.description)).toEqual([
        'Pay no energy',
        'Pay 1 energy',
        'Pay 2 energy',
        'Pay 3 energy',
      ]);
      return { index: 3, targets: new Map() };
    });

    expect(decisions).toHaveLength(1);
    expect(ctx.state.players.find((player) => player.id === 'P1')!.energy).toBe(0);
    expect(opposingCreature.damageMarked).toBe(3);
  });

  it('presents Druid of Purification choices as card subjects with a clear skip option', () => {
    const ctx = pod(3);
    const druid = spawn(ctx, 'P1', realCard('Druid of Purification'));
    spawn(ctx, 'P2', realCard('Sol Ring'));
    spawn(ctx, 'P3', realCard('Treasure Vault'));
    const trigger = interpretCard(realCard('Druid of Purification')).triggers![0]!;

    const { decisions } = pump(executeAbility(ctx, druid, trigger, []), () => ({
      index: 0,
      targets: new Map(),
    }));

    expect(decisions).toHaveLength(3);
    for (const decision of decisions) {
      expect(decision.options[0]?.description).toBe('Choose none');
      const cardChoices = decision.options.filter((option) => option.type === 'destroy');
      expect(cardChoices.length).toBeGreaterThan(0);
      for (const option of cardChoices) {
        expect(option.presentation?.subjects).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: 'card' })]),
        );
      }
    }
  });

  it('starts a real living-energy deck in single-player mode and waits for the human action', async () => {
    const { commander, cards } = livingDeckCards();
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      gameId: 'living-energy-single-player',
      seed: 'living-energy-single-player',
      seats: ['P1', 'P2', 'P3', 'P4'].map((seat) => livingSeat(seat, commander, cards)),
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      turnCap: 12,
      livePaceMs: 0,
      send: (message) => sent.push(message),
    });
    session.start();

    const deadline = Date.now() + 8_000;
    while (
      !sent.some((message) => message.type === 'playerActionRequired') &&
      Date.now() < deadline
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    const required = sent.find(
      (message): message is Extract<ServerToClientMessage, { type: 'playerActionRequired' }> =>
        message.type === 'playerActionRequired',
    );
    expect(required).toBeDefined();
    expect(sent.some((message) => message.type === 'error')).toBe(false);

    const chooser = new RandomDecisionProvider('living-energy-human-check');
    const response = chooser.decide(required!.payload.request);
    session.submitPlayerAction({
      requestId: response.requestId,
      actionId: response.actionId,
      revision: required!.payload.revision,
      ...(response.targets !== undefined ? { targets: response.targets } : {}),
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    session.abandon();
    await session.settled();
  }, 12_000);
});
