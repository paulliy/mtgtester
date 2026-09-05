/**
 * Game construction: interpret every card once, build identity-stable objects, and
 * assemble the initial `EngineState` (libraries unshuffled — the game flow shuffles with
 * the game PRNG so the call order is deterministic, brief §5.9).
 */

import type { OracleCard, PlayerId } from '@mtg/shared';
import { interpretCard } from '../cards/interpret';
import type { CardDefinition } from '../cards/definition';
import { emptyPool } from '../mana/cost';
import { Prng } from '../rng/prng';
import type {
  EngineCardObject,
  EnginePlayerState,
  EngineState,
  GameConfig,
  GameContext,
} from './types';

const DEFAULT_TURN_CAP = 500;
const STARTING_LIFE = 40; // brief §5.7

export function createGame(config: GameConfig): GameContext {
  if (config.players.length < 2) {
    throw new Error('a game needs at least two players');
  }

  const defs = new Map<string, CardDefinition>();
  const addDef = (card: OracleCard): void => {
    if (!defs.has(card.oracleId)) defs.set(card.oracleId, interpretCard(card));
  };
  for (const p of config.players) {
    for (const c of p.commanders) addDef(c);
    for (const c of p.cards) addDef(c);
    if (p.companion != null) addDef(p.companion);
  }
  for (const override of config.customDefinitions ?? []) {
    defs.set(override.oracleId, override);
  }

  let nextObjectNum = 1;
  let nextCardNum = 1;

  const players: EnginePlayerState[] = config.players.map((pc) => {
    const commanderCardIds: string[] = [];
    const commanderNames: Record<string, string> = {};
    const makeObject = (
      card: OracleCard,
      zone: EngineCardObject['zone'],
      isCommander: boolean,
    ): EngineCardObject => {
      const cardId = `c-${nextCardNum++}`;
      if (isCommander) {
        commanderCardIds.push(cardId);
        commanderNames[cardId] = card.name;
      }
      return {
        id: `o-${nextObjectNum++}`,
        cardId,
        oracleId: card.oracleId,
        ownerId: pc.id,
        name: card.name,
        typeLine: card.typeLine,
        oracleText: card.oracleText,
        manaCost: card.manaCost,
        isToken: false,
        isCommander,
        zone,
      };
    };

    const library = pc.cards.map((c) => makeObject(c, 'library', false));
    const commandZone = pc.commanders.map((c) => makeObject(c, 'command', true));
    // The companion starts OUTSIDE the game (brief §5.7). It is held only in
    // `companion`, never in a zone array; 'command' is the closest Zone label.
    const companion = pc.companion != null ? makeObject(pc.companion, 'command', false) : null;

    return {
      id: pc.id,
      deckId: pc.deckId,
      life: STARTING_LIFE,
      hand: [],
      library,
      graveyard: [],
      commandZone,
      commanderCastCount: {},
      commanderDamageTaken: {},
      manaPool: emptyPool(),
      manaEntries: [],
      energy: 0,
      counters: {},
      landsPlayedThisTurn: 0,
      poisonCounters: 0,
      hasLost: false,
      lossReason: null,
      companion,
      emblems: [],
      commanderCardIds,
      commanderNames,
      attemptedDrawFromEmptyLibrary: false,
      cardsDrawnThisTurn: 0,
      cardsDrawnThisDrawStep: 0,
      spellsCastThisTurn: 0,
      noncreatureSpellsCastThisTurn: 0,
      playFromZoneTypeUsesThisTurn: {},
      mulligansTaken: 0,
      decklistOracleIds: [
        ...pc.commanders.map((c) => c.oracleId),
        ...pc.cards.map((c) => c.oracleId),
      ],
      companionMovedToHand: false,
      yieldUntilEndOfTurn: false,
      yieldedAbilities: [],
    };
  });

  const state: EngineState = {
    gameId: config.gameId,
    seed: config.seed,
    turnNumber: 0,
    activePlayerIndex: 0,
    createdTokenThisTurn: { P1: false, P2: false, P3: false, P4: false },
    creaturesDiedThisTurn: 0,
    combatDamagePrevention: { all: false, players: {} },
    lifeFloorPlayers: {},
    exiledUntilLeaves: {},
    priorityPlayerIndex: null,
    phase: 'beginning',
    step: null,
    stack: [],
    players,
    battlefield: [],
    exile: [],
    turnOrder: players.map((p) => p.id as PlayerId),
    eliminatedPlayers: [],
    effects: [],
    eventLog: [],
    nextObjectNum,
    nextEventSequence: 1,
    nextDecisionNum: 1,
    nextTimestamp: 1,
    combat: null,
    seating: players.map((p) => p.id as PlayerId),
    currentTurnPlayer: players[0]?.id as PlayerId,
    pendingTriggers: [],
    delayedTriggers: [],
    excessDamageControllerIds: [],
    damageDealtToPlayersThisTurn: {},
    lifeLostThisTurn: {},
    combatDamagePlayersBySource: {},
    extraCombatPhases: 0,
    monarchPlayerId: null,
    temporaryGraveyardAbilities: {},
    turnCap: config.turnCap ?? DEFAULT_TURN_CAP,
  };

  return { state, defs, rng: new Prng(config.seed), debugLog: [] };
}
