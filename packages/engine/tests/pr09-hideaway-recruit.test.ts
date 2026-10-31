import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard, PlayerId } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { addMana } from '../src/mana/pool';
import { changeController, moveObject, playerById } from '../src/state/objects';
import { createGame } from '../src/state/game';
import { runCombatPhase } from '../src/combat/combat';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { computeCharacteristics } from '../src/effects/continuous';
import { buildPlayerBoardState } from '../src/view/spectator';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import type { EnginePermanent, GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  declareAttacks,
  forest,
  gameConfig,
  oracle,
  pump,
  pumpStrict,
  spawn,
} from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const pins = (
  JSON.parse(
    readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
  ) as PinnedFixture
).cards;
const rabblePin = pins.find(({ card }) => card.name === 'Rabble Rousing')!;
const celebratePin = pins.find(({ card }) => card.name === 'Celebrate the Mountain-king')!;

type Answer = (decision: PendingDecision, count: number) => DecisionOutcome;

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(12, forest) })),
      { seed },
    ),
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

function outcome(index: number, targets: ReadonlyMap<number, string> = new Map()) {
  return { index, targets };
}

function pass(decision: PendingDecision) {
  const index = decision.options.findIndex((option) => option.type === 'pass');
  return outcome(index < 0 ? 0 : index);
}

/** The triggers in this file are mandatory: none may ask "use this ability?" before its effects. */
function expectMandatory(decision: PendingDecision) {
  expect(decision.decisionType).not.toBe('optionalTrigger');
}

function settle(ctx: GameContext, answer?: Answer) {
  return pump(
    runPrioritySequence(ctx),
    (decision, count) => {
      expectMandatory(decision);
      return answer?.(decision, count) ?? pass(decision);
    },
    { strict: true },
  );
}

function castOption(ctx: GameContext, playerId: PlayerId, objectId: string) {
  return computePriorityOptions(ctx, playerById(ctx, playerId)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });
}

function payCast(
  ctx: GameContext,
  playerId: PlayerId,
  card: OracleCard,
  mana: ('C' | 'W')[],
  answer?: Answer,
) {
  const hand = conjure(ctx, playerId, card, 'hand');
  addMana(
    playerById(ctx, playerId),
    mana.map((symbol) => ({ symbol })),
  );
  const option = castOption(ctx, playerId, hand.id);
  expect(option, `${card.name} is offered through normal casting`).toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  const result = settle(ctx, answer);
  const permanent = ctx.state.battlefield.find((object) => object.cardId === hand.cardId);
  return { hand, permanent, decisions: result.decisions };
}

function rabbleMana(): ('C' | 'W')[] {
  return ['C', 'C', 'C', 'C', 'W'];
}

function celebrateMana(): ('C' | 'W')[] {
  return ['C', 'C', 'C', 'W'];
}

function simpleArtifact(name: string): OracleCard {
  return oracle({ name, typeLine: 'Artifact', manaCost: '{1}', oracleText: '' });
}

function simpleCreature(name: string, oracleText = ''): OracleCard {
  return oracle({
    name,
    typeLine: 'Creature — Bear',
    manaCost: '{2}',
    power: '2',
    toughness: '2',
    oracleText,
  });
}

function setupRabble(
  ctx: GameContext,
  hiddenCard: OracleCard = forest(),
  hiddenName = hiddenCard.name,
  seed = 'hideaway',
) {
  const player = playerById(ctx, 'P1');
  player.library.length = 0;
  const fillers = Array.from({ length: 4 }, (_, i) =>
    conjure(ctx, 'P1', simpleArtifact(`${seed} filler ${i}`), 'library'),
  );
  const hidden = conjure(ctx, 'P1', hiddenCard, 'library');
  let opponentViewAtChoice = '';
  const cast = payCast(ctx, 'P1', rabblePin.card, rabbleMana(), (decision) => {
    if (decision.options.some((option) => option.type === 'hideawayExile')) {
      opponentViewAtChoice = JSON.stringify(buildPlayerBoardState(ctx, 'P2'));
      const index = decision.options.findIndex((option) => option.description.includes(hiddenName));
      expect(index).toBeGreaterThanOrEqual(0);
      return outcome(index);
    }
    return pass(decision);
  });
  const permanent = cast.permanent;
  expect(permanent, 'Rabble Rousing resolves to the battlefield').toBeDefined();
  const linked = ctx.state.exile.find((card) => card.attachedToObjectId === permanent!.id);
  return {
    permanent: permanent!,
    hidden,
    fillers,
    linked,
    opponentViewAtChoice,
    decisions: cast.decisions,
  };
}

function attack(ctx: GameContext, attackerId: string, defendingPlayer: PlayerId, answer?: Answer) {
  ctx.state.phase = 'combat';
  ctx.state.step = null;
  return pump(
    runCombatPhase(ctx),
    (decision, count) => {
      if (decision.decisionType === 'declareAttackers') {
        const customAttacks = answer?.(decision, count);
        return customAttacks !== undefined && customAttacks.targets.size > 0
          ? customAttacks
          : declareAttacks(decision, (id) => (id === attackerId ? defendingPlayer : null));
      }
      expectMandatory(decision);
      return answer?.(decision, count) ?? pass(decision);
    },
    { strict: true },
  );
}

function citizenTokens(ctx: GameContext): EnginePermanent[] {
  return ctx.state.battlefield.filter((permanent) => {
    if (!permanent.isToken) return false;
    const characteristics = computeCharacteristics(ctx, permanent);
    return characteristics.subtypes.includes('Citizen');
  });
}

function chooseRecruitDiscard(decision: PendingDecision, cardName: string) {
  const index = decision.options.findIndex((option) => option.description.includes(cardName));
  expect(index, `discard option for ${cardName}`).toBeGreaterThanOrEqual(0);
  return outcome(index);
}

function answerCelebrateTargets(
  decision: PendingDecision,
  choices: Record<string, string>,
  offered: string[],
) {
  if (decision.decisionType !== 'general') return undefined;
  const target = decision.options.findIndex((option) => {
    if (!option.description.startsWith('Target ')) return false;
    offered.push(option.description);
    return Object.values(choices).some((name) => option.description.includes(name));
  });
  if (target >= 0) return outcome(target);
  const none = decision.options.findIndex(
    (option) => option.description === 'Choose no more targets',
  );
  return none >= 0 ? outcome(none) : undefined;
}

describe('PR09 hideaway and recruit cards', () => {
  it('pr09-rabble-hideaway-five-private-and-linked — chooses one exact face-down card and bottoms the rest in-library', () => {
    const ctx = pod('pr09-rabble-hideaway');
    const chosen = setupRabble(
      ctx,
      simpleArtifact('Chosen hideaway card'),
      'Chosen hideaway card',
      'rabble-hideaway',
    );
    expect(
      chosen.decisions.some((decision) =>
        decision.options.some((option) => option.type === 'hideawayExile'),
      ),
    ).toBe(true);
    expect(chosen.fillers).toHaveLength(4);
    expect(chosen.linked?.cardId).toBe(chosen.hidden.cardId);
    expect(chosen.linked?.attachedToCardId).toBe(chosen.permanent.cardId);
    expect(chosen.linked?.attachedToObjectId).toBe(chosen.permanent.id);
    expect(chosen.linked?.zone).toBe('exile');
    expect(chosen.opponentViewAtChoice).not.toContain('Chosen hideaway card');
    expect(JSON.stringify(buildPlayerBoardState(ctx, 'P2'))).not.toContain('Chosen hideaway card');
    expect(JSON.stringify(buildPlayerBoardState(ctx, 'P1'))).toContain('Chosen hideaway card');
    expect(playerById(ctx, 'P1').library).toHaveLength(4);
    expect(new Set(playerById(ctx, 'P1').library.map((card) => card.cardId))).toEqual(
      new Set(chosen.fillers.map((card) => card.cardId)),
    );
    expect(
      ctx.state.eventLog.filter(
        (event) => event.type === 'zoneChange' && event.payload['from'] === 'library',
      ),
    ).toHaveLength(1);
  });

  it('pr09-rabble-empty-library — an empty library offers no hideaway choice or linked card', () => {
    const ctx = pod('pr09-rabble-empty');
    playerById(ctx, 'P1').library.length = 0;
    const { permanent, decisions } = payCast(ctx, 'P1', rabblePin.card, rabbleMana());
    expect(permanent).toBeDefined();
    expect(
      decisions.some((decision) =>
        decision.options.some((option) => option.type === 'hideawayExile'),
      ),
    ).toBe(false);
    expect(ctx.state.exile.filter((card) => card.attachedToCardId === permanent!.cardId)).toEqual(
      [],
    );
  });

  it('pr09-rabble-attack-batch-creates-one-citizen-per-attacker — uses the declaration count, not board creature count', () => {
    const ctx = pod('pr09-rabble-attacks');
    const { permanent } = setupRabble(ctx, forest(), forest().name, 'rabble-attacks');
    const attackers = [
      spawn(ctx, 'P1', simpleCreature('Attacker A')),
      spawn(ctx, 'P1', simpleCreature('Attacker B')),
    ];
    for (let i = 0; i < 5; i++)
      spawn(ctx, 'P1', simpleCreature(`Sick creature ${i}`), { summoningSick: true });
    const { decisions } = attack(ctx, attackers[0]!.id, 'P2', (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id) =>
          attackers.some((attacker) => attacker.id === id) ? 'P2' : null,
        );
      return pass(decision);
    });
    expect(permanent.name).toBe('Rabble Rousing');
    expect(
      decisions.some((decision) =>
        decision.options.some((option) => option.description.startsWith('Play ')),
      ),
    ).toBe(false);
    expect(citizenTokens(ctx)).toHaveLength(2);
    for (const token of citizenTokens(ctx)) {
      expect(token.controllerId).toBe('P1');
      expect(computeCharacteristics(ctx, token)).toMatchObject({
        colors: ['G', 'W'],
        power: 1,
        toughness: 1,
        subtypes: ['Citizen'],
      });
    }
  });

  it('pr09-rabble-opponent-attacks-do-not-trigger — an opponent combat creates no Citizens', () => {
    const ctx = pod('pr09-rabble-opponent-attacks');
    setupRabble(ctx, forest(), forest().name, 'rabble-opponent');
    const attacker = spawn(ctx, 'P2', simpleCreature('Opponent attacker'));
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    attack(ctx, attacker.id, 'P1');
    expect(citizenTokens(ctx)).toHaveLength(0);
  });

  it('pr09-rabble-ten-creatures-casts-linked-spell-free — creates the token before checking ten creatures', () => {
    const ctx = pod('pr09-rabble-ten-cast');
    const card = simpleArtifact('Free hideaway artifact');
    const { linked } = setupRabble(ctx, card, card.name, 'rabble-ten');
    const attacker = spawn(ctx, 'P1', simpleCreature('Threshold attacker'));
    for (let i = 0; i < 8; i++)
      spawn(ctx, 'P1', simpleCreature(`Threshold sick ${i}`), { summoningSick: true });
    const { decisions } = attack(ctx, attacker.id, 'P2', (decision) => {
      const option = decision.options.findIndex(
        (candidate) => candidate.description === `Play ${card.name}`,
      );
      if (option >= 0) return outcome(option);
      return pass(decision);
    });
    expect(citizenTokens(ctx)).toHaveLength(1);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['cardId'] === linked?.cardId,
      ),
    ).toBe(true);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === linked?.cardId)).toBe(
      true,
    );
    expect(
      decisions.some((decision) =>
        decision.options.some((option) => option.description === `Play ${card.name}`),
      ),
    ).toBe(true);
  });

  it('pr09-rabble-below-ten-declines-free-play — does not offer the linked card below ten creatures', () => {
    const ctx = pod('pr09-rabble-below-ten');
    const card = simpleArtifact('Below threshold artifact');
    const { linked } = setupRabble(ctx, card, card.name, 'rabble-below');
    const attacker = spawn(ctx, 'P1', simpleCreature('Below threshold attacker'));
    for (let i = 0; i < 7; i++)
      spawn(ctx, 'P1', simpleCreature(`Below threshold sick ${i}`), { summoningSick: true });
    const { decisions } = attack(ctx, attacker.id, 'P2');
    expect(citizenTokens(ctx)).toHaveLength(1);
    expect(
      decisions.some((decision) =>
        decision.options.some((option) => option.description === `Play ${card.name}`),
      ),
    ).toBe(false);
    expect(ctx.state.exile.some((entry) => entry.cardId === linked?.cardId)).toBe(true);
  });

  it('pr09-rabble-land-limit-and-own-turn — plays a linked land on your turn only while a land play remains', () => {
    const ownTurn = pod('pr09-rabble-land-play');
    const { linked: available } = setupRabble(ownTurn, forest(), forest().name, 'rabble-own-land');
    const attacker = spawn(ownTurn, 'P1', simpleCreature('Land trigger attacker'));
    for (let i = 0; i < 8; i++)
      spawn(ownTurn, 'P1', simpleCreature(`Land threshold ${i}`), { summoningSick: true });
    const played = attack(ownTurn, attacker.id, 'P2', (decision) => {
      const option = decision.options.findIndex(
        (candidate) => candidate.description === `Play ${available?.name}`,
      );
      return option >= 0 ? outcome(option) : pass(decision);
    });
    expect(
      played.decisions.some((decision) =>
        decision.options.some((option) => option.description === `Play ${available?.name}`),
      ),
    ).toBe(true);
    expect(playerById(ownTurn, 'P1').landsPlayedThisTurn).toBe(1);
    expect(
      ownTurn.state.battlefield.some((permanent) => permanent.cardId === available?.cardId),
    ).toBe(true);

    const limit = pod('pr09-rabble-land-limit');
    const { linked } = setupRabble(limit, forest(), forest().name, 'rabble-limit');
    const limitAttacker = spawn(limit, 'P1', simpleCreature('Land limit attacker'));
    for (let i = 0; i < 8; i++)
      spawn(limit, 'P1', simpleCreature(`Land limit body ${i}`), { summoningSick: true });
    playerById(limit, 'P1').landsPlayedThisTurn = 1;
    const skipped = attack(limit, limitAttacker.id, 'P2');
    expect(
      skipped.decisions.some((decision) =>
        decision.options.some((option) => option.description.startsWith('Play ')),
      ),
    ).toBe(false);
    expect(limit.state.exile.some((card) => card.cardId === linked?.cardId)).toBe(true);
    expect(playerById(limit, 'P1').landsPlayedThisTurn).toBe(1);
  });

  it('pr09-rabble-blink-does-not-play-older-incarnation-card — the attack trigger follows the current source object', () => {
    const ctx = pod('pr09-rabble-blink');
    const oldCard = setupRabble(ctx, forest(), forest().name, 'rabble-old');
    const oldHidden = oldCard.linked!;
    const inGraveyard = pump(moveObject(ctx, oldCard.permanent, { zone: 'graveyard' })).value!;
    // The card returns from the graveyard as a new object (CR 400.7), not the old permanent.
    const returned = pumpStrict(
      moveObject(ctx, inGraveyard, { zone: 'battlefield', controllerId: 'P1' }),
    ).value;
    const current = returned as EnginePermanent;
    expect(current.id).not.toBe(oldCard.permanent.id);
    const attacker = spawn(ctx, 'P1', simpleCreature('New incarnation attacker'));
    for (let i = 0; i < 8; i++)
      spawn(ctx, 'P1', simpleCreature(`New incarnation body ${i}`), { summoningSick: true });
    const { decisions } = attack(ctx, attacker.id, 'P2');
    expect(citizenTokens(ctx)).toHaveLength(1);
    // The new object's own hideaway card may be played; the older incarnation's never is.
    const plays = decisions.flatMap((decision) =>
      decision.options.filter((option) => option.description.startsWith('Play ')),
    );
    expect(plays.some((option) => option.description.includes(oldHidden.name))).toBe(false);
    expect(ctx.state.exile.some((card) => card.id === oldHidden.id)).toBe(true);
  });

  it('pr09-celebrate-orders-independent-triggers-and-targets-per-opponent — excludes self, lands, and hexproof permanents', () => {
    const ctx = pod('pr09-celebrate-targets');
    const mine = spawn(ctx, 'P1', simpleCreature('My own creature'));
    const legalP2 = spawn(ctx, 'P2', simpleCreature('Target P2 creature'));
    const hexproof = spawn(ctx, 'P2', simpleCreature('Hexproof creature', 'Hexproof'));
    const legalP3 = spawn(ctx, 'P3', simpleArtifact('Target P3 artifact'));
    spawn(ctx, 'P4', forest());
    const discard = conjure(ctx, 'P1', simpleCreature('Recruit discard'), 'hand');
    const offered: string[] = [];
    const menus: string[][] = [];
    const cast = payCast(ctx, 'P1', celebratePin.card, celebrateMana(), (decision) => {
      const menu = decision.options
        .filter((option) => option.description.startsWith('Target '))
        .map((option) => option.description);
      if (menu.length > 0) {
        menus.push(menu);
        // "That player controls": your own permanents (the creature, Celebrate itself) are never
        // offered, and each opponent's choice offers only that opponent's permanents.
        const names = menu.join(' | ');
        expect(names, 'own permanents are not offered').not.toContain(mine.name);
        expect(names, 'own permanents are not offered').not.toContain('Mountain-king');
        expect(names.includes(legalP2.name) && names.includes(legalP3.name), names).toBe(false);
      }
      if (decision.decisionType === 'orderTriggers') {
        expect(decision.options.some((option) => option.description.includes('Recruit'))).toBe(
          true,
        );
        expect(
          decision.options.some((option) => option.description.includes('exile up to one target')),
        ).toBe(true);
        const recruit = decision.options.findIndex((option) =>
          option.description.includes('Recruit'),
        );
        return outcome(recruit);
      }
      const targetChoice = answerCelebrateTargets(
        decision,
        {
          P2: legalP2.name,
          P3: legalP3.name,
        },
        offered,
      );
      if (targetChoice !== undefined) return targetChoice;
      if (decision.options.some((option) => option.description.includes(discard.name)))
        return chooseRecruitDiscard(decision, discard.name);
      return pass(decision);
    });
    expect(cast.permanent).toBeDefined();
    expect(offered.some((description) => description.includes(legalP2.name))).toBe(true);
    expect(offered.some((description) => description.includes(legalP3.name))).toBe(true);
    expect(offered.some((description) => description.includes(hexproof.name))).toBe(false);
    expect(offered.some((description) => description.includes('Forest'))).toBe(false);
    expect(menus.length).toBeGreaterThanOrEqual(2);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === mine.cardId)).toBe(true);
    expect(ctx.state.exile.some((card) => card.cardId === legalP2.cardId)).toBe(true);
    expect(ctx.state.exile.some((card) => card.cardId === legalP3.cardId)).toBe(true);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === hexproof.cardId)).toBe(
      true,
    );
    const targetExile = ctx.state.eventLog.findIndex(
      (event) =>
        event.type === 'zoneChange' &&
        event.payload['from'] === 'battlefield' &&
        event.payload['to'] === 'exile',
    );
    const draw = ctx.state.eventLog.findIndex((event) => event.type === 'draw');
    const discardIndex = ctx.state.eventLog.findIndex((event) => event.type === 'discard');
    expect(targetExile).toBeGreaterThanOrEqual(0);
    expect(draw).toBeGreaterThan(targetExile);
    expect(discardIndex).toBeGreaterThan(draw);
    const soldier = ctx.state.battlefield.find(
      (permanent) =>
        permanent.isToken && computeCharacteristics(ctx, permanent).subtypes.includes('Soldier'),
    );
    expect(soldier).toBeDefined();
    expect(computeCharacteristics(ctx, soldier!)).toMatchObject({
      colors: ['W'],
      power: 1,
      toughness: 1,
      subtypes: ['Human', 'Soldier'],
    });
  });

  it('pr09-celebrate-no-targets-and-land-discard — permits no targets and creates no token from a land', () => {
    const ctx = pod('pr09-celebrate-no-targets');
    const land = conjure(ctx, 'P1', forest(), 'hand');
    const cast = payCast(ctx, 'P1', celebratePin.card, celebrateMana(), (decision) => {
      // No opponent controls a nonland permanent: Celebrate itself is never a choice.
      expect(
        decision.options.map((option) => option.description).filter((d) => d.startsWith('Target ')),
      ).toEqual([]);
      if (decision.decisionType === 'orderTriggers') {
        const recruit = decision.options.findIndex((option) =>
          option.description.includes('Recruit'),
        );
        return outcome(recruit);
      }
      if (decision.options.some((option) => option.description.includes(land.name)))
        return chooseRecruitDiscard(decision, land.name);
      return pass(decision);
    });
    expect(
      cast.decisions.some((decision) =>
        decision.options.some((option) => option.type === 'pickTarget'),
      ),
    ).toBe(false);
    expect(ctx.state.eventLog.filter((event) => event.type === 'draw')).toHaveLength(1);
    expect(ctx.state.eventLog.filter((event) => event.type === 'discard')).toHaveLength(1);
    expect(
      ctx.state.battlefield.filter(
        (permanent) =>
          permanent.isToken && computeCharacteristics(ctx, permanent).subtypes.includes('Soldier'),
      ),
    ).toHaveLength(0);
  });

  it('pr09-celebrate-source-gone-before-resolution — a source absent at resolution exiles nothing', () => {
    const ctx = pod('pr09-celebrate-source-gone');
    const target = spawn(ctx, 'P2', simpleCreature('Target survives source'));
    const hand = conjure(ctx, 'P1', celebratePin.card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      celebrateMana().map((symbol) => ({ symbol })),
    );
    const option = castOption(ctx, 'P1', hand.id)!;
    pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    const source = ctx.state.battlefield.find((permanent) => permanent.cardId === hand.cardId)!;
    pump(moveObject(ctx, source, { zone: 'graveyard' }));
    const { decisions } = settle(ctx, (decision) => {
      if (decision.decisionType === 'orderTriggers') {
        const exile = decision.options.findIndex((entry) =>
          entry.description.includes('exile up to one target'),
        );
        return outcome(exile);
      }
      if (decision.options.some((entry) => entry.description.includes(target.name)))
        return outcome(
          decision.options.findIndex((entry) => entry.description.includes(target.name)),
        );
      return pass(decision);
    });
    expect(
      decisions.some(
        (decision) =>
          decision.decisionType === 'chooseTargets' ||
          decision.options.some((entry) => entry.description.includes(target.name)),
      ),
    ).toBe(true);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === target.cardId)).toBe(
      true,
    );
    expect(ctx.state.exile.some((card) => card.cardId === target.cardId)).toBe(false);
  });

  it('pr09-celebrate-source-leaves-returns-to-owner-as-new-object — returns a stolen target under its owner', () => {
    const ctx = pod('pr09-celebrate-source-return');
    const target = spawn(ctx, 'P1', simpleCreature('Stolen target'));
    changeController(ctx, target, 'P2');
    const { permanent: source } = payCast(
      ctx,
      'P1',
      celebratePin.card,
      celebrateMana(),
      (decision) => {
        if (decision.decisionType === 'orderTriggers') {
          const exile = decision.options.findIndex((entry) =>
            entry.description.includes('exile up to one target'),
          );
          return outcome(exile);
        }
        if (decision.options.some((entry) => entry.description.includes(target.name)))
          return outcome(
            decision.options.findIndex((entry) => entry.description.includes(target.name)),
          );
        return pass(decision);
      },
    );
    const exiled = ctx.state.exile.find((card) => card.cardId === target.cardId);
    expect(exiled).toBeDefined();
    expect(exiled?.id).not.toBe(target.id);
    const oldObjectId = exiled!.id;
    pump(moveObject(ctx, source!, { zone: 'graveyard' }));
    const returned = ctx.state.battlefield.find((permanent) => permanent.cardId === target.cardId);
    expect(returned).toBeDefined();
    expect(returned?.id).not.toBe(oldObjectId);
    expect(returned?.ownerId).toBe('P1');
    expect(returned?.controllerId).toBe('P1');
    expect(ctx.state.exiledUntilLeaves[source!.cardId]).toBeUndefined();
    const blinked = pump(moveObject(ctx, source!, { zone: 'battlefield', controllerId: 'P1' }))
      .value as EnginePermanent;
    pump(moveObject(ctx, blinked, { zone: 'graveyard' }));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === target.cardId)).toBe(
      true,
    );
  });

  it('pr09-celebrate-commander-replacement-stays-command — a commander moved to command is not returned by source departure', () => {
    const ctx = pod('pr09-celebrate-commander');
    const commander = spawn(ctx, 'P2', simpleCreature('Commander target'), { isCommander: true });
    const { permanent: source } = payCast(
      ctx,
      'P1',
      celebratePin.card,
      celebrateMana(),
      (decision) => {
        if (decision.decisionType === 'orderTriggers') {
          const exile = decision.options.findIndex((entry) =>
            entry.description.includes('exile up to one target'),
          );
          return outcome(exile);
        }
        if (decision.options.some((entry) => entry.description.includes(commander.name)))
          return outcome(
            decision.options.findIndex((entry) => entry.description.includes(commander.name)),
          );
        return pass(decision);
      },
    );
    expect(playerById(ctx, 'P2').commandZone.some((card) => card.cardId === commander.cardId)).toBe(
      true,
    );
    pump(moveObject(ctx, source!, { zone: 'graveyard' }));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === commander.cardId)).toBe(
      false,
    );
    expect(playerById(ctx, 'P2').commandZone.some((card) => card.cardId === commander.cardId)).toBe(
      true,
    );
  });
});
