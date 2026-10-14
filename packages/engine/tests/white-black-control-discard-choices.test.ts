import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { Ability, Effect } from '../src/cards/ability';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlDiscardChoiceOverrides } from '../src/cards/overrides/white-black-control-discard-choices';
import { registerWhiteBlackControlDiscardOverrides } from '../src/cards/overrides/white-black-control-discard';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext, EnginePermanent } from '../src/state/types';
import { runCombatPhase } from '../src/combat/combat';
import { runPrioritySequence } from '../src/turn/priority';
import {
  copies,
  conjure,
  declareAttacks,
  doom,
  gameConfig,
  oracle,
  pick,
  pump,
  spawn,
  swamp,
} from './fixtures';

type MaybeAnswer = (decision: PendingDecision, count: number) => DecisionOutcome | undefined;

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}

const pinned = JSON.parse(
  readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8'),
) as { cards: PinnedCard[] };

const pins = {
  'Painful Quandary': '907cddfb6e25833cdd784e159a07b112cd910c9f95d9887bc51ce79c917b1424',
  'Rankle, Master of Pranks': '069593a2fb3dd2d4d28b5741f452ef3bad6c9662a747880792f1daa37e96836f',
  'Vicious Rumors': 'b09bf3c311377c7f92e925e5eabbdd4aefb978e905e525d70acc5a8429dec5a2',
  "Geth's Grimoire": '5b69db18aafa89cd067bbe5be9d0b6397b00200abe381fbfea927a3d6e682a91',
} as const;

const cards = new Map<keyof typeof pins, PinnedCard>();
for (const [name, sha256] of Object.entries(pins) as [keyof typeof pins, string][]) {
  const entry = pinned.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing pinned Oracle card: ${name}`);
  if (entry.sha256 !== sha256) throw new Error(`Oracle hash drift for ${name}`);
  cards.set(name, entry);
}

beforeAll(() => {
  registerWhiteBlackControlDiscardOverrides();
  registerWhiteBlackControlDiscardChoiceOverrides();
});

function card(name: keyof typeof pins): OracleCard {
  const entry = cards.get(name);
  if (entry === undefined) throw new Error(`Missing pinned card ${name}`);
  return entry.card;
}

function context(seed = 'white-black-control-discard-choices'): GameContext {
  const ctx = createGame(
    gameConfig(Array.from({ length: 4 }, () => ({ cards: copies(12, swamp) })), { seed }),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}

function player(ctx: GameContext, playerId: string): EnginePlayerState {
  const found = ctx.state.players.find((candidate) => candidate.id === playerId);
  if (found === undefined) throw new Error(`Missing player ${playerId}`);
  return found;
}

function handCard(
  name: string,
  typeLine = 'Basic Land — Test',
  manaCost: string | null = null,
): OracleCard {
  return oracle({ name, typeLine, manaCost, cmc: 0, power: null, toughness: null });
}

function creature(name: string): OracleCard {
  return oracle({
    name,
    typeLine: 'Creature — Bear',
    manaCost: '{1}{G}',
    power: '2',
    toughness: '2',
  });
}

function putInHand(ctx: GameContext, playerId: string, ...names: string[]): void {
  for (const name of names) conjure(ctx, playerId, handCard(name), 'hand');
}

function castCardFromHand(
  ctx: GameContext,
  playerId: string,
  spellCard: OracleCard,
  targets: ReadonlyMap<number, string> = new Map(),
  answer?: MaybeAnswer,
): void {
  conjure(ctx, playerId, spellCard, 'hand');
  let cast = false;
  pump(runPrioritySequence(ctx), (decision, count) => {
    if (decision.decisionType === 'priority' && decision.player === playerId && !cast) {
      const index = decision.options.findIndex(
        (option) => option.type === 'castSpell' && option.description.includes(spellCard.name),
      );
      if (index >= 0) {
        cast = true;
        return { index, targets };
      }
    }
    const answered = answer?.(decision, count);
    if (answered !== undefined) return answered;
    if (decision.options.some((option) => /Pass|does not/i.test(option.description)))
      return pick(decision, /Pass|does not/i);
    return { index: 0, targets: new Map() };
  });
  expect(cast, `cast ${spellCard.name} from hand through priority`).toBe(true);
}

function castPainfulQuandary(ctx: GameContext, count = 1): EnginePermanent[] {
  for (let index = 0; index < 5 * count; index++) spawn(ctx, 'P1', swamp());
  const permanents: EnginePermanent[] = [];
  for (let index = 0; index < count; index++) {
    castCardFromHand(ctx, 'P1', card('Painful Quandary'));
    const permanent = ctx.state.battlefield.find(
      (candidate) => candidate.name === 'Painful Quandary' && !permanents.includes(candidate),
    );
    if (permanent === undefined) throw new Error('Painful Quandary failed its normal cast');
    permanents.push(permanent);
  }
  return permanents;
}

function castRankle(ctx: GameContext): EnginePermanent {
  for (let index = 0; index < 4; index++) spawn(ctx, 'P1', swamp());
  castCardFromHand(ctx, 'P1', card('Rankle, Master of Pranks'));
  const rankle = ctx.state.battlefield.find(
    (candidate) => candidate.name === 'Rankle, Master of Pranks',
  );
  if (rankle === undefined) throw new Error('Rankle failed its normal cast');
  return rankle;
}

function rankleCombat(
  ctx: GameContext,
  chooseModes: (descriptions: string[]) => string,
  onDecision?: MaybeAnswer,
): void {
  ctx.state.phase = 'combat';
  pump(runCombatPhase(ctx), (decision, count) => {
    if (decision.decisionType === 'declareAttackers')
      return declareAttacks(decision, (_id, subject) =>
        subject.name === 'Rankle, Master of Pranks' ? 'P2' : null,
      );
    if (decision.prompt.toLowerCase().includes('choose modes')) {
      const descriptions = decision.options.map((option) => option.description);
      const wanted = chooseModes(descriptions);
      const index = descriptions.indexOf(wanted);
      if (index < 0) throw new Error(`Missing Rankle mode choice: ${wanted}`);
      return { index, targets: new Map() };
    }
    return onDecision?.(decision, count) ?? pick(decision, /Pass|does not/i);
  });
}

describe('white-black-control discard-choice cards — pinned Oracle', () => {
  it('pins each card hash and applies the local override', () => {
    for (const name of Object.keys(pins) as (keyof typeof pins)[]) {
      expect(cards.get(name)?.sha256).toBe(pins[name]);
      expect(interpretCard(card(name)).modeled, name).toBe(true);
      expect(interpretCard(card(name)).unmodeledReasons, name).toEqual([]);
    }
  });

  it('painful-quandary-c01-positive — an opponent may discard to avoid the five-life loss', () => {
    const ctx = context('painful-quandary-discard');
    player(ctx, 'P2').life = 40;
    castPainfulQuandary(ctx);
    spawn(ctx, 'P1', creature('Painful Quandary Doom Target'));
    spawn(ctx, 'P2', swamp());
    putInHand(ctx, 'P2', 'P2 Choice One', 'P2 Choice Two');

    let choices = 0;
    castCardFromHand(ctx, 'P2', doom(), new Map([[0, ctx.state.battlefield.find((perm) => perm.name === 'Painful Quandary Doom Target')!.id]]), (decision) => {
      if (!decision.prompt.includes('Discard a card or lose 5 life.')) return undefined;
      choices++;
      expect(decision.player).toBe('P2');
      return pick(decision, 'Discard P2 Choice Two');
    });

    expect(choices).toBe(1);
    expect(player(ctx, 'P2').life).toBe(40);
    expect(player(ctx, 'P2').graveyard.map((entry) => entry.name)).toContain('P2 Choice Two');
    expect(player(ctx, 'P2').hand.map((entry) => entry.name)).toEqual(['P2 Choice One']);
  });

  it('painful-quandary-c01-positive — declining costs five life and two copies ask separately', () => {
    const declined = context('painful-quandary-decline');
    player(declined, 'P2').life = 40;
    castPainfulQuandary(declined);
    spawn(declined, 'P1', creature('Decline Doom Target'));
    spawn(declined, 'P2', swamp());
    putInHand(declined, 'P2', 'P2 Keeps This');
    const target = declined.state.battlefield.find((perm) => perm.name === 'Decline Doom Target')!;
    castCardFromHand(declined, 'P2', doom(), new Map([[0, target.id]]), (decision) =>
      decision.prompt.includes('Discard a card or lose 5 life.')
        ? pick(decision, 'Lose 5 life')
        : undefined,
    );
    expect(player(declined, 'P2').life).toBe(35);
    expect(player(declined, 'P2').hand.map((entry) => entry.name)).toEqual(['P2 Keeps This']);

    const doubled = context('painful-quandary-two-copies');
    player(doubled, 'P2').life = 40;
    castPainfulQuandary(doubled, 2);
    spawn(doubled, 'P1', creature('Two Quandary Doom Target'));
    spawn(doubled, 'P2', swamp());
    putInHand(doubled, 'P2', 'P2 First Discard', 'P2 Second Discard', 'P2 Reserve');
    const secondTarget = doubled.state.battlefield.find(
      (perm) => perm.name === 'Two Quandary Doom Target',
    )!;
    const decisions: string[] = [];
    castCardFromHand(doubled, 'P2', doom(), new Map([[0, secondTarget.id]]), (decision) => {
      if (!decision.prompt.includes('Discard a card or lose 5 life.')) return undefined;
      decisions.push(decision.prompt);
      const choice = decision.options.find((option) => option.description.startsWith('Discard '));
      if (choice === undefined) throw new Error('Painful Quandary omitted the discard option');
      return { index: decision.options.indexOf(choice), targets: new Map() };
    });
    expect(decisions).toHaveLength(2);
    expect(player(doubled, 'P2').life).toBe(40);
    expect(player(doubled, 'P2').graveyard.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['P2 First Discard', 'P2 Second Discard', 'Test Doom']),
    );
    expect(player(doubled, 'P2').hand.map((entry) => entry.name)).toEqual(['P2 Reserve']);
  });

  it('painful-quandary-c01-negative — own casts do not trigger it, and an empty opponent hand loses five', () => {
    const ownCast = context('painful-quandary-own-cast');
    player(ownCast, 'P1').life = 40;
    castPainfulQuandary(ownCast);
    spawn(ownCast, 'P1', swamp());
    spawn(ownCast, 'P2', creature('Own Cast Doom Target'));
    castCardFromHand(
      ownCast,
      'P1',
      doom(),
      new Map([[0, ownCast.state.battlefield.find((perm) => perm.name === 'Own Cast Doom Target')!.id]]),
    );
    expect(player(ownCast, 'P1').life).toBe(40);
    expect(ownCast.state.stack).toHaveLength(0);
    expect(ownCast.state.pendingTriggers).toHaveLength(0);

    const empty = context('painful-quandary-empty-hand');
    player(empty, 'P2').life = 40;
    castPainfulQuandary(empty);
    spawn(empty, 'P1', creature('Empty Hand Doom Target'));
    spawn(empty, 'P2', swamp());
    const target = empty.state.battlefield.find((perm) => perm.name === 'Empty Hand Doom Target')!;
    castCardFromHand(empty, 'P2', doom(), new Map([[0, target.id]]));
    expect(player(empty, 'P2').life).toBe(35);
    expect(player(empty, 'P2').hand).toHaveLength(0);
    expect(player(empty, 'P2').graveyard).toHaveLength(1);
    expect(player(empty, 'P2').graveyard[0]?.name).toBe('Test Doom');
  });

  it('rankle-master-of-pranks-c01/c02-positive — casts normally with flying and haste and offers zero, one, or all modes', () => {
    const make = (seed: string) => {
      const ctx = context(seed);
      const rankle = castRankle(ctx);
      expect(computeCharacteristics(ctx, rankle).keywords).toEqual(
        expect.arrayContaining(['flying', 'haste']),
      );
      return { ctx, rankle };
    };

    const zero = make('rankle-zero-modes');
    rankleCombat(zero.ctx, (descriptions) => {
      expect(descriptions).toHaveLength(8);
      expect(descriptions).toContain('');
      return '';
    });
    expect(player(zero.ctx, 'P2').life).toBe(37);
    expect(player(zero.ctx, 'P1').life).toBe(40);
    expect(zero.ctx.state.eventLog.filter((event) => event.type === 'discard')).toHaveLength(0);

    const one = make('rankle-one-mode');
    rankleCombat(one.ctx, (descriptions) => {
      expect(descriptions).toHaveLength(8);
      return 'Each player loses 1 life and draws a card';
    });
    for (const id of ['P1', 'P2', 'P3', 'P4']) {
      expect(player(one.ctx, id).cardsDrawnThisTurn).toBe(1);
      expect(player(one.ctx, id).life).toBe(id === 'P2' ? 36 : 39);
    }

    const all = make('rankle-all-modes');
    spawn(all.ctx, 'P1', creature('P1 Sacrifice Bear'));
    spawn(all.ctx, 'P2', creature('P2 Sacrifice Bear One'));
    spawn(all.ctx, 'P2', creature('P2 Sacrifice Bear Two'));
    for (const id of ['P1', 'P2', 'P3']) putInHand(all.ctx, id, `${id} First`, `${id} Chosen`);
    const originalHands = new Map(
      all.ctx.state.players.map((entry) => [entry.id, entry.hand.map((object) => object.name)]),
    );
    const discardDecisionOrder: string[] = [];
    const sacrificeDecisionOrder: string[] = [];
    rankleCombat(
      all.ctx,
      (descriptions) => {
        const allModes =
          'Each player discards a card; Each player loses 1 life and draws a card; Each player sacrifices a creature';
        expect(descriptions).toContain(allModes);
        return allModes;
      },
      (decision) => {
        if (decision.prompt.startsWith('Discard a card (')) {
          discardDecisionOrder.push(decision.player);
          expect(all.ctx.state.eventLog.some((event) => event.type === 'discard')).toBe(false);
          for (const [id, names] of originalHands)
            expect(player(all.ctx, id).hand.map((object) => object.name)).toEqual(names);
          return pick(decision, `Discard ${decision.player} Chosen`);
        }
        if (decision.prompt.includes('choose a creature to sacrifice')) {
          sacrificeDecisionOrder.push(decision.player);
          if (decision.player === 'P1') return pick(decision, 'P1 Sacrifice Bear');
          if (decision.player === 'P2') return pick(decision, 'P2 Sacrifice Bear Two');
        }
        return undefined;
      },
    );
    expect(discardDecisionOrder).toEqual(['P1', 'P2', 'P3']);
    expect(sacrificeDecisionOrder).toEqual(['P1', 'P2']);
    for (const id of ['P1', 'P2', 'P3', 'P4']) {
      expect(player(all.ctx, id).cardsDrawnThisTurn).toBe(1);
      expect(player(all.ctx, id).life).toBe(id === 'P2' ? 36 : 39);
    }
    expect(player(all.ctx, 'P1').graveyard.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['P1 Chosen', 'P1 Sacrifice Bear']),
    );
    expect(player(all.ctx, 'P2').graveyard.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['P2 Chosen', 'P2 Sacrifice Bear Two']),
    );
    expect(player(all.ctx, 'P3').graveyard.map((entry) => entry.name)).toEqual(['P3 Chosen']);
    expect(player(all.ctx, 'P4').graveyard).toHaveLength(0);
    expect(all.ctx.state.battlefield.some((perm) => perm.name === 'Rankle, Master of Pranks')).toBe(
      true,
    );
  });

  it('rankle-master-of-pranks-c02-negative — noncombat damage does not trigger the combat-damage modes', () => {
    const ctx = context('rankle-noncombat-damage');
    const rankle = castRankle(ctx);
    const source = {
      id: rankle.id,
      cardId: rankle.cardId,
      name: rankle.name,
      oracleId: rankle.oracleId,
      controllerId: rankle.controllerId,
    };
    pump(
      executeAbility(
        ctx,
        source,
        {
          kind: 'activated',
          targets: [{ kind: 'player' }],
          effects: [{ op: 'dealDamage', target: 0, amount: { kind: 'const', n: 1 } }],
        },
        ['P2'],
      ),
    );
    expect(player(ctx, 'P2').life).toBe(39);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('vicious-rumors-c01-positive — damages opponents, then discards, mills, and gains one life', () => {
    const ctx = context('vicious-rumors-order');
    player(ctx, 'P1').life = 40;
    putInHand(ctx, 'P1', 'Vicious Owner Card');
    const ownerLibraryCard = handCard('Vicious Owner Library');
    conjure(ctx, 'P1', ownerLibraryCard, 'library');
    const ownerLibraryBefore = player(ctx, 'P1').library.map((entry) => entry.name);
    putInHand(ctx, 'P2', 'P2 Discard');
    putInHand(ctx, 'P3', 'P3 Discard');
    putInHand(ctx, 'P4', 'P4 Discard');
    for (const id of ['P2', 'P3', 'P4']) {
      player(ctx, id).library.splice(0);
      conjure(ctx, id, handCard(`${id} Mill`), 'library');
    }
    spawn(ctx, 'P1', swamp());

    castCardFromHand(ctx, 'P1', card('Vicious Rumors'));

    expect(player(ctx, 'P1').life).toBe(41);
    expect(player(ctx, 'P1').hand.map((entry) => entry.name)).toEqual(['Vicious Owner Card']);
    expect(player(ctx, 'P1').library.map((entry) => entry.name)).toEqual(ownerLibraryBefore);
    for (const id of ['P2', 'P3', 'P4']) {
      expect(player(ctx, id).life).toBe(39);
      expect(player(ctx, id).graveyard.map((entry) => entry.name)).toEqual([
        `${id} Discard`,
        `${id} Mill`,
      ]);
      expect(player(ctx, id).hand).toHaveLength(0);
      expect(player(ctx, id).library).toHaveLength(0);
    }
    const relevant = ctx.state.eventLog.filter((event) =>
      ['damage', 'discard', 'mill', 'lifeGain'].includes(event.type),
    );
    expect(relevant.map((event) => event.type)).toEqual([
      'damage', 'damage', 'damage', 'discard', 'discard', 'discard', 'mill', 'mill', 'mill', 'lifeGain',
    ]);
    expect(relevant.slice(0, 3).map((event) => event.payload['target'])).toEqual(['P2', 'P3', 'P4']);
    expect(relevant.slice(3, 6).map((event) => event.payload['player'])).toEqual(['P2', 'P3', 'P4']);
    expect(relevant.slice(6, 9).map((event) => event.payload['player'])).toEqual(['P2', 'P3', 'P4']);
    expect(relevant.at(-1)?.payload).toMatchObject({ player: 'P1', amount: 1, life: 41 });
  });

  it('vicious-rumors-c01-negative — empty hands and libraries are safe; mills do not trigger discard', () => {
    const ctx = context('vicious-rumors-empty-and-mill-events');
    const grimoire = card("Geth's Grimoire");
    spawn(ctx, 'P3', grimoire);
    putInHand(ctx, 'P1', 'Rumor Owner Card');
    putInHand(ctx, 'P2', 'P2 Discard');
    putInHand(ctx, 'P3', 'P3 Discard');
    for (const id of ['P2', 'P3', 'P4']) player(ctx, id).library.splice(0);
    conjure(ctx, 'P3', handCard('P3 Draw One'), 'library');
    conjure(ctx, 'P3', handCard('P3 Mill'), 'library');
    conjure(ctx, 'P4', handCard('P4 Mill'), 'library');
    spawn(ctx, 'P1', swamp());

    let grimoireChoices = 0;
    castCardFromHand(ctx, 'P1', card('Vicious Rumors'), new Map(), (decision) => {
      if (decision.prompt.includes('draw a card')) {
        grimoireChoices++;
        expect(decision.player).toBe('P3');
        return pick(decision, 'Yes');
      }
      return undefined;
    });

    expect(grimoireChoices).toBe(1);
    expect(player(ctx, 'P1').hand.map((entry) => entry.name)).toEqual(['Rumor Owner Card']);
    expect(player(ctx, 'P2').life).toBe(39);
    expect(player(ctx, 'P2').hand).toHaveLength(0);
    expect(player(ctx, 'P2').library).toHaveLength(0);
    expect(player(ctx, 'P2').graveyard.map((entry) => entry.name)).toEqual(['P2 Discard']);
    expect(player(ctx, 'P3').graveyard.map((entry) => entry.name)).toContain('P3 Discard');
    expect(player(ctx, 'P3').graveyard.map((entry) => entry.name)).toContain('P3 Mill');
    expect(player(ctx, 'P3').hand.map((entry) => entry.name)).toEqual(['P3 Draw One']);
    expect(player(ctx, 'P4').hand).toHaveLength(0);
    expect(player(ctx, 'P4').life).toBe(39);
    expect(player(ctx, 'P4').graveyard.map((entry) => entry.name)).toEqual(['P4 Mill']);
    expect(player(ctx, 'P2').hasLost).toBe(false);
    expect(player(ctx, 'P4').hasLost).toBe(false);
    expect(ctx.state.eventLog.filter((event) => event.type === 'discard')).toHaveLength(2);
    expect(ctx.state.eventLog.filter((event) => event.type === 'mill')).toHaveLength(2);
    expect(ctx.state.eventLog.filter((event) => event.type === 'draw')).toHaveLength(1);
    expect(ctx.state.eventLog.filter((event) => event.type === 'lifeGain')).toHaveLength(1);
  });

  it('structurally rejects player-reference and discard-scope mismatches', () => {
    const malformedTarget = interpretCard(card('Vicious Rumors'));
    malformedTarget.spellAbility = {
      kind: 'spell',
      targets: [{ kind: 'creature' }],
      effects: [{ op: 'discardTarget', target: 0, count: { kind: 'const', n: 1 } }],
    };
    expect(validateCardDefinition(malformedTarget).map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('creature is incompatible with effect domains player'),
      ]),
    );

    const malformedScope = interpretCard(card('Vicious Rumors'));
    malformedScope.spellAbility = {
      kind: 'spell',
      targets: [],
      effects: [
        {
          op: 'discardEachPlayer',
          scope: 'self',
          count: { kind: 'const', n: 1 },
        } as unknown as Effect,
      ],
    };
    expect(validateCardDefinition(malformedScope).map((issue) => issue.message)).toContain(
      'discard requires all players or opponents',
    );

    const misplacedEventPlayer = interpretCard(card('Vicious Rumors'));
    misplacedEventPlayer.spellAbility = {
      kind: 'spell',
      targets: [],
      effects: [
        { op: 'discardOrLoseLife', target: 'eventPlayer', amount: { kind: 'const', n: 5 } },
      ],
    } as Ability;
    expect(validateCardDefinition(misplacedEventPlayer).length).toBeGreaterThan(0);
  });
});
