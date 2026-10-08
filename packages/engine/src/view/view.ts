/**
 * `PlayerView` projection (brief §7.1) — the anti-cheat boundary. Everything the AI will
 * ever see about the game goes through this function; it is built ONLY from information
 * the viewing player is entitled to:
 *
 *   visible: own hand, own decklist CONTENTS, all graveyards, all battlefields, public
 *   exile, all command zones, life totals, commander damage, the stack, recent log.
 *   never: any other hand, any library ORDER (including the viewer's own), any other
 *   player's decklist, cards bottomed during other players' mulligans.
 */

import type {
  CardView,
  CommanderView,
  GameEvent,
  OpponentView,
  PermanentView,
  PlayerId,
  PlayerView,
  StackObjectView,
} from '@mtg/shared';
import {
  effectivePT,
  gatherRuleStatics,
  isCreaturePermanent,
  manaSourcesFor,
  playersInApnapOrder,
} from '../state/queries';
import { computeCharacteristics } from '../effects/continuous';
import { playerById } from '../state/objects';
import type { EngineCardObject, EnginePlayerState, GameContext } from '../state/types';

/** Full card view — for zones where oracle text is relevant (brief §7.4). */
function fullCardView(obj: EngineCardObject, ctx?: GameContext): CardView {
  const view: CardView = { id: obj.id, name: obj.name };
  if (obj.manaCost !== null) view.manaCost = obj.manaCost;
  view.typeLine = obj.typeLine;
  view.oracleText = obj.oracleText;
  if (ctx !== undefined) {
    const def = ctx.defs.get(obj.oracleId);
    if (def !== undefined && (def.power !== null || def.toughness !== null)) {
      view.power = def.power;
      view.toughness = def.toughness;
    }
  }
  return view;
}

/** Name-only card view — for zones where oracle text would waste tokens (brief §7.4). */
function nameOnlyView(id: string, name: string): CardView {
  return { id, name };
}

function commanderViews(ctx: GameContext, player: EnginePlayerState): CommanderView[] {
  return player.commanderCardIds.map((cardId) => {
    // Locate the commander's current zone by its stable card id.
    const battlefield = ctx.state.battlefield.find((p) => p.cardId === cardId);
    const zones: [string, EngineCardObject[]][] = [
      ['command', player.commandZone],
      ['graveyard', player.graveyard],
      ['hand', player.hand],
      ['library', player.library],
      ['exile', ctx.state.exile],
    ];
    let zone = 'command';
    let name = battlefield?.name ?? '';
    let commanderObject: EngineCardObject | typeof battlefield;
    if (battlefield !== undefined) {
      zone = 'battlefield';
      commanderObject = battlefield;
    } else {
      const onStack = ctx.state.stack.find((s) => s.card?.cardId === cardId);
      if (onStack !== undefined) {
        zone = 'stack';
        name = onStack.card?.name ?? name;
        commanderObject = onStack.card ?? undefined;
      } else {
        for (const [zoneName, arr] of zones) {
          const found = arr.find((o) => o.cardId === cardId);
          if (found !== undefined) {
            zone = zoneName;
            name = found.name;
            commanderObject = found;
            break;
          }
        }
      }
    }
    return {
      name,
      zone,
      castCount: player.commanderCastCount[cardId] ?? 0,
      ...(commanderObject?.manaCost !== null && commanderObject?.manaCost !== undefined
        ? { manaCost: commanderObject.manaCost }
        : {}),
      ...(commanderObject !== undefined
        ? { typeLine: commanderObject.typeLine, oracleText: commanderObject.oracleText }
        : {}),
    };
  });
}

function permanentViews(ctx: GameContext): PermanentView[] {
  return ctx.state.battlefield.map((perm) => {
    const view: PermanentView = {
      id: perm.id,
      controller: perm.controllerId,
      name: perm.faceDown || perm.statuses.includes('faceDown') ? 'Face-down permanent' : perm.name,
      tapped: perm.tapped,
      status: [
        ...perm.statuses,
        ...(perm.summoningSick && isCreaturePermanent(ctx, perm) ? ['summoningSick'] : []),
      ],
    };
    // A battlefield is public information, and §7.4 lists battlefield permanents among the
    // zones whose oracle text is relevant. The projection is faithful; trimming redundant
    // text (basic lands, repeats) is the context assembler's job, as it already is for hand.
    //
    // Manifest uses the faceDown field; legacy fixtures may still use the status.
    // Neither representation may expose the printed identity or abilities.
    if (!perm.faceDown && !perm.statuses.includes('faceDown')) {
      view.typeLine = perm.typeLine;
      view.oracleText = perm.oracleText;
      // Computed, not printed: layer 6 grants and removes keywords, so an anthem's trample or a
      // Darksteel Mutation's lost abilities have to be visible here. Behind the same face-down
      // guard as the text box, for the same reason — see the comment above.
      const keywords = computeCharacteristics(ctx, perm).keywords;
      if (keywords.length > 0) view.keywords = [...keywords];
    }
    if (isCreaturePermanent(ctx, perm)) {
      const pt = effectivePT(ctx, perm);
      view.power = pt.power;
      view.toughness = pt.toughness;
    }
    if (perm.blockedByOrdered.length > 0) view.blockedBy = [...perm.blockedByOrdered];
    return view;
  });
}

/**
 * Every player's exile zone, redacted the same way the human browser view redacts it
 * (`view/spectator.ts:buildPlayerBoardState`): a card exiled face down (`attachedToCardId`
 * set — currently only hideaway) reports as "Face-down card" to everyone but its owner.
 */
function exileViews(ctx: GameContext, playerId: PlayerId): CardView[] {
  return ctx.state.exile.map((card) =>
    card.attachedToCardId === undefined || card.ownerId === playerId
      ? nameOnlyView(card.id, card.name)
      : nameOnlyView(card.id, 'Face-down card'),
  );
}

function formatEvent(e: GameEvent): string {
  const actor = e.actorSeat ?? '--';
  const detail = Object.entries(e.payload)
    .filter(([k]) => !['cardId', 'sourceCardId', 'targetCardId', 'newObjectId'].includes(k))
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ');
  return `T${e.turn} ${actor} ${e.type}${detail.length > 0 ? ` ${detail}` : ''}`;
}

/**
 * Events that reveal hidden information and must not appear in the shared log: raw
 * decision records (mulligan bottoms, discard picks carry card names), draw identities,
 * and any zone change touching a library (draws, bottoms, tucks).
 */
function visibleEvent(e: GameEvent, viewer: PlayerId): GameEvent | null {
  if (e.type === 'draw' || e.type === 'decision') return null;
  if (e.type === 'zoneChange') {
    const from = e.payload['from'];
    const to = e.payload['to'];
    if (from === 'library' || to === 'library') return null;
  }
  if (e.type === 'searchFound') {
    const searcher = e.payload['player'];
    const destination = e.payload['to'];
    const publicDestination = ['battlefield', 'graveyard', 'exile', 'stack'].includes(
      typeof destination === 'string' ? destination : '',
    );
    const explicitlyRevealed = e.payload['revealed'] === true;
    if (searcher !== viewer && !publicDestination && !explicitlyRevealed) {
      const { name: _privateName, ...publicPayload } = e.payload;
      return { ...e, payload: publicPayload };
    }
  }
  return e;
}

/**
 * Build the view for `playerId`. Contains no hidden state: a test asserts this
 * structurally (brief §12).
 */
export function buildPlayerView(ctx: GameContext, playerId: PlayerId): PlayerView {
  const s = ctx.state;
  const viewer = playerById(ctx, playerId);

  // Credits EVERY alternative symbol a unit could become, not just the first — a 5-color
  // Command Tower must not be reported as producing only White. This deliberately over-reports
  // total capacity summed across colors for a flexible source (one unit counts toward all of
  // its alternatives at once): it describes *reachable* colors, not a literal simultaneous
  // total. Nothing treats `availableMana` as ground truth for legality — `canPay`/`planPayment`
  // remain authoritative; this is descriptive context for the AI only.
  //
  // A permanent with several mana abilities is one source per ability, all sharing its card id,
  // and one activation uses only one of them (Illuminor Szeras is one source per creature it
  // could sacrifice). So each card adds its largest ability's amount of each symbol to
  // `availableMana`, never the sum. `count` still reports every alternative unit (ADR 0010).
  const availableMana: Record<string, number> = { ...viewer.manaPool };
  const manaSourcesByCard = new Map<
    string,
    { symbols: Set<string>; count: number; perSymbol: Map<string, number> }
  >();
  for (const source of manaSourcesFor(ctx, playerId)) {
    let entry = manaSourcesByCard.get(source.cardId);
    if (entry === undefined) {
      entry = { symbols: new Set<string>(), count: 0, perSymbol: new Map() };
      manaSourcesByCard.set(source.cardId, entry);
    }
    entry.count += source.units.length;
    const perSymbol = new Map<string, number>();
    for (const unit of source.units) {
      for (const sym of unit) {
        perSymbol.set(sym, (perSymbol.get(sym) ?? 0) + 1);
        entry.symbols.add(sym);
      }
    }
    for (const [sym, n] of perSymbol) {
      entry.perSymbol.set(sym, Math.max(entry.perSymbol.get(sym) ?? 0, n));
    }
  }
  for (const entry of manaSourcesByCard.values()) {
    for (const [sym, n] of entry.perSymbol) availableMana[sym] = (availableMana[sym] ?? 0) + n;
  }
  const manaSources: PlayerView['manaSources'] = [...manaSourcesByCard.entries()].map(
    ([cardId, entry]) => {
      const perm = ctx.state.battlefield.find((p) => p.cardId === cardId);
      return { name: perm?.name ?? 'unknown', symbols: [...entry.symbols], count: entry.count };
    },
  );

  const opponents: OpponentView[] = playersInApnapOrder(ctx)
    .filter((p) => p.id !== playerId)
    .map((opp) => ({
      seat: opp.id,
      life: opp.life,
      handSize: opp.hand.length,
      librarySize: opp.library.length,
      graveyard: opp.graveyard.map((o) => nameOnlyView(o.id, o.name)),
      commanders: commanderViews(ctx, opp),
      poisonCounters: opp.poisonCounters,
      commanderDamageDealtToYou: opp.commanderCardIds.reduce(
        (sum, cardId) => sum + (viewer.commanderDamageTaken[cardId] ?? 0),
        0,
      ),
    }));

  const stack: StackObjectView[] = s.stack.map((so) => ({
    id: so.id,
    controller: so.controllerId,
    description: so.description,
    // Stack targets are indexed by slot, so an unchosen mode leaves a hole that would serialize as
    // `null`; the projection carries only the targets actually chosen.
    targets: so.targets.filter((id) => id !== undefined),
  }));

  const recentLog = s.eventLog
    .map((event) => visibleEvent(event, playerId))
    .filter((event): event is GameEvent => event !== null)
    .slice(-15)
    .map(formatEvent);
  const revealedLibraryTops = s.players.flatMap((player) => {
    const top = player.library[0];
    const revealed = gatherRuleStatics(ctx).some(
      (entry) => entry.controllerId === player.id && entry.static.kind === 'revealTopLibrary',
    );
    return top !== undefined && revealed
      ? [{ player: player.id, card: fullCardView(top, ctx) }]
      : [];
  });

  return {
    seat: playerId,
    life: viewer.life,
    hand: viewer.hand.map((o) => fullCardView(o, ctx)),
    // Own decklist: CONTENTS only, never order — keyed by oracle id, not object id.
    deck: viewer.decklistOracleIds.map((oracleId, i) => {
      const def = ctx.defs.get(oracleId);
      return nameOnlyView(`deck-${i}`, def?.name ?? 'unknown');
    }),
    graveyard: viewer.graveyard.map((o) => nameOnlyView(o.id, o.name)),
    commanders: commanderViews(ctx, viewer),
    availableMana,
    energy: viewer.energy,
    manaSources,
    opponents,
    revealedLibraryTops,
    battlefield: permanentViews(ctx),
    exile: exileViews(ctx, playerId),
    stack,
    recentLog,
  };
}
