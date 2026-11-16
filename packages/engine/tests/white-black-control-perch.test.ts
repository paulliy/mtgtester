import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlPerchOverrides } from '../src/cards/overrides/white-black-control-perch';
import { activated, triggered } from '../src/cards/templates';
import { constant } from '../src/cards/value';
import { ofType } from '../src/cards/selector';
import { computeCharacteristics } from '../src/effects/continuous';
import { gainLife, loseLife, payLife } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { playerLifeLocked } from '../src/state/phasing';
import { createGame } from '../src/state/game';
import { discardCard } from '../src/state/objects';
import type { EngineStackObject, GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { runCombatPhase } from '../src/combat/combat';
import { playPreparedScenario } from '../src/flow/game';
import { runBeginningAndPrecombatMain } from '../src/turn/turn';
import { targetIsLegal } from '../src/targets/legality';
import {
  conjure,
  copies,
  declareAttacks,
  gameConfig,
  oracle,
  pump,
  spawn,
  swamp,
} from './fixtures';

interface Pinned {
  sha256: string;
  card: OracleCard;
}
const fixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
) as { cards: Pinned[] };
const pin = 'e9adf2313e4738116e684727c9ebc9efc4d3a1e85ee65f91f9040d618252c80d';
const entry = fixture.cards.find((candidate) => candidate.card.name === 'Perch Protection');
if (!entry) throw new Error('Missing pinned Oracle card: Perch Protection');
const perchEntry = entry!;
beforeAll(registerWhiteBlackControlPerchOverrides);

function ctx(seed = 'perch'): GameContext {
  const game = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(16, swamp) })),
      { seed },
    ),
  );
  Object.assign(game.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return game;
}
function player(game: GameContext, id: string) {
  return game.state.players.find((candidate) => candidate.id === id)!;
}
function castPerch(game: GameContext, giftRecipient?: string): EngineStackObject {
  expect(perchEntry.sha256).toBe(pin);
  const definition = interpretCard(perchEntry.card);
  expect(definition.modeled, definition.unmodeledReasons.join('; ')).toBe(true);
  const card = conjure(game, 'P1', perchEntry.card, 'hand');
  addMana(player(game, 'P1'), [
    { symbol: 'W' },
    { symbol: 'W' },
    { symbol: 'C' },
    { symbol: 'C' },
    { symbol: 'C' },
    { symbol: 'C' },
  ]);
  const action = computePriorityOptions(game, player(game, 'P1')).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === card.id;
  });
  expect(action, 'Perch Protection is castable for its printed {4}{W}{W} cost').toBeDefined();
  pump(
    applyPriorityAction(game, player(game, 'P1'), action!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
    (decision) => {
      if (decision.prompt.startsWith('Promise an opponent a gift')) {
        if (!giftRecipient) return { index: 0, targets: new Map() };
        const chosen = decision.options.findIndex((option) =>
          option.description.includes(`Promise ${giftRecipient} a gift`),
        );
        expect(chosen).toBeGreaterThan(0);
        return { index: chosen, targets: new Map() };
      }
      return { index: 0, targets: new Map() };
    },
  );
  return game.state.stack.find((object) => object.sourceCardId === card.cardId)!;
}
function artifact(name: string): OracleCard {
  return oracle({
    name,
    typeLine: 'Artifact',
    types: ['Artifact'],
    manaCost: '{0}',
    cmc: 0,
    power: null,
    toughness: null,
  });
}

describe('Perch Protection — pinned gift and phasing behavior', () => {
  it('casts normally, offers the extra-turn gift, creates four Birds, phases the controlled set and exiles itself', () => {
    const game = ctx('perch-gift-phase');
    const host = spawn(game, 'P1', artifact('Host'));
    host.counters['+1/+1'] = 3;
    host.chosenOption = 'retain this choice';
    const opponentAura = spawn(
      game,
      'P2',
      oracle({
        name: 'Opponent Aura',
        typeLine: 'Enchantment — Aura',
        types: ['Enchantment'],
        manaCost: '{0}',
        cmc: 0,
        power: null,
        toughness: null,
      }),
    );
    opponentAura.attachedTo = host.id;
    const opponentPermanent = spawn(game, 'P2', artifact('Opponent Permanent'));
    const beforeEventCount = game.state.eventLog.length;
    const spell = castPerch(game, 'P2');
    expect(spell.giftRecipientId).toBe('P2');
    expect(game.state.phasedOut ?? []).toHaveLength(0);
    pump(resolveTopOfStack(game));

    const phased = game.state.phasedOut!.map((record) => record.permanent);
    expect(phased).toHaveLength(6); // host, attached Aura, and the four newly-created Bird tokens
    expect(game.state.battlefield).toEqual([opponentPermanent]);
    const birds = phased.filter((permanent) => permanent.name === 'Bird');
    expect(birds).toHaveLength(4);
    for (const bird of birds) {
      expect(bird.isToken).toBe(true);
      expect(bird.power).toBe(2);
      expect(bird.toughness).toBe(2);
      expect(computeCharacteristics(game, bird).keywords).toContain('flying');
    }
    const phasedHost = phased.find((permanent) => permanent.id === host.id)!;
    expect(phasedHost).toBe(host);
    expect(phasedHost.counters['+1/+1']).toBe(3);
    expect(phasedHost.chosenOption).toBe('retain this choice');
    expect(phased.find((permanent) => permanent.id === opponentAura.id)).toBe(opponentAura);
    expect(opponentAura.attachedTo).toBe(host.id);
    expect(phased.some((permanent) => permanent.id === opponentPermanent.id)).toBe(false);
    expect(game.state.playerProtectionUntilNextTurn?.['P1']).toBe(game.state.turnNumber);
    expect(game.state.extraTurns).toEqual(['P2']);
    expect(game.state.exile.some((object) => object.cardId === spell.sourceCardId)).toBe(true);

    const newEvents = game.state.eventLog.slice(beforeEventCount).map((event) => event.type);
    expect(newEvents).toContain('phaseOut');
    expect(newEvents).not.toContain('leavesBattlefield');
    expect(newEvents).not.toContain('entersBattlefield');
    expect(newEvents).not.toContain('dies');
  });

  it('declining leaves the four Birds on the battlefield and does not phase or shield', () => {
    const game = ctx('perch-decline');
    const permanent = spawn(game, 'P1', artifact('Stays Put'));
    const spell = castPerch(game);
    expect(spell.giftRecipientId).toBeUndefined();
    pump(resolveTopOfStack(game));
    expect(game.state.battlefield.find((candidate) => candidate.id === permanent.id)).toBe(
      permanent,
    );
    expect(
      game.state.battlefield.filter(
        (candidate) => candidate.name === 'Bird' && candidate.controllerId === 'P1',
      ),
    ).toHaveLength(4);
    expect(game.state.phasedOut ?? []).toHaveLength(0);
    expect(game.state.playerProtectionUntilNextTurn?.['P1']).toBeUndefined();
    expect(game.state.extraTurns ?? []).toEqual([]);
    expect(game.state.exile.some((object) => object.cardId === spell.sourceCardId)).toBe(true);
  });

  it('queues multiple promised extra turns most-recent-first', () => {
    const game = ctx('perch-extra-turn-order');
    castPerch(game, 'P2');
    pump(resolveTopOfStack(game));
    castPerch(game, 'P3');
    pump(resolveTopOfStack(game));
    expect(game.state.extraTurns).toEqual(['P3', 'P2']);
  });

  it('runs extra turns in order, then resumes the interrupted normal turn rotation', () => {
    const game = ctx('perch-extra-turn-flow');
    castPerch(game, 'P2');
    pump(resolveTopOfStack(game));
    castPerch(game, 'P3');
    pump(resolveTopOfStack(game));
    const continueOneUpkeep = () =>
      pump(
        playPreparedScenario(game, {
          currentTurnPlayer: game.state.currentTurnPlayer,
          phase: 'precombatMain',
          step: null,
          turnNumber: game.state.turnNumber,
          hand: [],
          battlefield: [],
          continueThroughUpkeeps: 1,
        }),
        (decision) => {
          const pass = decision.options.findIndex((option) => option.type === 'pass');
          return { index: Math.max(pass, 0), targets: new Map() };
        },
      );
    continueOneUpkeep();
    expect(game.state.currentTurnPlayer).toBe('P3');
    expect(game.state.normalTurnResumeAfter).toBe('P1');
    continueOneUpkeep();
    expect(game.state.currentTurnPlayer).toBe('P2');
    continueOneUpkeep();
    expect(game.state.currentTurnPlayer).toBe('P2'); // normal turn resumes after P1
    expect(game.state.normalTurnResumeAfter).toBeUndefined();
    continueOneUpkeep();
    expect(game.state.currentTurnPlayer).toBe('P3');
  });

  it('skips an eliminated promised recipient without consuming the next recipient’s extra turn', () => {
    const game = ctx('perch-extra-turn-elimination');
    castPerch(game, 'P2');
    pump(resolveTopOfStack(game));
    castPerch(game, 'P3');
    pump(resolveTopOfStack(game));
    player(game, 'P3').hasLost = true;
    pump(
      playPreparedScenario(game, {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: game.state.turnNumber,
        hand: [],
        battlefield: [],
        continueThroughUpkeeps: 1,
      }),
      (decision) => {
        const pass = decision.options.findIndex((option) => option.type === 'pass');
        return { index: Math.max(pass, 0), targets: new Map() };
      },
    );
    expect(game.state.currentTurnPlayer).toBe('P2');
    expect(game.state.extraTurns).toEqual([]);
    expect(game.state.normalTurnResumeAfter).toBe('P1');
  });

  it('locks life changes and player targeting, then expires before own untap and phases the same objects in', () => {
    const game = ctx('perch-shield-window');
    const permanent = spawn(game, 'P1', artifact('Taps After Returning'), { tapped: true });
    permanent.counters['+1/+1'] = 2;
    permanent.counterTimestamps = { '+1/+1': 9876 };
    const spell = castPerch(game, 'P2');
    pump(resolveTopOfStack(game));
    const originalLife = player(game, 'P1').life;
    pump(gainLife(game, player(game, 'P1'), 3));
    loseLife(game, player(game, 'P1'), 3);
    expect(player(game, 'P1').life).toBe(originalLife);
    expect(() => payLife(game, player(game, 'P1'), 1)).toThrow();
    expect(() => payLife(game, player(game, 'P1'), 0)).not.toThrow();
    expect(game.state.currentTurnPlayer).toBe('P1');
    expect(game.state.phasedOut!.some((record) => record.permanent.id === permanent.id)).toBe(true);

    game.state.currentTurnPlayer = 'P1';
    game.state.turnNumber += 1;
    expect(playerLifeLocked(game, 'P1')).toBe(false);
    const idsBefore = game.state.phasedOut!.map((record) => record.permanent.id);
    const eventsBeforeUntap = game.state.eventLog.length;
    pump(runBeginningAndPrecombatMain(game));
    expect(game.state.phasedOut).toHaveLength(0);
    expect(game.state.battlefield.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(idsBefore),
    );
    expect(game.state.battlefield.find((candidate) => candidate.id === permanent.id)).toBe(
      permanent,
    );
    expect(permanent.tapped).toBe(false);
    expect(permanent.counters['+1/+1']).toBe(2);
    expect(permanent.counterTimestamps?.['+1/+1']).toBe(9876);
    const returnEvents = game.state.eventLog.slice(eventsBeforeUntap).map((event) => event.type);
    expect(returnEvents).toContain('phaseIn');
    expect(returnEvents).not.toContain('entersBattlefield');
    expect(returnEvents).not.toContain('leavesBattlefield');
    const phaseInIndex = game.state.eventLog.findIndex((event) => event.type === 'phaseIn');
    const untapIndex = game.state.eventLog.findIndex((event) => event.type === 'untap');
    expect(phaseInIndex).toBeGreaterThanOrEqual(0);
    expect(untapIndex).toBeGreaterThan(phaseInIndex);
    expect(spell.giftRecipientId).toBe('P2');
  });

  it('makes the shielded player an illegal target for every player source, including their own', () => {
    const game = ctx('perch-protection-targeting');
    castPerch(game, 'P2');
    pump(resolveTopOfStack(game));
    expect(targetIsLegal(game, 'player', 'P1', { controllerId: 'P2' })).toBe(false);
    expect(targetIsLegal(game, 'player', 'P1', { controllerId: 'P1' })).toBe(false);
  });

  it('prevents an opponent lifelink attacker from dealing damage or gaining life, while still allowing the attack', () => {
    const game = ctx('perch-combat-shield');
    castPerch(game, 'P2');
    pump(resolveTopOfStack(game));
    game.state.currentTurnPlayer = 'P2';
    const attacker = spawn(
      game,
      'P2',
      oracle({
        name: 'Lifelink Attacker',
        typeLine: 'Creature — Human',
        types: ['Creature'],
        manaCost: '{0}',
        cmc: 0,
        power: '3',
        toughness: '3',
      }),
    );
    const def = game.defs.get(attacker.oracleId)!;
    game.defs.set(attacker.oracleId, { ...def, keywords: ['lifelink'] });
    expect(computeCharacteristics(game, attacker).keywords).toContain('lifelink');
    const lifeBefore = player(game, 'P1').life;
    const opponentLifeBefore = player(game, 'P2').life;
    let declared = false;
    pump(runCombatPhase(game), (decision) => {
      if (decision.decisionType === 'declareAttackers') {
        declared = true;
        return declareAttacks(decision, (id) => (id === attacker.id ? 'P1' : null));
      }
      return { index: 0, targets: new Map() };
    });
    expect(declared).toBe(true);
    expect(attacker.attackedThisTurn).toBe(true);
    expect(player(game, 'P1').life).toBe(lifeBefore);
    expect(player(game, 'P2').life).toBe(opponentLifeBefore);
    expect(
      game.state.eventLog.some(
        (event) => event.type === 'damagePrevented' && event.payload['target'] === 'P1',
      ),
    ).toBe(true);
  });

  it('allows untargeted discard and filters positive pay-life activations while retaining zero-pay activations', () => {
    const game = ctx('perch-nontarget-costs');
    castPerch(game, 'P2');
    pump(resolveTopOfStack(game));
    // A permanent entering after the resolving effect remains available to activate.
    const costSource = spawn(game, 'P1', artifact('Life Cost Source'));
    const definition = game.defs.get(costSource.oracleId)!;
    game.defs.set(costSource.oracleId, {
      ...definition,
      activatedAbilities: [
        activated({
          costs: [{ kind: 'payLife', amount: 2 }],
          effects: [],
          description: 'Pay two life',
        }),
        activated({
          costs: [{ kind: 'payLife', amount: 0 }],
          effects: [],
          description: 'Pay zero life',
        }),
      ],
    });
    const options = computePriorityOptions(game, player(game, 'P1')).filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === costSource.id;
    });
    const descriptions = options.map((option) => option.data?.['abilityDescription']);
    expect(descriptions).toContain('Pay zero life');
    expect(descriptions).not.toContain('Pay two life');
    const zeroPay = options.find(
      (option) => option.data?.['abilityDescription'] === 'Pay zero life',
    )!;
    const lifeBeforeZeroCost = player(game, 'P1').life;
    pump(
      applyPriorityAction(game, player(game, 'P1'), zeroPay.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(game.state.stack.some((object) => object.kind === 'activatedAbility')).toBe(true);
    pump(resolveTopOfStack(game));
    expect(player(game, 'P1').life).toBe(lifeBeforeZeroCost);
    const handCard = conjure(
      game,
      'P1',
      oracle({
        name: 'Discardable',
        typeLine: 'Sorcery',
        types: ['Sorcery'],
        manaCost: '{0}',
        cmc: 0,
        power: null,
        toughness: null,
      }),
      'hand',
    );
    pump(discardCard(game, handCard, 'P1', 'effect'));
    expect(player(game, 'P1').graveyard.some((card) => card.cardId === handCard.cardId)).toBe(true);
  });

  it('turns off a phased source’s global static effect and discard trigger while it is away', () => {
    const game = ctx('perch-inactive-phased-source');
    const source = spawn(game, 'P1', artifact('Static Trigger Source'));
    const sourceDef = game.defs.get(source.oracleId)!;
    game.defs.set(source.oracleId, {
      ...sourceDef,
      staticEffects: [{ affects: ofType('Creature'), op: { layer: 6, addKeyword: 'flying' } }],
      triggers: [
        triggered(
          { when: 'discardsCard', player: 'you' },
          {
            effects: [
              {
                op: 'createToken',
                count: constant(1),
                spec: {
                  name: 'Trigger Proof',
                  typeLine: 'Artifact',
                  types: ['Artifact'],
                  subtypes: [],
                  colors: [],
                  power: null,
                  toughness: null,
                },
              },
            ],
            description: 'Create proof token',
          },
        ),
      ],
    });
    const opposingCreature = spawn(
      game,
      'P2',
      oracle({
        name: 'Grounded Creature',
        typeLine: 'Creature — Bear',
        types: ['Creature'],
        manaCost: '{0}',
        cmc: 0,
        power: '2',
        toughness: '2',
      }),
    );
    expect(computeCharacteristics(game, opposingCreature).keywords).toContain('flying');
    castPerch(game, 'P2');
    pump(resolveTopOfStack(game));
    expect(computeCharacteristics(game, opposingCreature).keywords).not.toContain('flying');
    const handCard = conjure(
      game,
      'P1',
      oracle({
        name: 'Discardable Trigger Test',
        typeLine: 'Sorcery',
        types: ['Sorcery'],
        manaCost: '{0}',
        cmc: 0,
        power: null,
        toughness: null,
      }),
      'hand',
    );
    const pendingBefore = game.state.pendingTriggers.length;
    pump(discardCard(game, handCard, 'P1', 'effect'));
    expect(game.state.pendingTriggers).toHaveLength(pendingBefore);
    expect(game.state.battlefield.some((permanent) => permanent.name === 'Trigger Proof')).toBe(
      false,
    );
    expect(game.state.phasedOut!.some((record) => record.permanent === source)).toBe(true);
  });
});
