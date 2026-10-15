/**
 * The spectator projection (brief §10.2) and the minimal action log derived from the event
 * stream. This lives in the engine, next to `buildPlayerView`, for one reason: the UI must
 * never re-derive rules. Effective power/toughness, current keywords, and commander tax are
 * all layer-computed (ADR 0007), and only the engine may compute them.
 *
 * Unlike `PlayerView` this hides nothing for anti-cheat reasons — the human is watching, not
 * playing. It still reduces libraries to a count: library ORDER is secret to every player
 * including its owner (brief §7.1), and a spectator screen is readable over a shoulder.
 */

import type {
  CommanderDamageEntry,
  GameEvent,
  PlayerBoardState,
  SpectatorCard,
  SpectatorCommander,
  SpectatorLogLine,
  SpectatorPermanent,
  SpectatorSeat,
  SpectatorStackObject,
  SpectatorState,
} from '@mtg/shared';
import { computeCharacteristics } from '../effects/continuous';
import { manaSourcesFor, scryfallIdOf } from '../state/queries';
import { copyImageFace, playerById } from '../state/objects';
import type {
  EngineCardObject,
  EnginePermanent,
  EnginePlayerState,
  GameContext,
} from '../state/types';

function cardView(ctx: GameContext, obj: EngineCardObject): SpectatorCard {
  return {
    id: obj.id,
    name: obj.name,
    typeLine: obj.typeLine,
    manaCost: obj.manaCost,
    oracleText: obj.oracleText,
    scryfallId: scryfallIdOf(ctx, obj.oracleId),
    owner: obj.ownerId,
  };
}

function permanentView(ctx: GameContext, perm: EnginePermanent): SpectatorPermanent {
  const chars = computeCharacteristics(ctx, perm);
  const isCreature = chars.types.includes('Creature');
  return {
    id: perm.id,
    // The spectator projection sees everything; `buildPlayerBoardState` redacts a face-down
    // permanent for everyone but its controller (CR 708.5).
    name: perm.faceDown === true ? (ctx.defs.get(perm.oracleId)?.name ?? perm.name) : perm.name,
    typeLine: perm.typeLine,
    manaCost: perm.manaCost,
    oracleText: perm.oracleText,
    controller: perm.controllerId,
    tapped: perm.tapped,
    power: isCreature ? chars.power : null,
    toughness: isCreature ? chars.toughness : null,
    damageMarked: perm.damageMarked,
    counters: { ...perm.counters },
    statuses: [...new Set([...perm.statuses, ...(perm.faceDown ? ['faceDown' as const] : [])])],
    summoningSick: perm.summoningSick && isCreature,
    attachedTo: perm.attachedTo,
    attacking: perm.attacking,
    attackingPlaneswalker: perm.attackedPlaneswalkerRemoved ? null : perm.attackingPlaneswalker,
    blocking: perm.blocking,
    blockedBy: [...perm.blockedByOrdered],
    keywords: [
      ...new Set([
        ...chars.keywords,
        ...chars.protectionFrom.map(
          (color) =>
            `protection from ${
              ({ W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' } as const)[color]
            }`,
        ),
      ]),
    ],
    imageFace: copyImageFace(ctx, perm),
    scryfallId: scryfallIdOf(ctx, perm.oracleId),
    owner: perm.ownerId,
  };
}

/**
 * Locate a commander by its stable card id, wherever it currently sits.
 *
 * `gone` is a real answer, not a failure: when a player is eliminated their objects leave the
 * game entirely (CR 800.4a), so their commander is in no zone at all.
 */
function commanderZone(ctx: GameContext, player: EnginePlayerState, cardId: string): string {
  if (ctx.state.battlefield.some((p) => p.cardId === cardId)) return 'battlefield';
  if (ctx.state.stack.some((s) => s.card?.cardId === cardId)) return 'stack';
  if (player.commandZone.some((o) => o.cardId === cardId)) return 'command';
  if (player.graveyard.some((o) => o.cardId === cardId)) return 'graveyard';
  if (player.hand.some((o) => o.cardId === cardId)) return 'hand';
  if (player.library.some((o) => o.cardId === cardId)) return 'library';
  if (ctx.state.exile.some((o) => o.cardId === cardId)) return 'exile';
  return player.hasLost ? 'gone' : 'unknown';
}

/**
 * A commander's name must not depend on finding its card in a zone. Scanning zones returned
 * "unknown" the moment the card was not in one — which is exactly what happens to an eliminated
 * player's commander — and the seat panel is labelled from this, so a losing deck lost its name
 * on the screen whose entire purpose is comparing decks. The game config is the durable source.
 */
function commanderName(ctx: GameContext, player: EnginePlayerState, cardId: string): string {
  const declared = player.commanderNames?.[cardId];
  if (declared !== undefined) return declared;

  const zones: EngineCardObject[][] = [
    player.commandZone,
    player.graveyard,
    player.hand,
    player.library,
    ctx.state.exile,
  ];
  for (const zone of zones) {
    const found = zone.find((o) => o.cardId === cardId);
    if (found !== undefined) return found.name;
  }
  const perm = ctx.state.battlefield.find((p) => p.cardId === cardId);
  if (perm !== undefined) return perm.name;
  return ctx.state.stack.find((s) => s.card?.cardId === cardId)?.card?.name ?? 'unknown';
}

function commanderViews(ctx: GameContext, player: EnginePlayerState): SpectatorCommander[] {
  return player.commanderCardIds.map((cardId) => {
    const castCount = player.commanderCastCount[cardId] ?? 0;
    const zoneObject = [
      ...player.commandZone,
      ...player.graveyard,
      ...player.hand,
      ...player.library,
      ...ctx.state.exile,
    ].find((candidate) => candidate.cardId === cardId);
    const permanent = ctx.state.battlefield.find((candidate) => candidate.cardId === cardId);
    const stackObject = ctx.state.stack.find((candidate) => candidate.card?.cardId === cardId);
    const visibleObject = zoneObject ?? permanent ?? stackObject?.card ?? null;
    return {
      cardId,
      objectId: visibleObject?.id ?? null,
      name: commanderName(ctx, player, cardId),
      zone: commanderZone(ctx, player, cardId),
      castCount,
      // Commander tax: an additional {2} for each previous cast from the command zone
      // (brief §5.7). Mirrors `legal.ts`, which is what actually charges it.
      taxGeneric: 2 * castCount,
      scryfallId: visibleObject === null ? null : scryfallIdOf(ctx, visibleObject.oracleId),
    };
  });
}

/**
 * The 4×4 grid's nonzero cells. `commanderDamageTaken` is keyed by the *source* commander's
 * card id, so the dealing seat is found by looking up which player owns that commander.
 */
function commanderDamage(ctx: GameContext): CommanderDamageEntry[] {
  const ownerOf = new Map<string, EnginePlayerState>();
  for (const player of ctx.state.players) {
    for (const cardId of player.commanderCardIds) ownerOf.set(cardId, player);
  }

  const entries: CommanderDamageEntry[] = [];
  for (const victim of ctx.state.players) {
    for (const [sourceCardId, damage] of Object.entries(victim.commanderDamageTaken)) {
      if (damage <= 0) continue;
      const source = ownerOf.get(sourceCardId);
      if (source === undefined) continue;
      entries.push({
        victimSeat: victim.id,
        sourceSeat: source.id,
        sourceCardId,
        sourceName: commanderName(ctx, source, sourceCardId),
        damage,
      });
    }
  }
  return entries;
}

function seatView(ctx: GameContext, player: EnginePlayerState): SpectatorSeat {
  const commanders = commanderViews(ctx, player);
  return {
    seat: player.id,
    deckId: player.deckId,
    label: commanders.map((c) => c.name).join(' + ') || player.id,
    life: player.life,
    hand: player.hand.map((c) => cardView(ctx, c)),
    librarySize: player.library.length,
    graveyard: player.graveyard.map((c) => cardView(ctx, c)),
    commanders,
    manaPool: { ...player.manaPool },
    energy: player.energy,
    poisonCounters: player.poisonCounters,
    counters: { ...(player.counters ?? {}) },
    landsPlayedThisTurn: player.landsPlayedThisTurn,
    mulligansTaken: player.mulligansTaken,
    hasLost: player.hasLost,
    lossReason: player.lossReason,
    yieldingUntilEndOfTurn: player.yieldUntilEndOfTurn === true,
  };
}

/** Build everything the spectator UI needs to draw the current moment of the game. */
export function buildSpectatorState(ctx: GameContext): SpectatorState {
  const s = ctx.state;
  const priorityPlayer =
    s.priorityPlayerIndex === null ? null : (s.turnOrder[s.priorityPlayerIndex] ?? null);

  const stack: SpectatorStackObject[] = s.stack.map((so) => ({
    id: so.id,
    controller: so.controllerId,
    kind: so.kind,
    description: so.description,
    // Stack targets are indexed by slot, so an unchosen mode leaves a hole that would serialize as
    // `null`; the projection carries only the targets actually chosen.
    targets: so.targets.filter((id) => id !== undefined),
    scryfallId: scryfallIdOf(ctx, so.sourceOracleId),
  }));

  return {
    gameId: s.gameId,
    seed: s.seed,
    turnNumber: s.turnNumber,
    activePlayer: s.currentTurnPlayer,
    monarchSeat: s.monarchPlayerId,
    priorityPlayer,
    phase: s.phase,
    step: s.step,
    // Fixed seating order, so an eliminated player's panel stays where it was.
    seats: s.seating
      .map((id) => s.players.find((p) => p.id === id))
      .filter((p): p is EnginePlayerState => p !== undefined)
      .map((p) => seatView(ctx, p)),
    battlefield: s.battlefield.map((perm) => permanentView(ctx, perm)),
    exile: s.exile.map((c) => cardView(ctx, c)),
    stack,
    turnOrder: [...s.turnOrder],
    seating: [...s.seating],
    eliminatedPlayers: [...s.eliminatedPlayers],
    commanderDamage: commanderDamage(ctx),
  };
}

const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'] as const;

/** See `PlayerBoardState.viewerMana`. */
function viewerMana(ctx: GameContext, playerId: string): PlayerBoardState['viewerMana'] {
  const pool = playerById(ctx, playerId).manaPool;
  const colors = new Set<string>();
  let units = 0;
  for (const symbol of [...COLOR_ORDER, 'C'] as const) {
    units += pool[symbol];
    if (symbol !== 'C' && pool[symbol] > 0) colors.add(symbol);
  }
  // A permanent with several mana abilities is one source per ability, all sharing its card id,
  // and tapping it activates only one of them: count its largest one, not their sum.
  const bestByCard = new Map<string, number>();
  for (const source of manaSourcesFor(ctx, playerId)) {
    if (source.manaCost !== undefined || source.restriction !== undefined) continue;
    bestByCard.set(
      source.cardId,
      Math.max(bestByCard.get(source.cardId) ?? 0, source.units.length),
    );
    for (const unit of source.units) for (const symbol of unit) colors.add(symbol);
  }
  for (const best of bestByCard.values()) units += best;
  return { units, colors: COLOR_ORDER.filter((color) => colors.has(color)) };
}

/**
 * Active-player browser projection. Build it inside the engine so hidden cards never cross the
 * server/browser boundary and face-down objects are redacted before serialization.
 */
export function buildPlayerBoardState(ctx: GameContext, playerId: string): PlayerBoardState {
  const spectator = buildSpectatorState(ctx);
  return {
    ...spectator,
    viewerSeat: playerId,
    viewerMana: viewerMana(ctx, playerId),
    seats: spectator.seats.map((seat) => ({
      ...seat,
      handSize: seat.hand.length,
      hand: seat.seat === playerId ? seat.hand : null,
    })),
    battlefield: spectator.battlefield.map((permanent) => {
      if (!permanent.statuses.includes('faceDown') || permanent.controller === playerId) {
        return permanent;
      }
      return {
        ...permanent,
        name: 'Face-down permanent',
        typeLine: 'Creature',
        manaCost: null,
        oracleText: '',
        scryfallId: null,
      };
    }),
    exile: spectator.exile.map((card) => {
      const engineCard = ctx.state.exile.find((candidate) => candidate.id === card.id);
      if (
        (engineCard?.attachedToCardId === undefined && engineCard?.foretold === undefined) ||
        engineCard.ownerId === playerId
      ) {
        return card;
      }
      return {
        ...card,
        name: 'Face-down card',
        typeLine: '',
        manaCost: null,
        oracleText: '',
        scryfallId: null,
      };
    }),
  };
}

// ── The spectator action log (brief §10.2) ──────────────────────────────────────────────────

function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function num(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' ? value : null;
}

/**
 * The spectator log is *minimal* (brief §10.2) — it is not the debug log (§13) and it never
 * carries AI reasoning (§7.3, §15). Events not listed here are deliberately dropped rather
 * than rendered generically: an unfiltered dump of every SBA check and priority pass is what
 * the debug panel is for, and it would bury the five lines a human actually reads per turn.
 *
 * Returns `null` for an event that produces no spectator line.
 */
export function formatSpectatorLine(event: GameEvent): SpectatorLogLine | null {
  const p = event.payload;
  const base = { sequence: event.sequence, turn: event.turn, actorSeat: event.actorSeat };

  switch (event.type) {
    case 'turnBegin':
      return { ...base, text: `— turn ${event.turn} — ${event.actorSeat ?? ''}`, emphasis: 'turn' };

    case 'decision': {
      // The chosen action's own description is already written for a human ("Cast Giant
      // Growth targeting Llanowar Elves"), so the log reads as the player's action.
      const description = str(p, 'description');
      if (description === null) return null;
      // A combat-damage division is narrated by the `damageAssignmentDivision` event, which
      // records the division the engine actually applied (after validating the response).
      if (str(p, 'decisionType') === 'assignCombatDamage') return null;
      // Configuration is followed by one authoritative cast event, including forced choices.
      if (str(p, 'actionType') === 'castFree') return null;
      // Passing priority is the overwhelming majority of decisions and says nothing.
      if (/^pass\b/i.test(description)) return null;
      // A land play is announced twice — "Play Swamp" here and "plays Swamp" from the
      // `playLand` event that follows. Keep the second: it reads as narration like the rest of
      // the log, and it is emitted on the far side of the zone change, so seeking to it shows
      // the land on the battlefield. `Play ` is `legal.ts`'s land-play action, and only that.
      if (/^Play\s/.test(description)) return null;
      return { ...base, text: description };
    }

    case 'castSpell':
      return p['duringResolution'] === true
        ? { ...base, text: `casts ${str(p, 'name') ?? 'a spell'} without paying its mana cost` }
        : null;

    case 'playLand':
      return { ...base, text: `plays ${str(p, 'name') ?? 'a land'}` };

    case 'damageAssignmentDivision': {
      const assignments = Array.isArray(p['assignments'])
        ? (p['assignments'] as unknown[]).filter(
            (entry): entry is { target: string; amount: number } =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as { target?: unknown }).target === 'string' &&
              typeof (entry as { amount?: unknown }).amount === 'number',
          )
        : [];
      if (assignments.length === 0) return null;
      const parts = assignments.map((entry) => `${entry.amount} to ${entry.target}`);
      return {
        ...base,
        text: `${str(p, 'attacker') ?? 'An attacker'} divides its combat damage: ${parts.join(', ')}`,
      };
    }

    case 'resolved':
      return { ...base, text: `${str(p, 'description') ?? 'spell'} resolves` };

    case 'foretold':
      return { ...base, text: 'foretells a card' };

    case 'turnedFaceUp':
      return { ...base, text: `turns ${str(p, 'name') ?? 'a permanent'} face up` };

    case 'spellCopied':
      return { ...base, text: `copies ${str(p, 'name') ?? 'a spell'}` };

    case 'counterSpell':
      return {
        ...base,
        text: `${str(p, 'countered') ?? 'spell'} is countered by ${str(p, 'by') ?? 'an effect'}`,
      };

    case 'fizzle':
      return {
        ...base,
        text: `${str(p, 'description') ?? 'spell'} fizzles — all targets illegal`,
      };

    case 'attackersDeclared': {
      const count = num(p, 'count') ?? 0;
      if (count === 0) return null;
      return { ...base, text: `attacks with ${count} creature${count === 1 ? '' : 's'}` };
    }

    case 'combatDamageStep': {
      const assignments = num(p, 'assignments') ?? 0;
      if (assignments === 0) return null;
      return { ...base, text: `combat damage (${str(p, 'step') ?? 'normal'})` };
    }

    case 'damage': {
      const amount = num(p, 'amount');
      if (amount === null) return null;
      const source = str(p, 'source') ?? 'a source';
      const target = str(p, 'target') ?? 'a permanent';
      const commander = p['commanderDamage'] === true ? ' (commander damage)' : '';
      return { ...base, text: `${source} deals ${amount} to ${target}${commander}` };
    }

    case 'lifeGain':
      return { ...base, text: `gains ${num(p, 'amount') ?? 0} life` };

    case 'unlessPaid':
      return {
        ...base,
        text: `pays ${str(p, 'cost') ?? 'the cost'} for ${str(p, 'source') ?? 'an effect'}`,
      };

    case 'unlessNotPaid':
      return {
        ...base,
        text: `${p['reason'] === 'unable' ? "can't pay" : "doesn't pay"} ${str(p, 'cost') ?? 'the cost'} for ${str(p, 'source') ?? 'an effect'}`,
      };

    case 'draw':
      return { ...base, text: `draws ${str(p, 'name') ?? 'a card'}` };

    case 'discard':
      return { ...base, text: `discards ${str(p, 'name') ?? 'a card'}` };

    case 'mill':
      return { ...base, text: `mills ${str(p, 'name') ?? 'a card'}` };

    case 'scry':
      return { ...base, text: `scries ${num(p, 'looked') ?? 0}` };

    case 'surveil':
      return { ...base, text: `surveils ${num(p, 'looked') ?? 0}` };

    // Only an explicitly revealed search result is narrated: CR 701.16a makes it public, while an
    // unrevealed find bound for a hidden zone must stay private to the searcher.
    case 'searchFound':
    case 'revealCard':
      return p['revealed'] === true
        ? { ...base, text: `reveals ${str(p, 'name') ?? 'a card'}` }
        : null;
    case 'returnSpell':
      return { ...base, text: `${str(p, 'name') ?? 'a spell'} returns to its owner's hand` };
    case 'lifeLoss':
      return { ...base, text: `loses ${num(p, 'amount') ?? 0} life` };

    case 'sbaCreatureDies':
      return { ...base, text: `${str(p, 'name') ?? 'a creature'} dies` };

    case 'destroy':
      return {
        ...base,
        text: `${str(p, 'target') ?? 'a permanent'} is destroyed by ${str(p, 'source') ?? 'an effect'}`,
      };

    case 'regenerated':
      return {
        ...base,
        text: `${str(p, 'permanent') ?? 'a permanent'} regenerates instead of being destroyed`,
      };

    case 'sacrifice':
      return { ...base, text: `sacrifices ${str(p, 'name') ?? 'a permanent'}` };

    case 'exile':
      return {
        ...base,
        text: `${str(p, 'target') ?? 'a card'} is exiled by ${str(p, 'source') ?? 'an effect'}`,
      };

    case 'sbaLegendRule':
      return { ...base, text: `legend rule — keeps one ${str(p, 'name') ?? 'legend'}` };

    case 'commanderToCommandZone':
      return {
        ...base,
        text: `${str(p, 'name') ?? 'commander'} goes to the command zone from ${str(p, 'from') ?? 'play'}`,
      };

    // Mulligan number, not resulting hand size: London draws a fresh 7 every time and bottoms
    // on the keep, so "mulligans to 6" would be wrong until the bottoming actually happens.
    case 'mulligan':
      return { ...base, text: `takes mulligan #${num(p, 'number') ?? 1}` };

    case 'playerEliminated':
      return {
        ...base,
        text: `${event.actorSeat ?? 'a player'} is eliminated — ${str(p, 'reason') ?? 'unknown'}`,
        emphasis: 'elimination',
      };

    case 'engineHalt':
      return {
        ...base,
        text: `ENGINE HALT — ${str(p, 'reason') ?? 'unknown'}`,
        emphasis: 'warning',
      };

    case 'gameOver':
      return {
        ...base,
        text: `game over — winner ${str(p, 'winner') ?? '(none)'}`,
        emphasis: 'elimination',
      };

    default:
      return null;
  }
}

/** Convenience: format a run of events, dropping the ones with no spectator meaning. */
export function formatSpectatorLog(events: readonly GameEvent[]): SpectatorLogLine[] {
  const lines: SpectatorLogLine[] = [];
  for (const event of events) {
    const line = formatSpectatorLine(event);
    if (line !== null) lines.push(line);
  }
  return lines;
}

/**
 * Hidden-information-safe live log. Private bottoming and catch-all card choices made by
 * another seat are omitted; their public consequences are still narrated by later events.
 */
export function formatPlayerLog(
  events: readonly GameEvent[],
  playerId: string,
): SpectatorLogLine[] {
  return formatSpectatorLog(
    events
      .map((event) => {
        // Another seat's hidden-information action (a face-down cast) reads as its public
        // description, never its card's name.
        const publicDescription = event.payload['publicDescription'];
        if (
          event.type !== 'decision' ||
          event.actorSeat === playerId ||
          typeof publicDescription !== 'string'
        ) {
          return event;
        }
        return { ...event, payload: { ...event.payload, description: publicDescription } };
      })
      .filter((event) => {
        if (event.actorSeat === playerId) return true;
        // Opponents' draws and library manipulation reveal hidden information only to the
        // spectator projection. Their public zone changes (discard and mill) remain narrated.
        if (['draw', 'scry', 'surveil'].includes(event.type)) return false;
        if (event.type !== 'decision') return true;
        const decisionType = event.payload['decisionType'];
        return (
          decisionType !== 'mulligan' &&
          decisionType !== 'bottomCards' &&
          decisionType !== 'general'
        );
      }),
  );
}
