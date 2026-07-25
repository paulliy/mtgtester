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
  isCreaturePermanent,
  manaSourcesFor,
  playersInApnapOrder,
} from '../state/queries';
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
    if (battlefield !== undefined) {
      zone = 'battlefield';
    } else {
      const onStack = ctx.state.stack.find((s) => s.card?.cardId === cardId);
      if (onStack !== undefined) {
        zone = 'stack';
        name = onStack.card?.name ?? name;
      } else {
        for (const [zoneName, arr] of zones) {
          const found = arr.find((o) => o.cardId === cardId);
          if (found !== undefined) {
            zone = zoneName;
            name = found.name;
            break;
          }
        }
      }
    }
    return { name, zone, castCount: player.commanderCastCount[cardId] ?? 0 };
  });
}

function permanentViews(ctx: GameContext): PermanentView[] {
  return ctx.state.battlefield.map((perm) => {
    const view: PermanentView = {
      id: perm.id,
      controller: perm.controllerId,
      name: perm.name,
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
    // EXCEPT face down (§7.1: "face-down cards' identities" are never visible). Nothing sets
    // this status today — morph/manifest are unmodeled — but the status is already in the
    // vocabulary, so the guard is written now: when manifest lands, a permanent that gains it
    // must not start leaking its text box through a projection nobody re-reads.
    if (!perm.statuses.includes('faceDown')) {
      view.typeLine = perm.typeLine;
      view.oracleText = perm.oracleText;
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
function isPrivateEvent(e: GameEvent): boolean {
  if (e.type === 'draw' || e.type === 'decision') return true;
  if (e.type === 'zoneChange') {
    const from = e.payload['from'];
    const to = e.payload['to'];
    return from === 'library' || to === 'library';
  }
  return false;
}

/**
 * Build the view for `playerId`. Contains no hidden state: a test asserts this
 * structurally (brief §12).
 */
export function buildPlayerView(ctx: GameContext, playerId: PlayerId): PlayerView {
  const s = ctx.state;
  const viewer = playerById(ctx, playerId);

  const availableMana: Record<string, number> = { ...viewer.manaPool };
  for (const source of manaSourcesFor(ctx, playerId)) {
    for (const unit of source.units) {
      const sym = unit[0];
      if (sym !== undefined) availableMana[sym] = (availableMana[sym] ?? 0) + 1;
    }
  }

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
    targets: [...so.targets],
  }));

  const recentLog = s.eventLog
    .filter((e) => !isPrivateEvent(e))
    .slice(-15)
    .map(formatEvent);

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
    opponents,
    battlefield: permanentViews(ctx),
    stack,
    recentLog,
  };
}
