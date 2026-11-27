<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import type { ManaPool } from '@mtg/shared';
import { ATTACKS_TARGET, turnPositionLabel } from '@mtg/shared';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { ObjectId, TargetChoice } from '@mtg/shared';
import type { DecisionRequest, LegalAction } from '../lib/protocol';
import ActionLog from '../components/ActionLog.vue';
import CombatLane from '../components/CombatLane.vue';
import CombatOverlay from '../components/CombatOverlay.vue';
import CommanderDamageGrid from '../components/CommanderDamageGrid.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import CopyGameReportButton from '../components/CopyGameReportButton.vue';
import DealPanel from '../components/DealPanel.vue';
import DecisionPanel from '../components/DecisionPanel.vue';
import DeckColors from '../components/DeckColors.vue';
import ManaTaps from '../components/ManaTaps.vue';
import OpeningHand from '../components/OpeningHand.vue';
import GlobalCounters from '../components/GlobalCounters.vue';
import PermanentChip from '../components/PermanentChip.vue';
import ProvisionalBadge from '../components/ProvisionalBadge.vue';
import StackPanel from '../components/StackPanel.vue';
import YourTurnFlash from '../components/YourTurnFlash.vue';
import ZonePile from '../components/ZonePile.vue';
import ZoneStrip from '../components/ZoneStrip.vue';
import ThemeControl from '../components/shell/ThemeControl.vue';
import { useBoardAnchors } from '../composables/useBoardAnchors';
import { useCombatStrikes } from '../composables/useCombatStrikes';
import { useLifeFlash, useLifeFlashBySeat } from '../composables/useLifeFlash';
import { useZoneSizes } from '../composables/useZoneSizes';
import { fitTileWidth } from '../lib/fitTiles';
import { scryfallImageUrl } from '../lib/card';
import { splitTypeLine } from '../lib/typeLine';
import {
  buttonLabel,
  costChips,
  entryFor,
  pendingLabel,
  promptOf,
} from '../lib/actionPresentation';
import { summarizeCombat } from '../lib/combatSummary';
import { buildCombatLane, combatRecap, withDeparted, type LaneModel } from '../lib/combatLane';
import { CONNECTION_LABELS } from '../lib/socket';
import { groupByXFamily, type XActionGroup } from '../lib/xFamilies';
import { commanderObjectIds } from '../lib/commanderIds';
import { groupPermanents, stackKey, type GroupedPermanent } from '../lib/stackPermanents';
import { useCardPreviewStore } from '../stores/cardPreview';
import { useCombatPlanStore } from '../stores/combatPlan';
import { useGameStore } from '../stores/game';

const store = useGameStore();
const cardPreview = useCardPreviewStore();
const combatPlan = useCombatPlanStore();
const router = useRouter();
const selectedActionId = ref<number | null>(null);
const focusedSourceId = ref<ObjectId | null>(null);
const chosenTargets = ref<Record<number, ObjectId>>({});
const draggedId = ref<ObjectId | null>(null);

/** Board anchor root + drag pointer tracking for the combat overlay and drag-cursor line (§9.8). */
const { registerAnchor, anchorFor, setRoot, disposeRoot } = useBoardAnchors();
const tableRef = ref<HTMLElement | null>(null);
const dragPointer = ref<{ x: number; y: number } | null>(null);
// The table only renders once the first board state arrives, which can be after mount.
// Template refs are already cleared by unmount, so remember the root this view set.
let ownedRoot: HTMLElement | null = null;
watch(tableRef, (el) => {
  if (ownedRoot) disposeRoot(ownedRoot);
  ownedRoot = el;
  if (el) setRoot(el);
});
onUnmounted(() => {
  if (ownedRoot) disposeRoot(ownedRoot);
  // Game-over unmounts this view while the cursor may still be over a targeted chip.
  // Hide the App-level preview so a leftover Lab Ox image cannot outlive the battlefield.
  cardPreview.hide();
});

/**
 * While you aim at a player you can target, the line ends at that player's seat letter, beside their name, rather
 * than at the pointer, so the arrow names who is threatened. Over a card tile inside the seat
 * (a planeswalker, say) the line keeps following the pointer.
 */
function aimEnd(target: EventTarget | null, x: number, y: number): { x: number; y: number } {
  if (!(target instanceof Element) || target.closest('.tile') !== null) return { x, y };
  const seat = target.closest('[data-seat]')?.getAttribute('data-seat');
  if (seat == null || !isLegalTarget(seat)) return { x, y };
  const name = anchorFor(`name:${seat}`);
  if (name === undefined) return { x, y };
  const below = y > name.y + name.height / 2;
  return { x: name.x + name.width / 2, y: below ? name.y + name.height + 2 : name.y - 2 };
}

/** While you hold a creature during a declaration, a line follows the pointer from it. */
const aimPointer = ref<{ x: number; y: number } | null>(null);
function onBoardPointerMove(event: PointerEvent): void {
  if (tableRef.value === null || combatAimSourceId.value === null) return;
  const rect = tableRef.value.getBoundingClientRect();
  aimPointer.value = aimEnd(event.target, event.clientX - rect.left, event.clientY - rect.top);
}

function onBoardDragOver(event: DragEvent): void {
  if (tableRef.value === null || draggedId.value === null) return;
  const rect = tableRef.value.getBoundingClientRect();
  dragPointer.value = aimEnd(event.target, event.clientX - rect.left, event.clientY - rect.top);
}

/**
 * A fresh arrow function on every render would make Vue treat each `:ref` as a new callback and
 * spuriously unregister/re-register the anchor on every unrelated re-render (a seat id never
 * changes once the game starts). Caching one stable function per seat avoids that churn.
 */
const seatAnchorRefs = new Map<string, (el: Element | ComponentPublicInstance | null) => void>();
function seatAnchorRef(seatId: string): (el: Element | ComponentPublicInstance | null) => void {
  let fn = seatAnchorRefs.get(seatId);
  if (fn === undefined) {
    fn = (el) => registerAnchor(seatId, el instanceof Element ? el : null);
    seatAnchorRefs.set(seatId, fn);
  }
  return fn;
}

const state = computed(() => store.playerState);

/**
 * MTGA-style attack animation (extends §9.8.1): each batch's damage cues from the server become
 * lunges for the striking permanents, via anchors already registered for the combat overlay.
 * Skipped entirely under reduced motion, matching how `CombatOverlay.vue` and the drag-cursor line
 * are gated.
 */
const combatStrikes = useCombatStrikes();
watch(
  () => store.cueBatch,
  (batch) => {
    if (batch !== null && !store.reducedMotion) combatStrikes.observeCues(batch.cues);
  },
);

const pending = computed(() => store.playerAction);
const request = computed(() => pending.value?.request ?? null);
const human = computed(
  () => state.value?.seats.find((seat) => seat.seat === state.value?.viewerSeat) ?? null,
);
/** Keep-or-mulligan and London bottoming take over the screen, Arena-style, until decided. */
const openingHand = computed(() => {
  const req = request.value;
  const hand = human.value?.hand;
  if (req === null || hand === null || hand === undefined) return null;
  if (req.decisionType !== 'mulligan' && req.decisionType !== 'bottomCards') return null;
  return { request: req, hand, mulligansTaken: human.value?.mulligansTaken ?? 0 };
});
const opponents = computed(
  () => state.value?.seats.filter((seat) => seat.seat !== state.value?.viewerSeat) ?? [],
);
const humanExile = computed(
  () => state.value?.exile.filter((card) => card.owner === state.value?.viewerSeat) ?? [],
);

/**
 * Your lands sit apart from the rest of your board, in a pile you open to see or use them one by
 * one. A land that is also a creature stays on the board, where it can attack and block: the
 * server decides the row (`boardGroup`) from the permanent's computed types.
 */
function isPiledLand(permanent: { boardGroup?: string }): boolean {
  return permanent.boardGroup === 'lands';
}
const humanLands = computed(() =>
  human.value === null ? [] : permanentsFor(human.value.seat).filter(isPiledLand),
);
const humanBoardGroups = computed(() =>
  human.value === null
    ? []
    : groupPermanents(permanentsFor(human.value.seat).filter((p) => !isPiledLand(p))),
);
const humanLandGroups = computed(() => groupPermanents(humanLands.value));
const untappedLandCount = computed(() => humanLands.value.filter((land) => !land.tapped).length);
/**
 * The rest of your board in the design's two columns: creatures (including a land that is one),
 * and everything else. The server's `boardGroup` decides the column, as it decides the land row.
 */
const humanCreatureGroups = computed(() =>
  humanBoardGroups.value.filter((group) => group.permanent.boardGroup === 'creatures'),
);
const humanOtherGroups = computed(() =>
  humanBoardGroups.value.filter((group) => group.permanent.boardGroup !== 'creatures'),
);
function countOf(groups: readonly { count: number }[]): number {
  return groups.reduce((sum, group) => sum + group.count, 0);
}
const humanCreatureCount = computed(() => countOf(humanCreatureGroups.value));
const humanOtherCount = computed(() => countOf(humanOtherGroups.value));
/** "Artifacts and enchantments" names the usual second column; a planeswalker or battle widens it. */
const otherZoneLabel = computed(() =>
  humanOtherGroups.value.every((group) =>
    (group.permanent.types ?? []).some((type) => type === 'Artifact' || type === 'Enchantment'),
  )
    ? 'Artifacts and enchantments'
    : 'Other permanents',
);
/** The two columns share the width by how much each holds, creatures a little ahead. */
const meColumns = computed(() => {
  const creatures = Math.max(1, humanCreatureGroups.value.length) + 1;
  const other = Math.max(1, humanOtherGroups.value.length) * 0.75 + 1;
  return `minmax(0, ${creatures}fr) minmax(0, ${other}fr)`;
});

/**
 * Whether each pile (lands, graveyard, exile) is open, remembered across games the way the game
 * info column is: someone who likes their lands spread out keeps them that way.
 */
type Pile = 'lands' | 'graveyard' | 'exile';
const PILE_KEY = (pile: Pile) => `mtg.playerPile.${pile}`;
/** Lands start spread out as tiles, as the Decktank board draws them; the other piles closed. */
function readPile(pile: Pile): boolean {
  try {
    const stored = localStorage.getItem(PILE_KEY(pile));
    return stored === null ? pile === 'lands' : stored === 'true';
  } catch {
    return pile === 'lands';
  }
}
const pilesOpen = ref<Record<Pile, boolean>>({
  lands: readPile('lands'),
  graveyard: readPile('graveyard'),
  exile: readPile('exile'),
});
function togglePile(pile: Pile): void {
  pilesOpen.value[pile] = !pilesOpen.value[pile];
  try {
    localStorage.setItem(PILE_KEY(pile), String(pilesOpen.value[pile]));
  } catch {
    // Storage blocked: the toggle still works for this visit.
  }
}

/**
 * As on the spectator board, the settings (bot pace, confirmations, motion, Abandon) and the
 * game info drawer (commander damage, the log) sit behind top-bar buttons so the table gets the
 * window. The drawer remembers whether it was open; the settings menu always starts closed.
 */
/**
 * The server's "game over" line, once the game has ended. The log sits in the closed drawer, so
 * the top bar repeats it where it can be seen (a lab scenario keeps this board after its end).
 */
const gameOverLine = computed(() => store.gameOver?.summary ?? null);

const INFO_OPEN_KEY = 'mtg.playerGameInfoOpen';
const settingsOpen = ref(false);
/** The settings menu opens just under its button, wherever the bar has put that button. */
const settingsTop = ref<number | null>(null);
function toggleSettings(event: MouseEvent): void {
  const button = event.currentTarget as HTMLElement | null;
  if (button) settingsTop.value = Math.round(button.getBoundingClientRect().bottom + 6);
  settingsOpen.value = !settingsOpen.value;
}
const infoOpen = ref(
  (() => {
    try {
      return localStorage.getItem(INFO_OPEN_KEY) === 'true';
    } catch {
      return false;
    }
  })(),
);
function toggleInfo(): void {
  infoOpen.value = !infoOpen.value;
  try {
    localStorage.setItem(INFO_OPEN_KEY, String(infoOpen.value));
  } catch {
    // Storage blocked: the toggle still works for this visit.
  }
}

/**
 * Each opponent's graveyard and exile fold away behind a "zones" button beside their life, and
 * open by themselves while one of their cards is a target you can pick. Every opponent starts
 * the way you last left one, remembered like the piles.
 */
const OPPONENT_ZONES_KEY = 'mtg.playerOpponentZonesOpen';
const zonesByDefault = ref(
  (() => {
    try {
      return localStorage.getItem(OPPONENT_ZONES_KEY) === 'true';
    } catch {
      return false;
    }
  })(),
);
const zoneChoices = ref(new Map<string, boolean>());
function toggleZones(seat: string): void {
  const open = !(zoneChoices.value.get(seat) ?? zonesByDefault.value);
  zoneChoices.value = new Map(zoneChoices.value).set(seat, open);
  zonesByDefault.value = open;
  try {
    localStorage.setItem(OPPONENT_ZONES_KEY, String(open));
  } catch {
    // Storage blocked: the toggle still works for this visit.
  }
}
function zonesShown(seat: string): boolean {
  if (zoneChoices.value.get(seat) ?? zonesByDefault.value) return true;
  // Opened too while a card there is a target or one you may cast (Ragavan's exiled card).
  const wanted = [...zoneTargetIds.value, ...zoneSourceIds.value];
  if (wanted.length === 0) return false;
  const seatCards = [
    ...(state.value?.seats.find((s) => s.seat === seat)?.graveyard ?? []),
    ...exileFor(seat),
    // The "Top of library" strip lives in the same block.
    ...revealedLibraryTopsFor(seat),
  ];
  return seatCards.some((card) => wanted.includes(card.id));
}
const isYourTurn = computed(() => state.value?.activePlayer === state.value?.viewerSeat);
const selectedAction = computed(
  () => request.value?.legalActions.find((action) => action.id === selectedActionId.value) ?? null,
);
/**
 * Whether the server can remember a yield for this action — the same test as its
 * `playerYieldKey`: a spell or a printed activated ability of a source. Special actions (foretell,
 * turning a face-down permanent face up) have no ability index and are never yielded.
 */
function isYieldable(action: LegalAction | null | undefined): action is LegalAction {
  if (action?.interaction?.kind !== 'source') return false;
  if (action.type === 'castSpell') return true;
  return action.type === 'activateAbility' && action.interaction.abilityIndex !== undefined;
}

const smartYieldAction = computed(() => {
  if (request.value?.decisionType !== 'priority') return null;
  const action = selectedAction.value ?? selectedSourceActions.value[0];
  return isYieldable(action) ? action : null;
});

function yieldSelected(mode: 'always' | 'smart'): void {
  const action = smartYieldAction.value;
  if (action === null) return;
  selectedActionId.value = null;
  focusedSourceId.value = null;
  chosenTargets.value = {};
  store.yieldPlayerAbility(action.id, mode);
}
const immediateActions = computed(
  () => request.value?.legalActions.filter((action) => isImmediate(action)) ?? [],
);
/**
 * The engine's own declaration action ("Declare attackers (2 eligible creature(s))"). Composing
 * starts by itself, so while it runs the action stays on the band as the step's count line; after
 * a reset it is the band's button that starts declaring again.
 */
const declarationActions = computed(() =>
  (request.value?.legalActions ?? []).filter(
    (action) => action.type === 'attackDeclaration' || action.type === 'blockDeclaration',
  ),
);
const hasOnlyImmediateActions = computed(
  () =>
    request.value !== null &&
    request.value.legalActions.length > 0 &&
    immediateActions.value.length === request.value.legalActions.length,
);

/**
 * Drives the batched combat declaration (brief — Workstream 5). Fires on every freshly pushed
 * request: `onRequest` starts or continues a plan (a no-op unless it's a `declareAttackers`/
 * `declareBlockers` decision). Both sides submit their whole confirmed plan in one call
 * (`confirmCombatPlan`, below) now that ADR 0023's batched contract covers blockers too (Phase
 * 4) — there is nothing left here for a NEW request to replay one piece at a time; the only
 * thing `onRequest` alone needs to catch is a rejected retry, dropping the store back into
 * `composing` (see `combatPlan`'s doc comment).
 */
watch(
  request,
  (req) => {
    if (req === null) {
      if (combatPlan.mode !== 'idle') combatPlan.reset();
      return;
    }
    combatPlan.onRequest(req);
  },
  { immediate: true },
);

function permanentsFor(seat: string) {
  return state.value?.battlefield.filter((permanent) => permanent.controller === seat) ?? [];
}

/** Use the redacted player projection, including anonymous face-down exile placeholders. */
function exileFor(seat: string) {
  return state.value?.exile.filter((card) => card.owner === seat) ?? [];
}

/** Cards this viewer saw in `seat`'s hand (Peek, Gitaxian Probe) that are still there. */
function knownHandFor(seat: string) {
  return state.value?.knownHands?.find((entry) => entry.player === seat)?.cards ?? [];
}

/** Only show cards the server explicitly included in this viewer's authorized top reveal. */
function revealedLibraryTopsFor(seat: string) {
  return (
    state.value?.revealedLibraryTops
      ?.filter((entry) => entry.player === seat)
      .map((entry) => entry.card) ?? []
  );
}

const humanLifeFlash = useLifeFlash(() => human.value?.seat);
const opponentLifeFlash = useLifeFlashBySeat();

/**
 * Card tiles size themselves to fill their zone (redesign phase 5): each zone is measured, and
 * its tiles take the widest 5:7 size at which all of them fit (`fitTileWidth`), so a sparse board
 * shows large cards and a crowded one shrinks before it scrolls.
 */
const { sizes: zoneSizes, zoneRef } = useZoneSizes();
function zoneTileWidth(key: string, count: number, min: number, max: number, extra = 0): number {
  const size = zoneSizes.get(key);
  return fitTileWidth(count, size?.width ?? 0, size?.height ?? 0, { min, max, gap: 6, extra });
}
const humanCreatureWidth = computed(() =>
  zoneTileWidth('human-creatures', humanCreatureGroups.value.length, 50, 168, 4),
);
const humanOtherWidth = computed(() =>
  zoneTileWidth('human-other', humanOtherGroups.value.length, 46, 140, 4),
);
const humanPermMinWidth = 46;
const humanLandWidth = computed(() =>
  zoneTileWidth('human-lands', humanLandGroups.value.length, 40, 110, 4),
);
const humanCommandZoneCount = computed(
  () =>
    (human.value?.commanders ?? []).filter(
      (commander) => commander.zone === 'command' && commander.objectId !== null,
    ).length,
);
/** Hand tiles stay in one row: as tall as the band allows, narrower only when they don't fit. */
const handCardWidth = computed(() => {
  const size = zoneSizes.get('hand');
  const count = (human.value?.hand?.length ?? 0) + humanCommandZoneCount.value;
  if (!size) return 110;
  const byHeight = (size.height * 5) / 7;
  const byWidth = count > 0 ? (size.width - (count - 1) * 6 - 12) / count : byHeight;
  return Math.floor(Math.max(72, Math.min(170, byHeight, byWidth)));
});
/**
 * Each opponent's board split as the design draws it: lands as a line of names along the foot,
 * everything else as tiles, so the tiles get the panel.
 */
const opponentBoards = computed(() => {
  const boards = new Map<
    string,
    { tiles: GroupedPermanent[]; lands: GroupedPermanent[]; landCount: number; openLands: number }
  >();
  for (const opponent of opponents.value) {
    const all = permanentsFor(opponent.seat);
    const lands = all.filter(isPiledLand);
    boards.set(opponent.seat, {
      tiles: groupPermanents(all.filter((permanent) => !isPiledLand(permanent))),
      lands: groupPermanents(lands),
      landCount: lands.length,
      openLands: lands.filter((land) => !land.tapped).length,
    });
  }
  return boards;
});
function opponentBoardGroups(seat: string): GroupedPermanent[] {
  return opponentBoards.value.get(seat)?.tiles ?? [];
}
function opponentLandGroups(seat: string): GroupedPermanent[] {
  return opponentBoards.value.get(seat)?.lands ?? [];
}
function landCount(seat: string): number {
  return opponentBoards.value.get(seat)?.landCount ?? 0;
}
function openLandCount(seat: string): number {
  return opponentBoards.value.get(seat)?.openLands ?? 0;
}
const opponentPermMinWidth = 40;
/** One tile width per opponent zone, set on the zone so its tiles inherit it. */
const opponentPermWidths = computed(() => {
  const widths = new Map<string, number>();
  for (const seat of opponentBoards.value.keys()) {
    widths.set(seat, zoneTileWidth(`opp-${seat}`, opponentBoardGroups(seat).length, 40, 140));
  }
  return widths;
});
/** The art crop for a hand tile; tokens and unknown printings show the paper tone instead. */
function artCropOf(card: { scryfallId: string | null; isToken?: boolean }): string | null {
  if (card.isToken === true || card.scryfallId === null || card.scryfallId.length < 2) return null;
  return scryfallImageUrl(card.scryfallId, 'art_crop', 'front');
}
/** Art that fails to load leaves the paper tone, not a broken-image mark. */
function hideBrokenArt(event: Event): void {
  (event.target as HTMLElement).style.display = 'none';
}
function typePartsOf(typeLine: string | undefined) {
  return splitTypeLine(typeLine ?? '');
}

/** The turn ruler's stops, one per phase (CR 500.1). */
const TURN_STOPS = [
  { phase: 'beginning', label: 'Beginning' },
  { phase: 'precombatMain', label: 'Main' },
  { phase: 'combat', label: 'Combat' },
  { phase: 'postcombatMain', label: 'Second main' },
  { phase: 'ending', label: 'End' },
] as const;
const turnStopIndex = computed(() =>
  Math.max(
    0,
    TURN_STOPS.findIndex((stop) => stop.phase === state.value?.phase),
  ),
);

/** "P2" -> "P2 (Krenko, Mob Boss)" for combat-tray option labels; falls back to the raw id. */
function seatLabel(seatId: string): string {
  const seat = state.value?.seats.find((s) => s.seat === seatId);
  return seat === undefined ? seatId : seat.label;
}

/** An attack option is an opponent's seat, or a planeswalker (named, not shown as a raw id). */
function attackTargetLabel(optionId: string): string {
  if (optionId === ATTACKS_TARGET) return 'Attacks';
  const seat = state.value?.seats.find((s) => s.seat === optionId);
  return seat !== undefined ? seat.label : (nameById.value.get(optionId) ?? optionId);
}

/** What the combat tray says when a declaration is split between players (Master Warcraft). */
const combatHeading = computed(() => {
  const split = combatPlan.split;
  if (split?.variant === 'chooseAttackers')
    return `Choose which of ${seatLabel(split.owner)}'s creatures attack`;
  if (split?.variant === 'assignChosen')
    return `Choose what each creature ${seatLabel(split.chosenBy ?? '')} chose attacks`;
  if (split?.variant === 'blockersFor') return `Declare blockers for ${seatLabel(split.owner)}`;
  return combatPlan.kind === 'attackers' ? 'Declare attackers' : 'Declare blockers';
});
const combatInstruction = computed(() => {
  const split = combatPlan.split;
  if (split?.variant === 'chooseAttackers')
    return 'Mark the creatures that attack; the rest stay home. The attacking player then chooses what each one attacks.';
  if (split?.variant === 'assignChosen')
    return 'These creatures were chosen to attack. Choose what each attacks. One you decline to pay for will not attack, and the creatures are chosen again.';
  if (split?.variant === 'blockersFor')
    return 'You choose these blocks. Click a creature, then the attacker it blocks. Unassigned creatures do not block.';
  return `Click a creature, then its opponent or target, or choose an option below. Unassigned creatures ${
    combatPlan.kind === 'attackers' ? 'stay home' : 'do not block'
  }.`;
});
const combatDeclineLabel = computed(() =>
  combatPlan.split?.variant === 'assignChosen'
    ? 'Decline to pay'
    : combatPlan.kind === 'attackers'
      ? 'Stay home'
      : 'No block',
);

const nameById = computed(() => {
  const names = new Map<string, string>();
  for (const seat of state.value?.seats ?? []) {
    for (const card of seat.hand ?? []) names.set(card.id, card.name);
    for (const card of seat.graveyard) names.set(card.id, card.name);
    for (const commander of seat.commanders) {
      names.set(commander.cardId, commander.name);
      if (commander.objectId !== null) names.set(commander.objectId, commander.name);
    }
  }
  for (const permanent of state.value?.battlefield ?? []) names.set(permanent.id, permanent.name);
  for (const card of state.value?.exile ?? []) names.set(card.id, card.name);
  return names;
});

/** Battlefield object ids of every seat's commanders, for the commander frame. */
const commanderIds = computed(() => commanderObjectIds(state.value?.seats ?? []));

function sourceId(action: LegalAction): string | null {
  const interaction = action.interaction ?? { kind: 'choice' as const };
  if (interaction.kind === 'source') return interaction.sourceId;
  if (interaction.kind === 'attack') return interaction.attackerId;
  if (interaction.kind === 'block') return interaction.blockerId;
  // A choice about a player (who a token attacks, which opponent to pick) has no card to click:
  // it goes to the decision panel, which shows each player's buttons.
  if (interaction.kind === 'choice')
    return interaction.subjectId === undefined || seatIds.value.has(interaction.subjectId)
      ? null
      : interaction.subjectId;
  return null;
}
const seatIds = computed(() => new Set((state.value?.seats ?? []).map((seat) => seat.seat)));

/**
 * Every source action but making mana by hand (ADR 0030): that lives on the land itself, in the
 * open lands pile, so untapped lands never glow, crowd "Playable now", or hold up a pass.
 */
const sourceActions = computed(() =>
  (request.value?.legalActions ?? []).filter(
    (action) =>
      !isImmediate(action) && sourceId(action) !== null && action.type !== 'activateManaAbility',
  ),
);
const selectedSourceActions = computed(() =>
  focusedSourceId.value === null
    ? []
    : sourceActions.value.filter((action) => sourceId(action) === focusedSourceId.value),
);
const selectedSourceGrouped = computed(() =>
  groupByXFamily(selectedSourceActions.value, (action) => entryFor(request.value, action)?.xFamily),
);

/** One typed X value per open group, defaulting to the largest affordable amount. */
const xInputs = ref<Record<string, number>>({});
watch(
  () => selectedSourceGrouped.value.xGroups,
  (groups) => {
    const next: Record<string, number> = {};
    for (const group of groups) next[group.key] = xInputs.value[group.key] ?? group.max;
    xInputs.value = next;
  },
  { immediate: true },
);

/** The exact pre-enumerated action for the typed X, or `undefined` if the input is out of range
 * (a stray value the `min`/`max` on the `<input>` don't strictly enforce). */
function xGroupAction(group: XActionGroup): LegalAction | undefined {
  const x = xInputs.value[group.key] ?? group.max;
  return group.actions.find((action) => group.xById.get(action.id) === x);
}

/** Same, but always returns something to preview a label/cost — falls back to `first` while the
 * typed value is out of range, since the Cast/Activate button is disabled in that state anyway. */
function xGroupPreviewAction(group: XActionGroup): LegalAction {
  return xGroupAction(group) ?? group.first;
}

function chooseXGroupAction(group: XActionGroup): void {
  const action = xGroupAction(group);
  if (action !== undefined) chooseAction(action);
}

const fallbackActions = computed(() =>
  (request.value?.legalActions ?? []).filter(
    (action) => !isImmediate(action) && sourceId(action) === null,
  ),
);
/** Everything not already handled by the quick-actions row or the card-first source flow. */
const fallbackRequest = computed<DecisionRequest | null>(() => {
  if (request.value === null || fallbackActions.value.length === 0) return null;
  return { ...request.value, legalActions: fallbackActions.value };
});
const actionableSourceIds = computed(
  () =>
    new Set([
      ...sourceActions.value.map(sourceId).filter(Boolean),
      ...(combatPlan.mode === 'composing' ? combatPlan.order.map((entry) => entry.subjectId) : []),
    ]),
);

/** The ordinary things a source can do right now, best first: a land plays, a spell casts. */
const PLAYABLE_VERBS = ['playLand', 'castSpell', 'activateAbility'] as const;

/**
 * One entry per card or permanent the engine currently offers to play, cast, or activate, with
 * the verb for its best action. Drives the "Playable now" list and the tags on hand cards; both
 * select the source exactly as clicking the card does, so nothing here decides legality.
 */
const playableSources = computed(() => {
  const best = new Map<string, { rank: number; action: LegalAction }>();
  for (const action of sourceActions.value) {
    if (action.interaction?.kind !== 'source') continue;
    const rank = (PLAYABLE_VERBS as readonly string[]).indexOf(action.type);
    if (rank < 0) continue;
    const id = action.interaction.sourceId;
    const current = best.get(id);
    if (current === undefined || rank < current.rank) best.set(id, { rank, action });
  }
  // The verb ("Play", "Cast", "Activate") is the server's, from the action's type.
  return [...best].map(([id, { action }]) => ({
    id,
    verb: entryOf(action)?.verb ?? '',
    name: sourceNameOf(action) ?? id,
  }));
});
/** The "Playable now" list: identical entries (three Swamps) collapse to one with a count. */
const playableList = computed(() => {
  const groups = new Map<string, { key: string; ids: string[]; verb: string; name: string }>();
  for (const source of playableSources.value) {
    const key = `${source.verb}|${source.name}`;
    const group = groups.get(key);
    if (group === undefined)
      groups.set(key, { key, ids: [source.id], verb: source.verb, name: source.name });
    else group.ids.push(source.id);
  }
  return [...groups.values()];
});
const playableVerbById = computed(
  () => new Map(playableSources.value.map((source) => [source.id, source.verb])),
);

function yieldableSourceAction(id: string): LegalAction | undefined {
  return sourceActions.value.find(
    (candidate) => sourceId(candidate) === id && isYieldable(candidate),
  );
}

function smartYieldSource(id: string): void {
  if (request.value?.decisionType !== 'priority') return;
  const action = yieldableSourceAction(id);
  if (action !== undefined) store.yieldPlayerAbility(action.id, 'smart');
}

/**
 * Passing a main phase with a land drop unused is an easy mistake: the engine only offers
 * `playLand` while the drop is available and a land can be played, so its presence is the whole
 * test. Ask once per turn; "Pass anyway" is remembered until the next turn.
 */
const PASS_ACTION_TYPES = new Set(['pass', 'passAndYieldTurn']);
const pendingPass = ref<LegalAction | null>(null);
const landReminderDismissedTurn = ref<number | null>(null);

function needsLandReminder(action: LegalAction): boolean {
  return (
    store.remindUnplayedLand &&
    PASS_ACTION_TYPES.has(action.type) &&
    isYourTurn.value &&
    landReminderDismissedTurn.value !== state.value?.turnNumber &&
    (request.value?.legalActions ?? []).some((candidate) => candidate.type === 'playLand')
  );
}

function passAnyway(): void {
  const action = pendingPass.value;
  pendingPass.value = null;
  landReminderDismissedTurn.value = state.value?.turnNumber ?? null;
  if (action !== null && request.value?.legalActions.some((a) => a.id === action.id)) {
    chooseAction(action);
  }
}
const selectedSourceName = computed(() =>
  focusedSourceId.value === null ? null : (nameById.value.get(focusedSourceId.value) ?? null),
);

/** The server's presentation entry for an action in the current request. */
function entryOf(action: LegalAction) {
  return entryFor(request.value, action);
}
/** The text on an action's button in the source panel. */
function labelOf(action: LegalAction): string {
  return buttonLabel(action, entryOf(action));
}
const selectedEntry = computed(() =>
  selectedAction.value === null ? undefined : entryOf(selectedAction.value),
);
/** The card or permanent an action comes from, by name. */
function sourceNameOf(action: LegalAction): string | null {
  const id = sourceId(action);
  if (id === null) return null;
  // A card played from the top of a library is in no zone `nameById` covers.
  const top = state.value?.revealedLibraryTops?.find((entry) => entry.card.id === id);
  return nameById.value.get(id) ?? top?.card.name ?? null;
}

function targetSlots(action: LegalAction | null) {
  if (action === null) return [];
  const interaction = action.interaction ?? { kind: 'choice' as const };
  if (interaction.kind === 'source' || interaction.kind === 'choice') {
    return interaction.targetSlots ?? action.targets ?? [];
  }
  return action.targets ?? [];
}

const canConfirm = computed(() =>
  targetSlots(selectedAction.value).every((slot) => chosenTargets.value[slot.slot] !== undefined),
);
const selectedTargetCount = computed(() => Object.keys(chosenTargets.value).length);
const targetCount = computed(() => targetSlots(selectedAction.value).length);
/**
 * What each opponent did since you last did something other than pass, grouped by seat so "takes mulligan"
 * four times reads as who did what. Turn markers are skipped; each seat shows its latest few
 * lines and how many more there were.
 */
const BOT_LINES_PER_SEAT = 3;
const opponentActivity = computed(() => {
  const viewer = state.value?.viewerSeat;
  const since = store.lastPlayerActionSequence;
  const bySeat = new Map<string, Array<{ sequence: number; text: string }>>();
  for (const line of store.log) {
    if (since !== null && line.sequence <= since) continue;
    if (line.actorSeat === null || line.actorSeat === viewer || line.emphasis === 'turn') continue;
    const lines = bySeat.get(line.actorSeat) ?? [];
    lines.push({ sequence: line.sequence, text: line.text });
    bySeat.set(line.actorSeat, lines);
  }
  return [...bySeat].map(([seat, lines]) => ({
    seat,
    label: seatLabel(seat),
    lines: lines.slice(-BOT_LINES_PER_SEAT),
    more: Math.max(0, lines.length - BOT_LINES_PER_SEAT),
  }));
});

/** The active opponent's column is wider, so the seat whose turn it is reads first. */
/** Opponent panels share the width by how much each has in play; a seat that is out keeps a sliver. */
const opponentColumns = computed(() =>
  opponents.value
    .map((opponent) => {
      const weight = opponent.hasLost ? 0.42 : 1 + opponentBoardGroups(opponent.seat).length / 10;
      return `minmax(0, ${weight}fr)`;
    })
    .join(' '),
);

/** The combat strip and the attacked seats' chips, in words (`combatSummary.ts`). */
const combatStripHidden = ref(false);
const combatSummary = computed(() => {
  const board = state.value;
  if (board === null) return null;
  return summarizeCombat({
    phase: board.phase,
    step: board.step,
    priorityPlayer: board.priorityPlayer,
    permanents: board.battlefield,
    seats: board.seats.map((seat) => ({ seat: seat.seat, label: seat.label })),
    plan:
      combatPlan.mode === 'composing' && combatPlan.kind !== null
        ? {
            kind: combatPlan.kind,
            assignment: combatPlan.assignment,
            subjects: combatPlan.order.length,
          }
        : null,
  });
});

/**
 * The combat lane (`combatLane.ts`): the board's combat as columns, your plan while you compose
 * it, and the creatures that fell during damage. `laneMemory` remembers this turn's lane so the
 * damage beat can show who left and the recap can say what happened.
 */
let laneMemory: { turn: number; model: LaneModel } | null = null;
const combatLane = computed<LaneModel | null>(() => {
  const board = state.value;
  if (board === null) return null;
  const planned = combatPlan.mode === 'composing' || combatPlan.mode === 'replaying';
  const raw = buildCombatLane({
    phase: board.phase,
    step: board.step,
    priorityPlayer: board.priorityPlayer,
    viewerSeat: board.viewerSeat,
    permanents: board.battlefield,
    seats: board.seats.map((seat) => ({ seat: seat.seat, label: seat.label, life: seat.life })),
    plan:
      planned && combatPlan.kind !== null
        ? {
            kind: combatPlan.kind,
            assignment: combatPlan.assignment,
            options: combatPlan.order.map((entry) => entry.optionIds),
          }
        : null,
  });
  const damaging =
    board.phase === 'combat' &&
    (board.step === 'firstStrikeCombatDamage' ||
      board.step === 'combatDamage' ||
      board.step === 'endCombat');
  const previous = laneMemory?.turn === board.turnNumber ? laneMemory.model : null;
  // Every attacker may have fallen: the lane then keeps them, from what it last showed.
  const current =
    raw ??
    (damaging && previous !== null && previous.kind !== 'attackers'
      ? {
          ...previous,
          kind: 'declared' as const,
          title:
            board.step === 'endCombat'
              ? 'End of combat'
              : board.step === 'firstStrikeCombatDamage'
                ? 'First strike damage'
                : 'Damage',
          beat: board.step === 'firstStrikeCombatDamage' ? 2 : previous.beats.length - 1,
          groups: [],
        }
      : null);
  if (current === null) return null;
  const model = damaging
    ? withDeparted(current, previous, new Set(board.battlefield.map((p) => p.id)))
    : current;
  laneMemory = { turn: board.turnNumber, model };
  return model;
});

/** Life totals when this turn's combat first showed, for the recap. */
const combatStart = ref<{ turn: number; attacker: string; life: Map<string, number> } | null>(null);
const lastCombat = ref<{ turn: number; model: LaneModel } | null>(null);
watch(combatLane, (model) => {
  const board = state.value;
  if (model === null || board === null) return;
  if (combatStart.value?.turn !== board.turnNumber) {
    // A new combat shows its lane again, even if the last one was hidden.
    combatStripHidden.value = false;
    combatStart.value = {
      turn: board.turnNumber,
      attacker: board.activePlayer,
      life: new Map(board.seats.map((seat) => [seat.seat, seat.life])),
    };
  }
  if (model.kind !== 'attackers') lastCombat.value = { turn: board.turnNumber, model };
});
/** Life totals as combat left them, so later life changes this turn aren't put down to combat. */
const combatEndLife = ref<{ turn: number; life: Map<string, number> } | null>(null);
watch(
  () => {
    const board = state.value;
    if (board === null || board.phase !== 'combat') return null;
    return `${board.turnNumber}|${board.seats.map((seat) => `${seat.seat}:${seat.life}`).join(',')}`;
  },
  (key) => {
    const board = state.value;
    if (key === null || board === null) return;
    combatEndLife.value = {
      turn: board.turnNumber,
      life: new Map(board.seats.map((seat) => [seat.seat, seat.life])),
    };
  },
  { immediate: true },
);
/** The line the lane folds into for the rest of the turn once combat is over. */
const combatRecapLine = computed(() => {
  const board = state.value;
  const last = lastCombat.value;
  const start = combatStart.value;
  if (board === null || last === null || start === null) return null;
  if (board.phase === 'combat' || last.turn !== board.turnNumber) return null;
  if (board.phase !== 'postcombatMain' && board.phase !== 'ending') return null;
  const end = combatEndLife.value?.turn === board.turnNumber ? combatEndLife.value.life : null;
  return combatRecap(
    last.model,
    start.attacker,
    start.life,
    board.seats.map((seat) => ({
      seat: seat.seat,
      label: seat.label,
      life: end?.get(seat.seat) ?? seat.life,
    })),
    board.viewerSeat,
  );
});
const laneShowing = computed(
  () => !combatStripHidden.value && (combatLane.value !== null || combatRecapLine.value !== null),
);

/** The creature you are holding while you declare, and where it may go. */
const combatAimSourceId = computed(() =>
  combatPlan.mode === 'composing' ? (draggedId.value ?? focusedSourceId.value) : null,
);
watch(combatAimSourceId, (id) => {
  if (id === null) aimPointer.value = null;
});
const combatAimTargets = computed<ReadonlySet<string>>(() => {
  const id = combatAimSourceId.value;
  if (id === null) return new Set();
  return new Set(combatPlan.order.find((entry) => entry.subjectId === id)?.optionIds ?? []);
});
/** A click on a lane group or slot: the creature you hold goes there. */
function laneTarget(targetId: string): void {
  if (combatPlan.kind === 'attackers' && sendTargets.value.includes(targetId)) {
    sendAt(targetId);
    return;
  }
  tryPlanAssign(targetId);
}
/**
 * The lane draws its cards and slots only on defense: while blocks are declared, or while attacks
 * come at you on someone else's turn. When you attack it keeps to the hint, the life numbers and
 * the confirm.
 */
const laneCards = computed(() => {
  const lane = combatLane.value;
  if (lane === null) return false;
  if (lane.kind === 'blockers') return true;
  const viewer = state.value?.viewerSeat;
  return (
    !isYourTurn.value && viewer != null && lane.groups.some((group) => group.targetId === viewer)
  );
});

/** Who the lane says the game is waiting on, when it isn't you. */
const laneWaiting = computed(() => {
  if (request.value !== null) return null;
  const seat = waitingSeat.value;
  return seat === null ? null : `Waiting on ${seatLabel(seat)}: ${seat} ${waitingActivity.value}.`;
});

/** Each opponent's seat letter registers as an anchor, so an aimed attack's arrow ends at the player. */
const nameAnchorRefs = new Map<string, (el: Element | ComponentPublicInstance | null) => void>();
function nameAnchorRef(seatId: string): (el: Element | ComponentPublicInstance | null) => void {
  let fn = nameAnchorRefs.get(seatId);
  if (fn === undefined) {
    fn = (el) => registerAnchor(`name:${seatId}`, el instanceof Element ? el : null);
    nameAnchorRefs.set(seatId, fn);
  }
  return fn;
}

const ZONE_WORDS: Record<string, string> = {
  graveyard: 'in graveyard',
  exile: 'in exile',
  hand: 'in hand',
  library: 'in library',
  stack: 'on the stack',
};
/** Where a seat's commander is, in the design's short words: "Cmdr in play", "Cmdr in zone". */
function commanderState(seat: { commanders: readonly { zone: string }[] }): string {
  const zones = seat.commanders.map((commander) => commander.zone);
  if (zones.length === 0) return 'No commander';
  if (zones.includes('battlefield')) return 'Cmdr in play';
  const away = zones.find((zone) => zone !== 'command');
  if (away === undefined) return 'Cmdr in zone';
  return `Cmdr ${ZONE_WORDS[away] ?? `in ${away}`}`;
}

/** A minus sign, not a hyphen, for numbers below zero. */
function signed(n: number): string {
  return n < 0 ? `−${Math.abs(n)}` : String(n);
}
/** Why a seat is out, for its folded panel. */
function outNote(seat: {
  life: number;
  poisonCounters: number;
  lossReason: string | null;
}): string {
  switch (seat.lossReason) {
    case 'lifeZeroOrLess':
      return `Lost at ${signed(seat.life)} life.`;
    case 'emptyLibraryDraw':
      return 'Lost drawing from an empty library.';
    case 'poisonCounters':
      return `Lost to ${seat.poisonCounters} poison counters.`;
    case 'commanderDamage':
      return 'Lost to 21 commander damage.';
    default:
      return 'Out of the game.';
  }
}

/** Life at the start of this turn, so the rail can say what the turn has cost. */
const lifeAtTurnStart = ref(new Map<string, number>());
watch(
  () => state.value?.turnNumber,
  () => {
    lifeAtTurnStart.value = new Map(
      (state.value?.seats ?? []).map((seat) => [seat.seat, seat.life]),
    );
  },
  { immediate: true },
);
function lifeDeltaText(seatId: string): string {
  const seat = state.value?.seats.find((entry) => entry.seat === seatId);
  const start = lifeAtTurnStart.value.get(seatId);
  if (seat === undefined || start === undefined || seat.life === start) return '';
  const change = seat.life - start;
  return `${change > 0 ? '+' : '−'}${Math.abs(change)} this turn`;
}
/** Commander tax, one figure per commander: "+2", or "+2 / +0" for partners. */
const commanderTaxText = computed(() => {
  const commanders = human.value?.commanders ?? [];
  if (commanders.length === 0) return '+0';
  return commanders.map((commander) => `+${commander.taxGeneric}`).join(' / ');
});

/** The interaction marks every tile of yours can wear. */
function permanentClasses(id: ObjectId): Record<string, boolean> {
  return {
    focused: focusedSourceId.value === id,
    targetable: isLegalTarget(id),
    'chosen-target': isChosenTarget(id),
    'payment-source': isPaymentSource(id),
    actionable: actionableSourceIds.value.has(id),
    'makes-mana': (manaByGroup.value.get(id) ?? []).length > 0,
  };
}

/**
 * The tag a tile wears while you compose a declaration: "→ P2" for an attacker you have sent,
 * "2 → P2" when two of a stack go, "Blocks Klauth" for a blocker.
 */
function planTagFor(id: ObjectId): string | null {
  if (combatPlan.mode !== 'composing' && combatPlan.mode !== 'replaying') return null;
  if (combatPlan.assignment.size === 0 || human.value === null) return null;
  const yours = permanentsFor(human.value.seat);
  const representative = yours.find((permanent) => permanent.id === id);
  if (representative === undefined) return null;
  const key = stackKey(representative);
  const targets = yours
    .filter((permanent) => stackKey(permanent) === key)
    .map((permanent) => combatPlan.assignment.get(permanent.id))
    .filter((target): target is string => target !== undefined);
  if (targets.length === 0) return null;
  const first = targets[0]!;
  const count = targets.length > 1 ? `${targets.length} ` : '';
  const sameTarget = targets.every((target) => target === first);
  if (combatPlan.kind === 'attackers') {
    const seat = state.value?.seats.find((entry) => entry.seat === first);
    const label = seat !== undefined ? seat.seat : (nameById.value.get(first) ?? first);
    return sameTarget ? `${count}→ ${label}` : `${count}attacking`;
  }
  return sameTarget ? `${count}Blocks ${nameById.value.get(first) ?? first}` : `${count}blocking`;
}

/** The seat the game is waiting on when you have no decision, or null while it resolves yours. */
const waitingSeat = computed(() => {
  const board = state.value;
  if (board === null) return null;
  const seat = board.priorityPlayer ?? board.activePlayer;
  return seat === board.viewerSeat ? null : seat;
});
/** What the waiting seat is doing, in the design's words ("is blocking"). */
const waitingActivity = computed(() => {
  const board = state.value;
  const seat = waitingSeat.value;
  if (board === null || seat === null) return '';
  if (board.step === 'declareBlockers' && seat !== board.activePlayer) return 'is blocking';
  if (board.step === 'declareAttackers' && seat === board.activePlayer) return 'is attacking';
  if (board.stack.length > 0) return 'is responding';
  return 'is deciding';
});

/**
 * An attacker you are blocking wears the same "blocked" tag as a declared block while you compose,
 * so the tile and the dashed line agree before you confirm.
 */
function plannedBlockTag(id: ObjectId): string | null {
  if (combatPlan.mode !== 'composing' || combatPlan.kind !== 'blockers') return null;
  const attacker = state.value?.battlefield.find((permanent) => permanent.id === id);
  if (attacker === undefined || attacker.attacking == null) return null;
  const blocked = [...combatPlan.assignment.values()].some((target) => target === id);
  if (!blocked) return null;
  const target = attacker.attackingPlaneswalker ?? attacker.attacking;
  return `→ ${nameById.value.get(target) ?? target} · blocked`;
}

/** With a blocker picked up, the creatures it cannot block fade back, as in the design. */
function outOfBlockReach(id: ObjectId): boolean {
  if (combatPlan.mode !== 'composing' || combatPlan.kind !== 'blockers') return false;
  const source = draggedId.value ?? focusedSourceId.value;
  if (source === null || !combatPlan.order.some((entry) => entry.subjectId === source))
    return false;
  // Blockers themselves never fade: you may be choosing blocks for another seat's creatures.
  if (combatPlan.order.some((entry) => entry.subjectId === id)) return false;
  return !combatPlan.isLegalTarget(source, id);
}

/** The decision band's kicker and title: whose move it is and what it is. */
const decisionKicker = computed(() => {
  if (request.value !== null) return 'Your move';
  if (state.value === null) return 'Waiting';
  return waitingSeat.value === null ? 'Working' : `Waiting on ${waitingSeat.value}`;
});
const decisionTitle = computed(() => {
  const req = request.value;
  if (req === null) {
    if (state.value === null) return 'Getting the game ready';
    const seat = waitingSeat.value;
    return seat === null ? 'Resolving' : `${seatLabel(seat)} ${waitingActivity.value}`;
  }
  if (combatPlan.mode === 'composing' || combatPlan.mode === 'replaying') {
    if (combatPlan.split !== null) return combatHeading.value;
    return combatPlan.kind === 'attackers' ? 'Declare attackers' : 'Declare blockers';
  }
  if (selectedAction.value !== null)
    return sourceNameOf(selectedAction.value) ?? selectedSourceName.value ?? 'Choose targets';
  if (req.decisionType === 'priority') return combatPriorityTitle.value ?? 'Your priority';
  return 'Make a choice';
});
/**
 * Priority in the middle of a combat you attacked in reads as the design's combat beats: "Attackers
 * declared" while the defenders choose blocks, "Blocks are in" once they have.
 */
const combatPriorityTitle = computed(() => {
  const summary = combatSummary.value;
  const board = state.value;
  if (summary === null || board === null || board.activePlayer !== board.viewerSeat) return null;
  if (summary.label === 'Combat · blockers') return 'Attackers declared';
  if (summary.label === 'Combat · blocks declared') return 'Blocks are in';
  return null;
});
/** The sentence under the title for those beats. */
const decisionBody = computed(() => {
  if (request.value?.decisionType !== 'priority' || combatPlan.mode !== 'idle') return '';
  const title = combatPriorityTitle.value;
  if (title === 'Attackers declared')
    return 'Attacks are locked in. Each defending player now chooses blocks.';
  if (title === 'Blocks are in') return combatSummary.value?.prose.join(' ') ?? '';
  return '';
});
/** A priority stop whose prompt only restates the title ("You have priority (…). Choose…"). */
function isPlainPriority(req: DecisionRequest): boolean {
  return (
    req.decisionType === 'priority' &&
    /^You have priority \([^)]*\)\. Choose an action\.$/.test(promptOf(req).trim())
  );
}
/** The band's body while you wait: the design says plainly that nothing is asked of you yet. */
const waitingBody = computed(() => {
  const board = state.value;
  if (board === null) return 'Getting the game ready…';
  if (waitingSeat.value === null) return 'Resolving your action…';
  const yoursAttacking = board.battlefield.some(
    (p) => p.controller === board.viewerSeat && p.attacking != null,
  );
  if (waitingActivity.value === 'is blocking' && yoursAttacking)
    return 'Nothing to do yet. Their blocks show on the board once they are declared.';
  return 'Nothing to do yet.';
});

/**
 * "Send at": the seats your attackers can go to. Picking one sends the creature you last clicked
 * there, and is where "Attack with all" sends everyone.
 */
const sendTargets = computed(() => {
  if (combatPlan.mode !== 'composing' || combatPlan.kind !== 'attackers') return [];
  const seats = new Set((state.value?.seats ?? []).map((seat) => seat.seat));
  const found: string[] = [];
  for (const entry of combatPlan.order) {
    for (const option of entry.optionIds) {
      if (seats.has(option) && !found.includes(option)) found.push(option);
    }
  }
  return found;
});
const sendTarget = ref<string | null>(null);
watch(sendTargets, (targets) => {
  if (sendTarget.value !== null && !targets.includes(sendTarget.value)) sendTarget.value = null;
});
function sendAt(seat: string): void {
  sendTarget.value = seat;
  const subject = focusedSourceId.value;
  if (subject === null) return;
  const entry = combatPlan.order.find((candidate) => candidate.subjectId === subject);
  if (entry !== undefined && entry.optionIds.includes(seat)) combatPlan.assign(subject, seat);
}
/** Every creature not yet sent goes at the chosen seat, or the first seat it can attack. */
function attackWithAll(): void {
  for (const entry of combatPlan.order) {
    if (combatPlan.assignment.has(entry.subjectId)) continue;
    const target =
      sendTarget.value !== null && entry.optionIds.includes(sendTarget.value)
        ? sendTarget.value
        : entry.optionIds.find((option) => sendTargets.value.includes(option));
    if (target !== undefined) combatPlan.assign(entry.subjectId, target);
  }
}

function isImmediate(action: LegalAction): boolean {
  return action.interaction?.kind === 'immediate';
}

/**
 * An "immediate" (per the engine's own `interactionFor`) action never has anything to target
 * or confirm — pass, yield variants, mulligan keep/decline, and the like. Routing these through
 * the composed-action tray added an unnecessary click that a stray click elsewhere could
 * silently discard (`selectSource` clears `selectedActionId`), which is why "pass and yield
 * until end of turn" looked broken: the yield never actually got submitted. Only `pass` and
 * `playLand` — genuine resource commitments — still honour the "Confirm passes & lands"
 * preference; every other immediate action is always one-click.
 */
function isRoutineAction(action: LegalAction): boolean {
  if (!isImmediate(action)) return false;
  if (store.confirmRoutineActions && (action.type === 'pass' || action.type === 'playLand')) {
    return false;
  }
  return true;
}

function chooseAction(action: LegalAction): void {
  if (action.type === 'attackDeclaration' || action.type === 'blockDeclaration') {
    selectedActionId.value = null;
    if (request.value !== null) combatPlan.reopen(request.value);
    return;
  }
  if (needsLandReminder(action)) {
    pendingPass.value = action;
    return;
  }
  if (
    action.type === 'playLand' &&
    !store.confirmRoutineActions &&
    targetSlots(action).length === 0 &&
    sourceActions.value.filter((candidate) => sourceId(candidate) === sourceId(action)).length === 1
  ) {
    // Taken at once, so close the source: otherwise its tray shows a stale "Play" button until
    // the next request arrives, and pressing it resubmits an action that is already gone.
    focusedSourceId.value = null;
    store.submitPlayerAction(action.id);
    return;
  }
  selectedActionId.value = action.id;
  chosenTargets.value = {};
  if (isRoutineAction(action)) {
    store.submitPlayerAction(action.id);
  }
}

/**
 * A `chooseTargets` request is a triggered ability already committed to the stack — there is
 * nothing to decide except which targets, so making the player click the source permanent
 * first (the way choosing whether to cast a spell or activate an ability does) is an extra,
 * pointless step. Auto-opening the tray for these skips straight to targeting.
 */
watch(
  () => request.value?.requestId,
  () => {
    selectedActionId.value = null;
    focusedSourceId.value = null;
    chosenTargets.value = {};
    pendingPass.value = null;
    const req = request.value;
    if (req?.decisionType === 'chooseTargets' && req.legalActions.length === 1) {
      const [only] = req.legalActions;
      if (only !== undefined) chooseAction(only);
    }
  },
  // A trigger's targets may be the first thing asked, already pending when the board mounts.
  { immediate: true },
);

function chooseFallbackAction(actionId: number): void {
  const action = request.value?.legalActions.find((candidate) => candidate.id === actionId);
  if (action?.type === 'attackDeclaration' || action?.type === 'blockDeclaration')
    chooseAction(action);
  else store.submitPlayerAction(actionId);
}

function chooseTarget(id: ObjectId | string): boolean {
  if (selectedAction.value !== null) {
    const slot = targetSlots(selectedAction.value).find(
      (candidate) =>
        chosenTargets.value[candidate.slot] === undefined && candidate.options.includes(id),
    );
    if (slot !== undefined) {
      chosenTargets.value = { ...chosenTargets.value, [slot.slot]: id };
      return true;
    }
  }
  return false;
}

/**
 * Ids the pending action can target that live in a displayed zone strip (graveyard, exile) —
 * for example "return target artifact card from your graveyard". Battlefield and player
 * targets already have click affordances; zone cards need one too.
 */
const zoneTargetIds = computed(() => {
  if (selectedAction.value === null) return [];
  const ids: string[] = [];
  for (const slot of targetSlots(selectedAction.value)) {
    if (chosenTargets.value[slot.slot] !== undefined) continue;
    ids.push(...slot.options);
  }
  return ids;
});

/**
 * Sources of legal actions, for the zone strips: a graveyard card with unearth or flashback is
 * clicked like a hand card. Hidden while a target choice is pending so a click there is never
 * ambiguous.
 */
const zoneSourceIds = computed(() =>
  selectedAction.value === null
    ? [...actionableSourceIds.value].filter((id): id is ObjectId => id !== null)
    : [],
);

/**
 * A pile opens on its own while a card in it is the target being chosen, as an opponent's zones
 * do, and otherwise stays as you left it. A closed pile glows when a card inside can act.
 */
const landsShown = computed(
  () =>
    pilesOpen.value.lands ||
    humanLands.value.some((land) => isLegalTarget(land.id) || isChosenTarget(land.id)),
);
const graveyardShown = computed(
  () =>
    pilesOpen.value.graveyard ||
    (human.value?.graveyard ?? []).some((card) => zoneTargetIds.value.includes(card.id)),
);
const exileShown = computed(
  () =>
    pilesOpen.value.exile || humanExile.value.some((card) => zoneTargetIds.value.includes(card.id)),
);
/**
 * Mana you can make by hand right now, by the permanent that makes it (ADR 0030). Not while a
 * spell's targets are being chosen or combat is being declared: a click there means that.
 */
const manaActionsBySource = computed(() => {
  const bySource = new Map<string, LegalAction[]>();
  if (selectedAction.value !== null || combatPlan.mode === 'composing') return bySource;
  for (const action of request.value?.legalActions ?? []) {
    if (action.type !== 'activateManaAbility' || action.interaction?.kind !== 'source') continue;
    const id = action.interaction.sourceId;
    bySource.set(id, [...(bySource.get(id) ?? []), action]);
  }
  return bySource;
});
/**
 * The mana each tile of yours can make by hand, lands and the rest of your board (a Sol Ring, a
 * mana creature, a Treasure) alike: that of its first member that can, so clicking "×6 Forest"
 * taps one untapped Forest.
 */
const manaByGroup = computed(() => {
  const byGroup = new Map<string, LegalAction[]>();
  const yours = human.value === null ? [] : permanentsFor(human.value.seat);
  for (const group of [...humanBoardGroups.value, ...humanLandGroups.value]) {
    const key = stackKey(group.permanent);
    const member = yours.find(
      (permanent) => stackKey(permanent) === key && manaActionsBySource.value.has(permanent.id),
    );
    byGroup.set(group.permanent.id, member ? manaActionsBySource.value.get(member.id)! : []);
  }
  return byGroup;
});
function tapForMana(action: LegalAction): void {
  store.submitPlayerAction(action.id);
}
/**
 * A land tile in the open pile: one that only makes one kind of mana taps for it; anything else
 * (a choice of colors, another ability, a target being chosen) goes through the usual source
 * flow, with the mana buttons on the tile alongside.
 */
function clickLand(id: ObjectId): void {
  const mana = manaByGroup.value.get(id) ?? [];
  const hasOther = sourceActions.value.some((action) => sourceId(action) === id);
  if (mana.length === 1 && !hasOther) {
    tapForMana(mana[0]!);
    return;
  }
  selectSource(id);
}

function pileGlow(ids: readonly string[], targetIds: readonly string[]) {
  if (ids.some((id) => targetIds.includes(id))) return 'targetable' as const;
  if (ids.some((id) => actionableSourceIds.value.has(id as ObjectId))) return 'actionable' as const;
  return null;
}

/** During composing, a click assigns to the plan instead of selecting a real engine action. */
function tryPlanAssign(target: ObjectId | string, ownerSeat?: string): boolean {
  if (!combatPlan.assignFromBoardClick(focusedSourceId.value, target, ownerSeat)) return false;
  focusedSourceId.value = null;
  return true;
}

/** `ownerSeat` is the seat that controls a clicked permanent: while composing, a click on a
 * permanent that is not itself a legal target attacks that seat instead. */
function selectSource(id: ObjectId, ownerSeat?: string): void {
  if (combatPlan.mode === 'composing') {
    if (tryPlanAssign(id, ownerSeat)) return;
    if (combatPlan.order.some((entry) => entry.subjectId === id)) {
      focusedSourceId.value = focusedSourceId.value === id ? null : id;
    }
    return;
  }
  if (chooseTarget(id)) return;
  const nextSource = focusedSourceId.value === id ? null : id;
  focusedSourceId.value = nextSource;
  selectedActionId.value = null;
  chosenTargets.value = {};
  // The usual case has exactly one action (play this land, cast this spell, or activate this
  // ability). Selecting it should immediately put the player in its confirmation/targeting
  // flow; modes and other ambiguous sources still expose their explicit choice buttons.
  if (nextSource !== null) {
    const actions = sourceActions.value.filter((action) => sourceId(action) === nextSource);
    if (actions.length === 1 && actions[0] !== undefined) chooseAction(actions[0]);
  }
}

function chooseOpponent(seat: string): void {
  if (combatPlan.mode === 'composing') {
    tryPlanAssign(seat);
    return;
  }
  if (chooseTarget(seat)) return;
  const attack = (request.value?.legalActions ?? []).find(
    (action) =>
      action.interaction?.kind === 'attack' &&
      action.interaction.defenderId === seat &&
      (focusedSourceId.value === null || action.interaction.attackerId === focusedSourceId.value),
  );
  if (attack !== undefined) chooseAction(attack);
}

function confirm(): void {
  const action = selectedAction.value;
  if (action === null || !canConfirm.value) return;
  const targets: TargetChoice[] = Object.entries(chosenTargets.value).map(([slot, choice]) => ({
    slot: Number(slot),
    choice,
  }));
  store.submitPlayerAction(action.id, targets);
}

function cancel(): void {
  selectedActionId.value = null;
  chosenTargets.value = {};
}

/**
 * Opt-in ("Skip confirm step"): once every target slot on the open tray is filled, submit right
 * away instead of waiting for the explicit Confirm click. This watcher handles target completion;
 * a targetless land uses the direct path in `chooseAction`. The routine-confirm preference keeps
 * the review step for lands even when auto-confirm is enabled.
 */
watch(canConfirm, (ready) => {
  const action = selectedAction.value;
  if (
    ready &&
    store.autoConfirmActions &&
    action !== null &&
    !(action.type === 'playLand' && store.confirmRoutineActions)
  ) {
    confirm();
  }
});

/**
 * Flipping `combatPlan.mode` to 'replaying' alone submits nothing: the engine is still parked on
 * the same pending request it was composing over, so nothing else reacts on its own until a
 * submit happens. Kick the one whole-plan submit off immediately instead (ADR 0023 items 13/14,
 * Phase 4 — both attackers and blockers submit this way now).
 */
function confirmCombatPlan(): void {
  if (request.value === null || combatPlan.mode !== 'composing') return;
  combatPlan.confirm();
  const submission = combatPlan.pendingSubmission(request.value);
  // Held behind a deal warning: keep composing, so "Go back" returns to the plan as it was.
  if (submission === null || !store.submitPlayerAction(submission.actionId, submission.targets)) {
    combatPlan.reopen(request.value);
  }
}

function cancelCombatPlan(): void {
  combatPlan.cancel();
  focusedSourceId.value = null;
  if (request.value !== null) combatPlan.onRequest(request.value);
}

const confirmButtonRef = ref<HTMLButtonElement | null>(null);

watch(selectedAction, (action) => {
  if (action !== null) {
    void nextTick(() => confirmButtonRef.value?.focus());
  }
});

/**
 * Enter/Escape/Space, scoped to this view. Inputs and native button/link activation own their
 * keys; Escape still cancels an open action or resets a declaration when a button is focused.
 */
function onKeyDown(event: KeyboardEvent): void {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
      (target.closest('button, a') && ['Enter', ' '].includes(event.key)))
  )
    return;
  // An open dialog owns the keyboard: Space on its focused button must not also pass priority.
  if (confirmingAbandon.value || pendingPass.value !== null || store.dealWarning !== null) return;

  if (event.key === 'Enter') {
    if (selectedAction.value !== null && canConfirm.value) {
      event.preventDefault();
      confirm();
    } else if (combatPlan.mode === 'composing') {
      event.preventDefault();
      confirmCombatPlan();
    }
    return;
  }
  if (event.key === 'Escape') {
    if (selectedAction.value !== null) {
      event.preventDefault();
      cancel();
    } else if (combatPlan.mode === 'composing') {
      event.preventDefault();
      cancelCombatPlan();
    }
    return;
  }
  if (event.key === ' ' || event.code === 'Space') {
    // Don't steal Space from an in-progress target choice or a combat declaration in composing.
    if (selectedAction.value !== null || combatPlan.mode !== 'idle') return;
    const pass = immediateActions.value.find((action) => action.type === 'pass');
    if (pass !== undefined) {
      event.preventDefault();
      chooseAction(pass);
    }
  }
}

onMounted(() => window.addEventListener('keydown', onKeyDown));
onUnmounted(() => window.removeEventListener('keydown', onKeyDown));

/**
 * A custom, card-sized drag ghost (§9.8.3) instead of the browser's default full-tile image: the
 * dragged element's own `<img>` (found via the event's current target) is what actually renders,
 * offset to sit under the cursor rather than anchored at its top-left corner.
 */
function dragStart(id: ObjectId, event: DragEvent): void {
  draggedId.value = id;
  if (selectedAction.value === null) {
    focusedSourceId.value = id;
    chosenTargets.value = {};
  }
  const img =
    event.currentTarget instanceof HTMLElement ? event.currentTarget.querySelector('img') : null;
  if (img instanceof HTMLImageElement) {
    event.dataTransfer?.setDragImage(img, img.clientWidth / 2, img.clientHeight / 2);
  }
}

function dragEnd(): void {
  draggedId.value = null;
  dragPointer.value = null;
}

function showCardPreview(
  card: { scryfallId: string | null; name: string },
  event: MouseEvent,
): void {
  cardPreview.show({ scryfallId: card.scryfallId, name: card.name });
  cardPreview.updateCursor(event.clientX, event.clientY);
}

function moveCardPreview(event: MouseEvent): void {
  cardPreview.updateCursor(event.clientX, event.clientY);
}

function hideCardPreview(): void {
  cardPreview.hide();
}

/** Keyboard focus on a commander peek shows its card beside the control, as hovering does. */
function focusCardPreview(
  card: { scryfallId: string | null; name: string },
  event: FocusEvent,
): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  cardPreview.show({ scryfallId: card.scryfallId, name: card.name });
  cardPreview.updateCursor(rect.right, rect.bottom);
}

/** Each commander's own tax: partners are taxed separately (CR 903.8). */
const taxedCommanders = computed(() =>
  (human.value?.commanders ?? []).filter((commander) => commander.taxGeneric > 0),
);

function resourceSummary(pool: ManaPool): string {
  const entries = Object.entries(pool).filter(([, amount]) => amount > 0);
  return entries.length === 0
    ? ''
    : entries.map(([color, amount]) => `${amount}${color}`).join(' ');
}

function isLegalTarget(target: ObjectId | string): boolean {
  if (combatPlan.mode === 'composing') {
    const source = draggedId.value ?? focusedSourceId.value;
    return source !== null && combatPlan.isLegalTarget(source, target as string);
  }
  if (selectedAction.value !== null) {
    const nextSlot = targetSlots(selectedAction.value).find(
      (slot) => chosenTargets.value[slot.slot] === undefined,
    );
    return nextSlot?.options.includes(target) ?? false;
  }
  const source = draggedId.value ?? focusedSourceId.value;
  if (source === null) return false;
  return (request.value?.legalActions ?? []).some((candidate) => {
    const interaction = candidate.interaction ?? { kind: 'choice' as const };
    if (interaction.kind === 'attack')
      return interaction.attackerId === source && interaction.defenderId === target;
    if (interaction.kind === 'block')
      return interaction.blockerId === source && interaction.attackerId === target;
    return (
      interaction.kind === 'source' &&
      interaction.sourceId === source &&
      (interaction.targetSlots ?? candidate.targets ?? []).some((slot) =>
        slot.options.includes(target),
      )
    );
  });
}

function isChosenTarget(target: ObjectId | string): boolean {
  if (combatPlan.mode === 'composing') {
    return [...combatPlan.assignment.values()].includes(target as string);
  }
  return Object.values(chosenTargets.value).includes(target as ObjectId);
}

function isPaymentSource(id: ObjectId): boolean {
  if (selectedAction.value === null) return false;
  return entryFor(request.value, selectedAction.value)?.payment?.sourceIds.includes(id) ?? false;
}

function selectedTargetLabel(slot: string, choice: ObjectId): string {
  return `Target ${Number(slot) + 1}: ${nameById.value.get(choice) ?? choice}`;
}

function dropToBattlefield(): void {
  const source = draggedId.value;
  draggedId.value = null;
  dragPointer.value = null;
  if (source === null) return;
  const action = (request.value?.legalActions ?? []).find(
    (candidate) =>
      (candidate.type === 'playLand' || candidate.type === 'castSpell') &&
      sourceId(candidate) === source &&
      targetSlots(candidate).length === 0,
  );
  if (action !== undefined) chooseAction(action);
}

function dropOn(target: ObjectId | string, ownerSeat?: string): void {
  const source = draggedId.value;
  draggedId.value = null;
  dragPointer.value = null;
  if (source === null) return;
  if (combatPlan.mode === 'composing') {
    combatPlan.assignFromBoardClick(source, target as string, ownerSeat);
    return;
  }
  const action = (request.value?.legalActions ?? []).find((candidate) => {
    const interaction = candidate.interaction ?? { kind: 'choice' as const };
    if (
      interaction.kind === 'attack' &&
      interaction.attackerId === source &&
      interaction.defenderId === target
    )
      return true;
    if (
      interaction.kind === 'block' &&
      interaction.blockerId === source &&
      interaction.attackerId === target
    )
      return true;
    return (
      interaction.kind === 'source' &&
      interaction.sourceId === source &&
      (interaction.targetSlots ?? candidate.targets ?? []).some((slot) =>
        slot.options.includes(target),
      )
    );
  });
  if (action === undefined) return;
  chooseAction(action);
  const slot = targetSlots(action).find((candidate) => candidate.options.includes(target));
  if (slot !== undefined) chosenTargets.value = { [slot.slot]: target };
}

const confirmingAbandon = ref(false);

function abandon(): void {
  confirmingAbandon.value = false;
  store.abandonGame();
  void router.push('/');
}
</script>

<template>
  <div class="player-game">
    <YourTurnFlash
      :active="isYourTurn"
      :turn="state?.turnNumber ?? null"
      :reduced-motion="store.reducedMotion"
      :suppressed="openingHand !== null"
    />
    <OpeningHand
      v-if="openingHand"
      :request="openingHand.request"
      :cards="openingHand.hand"
      :mulligans-taken="openingHand.mulligansTaken"
      @choose="store.submitPlayerAction"
    />
    <!-- The board's header, in the app's top bar (which folds the site's ruler away while you play):
         the turn and where in it on the left, your resources and the ways out on the right. -->
    <Teleport to="#top-bar-status" defer>
      <span v-if="state" class="turn-badge" :class="{ 'your-turn': isYourTurn }">
        <!-- The text reads "Turn 6 · Your turn" as before, for screen readers and the tests; the
             separator is hidden and the two halves are styled apart. -->
        <span class="turn-round">Turn {{ state.turnNumber }}</span
        ><span class="dt-sr"> · </span
        ><span class="turn-tag">{{
          isYourTurn ? 'Your turn' : `${state.activePlayer}'s turn`
        }}</span>
      </span>
      <!-- Where in the turn: a ruler of the five phases with a warm dot on the current one. -->
      <ol
        v-if="state"
        class="turn-ruler"
        :style="{ '--stop': turnStopIndex, '--stops': TURN_STOPS.length }"
        aria-hidden="true"
      >
        <li
          v-for="(stop, i) in TURN_STOPS"
          :key="stop.phase"
          :class="{ reached: i <= turnStopIndex, on: i === turnStopIndex }"
        >
          <span class="stop-label">{{ stop.label }}</span>
        </li>
      </ol>
      <!-- The ruler draws the position; readers get it in words, with who holds priority. -->
      <span v-if="state" class="dt-sr phase-label">{{
        turnPositionLabel(state.phase, state.step)
      }}</span>
      <span v-if="state?.priorityPlayer" class="dt-sr priority-label"
        >Priority:
        {{ state.priorityPlayer === state.viewerSeat ? 'You' : state.priorityPlayer }}</span
      >
      <span class="bar-spacer" />
      <!-- Your resources, beside the turn they belong to: global counters, the land drop, and the
           mana you can spend right now. -->
      <span v-if="human" class="bar-resources" aria-label="Your resources">
        <GlobalCounters
          :energy="human.energy"
          :poison-counters="human.poisonCounters"
          :counters="human.counters"
          compact
        />
        <span class="resource" :class="{ ready: human.landsPlayedThisTurn === 0 }">{{
          human.landsPlayedThisTurn === 0 ? 'Land drop available' : 'Land played'
        }}</span>
        <span
          class="resource"
          title="Mana you can spend on anything right now: floating mana plus sources that need no mana to activate and whose mana has no spending restriction."
          >Mana ready <strong>{{ state!.viewerMana.units }}</strong
          ><span
            v-for="color in state!.viewerMana.colors"
            :key="color"
            class="mana-dot"
            :class="`mana-${color}`"
            >{{ color }}</span
          ></span
        >
        <span v-if="resourceSummary(human.manaPool)" class="resource"
          >Floating <strong>{{ resourceSummary(human.manaPool) }}</strong></span
        >
      </span>
      <span v-if="gameOverLine" class="game-over-badge">{{ gameOverLine }}</span>
      <!-- Only a problem is worth the space: a healthy connection says nothing. -->
      <span v-if="store.connection !== 'open'" :class="['connection', store.connection]">{{
        CONNECTION_LABELS[store.connection]
      }}</span>
      <span class="bar-links">
        <button
          v-if="combatStripHidden && (combatLane !== null || combatRecapLine !== null)"
          type="button"
          class="bar-link"
          @click="combatStripHidden = false"
        >
          <span aria-hidden="true">[ </span>Combat<span aria-hidden="true"> ]</span>
        </button>
        <button
          type="button"
          class="bar-link"
          :aria-expanded="infoOpen"
          aria-controls="player-game-info"
          @click="toggleInfo"
        >
          <span aria-hidden="true">[ </span>Game log<span aria-hidden="true"> ]</span>
        </button>
        <button
          type="button"
          class="bar-link"
          :aria-expanded="settingsOpen"
          aria-controls="player-settings"
          @click="toggleSettings"
        >
          <span aria-hidden="true">[ </span>Settings<span aria-hidden="true"> ]</span>
        </button>
        <!-- Leaving ends the game, so it asks first, as Abandon does; a table's game is its host's. -->
        <button
          v-if="store.gameMode !== 'table'"
          type="button"
          class="leave-game"
          @click="confirmingAbandon = true"
        >
          Leave game
        </button>
      </span>
    </Teleport>

    <!-- Bot pace, confirmations, motion and Abandon: set once, rarely touched, so folded away. -->
    <div
      v-show="settingsOpen"
      id="player-settings"
      class="settings-menu"
      aria-label="Settings"
      :style="settingsTop === null ? undefined : { top: settingsTop + 'px' }"
    >
      <div class="pace">
        Bot turns
        <button type="button" :class="{ active: store.paceMs === 0 }" @click="store.setPace(0)">
          Next choice
        </button>
        <button type="button" :class="{ active: store.paceMs === 400 }" @click="store.setPace(400)">
          Watch
        </button>
        <button
          type="button"
          :class="{ active: store.paceMs === 1200 }"
          @click="store.setPace(1200)"
        >
          Slow
        </button>
      </div>
      <label class="routine-confirm">
        <input
          :checked="store.confirmRoutineActions"
          type="checkbox"
          @change="store.setConfirmRoutineActions(($event.target as HTMLInputElement).checked)"
        />
        Confirm passes & lands
      </label>
      <label class="routine-confirm">
        <input
          :checked="store.remindUnplayedLand"
          type="checkbox"
          @change="store.setRemindUnplayedLand(($event.target as HTMLInputElement).checked)"
        />
        Land drop reminder
      </label>
      <label class="routine-confirm">
        <input
          :checked="store.autoConfirmActions"
          type="checkbox"
          @change="store.setAutoConfirmActions(($event.target as HTMLInputElement).checked)"
        />
        Skip confirm step
      </label>
      <label class="routine-confirm">
        <input
          :checked="store.reducedMotion"
          type="checkbox"
          @change="store.setReducedMotion(($event.target as HTMLInputElement).checked)"
        />
        Reduce motion
      </label>
      <div class="settings-row">
        <span>Theme</span>
        <ThemeControl />
      </div>
      <div class="settings-row">
        <CopyGameReportButton />
        <!-- A table's game belongs to the table: only its host can end it, from the table bar. -->
        <button
          v-if="store.gameMode !== 'table'"
          type="button"
          class="abandon"
          @click="confirmingAbandon = true"
        >
          Abandon
        </button>
      </div>
    </div>

    <div v-if="store.connection !== 'open'" class="paused">
      Reconnecting… the engine will not begin another bot decision while you are away.
    </div>

    <div v-if="human?.yieldingUntilEndOfTurn" class="yield-banner">
      <span
        >Yielding until end of turn — you'll only be asked again if something targets you, threatens
        your board, or threatens your life or hand.</span
      >
      <button type="button" @click="store.cancelYield()">Take priority back</button>
    </div>

    <main v-if="state" class="player-layout" :class="{ 'info-open': infoOpen }">
      <section
        ref="tableRef"
        class="table"
        :class="{ 'has-combat': laneShowing }"
        @dragover="onBoardDragOver"
        @pointermove="onBoardPointerMove"
      >
        <CombatOverlay
          :drag-source-id="combatAimSourceId ?? draggedId"
          :pointer="dragPointer ?? aimPointer"
        />
        <!-- Opponents: one panel each, wider for the one whose turn it is. -->
        <div class="opponents" :style="{ '--opponent-columns': opponentColumns }">
          <article
            v-for="opponent in opponents"
            :key="opponent.seat"
            :ref="seatAnchorRef(opponent.seat)"
            class="opponent"
            :data-seat="opponent.seat"
            :aria-label="`${opponent.seat}, ${opponent.label}`"
            :class="{
              active: opponent.seat === state.activePlayer,
              out: opponent.hasLost,
              targetable: isLegalTarget(opponent.seat),
              'chosen-target': isChosenTarget(opponent.seat),
            }"
            @click="chooseOpponent(opponent.seat)"
            @dragover.prevent
            @drop="dropOn(opponent.seat)"
          >
            <!-- Who: seat, commander and a line of counts; then any combat chip and the life. -->
            <header>
              <span :ref="nameAnchorRef(opponent.seat)" class="id-badge">{{ opponent.seat }}</span>
              <span class="seat-who">
                <strong
                  class="seat-name"
                  tabindex="0"
                  @mouseenter="
                    opponent.commanders[0] && showCardPreview(opponent.commanders[0], $event)
                  "
                  @mousemove="moveCardPreview"
                  @mouseleave="hideCardPreview"
                  >{{ opponent.label }}</strong
                >
                <span class="seat-sub">
                  <template v-if="!opponent.hasLost">
                    <span class="cmdr-state">{{ commanderState(opponent) }}</span>
                    <span class="dot" aria-hidden="true">·</span>
                  </template>
                  <template v-if="opponent.commanders.length > 0">
                    <DeckColors :commanders="opponent.commanders" />
                    <span class="dot" aria-hidden="true">·</span>
                  </template>
                  <template v-if="opponent.hasLost">out</template>
                  <template v-else>
                    <span title="Cards in hand">hand {{ opponent.handSize }}</span>
                    <span class="dot" aria-hidden="true">·</span>
                    <span title="Cards in library">library {{ opponent.librarySize }}</span>
                  </template>
                </span>
              </span>
              <!-- One peek per commander, so a partner in the command zone, with no tile on the
                   board, can still be read. -->
              <span class="cmdr-peeks">
                <button
                  v-for="commander in opponent.commanders"
                  :key="commander.cardId"
                  type="button"
                  class="cmdr-peek"
                  :aria-label="`Show ${commander.name}`"
                  :title="commander.name"
                  @click.stop
                  @mouseenter="showCardPreview(commander, $event)"
                  @mousemove="moveCardPreview"
                  @mouseleave="hideCardPreview"
                  @focus="focusCardPreview(commander, $event)"
                  @blur="hideCardPreview"
                >
                  {{ commander.name.split(/[ ,]/)[0] }}
                </button>
              </span>
              <span
                v-if="combatSummary?.attacked.get(opponent.seat)"
                class="attacked-chip"
                :title="combatSummary.attacked.get(opponent.seat)"
                >{{ combatSummary.chips.get(opponent.seat) }}</span
              >
              <span
                v-if="state.monarchSeat === opponent.seat"
                class="monarch-badge"
                title="This player is the monarch"
                >MONARCH</span
              >
              <span
                class="life-badge"
                :aria-label="`${opponent.life} life`"
                :class="{
                  low: opponent.life <= 10,
                  'flash-damage': opponentLifeFlash[opponent.seat] === 'damage',
                  'flash-heal': opponentLifeFlash[opponent.seat] === 'heal',
                }"
                >{{ opponent.life }}</span
              >
            </header>
            <GlobalCounters
              :energy="opponent.energy"
              :poison-counters="opponent.poisonCounters"
              :counters="opponent.counters"
              compact
            />
            <div v-if="opponent.hasLost" class="opp-out">
              <span class="out-word">Out</span>
              <span class="out-note">{{ outNote(opponent) }}</span>
            </div>
            <TransitionGroup
              v-else
              :ref="zoneRef(`opp-${opponent.seat}`)"
              tag="div"
              name="board-card"
              class="permanents"
              :style="{
                '--chip-w': (opponentPermWidths.get(opponent.seat) ?? 140) + 'px',
                '--chip-min': opponentPermMinWidth + 'px',
              }"
            >
              <div
                v-for="group in opponentBoardGroups(opponent.seat)"
                :key="group.permanent.id"
                class="object"
                :class="{
                  targetable: isLegalTarget(group.permanent.id),
                  'chosen-target': isChosenTarget(group.permanent.id),
                  actionable: actionableSourceIds.has(group.permanent.id),
                  'out-of-reach': outOfBlockReach(group.permanent.id),
                }"
                draggable="true"
                @dragstart="dragStart(group.permanent.id, $event)"
                @dragend="dragEnd"
                @dragover.prevent
                @drop.stop="dropOn(group.permanent.id, opponent.seat)"
                @click.stop="selectSource(group.permanent.id, opponent.seat)"
              >
                <PermanentChip
                  :permanent="group.permanent"
                  :count="group.count"
                  :name-by-id="nameById"
                  :is-commander="commanderIds.has(group.permanent.id)"
                  :plan-tag="plannedBlockTag(group.permanent.id)"
                />
              </div>
            </TransitionGroup>
            <!-- Lands as a line of names, then the zones that are only counts. -->
            <div v-if="!opponent.hasLost" class="opp-foot">
              <span class="foot-label"
                >Lands {{ landCount(opponent.seat) }} ·
                {{ openLandCount(opponent.seat) }} open</span
              >
              <TransitionGroup tag="span" name="land-line" class="land-line">
                <span
                  v-for="(group, i) in opponentLandGroups(opponent.seat)"
                  :key="group.permanent.id"
                  class="object land-name"
                  :class="{
                    targetable: isLegalTarget(group.permanent.id),
                    'chosen-target': isChosenTarget(group.permanent.id),
                    actionable: actionableSourceIds.has(group.permanent.id),
                  }"
                  @dragover.prevent
                  @drop.stop="dropOn(group.permanent.id, opponent.seat)"
                  @click.stop="selectSource(group.permanent.id, opponent.seat)"
                  ><span v-if="i > 0" class="dot" aria-hidden="true">·</span
                  ><PermanentChip
                    :permanent="group.permanent"
                    :count="group.count"
                    :name-by-id="nameById"
                    variant="line"
                /></span>
              </TransitionGroup>
              <button
                type="button"
                class="zones-toggle"
                :aria-expanded="zonesShown(opponent.seat)"
                @click.stop="toggleZones(opponent.seat)"
              >
                <span aria-hidden="true">[ </span>Graveyard {{ opponent.graveyard.length
                }}<span aria-hidden="true"> ]</span>
              </button>
              <button
                type="button"
                class="zones-toggle"
                :aria-expanded="zonesShown(opponent.seat)"
                @click.stop="toggleZones(opponent.seat)"
              >
                <span aria-hidden="true">[ </span>Exile {{ exileFor(opponent.seat).length
                }}<span aria-hidden="true"> ]</span>
              </button>
            </div>
            <div v-show="zonesShown(opponent.seat)" class="zones-strip opponent-zones" @click.stop>
              <ZoneStrip
                label="Graveyard"
                :cards="opponent.graveyard"
                :selectable-ids="zoneTargetIds"
                :actionable-ids="zoneSourceIds"
                @select="chooseTarget"
                @activate="selectSource"
              />
              <ZoneStrip
                label="Exile"
                :cards="exileFor(opponent.seat)"
                :selectable-ids="zoneTargetIds"
                :actionable-ids="zoneSourceIds"
                @select="chooseTarget"
                @activate="selectSource"
              />
              <ZoneStrip
                v-if="revealedLibraryTopsFor(opponent.seat).length > 0"
                label="Top of library"
                :cards="revealedLibraryTopsFor(opponent.seat)"
                :selectable-ids="zoneTargetIds"
                :actionable-ids="zoneSourceIds"
                @select="chooseTarget"
                @activate="selectSource"
              />
              <ZoneStrip
                v-if="knownHandFor(opponent.seat).length > 0"
                label="Seen in hand"
                :cards="knownHandFor(opponent.seat)"
              />
            </div>
          </article>
        </div>

        <!-- Combat: one lane between the opponents and you, a column per attacker. -->
        <CombatLane
          v-if="laneShowing"
          class="combat-strip"
          :model="combatLane"
          :cards="laneCards"
          :lines="combatSummary?.lines ?? []"
          :recap="combatRecapLine"
          :composing="combatPlan.mode === 'composing'"
          :aim-targets="combatAimTargets"
          :rejection="combatPlan.rejectionMessage"
          :can-attack-all="combatPlan.kind === 'attackers' && combatPlan.split === null"
          :waiting="laneWaiting"
          :hint="combatInstruction"
          @target="laneTarget"
          @send-home="combatPlan.clear"
          @confirm="confirmCombatPlan"
          @attack-all="attackWithAll"
          @reset="cancelCombatPlan"
          @hide="combatStripHidden = true"
        />

        <!-- Your side: who you are, your creatures and the rest of your board in two columns, your
             lands under them; your life and the zones that are only counts in the rail. -->
        <section
          v-if="human"
          :ref="seatAnchorRef(human.seat)"
          class="human-zone"
          :class="{
            'your-turn': isYourTurn,
            // The hand row also holds a commander waiting in the command zone: keep it then.
            'no-hand': (human.hand ?? []).length === 0 && humanCommandZoneCount === 0,
          }"
        >
          <header
            :class="{
              targetable: isLegalTarget(human.seat),
              'chosen-target': isChosenTarget(human.seat),
            }"
            @click="chooseOpponent(human.seat)"
          >
            <span class="id-badge you">{{ human.seat }}</span>
            <span class="seat-name"
              >You ·
              <strong
                tabindex="0"
                @mouseenter="human.commanders[0] && showCardPreview(human.commanders[0], $event)"
                @mousemove="moveCardPreview"
                @mouseleave="hideCardPreview"
                >{{ human.label }}</strong
              ></span
            >
            <span class="seat-sub">
              <span class="cmdr-state">{{ commanderState(human) }}</span>
              <span class="dot" aria-hidden="true">·</span>
              <template v-if="human.commanders.length > 0">
                <DeckColors :commanders="human.commanders" />
                <span class="dot" aria-hidden="true">·</span>
              </template>
              <span>hand {{ human.hand?.length ?? human.handSize }}</span>
              <span class="dot" aria-hidden="true">·</span>
              <span>library {{ human.librarySize }}</span>
            </span>
            <span
              v-if="state.monarchSeat === human.seat"
              class="monarch-badge"
              title="You are the monarch"
              >MONARCH</span
            >
          </header>

          <div class="me-cols" :style="{ '--me-cols': meColumns }">
            <div class="me-zone">
              <span class="zone-label">Creatures {{ humanCreatureCount }}</span>
              <TransitionGroup
                :ref="zoneRef('human-creatures')"
                tag="div"
                name="board-card"
                class="permanents"
                @dragover.prevent
                @drop="dropToBattlefield"
              >
                <div
                  v-for="group in humanCreatureGroups"
                  :key="group.permanent.id"
                  class="object"
                  :style="{
                    '--chip-w': humanCreatureWidth + 'px',
                    '--chip-min': humanPermMinWidth + 'px',
                  }"
                  :class="permanentClasses(group.permanent.id)"
                  draggable="true"
                  @dragstart="dragStart(group.permanent.id, $event)"
                  @dragend="dragEnd"
                  @dragover.prevent
                  @drop.stop="dropOn(group.permanent.id)"
                  @click="selectSource(group.permanent.id)"
                >
                  <PermanentChip
                    :permanent="group.permanent"
                    :count="group.count"
                    :name-by-id="nameById"
                    :is-commander="commanderIds.has(group.permanent.id)"
                    :plan-tag="planTagFor(group.permanent.id)"
                  />
                  <ManaTaps
                    v-if="(manaByGroup.get(group.permanent.id) ?? []).length > 0"
                    :actions="manaByGroup.get(group.permanent.id)!"
                    :presentation="request?.presentation?.actions"
                    @tap="tapForMana"
                  />
                </div>
              </TransitionGroup>
            </div>
            <div class="me-zone">
              <span class="zone-label">{{ otherZoneLabel }} {{ humanOtherCount }}</span>
              <TransitionGroup
                :ref="zoneRef('human-other')"
                tag="div"
                name="board-card"
                class="permanents"
                @dragover.prevent
                @drop="dropToBattlefield"
              >
                <div
                  v-for="group in humanOtherGroups"
                  :key="group.permanent.id"
                  class="object"
                  :style="{
                    '--chip-w': humanOtherWidth + 'px',
                    '--chip-min': humanPermMinWidth + 'px',
                  }"
                  :class="permanentClasses(group.permanent.id)"
                  draggable="true"
                  @dragstart="dragStart(group.permanent.id, $event)"
                  @dragend="dragEnd"
                  @dragover.prevent
                  @drop.stop="dropOn(group.permanent.id)"
                  @click="selectSource(group.permanent.id)"
                >
                  <PermanentChip
                    :permanent="group.permanent"
                    :count="group.count"
                    :name-by-id="nameById"
                    :is-commander="commanderIds.has(group.permanent.id)"
                    :plan-tag="planTagFor(group.permanent.id)"
                  />
                  <ManaTaps
                    v-if="(manaByGroup.get(group.permanent.id) ?? []).length > 0"
                    :actions="manaByGroup.get(group.permanent.id)!"
                    :presentation="request?.presentation?.actions"
                    @tap="tapForMana"
                  />
                </div>
              </TransitionGroup>
            </div>
          </div>

          <!-- Lands: the same cards on a smaller ceiling, stacked by name; or one closed row. -->
          <div id="player-lands" class="land-area" :class="{ spread: landsShown }">
            <template v-if="landsShown">
              <button
                type="button"
                class="pile-close zone-label"
                aria-controls="player-lands"
                :aria-expanded="true"
                @click.stop="togglePile('lands')"
              >
                ▾ Lands {{ humanLands.length }} · {{ untappedLandCount }} untapped
              </button>
              <TransitionGroup
                :ref="zoneRef('human-lands')"
                tag="div"
                name="board-card"
                class="permanents lands"
              >
                <div
                  v-for="group in humanLandGroups"
                  :key="group.permanent.id"
                  class="object"
                  :style="{
                    '--chip-w': humanLandWidth + 'px',
                    '--chip-min': 40 + 'px',
                  }"
                  :class="permanentClasses(group.permanent.id)"
                  draggable="true"
                  @dragstart="dragStart(group.permanent.id, $event)"
                  @dragend="dragEnd"
                  @dragover.prevent
                  @drop.stop="dropOn(group.permanent.id)"
                  @click="clickLand(group.permanent.id)"
                >
                  <PermanentChip
                    :permanent="group.permanent"
                    :count="group.count"
                    :name-by-id="nameById"
                    :is-commander="commanderIds.has(group.permanent.id)"
                  />
                  <!-- Tap it for mana by hand: one button per kind of mana it can make. -->
                  <ManaTaps
                    v-if="(manaByGroup.get(group.permanent.id) ?? []).length > 0"
                    :actions="manaByGroup.get(group.permanent.id)!"
                    :presentation="request?.presentation?.actions"
                    @tap="tapForMana"
                  />
                </div>
              </TransitionGroup>
            </template>
            <ZonePile
              v-else
              label="Lands"
              variant="row"
              :cards="humanLands"
              :open="false"
              :detail="`${untappedLandCount} untapped`"
              :glow="
                pileGlow(
                  humanLands.map((land) => land.id),
                  [],
                )
              "
              controls="player-lands"
              @toggle="togglePile('lands')"
            />
          </div>

          <!-- The rail: life first, then the zones that are only counts. -->
          <aside class="me-rail" aria-label="Your zones">
            <div class="rail-life">
              <span class="rail-kicker">Life</span>
              <span class="rail-life-row">
                <span
                  class="life-badge"
                  :aria-label="`${human.life} life`"
                  :class="{
                    low: human.life <= 10,
                    'flash-damage': humanLifeFlash === 'damage',
                    'flash-heal': humanLifeFlash === 'heal',
                  }"
                  >{{ human.life }}</span
                >
                <span v-if="lifeDeltaText(human.seat)" class="life-delta">{{
                  lifeDeltaText(human.seat)
                }}</span>
              </span>
            </div>
            <ul class="rail-piles">
              <li>
                <ZonePile
                  label="Graveyard"
                  variant="row"
                  class="meta-item"
                  :cards="human.graveyard"
                  :open="graveyardShown"
                  :glow="
                    pileGlow(
                      human.graveyard.map((card) => card.id),
                      zoneTargetIds,
                    )
                  "
                  controls="player-zones"
                  @toggle="togglePile('graveyard')"
                />
              </li>
              <li>
                <ZonePile
                  label="Exile"
                  variant="row"
                  class="meta-item"
                  :cards="humanExile"
                  :open="exileShown"
                  :glow="
                    pileGlow(
                      humanExile.map((card) => card.id),
                      zoneTargetIds,
                    )
                  "
                  controls="player-zones"
                  @toggle="togglePile('exile')"
                />
              </li>
              <li class="meta-item rail-row">
                <span>Library</span> <span class="rail-num">{{ human.librarySize }}</span>
              </li>
              <li
                class="meta-item rail-row"
                :title="
                  taxedCommanders
                    .map((c) => `Casting ${c.name} costs {${c.taxGeneric}} more`)
                    .join('. ') || 'Your commander costs nothing extra to cast'
                "
              >
                <span>Cmdr tax</span>
                <span class="rail-num cmdr-tax">{{ commanderTaxText }}</span>
              </li>
            </ul>
          </aside>

          <!-- An open graveyard or exile pile spreads its cards here, under your board. -->
          <div id="player-zones" class="zones-strip">
            <ZoneStrip
              v-if="graveyardShown"
              label="Graveyard"
              :cards="human.graveyard"
              :selectable-ids="zoneTargetIds"
              :actionable-ids="zoneSourceIds"
              @select="chooseTarget"
              @activate="selectSource"
            />
            <ZoneStrip
              v-if="exileShown"
              label="Exile"
              :cards="humanExile"
              :selectable-ids="zoneTargetIds"
              :actionable-ids="zoneSourceIds"
              @select="chooseTarget"
              @activate="selectSource"
            />
            <ZoneStrip
              v-if="revealedLibraryTopsFor(human.seat).length > 0"
              label="Top of library"
              :cards="revealedLibraryTopsFor(human.seat)"
              :selectable-ids="zoneTargetIds"
              :actionable-ids="zoneSourceIds"
              @select="chooseTarget"
              @activate="selectSource"
            />
          </div>

          <!-- Your hand, led by your commander while it waits in the command zone, and beside it
               the one decision you owe. -->
          <div class="hand-band">
            <div class="hand-wrap">
              <span class="zone-label hand-label">{{
                (human.hand ?? []).length > 0
                  ? `Your hand ${(human.hand ?? []).length}`
                  : 'Your hand is empty'
              }}</span>
              <div :ref="zoneRef('hand')" class="hand-row">
                <span v-if="humanCommandZoneCount > 0" class="command-zone">
                  <template v-for="commander in human.commanders" :key="commander.cardId">
                    <button
                      v-if="commander.zone === 'command' && commander.objectId !== null"
                      type="button"
                      class="commander-card hand-tile"
                      :style="{ width: handCardWidth + 'px' }"
                      :title="`${commander.name}: in the command zone`"
                      :class="{
                        focused: focusedSourceId === commander.objectId,
                        actionable: actionableSourceIds.has(commander.objectId),
                        'chosen-target': isChosenTarget(commander.objectId),
                      }"
                      @click.stop="selectSource(commander.objectId)"
                      @mouseenter="showCardPreview(commander, $event)"
                      @mousemove="moveCardPreview"
                      @mouseleave="hideCardPreview"
                    >
                      <span class="tile-bar cmdr" aria-hidden="true">Commander</span>
                      <span class="tile-name">{{ commander.name }}</span>
                      <span class="tile-art">
                        <img
                          v-if="artCropOf(commander)"
                          :src="artCropOf(commander)!"
                          alt=""
                          loading="lazy"
                          decoding="async"
                          @error="hideBrokenArt"
                        />
                      </span>
                      <span v-if="commander.taxGeneric > 0" class="tile-type"
                        >Tax +{{ commander.taxGeneric }}</span
                      >
                      <ProvisionalBadge v-if="commander.provisional === true" />
                    </button>
                  </template>
                </span>
                <TransitionGroup
                  tag="div"
                  name="hand-card"
                  class="hand"
                  :class="{
                    'has-playable': playableSources.length > 0 && selectedAction === null,
                  }"
                >
                  <button
                    v-for="card in human.hand ?? []"
                    :key="card.id"
                    type="button"
                    class="hand-card hand-tile"
                    :style="{ width: handCardWidth + 'px' }"
                    :class="{
                      focused: focusedSourceId === card.id,
                      actionable: actionableSourceIds.has(card.id),
                      'chosen-target': isChosenTarget(card.id),
                    }"
                    draggable="true"
                    @dragstart="dragStart(card.id, $event)"
                    @dragend="dragEnd"
                    @click="selectSource(card.id)"
                    @mouseenter="showCardPreview(card, $event)"
                    @mousemove="moveCardPreview"
                    @mouseleave="hideCardPreview"
                  >
                    <span v-if="playableVerbById.get(card.id)" class="play-tag tile-bar">{{
                      playableVerbById.get(card.id)
                    }}</span>
                    <span class="tile-name">{{ card.name }}</span>
                    <span class="tile-art">
                      <img
                        v-if="artCropOf(card)"
                        :src="artCropOf(card)!"
                        alt=""
                        loading="lazy"
                        decoding="async"
                        @error="hideBrokenArt"
                      />
                      <span
                        v-if="card.isToken === true || typePartsOf(card.typeLine).supertypes[0]"
                        class="art-tag"
                        aria-hidden="true"
                        >{{
                          card.isToken === true ? 'Token' : typePartsOf(card.typeLine).supertypes[0]
                        }}</span
                      >
                    </span>
                    <span class="tile-type" aria-hidden="true">
                      <span>{{ typePartsOf(card.typeLine).types }}</span>
                      <span v-if="typePartsOf(card.typeLine).subtypes" class="subtypes">{{
                        typePartsOf(card.typeLine).subtypes
                      }}</span>
                    </span>
                    <ProvisionalBadge v-if="card.provisional === true" />
                  </button>
                </TransitionGroup>
              </div>
            </div>

            <!-- The one decision you owe: a kicker and a title, its buttons, then what it means. -->
            <section class="decision" :data-request-id="request?.requestId" aria-live="polite">
              <div class="decide-head">
                <span class="decide-kicker">
                  <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
                    <path d="M7 0 L8 6 L14 7 L8 8 L7 14 L6 8 L0 7 L6 6 Z" />
                  </svg>
                  {{ decisionKicker }}
                </span>
                <span class="decide-title">{{ decisionTitle }}</span>
                <span
                  v-if="
                    combatPlan.mode === 'composing' &&
                    combatPlan.kind === 'attackers' &&
                    sendTargets.length > 0
                  "
                  role="group"
                  aria-label="Send the chosen creature at"
                  class="send-at"
                >
                  <span class="send-label">Send at</span>
                  <button
                    v-for="seat in sendTargets"
                    :key="seat"
                    type="button"
                    :aria-pressed="sendTarget === seat"
                    :title="seatLabel(seat)"
                    @click="sendAt(seat)"
                  >
                    {{ seat }}
                  </button>
                </span>
              </div>
              <p v-if="decisionBody" class="decide-body">{{ decisionBody }}</p>
              <StackPanel
                v-if="state.stack.length > 0"
                :state="state"
                :is-legal-target="isLegalTarget"
                :is-chosen-target="isChosenTarget"
                @select="selectSource"
              />
              <section
                v-if="request"
                class="interaction-tray"
                :class="{ targeting: selectedAction !== null }"
              >
                <div v-if="smartYieldAction" class="tray-actions">
                  <button
                    type="button"
                    title="Skip this opportunity and quiet windows. Offer again for new interaction or relevant combat changes; passing declines that opportunity."
                    @click="yieldSelected('smart')"
                  >
                    Smart yield
                  </button>
                  <button
                    v-if="selectedAction?.type === 'activateAbility' && isYieldable(selectedAction)"
                    type="button"
                    @click="yieldSelected('always')"
                  >
                    Yield always
                  </button>
                </div>
                <template v-if="selectedAction">
                  <div class="tray-heading">
                    <strong>{{
                      sourceNameOf(selectedAction) ??
                      selectedSourceName ??
                      selectedAction.description
                    }}</strong>
                    <span v-for="cost in costChips(selectedEntry)" :key="cost" class="cost-chip">{{
                      cost
                    }}</span>
                  </div>
                  <div class="pending-stack" aria-live="polite">
                    <span>Pending</span>
                    <strong>{{ pendingLabel(selectedAction, selectedEntry) }}</strong>
                  </div>
                  <p
                    v-if="
                      selectedEntry?.payment !== undefined && selectedEntry.payment.summary !== ''
                    "
                    class="payment-preview"
                  >
                    Auto-pay: {{ selectedEntry.payment.summary }}
                  </p>
                  <p v-if="targetSlots(selectedAction).length > 0" class="target-instruction">
                    {{
                      canConfirm
                        ? `All ${targetCount} target${targetCount === 1 ? '' : 's'} selected. Confirm to put it on the stack.`
                        : `Target ${selectedTargetCount + 1} of ${targetCount}: click a highlighted card or player.`
                    }}
                  </p>
                  <div v-if="Object.keys(chosenTargets).length > 0" class="chosen-targets">
                    <span v-for="(choice, slot) in chosenTargets" :key="slot" class="target-chip">
                      {{ selectedTargetLabel(slot, choice) }}
                    </span>
                  </div>
                  <div class="tray-actions">
                    <button
                      ref="confirmButtonRef"
                      type="button"
                      class="primary"
                      :disabled="!canConfirm"
                      @click="confirm"
                    >
                      {{ selectedAction.type === 'playLand' ? 'Play land' : 'Confirm' }}
                    </button>
                    <button type="button" class="link" @click="cancel">Cancel</button>
                  </div>
                </template>
                <template v-else-if="combatPlan.mode === 'composing'">
                  <!-- Confirm, reset and the hint live in the combat lane above; this list is
                       the exact, keyboard-friendly way to make the same choices. -->
                  <p v-if="!laneShowing" class="tray-actions">
                    <button type="button" class="primary" @click="combatStripHidden = false">
                      Show combat
                    </button>
                  </p>
                  <p
                    v-if="combatPlan.rejectionMessage !== null"
                    class="target-instruction combat-interrupted"
                  >
                    Fix the flagged creature(s) and confirm again.
                  </p>
                  <div class="tray-heading combat-count">
                    <button
                      v-for="action in declarationActions"
                      :key="action.id"
                      type="button"
                      class="combat-step"
                      @click="chooseAction(action)"
                    >
                      {{ action.description }}
                    </button>
                    <span v-if="declarationActions.length === 0"
                      >{{ combatPlan.order.length }} creature{{
                        combatPlan.order.length === 1 ? '' : 's'
                      }}
                      can {{ combatPlan.kind === 'attackers' ? 'attack' : 'block' }}</span
                    >
                  </div>
                  <div class="combat-assignments">
                    <div
                      v-for="entry in combatPlan.order"
                      :key="entry.subjectId"
                      class="combat-assignment-row"
                      :class="{ focused: focusedSourceId === entry.subjectId }"
                    >
                      <span class="assignment-name">{{
                        nameById.get(entry.subjectId) ?? entry.subjectId
                      }}</span>
                      <div class="assignment-options">
                        <button
                          v-for="optionId in entry.optionIds"
                          :key="optionId"
                          type="button"
                          :class="{
                            primary: combatPlan.assignment.get(entry.subjectId) === optionId,
                          }"
                          @click="combatPlan.assign(entry.subjectId, optionId)"
                        >
                          {{
                            combatPlan.kind === 'attackers'
                              ? attackTargetLabel(optionId)
                              : (nameById.get(optionId) ?? optionId)
                          }}
                        </button>
                        <button
                          v-if="!entry.mustAct"
                          type="button"
                          class="muted"
                          :class="{ primary: !combatPlan.assignment.has(entry.subjectId) }"
                          @click="combatPlan.clear(entry.subjectId)"
                        >
                          {{ combatDeclineLabel }}
                        </button>
                      </div>
                    </div>
                  </div>
                </template>
                <p v-else-if="combatPlan.mode === 'replaying'" class="tray-hint">
                  Submitting your {{ combatPlan.kind === 'attackers' ? 'attacks' : 'blocks' }}…
                </p>
                <template v-else-if="focusedSourceId !== null && selectedSourceActions.length > 0">
                  <div class="tray-heading">
                    <strong>{{ selectedSourceName ?? 'Selected card' }}</strong
                    ><span>Choose an action</span>
                  </div>
                  <div class="source-actions">
                    <div
                      v-for="group in selectedSourceGrouped.xGroups"
                      :key="group.key"
                      class="source-action-row x-group"
                    >
                      <label>
                        Choose X ({{ group.min }}–{{ group.max }})
                        <input
                          type="number"
                          :min="group.min"
                          :max="group.max"
                          v-model.number="xInputs[group.key]"
                        />
                      </label>
                      <button
                        type="button"
                        :disabled="xGroupAction(group) === undefined"
                        @click="chooseXGroupAction(group)"
                      >
                        <span>{{ labelOf(xGroupPreviewAction(group)) }}</span>
                        <small>{{
                          costChips(entryOf(xGroupPreviewAction(group))).join(' · ')
                        }}</small>
                      </button>
                    </div>
                    <div
                      v-for="action in selectedSourceGrouped.plain"
                      :key="action.id"
                      class="source-action-row"
                    >
                      <button type="button" @click="chooseAction(action)">
                        <span>{{ labelOf(action) }}</span>
                        <small>{{ costChips(entryOf(action)).join(' · ') }}</small>
                      </button>
                      <button
                        v-if="action.type === 'activateAbility' && isYieldable(action)"
                        type="button"
                        class="yield-ability"
                        title="Hide this optional ability until you re-enable it"
                        @click="store.yieldPlayerAbility(action.id)"
                      >
                        Yield always
                      </button>
                    </div>
                  </div>
                </template>
                <p
                  v-else-if="
                    !openingHand &&
                    request?.decisionType === 'priority' &&
                    playableSources.length > 0
                  "
                  class="tray-hint"
                >
                  Click a highlighted card or permanent to play, cast, or activate it.
                </p>
              </section>
              <template
                v-if="
                  request && !openingHand && selectedAction === null && combatPlan.mode === 'idle'
                "
              >
                <DecisionPanel
                  v-if="fallbackRequest && immediateActions.length === 0"
                  :request="fallbackRequest"
                  @choose="chooseFallbackAction"
                />
                <template v-else>
                  <!-- The question comes first, then its answers. A plain priority stop says no
                       more than the title, so its line is kept for screen readers only. -->
                  <p class="prompt" :class="{ 'dt-sr': isPlainPriority(request) }">
                    {{ promptOf(request) }}
                  </p>
                  <div v-if="immediateActions.length > 0" class="quick-actions">
                    <button
                      v-for="(action, i) in immediateActions"
                      :key="action.id"
                      type="button"
                      :class="i === 0 ? 'primary' : 'secondary'"
                      @click="chooseAction(action)"
                    >
                      {{ action.description }}
                    </button>
                  </div>
                  <div v-if="playableSources.length > 0" class="playable-now">
                    <strong>Playable now</strong>
                    <div class="playable-list">
                      <div v-for="entry in playableList" :key="entry.key" class="playable-entry">
                        <button
                          type="button"
                          :class="{ focused: entry.ids.includes(focusedSourceId ?? '') }"
                          @click="selectSource(entry.ids[0] ?? '')"
                        >
                          <span class="verb">{{ entry.verb }}</span> {{ entry.name
                          }}<span v-if="entry.ids.length > 1" class="count">
                            ×{{ entry.ids.length }}</span
                          >
                        </button>
                        <button
                          v-if="
                            request.decisionType === 'priority' &&
                            entry.verb !== 'Play' &&
                            yieldableSourceAction(entry.ids[0] ?? '') !== undefined
                          "
                          type="button"
                          class="link"
                          :aria-label="`Smart yield ${entry.name}`"
                          title="Skip this opportunity and quiet windows; offer this copy again for new interaction or relevant combat changes"
                          @click="smartYieldSource(entry.ids[0] ?? '')"
                        >
                          Smart yield
                        </button>
                      </div>
                    </div>
                  </div>
                  <p
                    v-if="hasOnlyImmediateActions && store.ignoredAbilities.length > 0"
                    class="yield-explanation"
                  >
                    All other optional actions are currently yielded. Pass priority to continue, or
                    resume a spell or ability in the game log to make it available again.
                  </p>
                  <DecisionPanel
                    v-if="fallbackRequest"
                    :request="fallbackRequest"
                    @choose="chooseFallbackAction"
                  />
                </template>
              </template>
              <p v-else-if="!request" class="thinking prompt" role="status">
                {{ waitingBody }}
              </p>
            </section>
          </div>
        </section>
      </section>
      <!-- Game log: commander damage, what the others did, yields, deals and the log. Stays mounted
           while hidden, so the log keeps following play and opening it shows the present. -->
      <aside v-show="infoOpen" id="player-game-info" class="info-drawer" aria-label="Game log">
        <div class="info-head">
          <h2>Game log</h2>
          <button
            type="button"
            class="info-close"
            aria-label="Close the game log"
            @click="toggleInfo"
          >
            ×
          </button>
        </div>
        <div v-if="opponentActivity.length > 0" class="bot-summary">
          <strong title="Passing priority doesn't count as an action here."
            >Since your last action</strong
          >
          <div v-for="seat in opponentActivity" :key="seat.seat" class="bot-seat">
            <span class="actor" :title="seat.label">{{ seat.seat }}</span>
            <ul>
              <li v-for="line in seat.lines" :key="line.sequence">{{ line.text }}</li>
              <li v-if="seat.more > 0" class="more">and {{ seat.more }} more in the log</li>
            </ul>
          </div>
        </div>
        <div v-if="store.ignoredAbilities.length > 0" class="ignored-abilities">
          <strong>Yielded spells &amp; abilities</strong>
          <div v-for="ability in store.ignoredAbilities" :key="ability.key" class="action-row">
            <span>{{ ability.label }}{{ ability.mode === 'smart' ? ' · Smart yield' : '' }}</span>
            <button type="button" @click="store.resumePlayerAbility(ability.key)">Resume</button>
          </div>
        </div>
        <StackPanel
          v-if="state.stack.length === 0"
          :state="state"
          :is-legal-target="isLegalTarget"
          :is-chosen-target="isChosenTarget"
          @select="selectSource"
        />
        <DealPanel v-if="store.diplomacy && store.diplomacySeat" />
        <CommanderDamageGrid :state="state" />
        <!-- The reasoning toggle appears only once the game is over: until then the server
             withholds every opponent's reasoning, so offering the control would promise
             something it must not deliver (ADR 0022 §3). -->
        <ActionLog
          :lines="store.log"
          :follow="true"
          :annotations="store.annotations"
          :can-show-reasoning="store.providerKind === 'ai' && store.gameOver !== null"
          :show-reasoning="store.debugFlags.showAIResponses"
          @update:show-reasoning="
            store.setDebugFlags({ ...store.debugFlags, showAIResponses: $event })
          "
        >
        </ActionLog>
      </aside>
    </main>
    <p v-else class="waiting">Waiting for the player-safe board…</p>
    <ConfirmDialog
      v-if="pendingPass"
      title="You haven't played a land this turn"
      message="You still have a land drop and a land you can play. Pass anyway?"
      confirm-label="Pass anyway"
      cancel-label="Play a land"
      tone="primary"
      @cancel="pendingPass = null"
      @confirm="passAnyway"
    />
    <ConfirmDialog
      v-if="store.dealWarning"
      title="This may break a deal"
      :message="`${store.dealWarning.messages.join(' ')} Everyone at the table sees a broken deal.`"
      confirm-label="Do it anyway"
      cancel-label="Go back"
      @cancel="store.cancelDealWarning()"
      @confirm="store.confirmDealWarning()"
    />
    <ConfirmDialog
      v-if="confirmingAbandon"
      title="Abandon match?"
      message="Your current game will end and cannot be resumed."
      confirm-label="Confirm Abandon"
      @cancel="confirmingAbandon = false"
      @confirm="abandon"
    />
  </div>
</template>

<style scoped>
.player-game {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.6rem;
}
.game-over-badge {
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--warn);
  color: var(--warn);
  font-size: 0.75rem;
  font-weight: 700;
  white-space: nowrap;
}
/* Settings drop down from the top bar's right end, over the table. */
.settings-menu {
  position: fixed;
  top: 3.1rem;
  right: 0.6rem;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.35);
  font-size: 0.78rem;
}
.settings-menu .abandon {
  align-self: flex-start;
  margin-top: 0.2rem;
  color: var(--danger);
}
/* Game info: commander damage and the log in a column beside the rail, covering nothing. */
.info-drawer {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.6rem;
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
}
.info-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.info-head h2 {
  margin: 0;
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.info-close {
  padding: 0 0.45rem;
  font-size: 1rem;
  line-height: 1.4;
}
.info-drawer :deep(.log) {
  flex: 1;
  min-height: 0;
}
.turn-badge {
  color: var(--muted);
  font-weight: 600;
}
.turn-badge.your-turn {
  color: var(--accent);
}
.pace {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--muted);
}
button.active,
button.selected,
.focused {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.targetable {
  border-color: var(--ok) !important;
  box-shadow: 0 0 0 1px var(--ok);
}
.chosen-target {
  border-color: var(--accent) !important;
  box-shadow:
    0 0 0 2px var(--accent),
    inset 0 0 0 2px rgb(96 165 250 / 0.35);
}
.payment-source {
  border-color: var(--warn) !important;
  box-shadow:
    0 0 0 2px var(--warn),
    inset 0 0 0 2px rgb(250 204 21 / 0.18);
}
.opponent.chosen-target {
  background: rgb(96 165 250 / 0.1);
}
.connection.open {
  color: var(--ok);
}
.connection.closed {
  color: var(--danger);
}
.paused {
  border: 1px solid var(--warn);
  color: var(--warn);
  padding: 0.5rem;
  border-radius: 4px;
}
.yield-banner {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  border: 1px solid var(--accent);
  color: var(--text);
  background: var(--surface);
  padding: 0.5rem 0.7rem;
  border-radius: 4px;
  font-size: 0.78rem;
}
.yield-banner > span {
  flex: 1;
}
.player-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 22rem;
  gap: 0.6rem;
}
.player-layout.info-open {
  grid-template-columns: minmax(0, 1fr) 22rem 20rem;
}
.table {
  position: relative;
  min-height: 0;
  display: grid;
  /* Opponents take what their boards need, up to a cap; your side gets the rest. */
  grid-template-rows: fit-content(40%) minmax(0, 1fr);
  gap: 0.6rem;
}
.opponents {
  min-height: 0;
  display: grid;
  grid-template-columns: var(--opponent-columns, repeat(3, minmax(0, 1fr)));
  gap: 0.5rem;
}
.opponent,
.human-zone {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  padding: 0.4rem 0.5rem;
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
}
.opponent {
  cursor: pointer;
  gap: 0.25rem;
  overflow-y: auto;
}
.opponent > .permanents {
  flex-shrink: 0;
}
.opponent-zones {
  cursor: default;
}
.opponent-zones :deep(.cards-strip) {
  max-height: 5.2rem;
}
.opponent.active {
  border-color: var(--accent);
  box-shadow: 0 0 12px rgb(96 165 250 / 0.2);
}
.opponent.targetable {
  animation: targetPulse 1.4s ease-in-out infinite;
}
.opponent.chosen-target {
  animation: none;
  box-shadow: 0 0 0 2px var(--ok);
}
.opponent > header {
  display: flex;
  flex-wrap: wrap;
  row-gap: 0.2rem;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.72rem;
  flex-shrink: 0;
}
/* A seat's header: who, their colors and counts, then (pushed right) zones and life. */
/* In a narrow seat the counts wrap under the name rather than squeeze it out. */
.cmdr-peeks {
  display: inline-flex;
  gap: 0.25rem;
  min-width: 0;
}
.cmdr-peek {
  max-width: 7rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0.05rem 0.35rem;
  border: 1px solid var(--rule);
  background: transparent;
  color: var(--muted);
  font-family: var(--font-ui);
  font-size: 0.6rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: help;
}
.cmdr-peek:hover,
.cmdr-peek:focus-visible {
  border-color: var(--ink);
  color: var(--ink);
}
.seat-name {
  flex: 0 1 auto;
  min-width: min(6rem, 40%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: zoom-in;
}
.meta-item {
  flex-shrink: 0;
  font-size: 0.68rem;
  color: var(--muted);
  white-space: nowrap;
}
.meta-item b {
  font-weight: 700;
}
.cmdr-tax {
  flex-shrink: 0;
  color: var(--warn);
  font-size: 0.72rem;
  font-weight: 700;
}
.zones-toggle {
  flex-shrink: 0;
  font-size: 0.62rem;
  padding: 0.05rem 0.4rem;
  color: var(--muted);
  background: var(--surface-2);
}
.human-zone > header {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 0.1rem 0.2rem;
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
}
.human-zone > header.targetable {
  animation: targetPulse 1.4s ease-in-out infinite;
}
.human-zone > header.chosen-target {
  animation: none;
  box-shadow: 0 0 0 2px var(--ok);
}
.id-badge {
  font-weight: 800;
  font-size: 0.68rem;
  color: var(--accent);
  background: rgb(96 165 250 / 0.15);
  padding: 0.02rem 0.3rem;
  border-radius: 3px;
  flex-shrink: 0;
}
.id-badge.you {
  white-space: nowrap;
}
.monarch-badge {
  flex-shrink: 0;
  color: #fbbf24;
  background: rgb(251 191 36 / 0.14);
  border: 1px solid rgb(251 191 36 / 0.45);
  border-radius: 999px;
  padding: 0.06rem 0.3rem;
  font-size: 0.5rem;
  font-weight: 800;
  letter-spacing: 0.05em;
}
.life-badge {
  font-weight: 800;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  color: var(--ok);
  background: rgb(74 222 128 / 0.12);
  border: 1px solid rgb(74 222 128 / 0.3);
  padding: 0.04rem 0.4rem;
  border-radius: 4px;
  flex-shrink: 0;
}
.life-badge.low {
  color: var(--danger);
  background: rgb(248 113 113 / 0.12);
  border-color: rgb(248 113 113 / 0.35);
}
.life-badge.flash-damage {
  animation: flash 0.8s ease-out;
}
.life-badge.flash-heal {
  animation: flashOk 0.9s ease-out;
}
.permanents {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  align-content: flex-start;
  gap: 0.3rem;
  /* Room for a stack's ×N badge, which sits over the top corner of its tile. */
  padding-top: 6px;
  overflow-x: hidden;
  overflow-y: auto;
}
.board-card-enter-active,
.board-card-leave-active {
  transition:
    opacity 300ms ease,
    transform 300ms cubic-bezier(0.2, 0.72, 0.25, 1),
    filter 300ms ease;
}
.board-card-move {
  transition: transform 300ms ease;
}
.board-card-enter-from {
  opacity: 0;
  transform: translateY(12px) scale(0.9);
  filter: brightness(1.3);
}
.board-card-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.94);
  filter: brightness(1.35);
}
.board-card-leave-active {
  position: absolute;
  pointer-events: none;
}
.zones-strip {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  flex-shrink: 0;
}
.object {
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  flex: 0 1 var(--chip-w, 108px);
  min-width: var(--chip-min, 54px);
}
/* PermanentChip's own `.tile` sets a fixed pixel width; make it fill this flexed wrapper instead
   so the browser's own shrink-to-fit (not the chip's internal default) governs actual size. */
.object :deep(.tile) {
  width: 100%;
}
.actionable {
  border-color: var(--accent) !important;
  box-shadow:
    0 0 0 2px rgb(96 165 250 / 0.45),
    0 0 14px rgb(96 165 250 / 0.35);
}
.actionable:hover {
  transform: translateY(-2px);
}
/* On a short window the board, hand and tray do not all fit. Scroll rather than clip, so the
   tray (pinned below) is never pushed out of reach while the game waits on it. */
.human-zone {
  gap: 0.4rem;
  overflow-y: auto;
  border-color: rgb(96 165 250 / 0.45);
}
.human-zone.your-turn {
  border-color: var(--accent);
  box-shadow: 0 0 10px rgb(110 168 254 / 0.25);
}
/* Your resources ride in the top bar, as compact chips. */
.bar-resources {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  white-space: nowrap;
}
.resource {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0.1rem 0.5rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 0.72rem;
}
.resource strong {
  color: var(--text);
}
.resource.ready {
  border-color: var(--ok);
  color: var(--ok);
  font-weight: 600;
}
/* The colors that mana can be, as mana-symbol circles (the same tints as a deck's colors). */
.mana-dot {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.5rem;
  font-family: var(--font-display);
  font-weight: 400;
  line-height: 1;
  color: var(--mana-letter);
  background: var(--mana-c);
  box-shadow: inset 0 0 0 1px var(--ink);
}
.mana-dot:first-of-type {
  margin-left: 0.15rem;
}
.mana-W {
  background: var(--mana-w);
}
.mana-U {
  background: var(--mana-u);
}
.mana-B {
  background: var(--mana-b);
  color: var(--mana-b-letter);
}
.mana-R {
  background: var(--mana-r);
}
.mana-G {
  background: var(--mana-g);
}
/* Lands beside the board, behind a dashed rule as on the spectator board: a pile, or spread. */
.land-area {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-height: 0;
  padding-left: 0.5rem;
  border-left: 1px dashed var(--line);
}
.land-area.spread {
  flex: 1;
  flex-shrink: 1;
  min-width: 0;
}
.land-area .permanents.lands {
  flex: 1;
}
.pile-close {
  align-self: flex-start;
  padding: 0.05rem 0.45rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-size: 0.68rem;
  font-weight: 600;
}
.pile-close:hover {
  color: var(--text);
}
/* A permanent you can tap by hand: its mana buttons (ManaTaps) sit over its tile. */
.object.makes-mana {
  position: relative;
}
.hand {
  position: relative;
  flex-shrink: 0;
  display: flex;
  gap: 0.35rem;
  overflow-x: auto;
  overflow-y: hidden;
  padding-top: 0.35rem;
  border-top: 1px solid var(--line);
}
.hand-card-enter-active,
.hand-card-leave-active {
  transition:
    opacity 300ms ease,
    transform 300ms cubic-bezier(0.2, 0.72, 0.25, 1);
}
.hand-card-move {
  transition: transform 300ms ease;
}
.hand-card-enter-from {
  opacity: 0;
  transform: translateY(14px) scale(0.94);
}
.hand-card-leave-to {
  opacity: 0;
  transform: translateY(-12px) scale(0.92) rotate(-2deg);
}
.hand-card-leave-active {
  position: absolute;
  pointer-events: none;
}
.hand-card {
  position: relative;
  flex: 0 0 auto;
  padding: 0.2rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.65rem;
  overflow: hidden;
}
/* Your commander in the header; in the command zone it is the button that casts it. */
.command-zone {
  display: inline-flex;
  gap: 0.2rem;
  flex-shrink: 0;
}
/* Pinned to the zone's bottom edge: confirms, targets and combat declarations stay on screen
   however tall the board above them grows. A long combat list scrolls inside the tray. */
.interaction-tray {
  position: sticky;
  bottom: 0;
  z-index: 2;
  flex-shrink: 0;
  max-height: 70%;
  overflow-y: auto;
  margin-top: 0.1rem;
  min-height: 4.2rem;
  border: 1px solid var(--line);
  background: var(--surface-2);
  border-radius: 5px;
  padding: 0.45rem 0.55rem;
}
.interaction-tray.targeting {
  border-color: var(--ok);
  box-shadow: 0 0 0 1px rgb(74 222 128 / 0.25);
}
.tray-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem;
  font-size: 0.72rem;
}
.tray-heading > span:not(.cost-chip) {
  color: var(--muted);
}
.tray-hint,
.target-instruction {
  margin: 0.2rem 0;
  color: var(--muted);
  font-size: 0.72rem;
}
.target-instruction {
  color: var(--ok);
}
.pending-stack {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.35rem;
  padding: 0.25rem 0.4rem;
  border-left: 3px solid var(--accent);
  background: rgb(96 165 250 / 0.1);
  font-size: 0.72rem;
}
.pending-stack > span {
  color: var(--muted);
  text-transform: uppercase;
  font-size: 0.61rem;
  letter-spacing: 0.04em;
}
.payment-preview {
  margin: 0.3rem 0;
  color: var(--warn);
  font-size: 0.7rem;
}
.cost-chip,
.target-chip {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 0.08rem 0.35rem;
  font-size: 0.66rem;
  color: var(--muted);
}
.chosen-targets {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
  margin-top: 0.35rem;
}
.target-chip {
  color: var(--ok);
  border-color: rgb(74 222 128 / 0.55);
}
.source-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.4rem;
}
.source-action-row {
  display: flex;
  gap: 0.25rem;
}
.source-action-row > button:first-child {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  text-align: left;
}
.source-action-row small {
  color: var(--muted);
}
.source-action-row.x-group {
  align-items: center;
}
.source-action-row.x-group label {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.68rem;
  color: var(--muted);
}
.source-action-row.x-group input[type='number'] {
  width: 4.2rem;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0.1rem 0.3rem;
  font-size: 0.72rem;
}
.combat-assignments {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-top: 0.4rem;
  max-height: 14rem;
  overflow: auto;
}
.combat-assignment-row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.3rem 0.4rem;
  border: 1px solid var(--line);
  border-radius: 4px;
  font-size: 0.72rem;
}
.combat-assignment-row.focused {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.combat-assignment-row .assignment-name {
  font-weight: 700;
}
.assignment-options {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.assignment-options button {
  font-size: 0.68rem;
  padding: 0.15rem 0.4rem;
}
.assignment-options button.primary {
  background: var(--accent);
  color: var(--paper);
  font-weight: 700;
  border-color: var(--accent);
}
.assignment-options button.muted:not(.primary) {
  color: var(--muted);
}
.combat-interrupted {
  color: var(--warn) !important;
}
.tray-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.35rem;
  margin-top: 0.45rem;
}
.decision {
  flex: 0 1 auto;
  max-height: 62%;
  overflow: auto;
  border: 2px solid var(--accent);
  background: var(--surface);
  border-radius: 6px;
  padding: 0.55rem;
}
.decision h3,
.decision p {
  margin: 0.15rem 0 0.45rem;
}
.decision .prompt {
  font-size: 0.95rem;
  font-weight: 600;
  line-height: 1.35;
}
.quick-actions {
  display: flex;
  gap: 0.3rem;
  margin: 0.45rem 0;
}
/* While something is playable, cards that are not recede so the playable ones read first. */
.hand.has-playable .hand-card:not(.actionable):not(.focused):not(.chosen-target) {
  opacity: 0.7;
}
.play-tag {
  position: absolute;
  top: 0.35rem;
  left: 50%;
  transform: translateX(-50%);
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: var(--accent);
  color: var(--paper);
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  pointer-events: none;
}
.playable-now {
  margin: 0.45rem 0;
  font-size: 0.75rem;
}
.playable-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.3rem;
}
.playable-list button {
  border-color: var(--accent);
}
.playable-entry {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem;
}
.playable-list button.focused {
  background: var(--accent);
  color: var(--paper);
}
.playable-list .verb {
  font-weight: 700;
  color: var(--accent);
}
.playable-list button.focused .verb {
  color: inherit;
}
.yield-explanation {
  color: var(--muted);
  font-size: 0.72rem;
  line-height: 1.35;
}
.action-row {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.action-row > :first-child {
  min-width: 0;
  flex: 1;
}
.yield-ability {
  flex: 0 0 auto;
  color: var(--warn);
  font-size: 0.67rem !important;
}
.ignored-abilities {
  margin-top: 0.7rem;
  padding-top: 0.55rem;
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.7rem;
}
.ignored-abilities span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
button.primary {
  background: var(--accent);
  color: var(--paper);
  font-weight: 700;
}
.decision :deep(.decision-panel) {
  margin-top: 0.5rem;
}
.thinking,
.waiting {
  color: var(--muted);
  font-style: italic;
}
.thinking {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.routine-confirm {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--muted);
  white-space: nowrap;
}
.bot-summary {
  margin-top: 0.65rem;
  padding-top: 0.55rem;
  border-top: 1px solid var(--line);
  font-size: 0.72rem;
}
.bot-seat {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.3rem;
}
.bot-seat ul {
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--muted);
  min-width: 0;
}
.bot-seat li {
  overflow-wrap: anywhere;
}
.bot-seat .more {
  font-style: italic;
}
.bot-summary .actor {
  font-weight: 700;
  color: var(--accent);
}
/*
 * Decktank board (docs/design/decktank/Board.dc.html): paper, ink hairlines and no rounded
 * boxes; Bodoni numerals for the turn, seats and life totals; opponents in columns divided by ink
 * rules; your side with its life and count-only zones in a paper-2 rail; your hand beside the one
 * decision you owe. These rules come after the base ones above and override them.
 */
.player-game {
  gap: 0;
  padding: 0;
  font-family: var(--font-body);
  --faint: color-mix(in srgb, var(--muted) 62%, var(--paper));
}

/* The header, in the app's top bar: the turn and its ruler, then resources and the ways out. */
.turn-badge {
  display: inline-flex;
  align-items: center;
  gap: 1rem;
  color: var(--ink);
  font-weight: 400;
}
.turn-badge.your-turn {
  color: var(--ink);
}
.turn-round {
  font-family: var(--font-display);
  font-size: 1.6rem;
  line-height: 1;
  letter-spacing: -0.02em;
  white-space: nowrap;
}
.turn-tag {
  padding: 0.35rem 0.6rem;
  border: 1px solid var(--ink);
  font-family: var(--font-ui);
  /* Small capitals, not text-transform: tests and screen readers read the turn as written. */
  font-size: 0.76rem;
  font-variant-caps: all-small-caps;
  letter-spacing: 0.1em;
  white-space: nowrap;
}
.turn-badge.your-turn .turn-tag {
  background: var(--ink);
  color: var(--paper);
}
/* Five stops on a hairline, ticks below each, the line inked up to now and a warm dot on now. */
.turn-ruler {
  --stop-w: 5.8rem;
  position: relative;
  display: flex;
  align-self: stretch;
  align-items: flex-end;
  margin: 0 0 0 0.5rem;
  padding: 0;
  list-style: none;
}
.turn-ruler::before,
.turn-ruler::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  height: 1px;
  background: var(--rule);
}
.turn-ruler::before {
  right: 0;
}
.turn-ruler::after {
  height: 2px;
  width: calc((var(--stop) + 0.5) * var(--stop-w));
  background: var(--ink);
  transition: width 0.6s var(--ease);
}
.turn-ruler li {
  position: relative;
  flex: 0 0 var(--stop-w);
  padding: 0 0 0.7rem;
  text-align: center;
  font-family: var(--font-ui);
  font-size: 0.62rem;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--faint);
}
.turn-ruler li.reached {
  color: var(--muted);
}
.turn-ruler li.on {
  color: var(--ink);
  font-weight: 500;
}
.turn-ruler li::before {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 1px;
  height: 0.35rem;
  background: var(--rule);
}
.turn-ruler li.reached::before {
  background: var(--ink);
}
.turn-ruler li.on::before {
  height: 0.6rem;
}
.turn-ruler li.on::after {
  content: '';
  position: absolute;
  z-index: 1;
  left: 50%;
  bottom: -6px;
  width: 9px;
  height: 9px;
  margin-left: -6.5px;
  border: 2px solid var(--paper);
  border-radius: 50%;
  background: var(--warm);
}
.bar-spacer {
  flex: 1 1 0;
  min-width: 0.5rem;
}
.bar-resources {
  gap: 0.4rem;
}
.resource {
  border-radius: 0;
  border-color: var(--rule);
  background: transparent;
  font-family: var(--font-body);
  font-size: 0.72rem;
}
.resource.ready {
  border-color: var(--ink);
  background: var(--paper-2);
  color: var(--ink);
  font-weight: 400;
}
.game-over-badge {
  border-radius: 0;
  border-color: var(--ink);
  color: var(--ink);
  font-family: var(--font-ui);
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.bar-links {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  flex-shrink: 0;
  font-family: var(--font-body);
  font-size: 0.8rem;
}
.bar-link {
  min-height: 36px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.bar-link:hover,
.bar-link[aria-expanded='true'] {
  text-decoration: underline;
  text-underline-offset: 0.25em;
}
.leave-game {
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  padding: 0 0.75rem;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 0.2s var(--ease),
    color 0.2s var(--ease);
}
.leave-game:hover {
  background: var(--ink);
  color: var(--paper);
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding-top: 0.45rem;
  border-top: 1px solid var(--rule);
}
.settings-menu .abandon {
  margin-top: 0;
}

/* The board: opponents, the combat strip, then your side, in bands divided by ink hairlines. */
.player-layout {
  grid-template-columns: minmax(0, 1fr);
  gap: 0;
  overflow: auto;
}
.player-layout.info-open {
  grid-template-columns: minmax(0, 1fr) 22rem;
}
.table {
  min-height: 44rem;
  grid-template-rows: minmax(0, 33fr) auto minmax(0, 54fr);
  gap: 0;
}

/* Each band keeps its row, whether or not the combat strip is showing. */
.opponents {
  grid-row: 1;
}
.combat-strip {
  grid-row: 2;
}
.human-zone {
  grid-row: 3;
}

/* Opponents: one panel each, widths following how much each has in play. */
.opponents {
  gap: 0;
  border-bottom: 1px solid var(--ink);
}
.opponent {
  position: relative;
  gap: 0.4rem;
  padding: 0.6rem 0.9rem 0.5rem;
  border: 0;
  border-radius: 0;
  background: var(--paper);
  box-shadow: none;
  overflow: hidden;
}
.opponent + .opponent {
  border-left: 1px solid var(--ink);
}
.opponent.out {
  background: var(--paper-2);
  color: var(--muted);
}
.opponent.active {
  background: var(--paper);
  box-shadow: none;
}
.opponent.chosen-target,
.human-zone > header.chosen-target {
  background: var(--paper-2);
  box-shadow: inset 0 0 0 2px var(--ink);
}
/* A seat you can choose: a dashed ink frame, no pulse. Chosen: a solid one on paper-2. */
.opponent.targetable,
.human-zone > header.targetable {
  animation: none;
  box-shadow: none;
  outline: 1px dashed var(--ink);
  outline-offset: -5px;
}
.opponent.chosen-target,
.human-zone > header.chosen-target {
  outline: 0;
}
.opponent > header {
  flex-wrap: nowrap;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
  padding: 0;
  font-size: inherit;
}
.id-badge {
  flex-shrink: 0;
  padding: 0;
  border-radius: 0;
  background: none;
  color: inherit;
  font-family: var(--font-display);
  font-size: 2.1rem;
  font-weight: 400;
  line-height: 1;
  letter-spacing: -0.02em;
}
/* Whose turn it is, among the opponents: a warm dot under the seat's letter. */
.opponent.active .id-badge {
  position: relative;
}
.opponent.active .id-badge::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -0.35rem;
  width: 7px;
  height: 7px;
  margin-left: -3.5px;
  border-radius: 50%;
  background: var(--warm);
}
.opponent.out .id-badge {
  font-size: 1.3rem;
}
.seat-who {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.seat-name {
  min-width: 0;
  font-family: var(--font-ui);
  font-size: 0.8rem;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.seat-name,
.human-zone .seat-name strong {
  cursor: help;
}
.opponent .seat-name,
.human-zone .seat-name strong {
  font-weight: 400;
  text-decoration: underline dotted var(--faint);
  text-underline-offset: 0.3em;
}
.opponent.out .seat-name {
  white-space: normal;
}
.seat-sub {
  min-width: 0;
  font-family: var(--font-body);
  font-size: 0.6rem;
  line-height: 1.8;
  letter-spacing: 0.09em;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.seat-sub > * {
  vertical-align: middle;
}
.seat-sub .dot {
  margin: 0 0.35em;
}
.cmdr-state {
  color: var(--ink);
}
.opponent.out .cmdr-state {
  color: inherit;
}
/* "5 incoming" beside the life it threatens: outlined and small, the lane says the rest. */
.attacked-chip {
  flex-shrink: 0;
  align-self: center;
  padding: 0.15rem 0.4rem;
  border: 1px solid var(--ink);
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: 0.62rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}
.monarch-badge {
  flex-shrink: 0;
  align-self: center;
  padding: 0.2rem 0.4rem;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: 0.6rem;
  font-weight: 400;
  letter-spacing: 0.08em;
}
.life-badge {
  flex-shrink: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: none;
  color: inherit;
  font-family: var(--font-display);
  font-size: 2.1rem;
  font-weight: 400;
  line-height: 1;
  letter-spacing: -0.03em;
}
.opponent.out .life-badge {
  font-size: 1.1rem;
}
.life-badge.low {
  border: 0;
  background: none;
  color: var(--danger);
}
.permanents {
  gap: 6px;
  padding: 0.5rem 0;
  align-content: safe center;
}
.opponent > .permanents {
  flex: 1;
  justify-content: center;
  border-top: 1px solid var(--ink);
}
.object {
  flex: 0 0 auto;
  width: var(--chip-w, 108px);
  min-width: 0;
  border-radius: 0;
}
.opp-out {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  border-top: 1px solid var(--ink);
  text-align: center;
  color: var(--muted);
}
.out-word {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.out-note {
  font-size: 0.725rem;
  line-height: 1.6;
}
/* An opponent's foot: lands as a line of names, then the zones that are only counts. Labels sit
   on their own paper above any arrow that passes. */
.opp-foot {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 0.8rem;
  min-width: 0;
  padding-top: 0.35rem;
  border-top: 1px solid var(--ink);
  font-size: 0.725rem;
  line-height: 1.6;
}
.foot-label,
.land-line,
.zones-toggle {
  position: relative;
  z-index: 6;
  background: var(--paper);
}
.foot-label {
  flex-shrink: 0;
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}
/* The names wrap rather than clip: every land stays in reach for a target or an activation. On a
   narrow panel the zone buttons move to a line of their own. */
.land-line {
  flex: 1 1 auto;
  min-width: 0;
  display: block;
  color: var(--muted);
}
.land-line .object.land-name {
  display: inline;
  width: auto;
  flex: none;
  border: 0;
  box-shadow: none;
}
.land-line .dot {
  margin: 0 0.4em;
}
.land-line .object.land-name.targetable,
.land-line .object.land-name.chosen-target,
.land-line .object.land-name.actionable {
  color: var(--ink);
  box-shadow: none;
  text-decoration: underline;
  text-underline-offset: 0.2em;
}
.zones-toggle {
  flex-shrink: 0;
  align-self: center;
  min-height: 28px;
  padding: 0;
  border: 0;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 0.725rem;
  white-space: nowrap;
  cursor: pointer;
}
.zones-toggle:hover,
.zones-toggle[aria-expanded='true'] {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

/* Your side: who you are, two columns of your board, your lands; the rail on the right; then
   your hand beside the decision, across the whole width. */
.human-zone {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(8.5rem, 11vw, 11rem);
  /* Your board keeps room for a row of tiles; the decision scrolls inside its share instead of
     growing over the board on a short screen. */
  grid-template-rows: auto minmax(7.5rem, 27fr) minmax(5.5rem, 14fr) auto minmax(10rem, 13fr);
  grid-template-areas:
    'head rail'
    'cols rail'
    'lands rail'
    'zones zones'
    'hand hand';
  gap: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: var(--paper);
  box-shadow: none;
  overflow: hidden;
}
/* With no hand to set its height the band takes what the decision needs, once your board has its
   row of tiles. */
.human-zone.no-hand {
  grid-template-rows: auto minmax(7.5rem, 27fr) minmax(5.5rem, 14fr) auto minmax(
      10rem,
      max-content
    );
}
.human-zone.your-turn {
  border-color: transparent;
  box-shadow: none;
}
.human-zone > header {
  grid-area: head;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.75rem;
  min-width: 0;
  margin: 0;
  padding: 0.6rem 1.25rem 0.4rem;
  border: 0;
  border-radius: 0;
}
.human-zone > header > * {
  position: relative;
  z-index: 6;
}
.human-zone > header .seat-name,
.human-zone > header .seat-sub {
  background: var(--paper);
}
.human-zone > header .seat-name {
  overflow: visible;
}
.id-badge.you {
  font-size: 2.1rem;
}
.me-cols {
  grid-area: cols;
  min-height: 0;
  display: grid;
  grid-template-columns: var(--me-cols, minmax(0, 1fr) minmax(0, 1fr));
  gap: 1rem;
  padding: 0 1.25rem;
}
.me-zone {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--ink);
}
.zone-label {
  position: relative;
  z-index: 6;
  align-self: flex-start;
  flex-shrink: 0;
  padding: 0.3rem 0.25rem 0 0;
  background: var(--paper);
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}
.me-zone > .permanents {
  flex: 1;
  gap: 8px;
  justify-content: center;
  padding: 0.35rem 0;
}
.land-area {
  grid-area: lands;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 0.4rem 1.25rem 0.5rem;
  padding: 0;
  border: 0;
  border-top: 1px solid var(--ink);
}
.land-area.spread {
  flex: none;
}
.land-area .permanents.lands {
  flex: 1;
  justify-content: flex-start;
  padding: 0.35rem 0 0;
}
.land-area > :deep(.zone-pile.row) {
  border-bottom: 0;
}
.pile-close {
  align-self: flex-start;
  padding: 0.3rem 0.25rem 0 0;
  border: 0;
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  font-weight: 400;
  cursor: pointer;
}
.object.makes-mana {
  position: relative;
}

/* The rail: life first, then the zones that are only counts, on paper-2 behind an ink rule. */
.me-rail {
  grid-area: rail;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-left: 1px solid var(--ink);
  background: var(--paper-2);
  overflow-y: auto;
}
.rail-life {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.rail-kicker {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.rail-life-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 0.5rem;
}
.me-rail .life-badge {
  font-size: 2.65rem;
}
.life-delta {
  font-size: 0.725rem;
  white-space: nowrap;
}
.rail-piles {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--ink);
  font-size: 0.9rem;
}
.rail-piles > li {
  border-bottom: 1px solid var(--ink);
}
.rail-piles :deep(.zone-pile.row) {
  width: 100%;
  border: 0;
  background: transparent;
}
.meta-item {
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--ink);
}
.rail-row {
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.cmdr-tax {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  letter-spacing: 0;
}
#player-zones {
  grid-area: zones;
  padding: 0 1.25rem;
}
#player-zones:not(:empty) {
  padding: 0.4rem 1.25rem;
  border-top: 1px solid var(--ink);
}

/* Your hand beside the one decision you owe, under an ink rule across the whole width. */
.hand-band {
  grid-area: hand;
  min-height: 0;
  display: grid;
  /* The decision is where the game asks you things, so it gets the larger share. */
  grid-template-columns: minmax(0, 42fr) minmax(26rem, 58fr);
  border-top: 1px solid var(--ink);
}
.hand-wrap {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0.5rem 1.25rem;
}
.hand-label {
  padding: 0;
}
.hand-row {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0.35rem 0 0;
  box-sizing: border-box;
}
.human-zone.no-hand .hand-row {
  display: none;
}
.command-zone {
  display: flex;
  align-items: center;
  align-self: stretch;
  gap: 8px;
  padding-right: 8px;
  margin-right: 0;
  border-right: 1px solid var(--ink);
}
.hand {
  flex: 1;
  min-width: 0;
  align-self: stretch;
  align-items: center;
  gap: 8px;
  padding: 0 0 4px;
  border-top: 0;
  scrollbar-width: thin;
}
.hand-tile {
  position: relative;
  flex: 0 0 auto;
  aspect-ratio: 5 / 7;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  overflow: hidden;
  container-type: inline-size;
  border: 1px solid var(--ink);
  background: var(--paper);
  color: var(--ink);
  text-align: left;
  transition:
    translate 0.2s var(--ease),
    box-shadow 0.2s var(--ease),
    opacity 0.2s var(--ease);
}
.hand-tile:hover {
  translate: 0 -4px;
  box-shadow: var(--lift-shadow);
}
.commander-card.hand-tile {
  border: 3px double var(--ink);
  cursor: pointer;
}
.play-tag,
.tile-bar {
  position: static;
  transform: none;
  flex-shrink: 0;
  padding: 2% 5%;
  border-radius: 0;
  border-bottom: 1px solid var(--ink);
  background: var(--ink);
  color: var(--paper);
  font-family: var(--font-ui);
  font-size: max(8px, 7.5cqw);
  font-weight: 400;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tile-name {
  flex-shrink: 0;
  margin: 5% 6% 3%;
  font-family: var(--font-ui);
  font-size: max(10px, 9.5cqw);
  line-height: 1.12;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tile-art {
  position: relative;
  flex: 1;
  min-height: 0;
  margin: 0 6% 4%;
  overflow: hidden;
  background: var(--paper-2);
}
.tile-art img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.art-tag {
  position: absolute;
  left: 5%;
  bottom: 5%;
  padding: 1px 4px;
  border: 1px solid var(--ink);
  background: var(--paper);
  font-family: var(--font-ui);
  font-size: max(7px, 6.2cqw);
  line-height: 1.3;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.tile-type {
  flex-shrink: 0;
  padding: 0 6% 6%;
  font-family: var(--font-body);
  font-size: max(8px, 7.5cqw);
  line-height: 1.3;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
}
.tile-type > span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tile-type .subtypes {
  font-family: var(--font-display);
  font-size: 1.3em;
  line-height: 1.15;
  color: var(--ink);
}
@container (max-width: 90px) {
  .tile-type {
    display: none;
  }
}

/* The decision: a warm star and whose move it is, the title in spaced capitals, then its buttons
   and what it means. It scrolls inside the band rather than pushing your hand off screen. */
.decision {
  min-width: 0;
  min-height: 0;
  max-height: none;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 1.25rem;
  overflow: auto;
  border: 0;
  border-left: 1px solid var(--ink);
  border-radius: 0;
  background: transparent;
}
.decide-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem 1.5rem;
}
.decide-kicker {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}
.decide-kicker path {
  fill: var(--warm);
}
.decide-title {
  font-family: var(--font-body);
  font-size: 1.05rem;
  line-height: 1.2;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}
.decide-body {
  margin: 0;
  max-width: 44rem;
  font-size: 0.9rem;
  line-height: 1.6;
}
.send-at {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
}
.send-label {
  font-family: var(--font-ui);
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.send-at button {
  min-width: 40px;
  min-height: 36px;
  padding: 0 0.5rem;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-body);
}
.send-at button[aria-pressed='true'] {
  background: var(--ink);
  color: var(--paper);
}
.decision p {
  margin: 0;
}
.decision .prompt {
  max-width: 62ch;
  font-family: var(--font-body);
  font-size: 0.9rem;
  font-weight: 400;
  line-height: 1.5;
}
.decision .thinking {
  font-style: normal;
  color: var(--muted);
}
.decision :deep(.decision-panel) {
  margin-top: 0;
}
/* The tray inside the decision: no box of its own, the decision's buttons and lists. */
.interaction-tray {
  position: static;
  max-height: none;
  min-height: 0;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  overflow: visible;
}
.interaction-tray.targeting {
  box-shadow: none;
}
.interaction-tray:empty {
  display: none;
}
.tray-heading {
  font-family: var(--font-body);
  font-size: 0.8rem;
}
.tray-actions {
  flex-wrap: wrap;
  justify-content: flex-start;
  align-items: center;
  gap: 0.5rem 1.25rem;
  margin-top: 0;
}
.tray-hint,
.target-instruction {
  max-width: 62ch;
  font-family: var(--font-body);
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--muted);
}
.target-instruction {
  color: var(--ink);
}
button.link {
  min-height: 44px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 0.8rem;
  cursor: pointer;
}
/* The brackets are decoration: the empty alternative keeps them out of the button's name. */
button.link::before {
  content: '[ ' / '';
}
button.link::after {
  content: ' ]' / '';
}
.pending-stack {
  border-left-color: var(--ink);
  background: var(--paper-2);
}
.cost-chip,
.target-chip {
  border-radius: 0;
  border-color: var(--rule);
}
/* One ruled row per creature: its name, then a choice per target, the chosen one inked. */
.combat-assignments {
  gap: 0;
  margin-top: 0;
  max-height: none;
  overflow: visible;
  border-top: 1px solid var(--ink);
}
.combat-assignment-row {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.75rem;
  padding: 0.35rem 0;
  border: 0;
  border-bottom: 1px solid var(--rule);
  border-radius: 0;
  font-family: var(--font-body);
  font-size: 0.8rem;
}
.combat-assignment-row.focused {
  border-color: var(--rule);
  box-shadow: inset 3px 0 0 var(--warm);
  padding-left: 0.6rem;
}
.combat-assignment-row .assignment-name {
  flex: 1 1 10rem;
  min-width: 0;
  font-family: var(--font-ui);
  font-size: 0.7rem;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.assignment-options {
  gap: 0.35rem;
}
.assignment-options button,
.assignment-options button.primary {
  min-height: 32px;
  min-width: 40px;
  padding: 0 0.6rem;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 0.75rem;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}
.assignment-options button.primary {
  background: var(--ink);
  color: var(--paper);
}
.assignment-options button.muted:not(.primary) {
  border-color: var(--rule);
  color: var(--muted);
}
.combat-count {
  font-size: 0.7rem;
  color: var(--muted);
}
/* The engine's declaration action, read as the step's count line: composing is already open. */
.combat-count .combat-step {
  min-height: 24px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-family: var(--font-ui);
  font-size: 0.62rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: default;
}
.combat-interrupted {
  color: var(--danger) !important;
}
.quick-actions {
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1.25rem;
  margin: 0;
}
button.primary {
  min-height: 44px;
  padding: 0 1.5rem;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--ink);
  color: var(--paper);
  font-family: var(--font-ui);
  font-size: 0.8rem;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.quick-actions button.secondary {
  min-height: 44px;
  padding: 0 1rem;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 0.8rem;
}
.playable-now {
  margin: 0;
}
.playable-now > strong,
.bot-summary > strong,
.ignored-abilities > strong {
  font-family: var(--font-ui);
  font-size: 0.64rem;
  font-weight: 400;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.playable-list button {
  border-radius: 0;
  border-color: var(--ink);
}
.playable-list .verb {
  font-weight: 400;
  color: var(--ink);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.playable-list button.focused {
  background: var(--ink);
  color: var(--paper);
}
.decision :deep(.stack-panel) {
  border-radius: 0;
}

/* Interaction marks: ink and the warm accent instead of blue and green glows. */
button.active,
button.selected,
.focused {
  border-color: var(--ink);
  box-shadow: 0 0 0 1px var(--ink);
}
.actionable {
  border-color: var(--warm) !important;
  box-shadow:
    0 0 0 2px var(--warm),
    0 6px 14px color-mix(in srgb, var(--warm) 30%, transparent);
}
.targetable {
  border-color: var(--ink) !important;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 45%, transparent);
}
.chosen-target {
  border-color: var(--ink) !important;
  box-shadow:
    0 0 0 2px var(--ink),
    inset 0 0 0 2px var(--paper);
}
.object.out-of-reach {
  opacity: 0.45;
  transition: opacity 160ms var(--ease);
}
.payment-source {
  border-color: var(--warm) !important;
  box-shadow:
    0 0 0 2px var(--warm),
    inset 0 0 0 2px var(--paper);
}

/* Game log: a column at the right, on paper-2 behind an ink rule. */
.info-drawer,
.settings-menu {
  border-radius: 0;
  border: 1px solid var(--ink);
  background: var(--paper);
  box-shadow: none;
}
.info-drawer {
  min-height: 0;
  overflow-y: auto;
  border-width: 0 0 0 1px;
  background: var(--paper-2);
  padding: 0.75rem 1rem;
}
.info-head h2 {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  font-weight: 400;
  letter-spacing: 0.08em;
  color: var(--ink);
}
.info-close {
  border: 0;
  background: transparent;
  color: var(--ink);
}
.yield-banner,
.paused {
  border-radius: 0;
  border-color: var(--ink);
  background: var(--paper-2);
  color: var(--ink);
}

/* Phone and narrow windows: everything in one column, in reading order, scrolling. */
@media (max-width: 900px) {
  .player-layout {
    display: flex;
    flex-direction: column;
  }
  .table {
    flex-shrink: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .opponents {
    grid-template-columns: minmax(0, 1fr) !important;
  }
  /* Stacked seats get fixed heights, so their tiles have a zone to size to. */
  .opponent {
    height: 14rem;
  }
  .opponent.out {
    height: auto;
    min-height: 5rem;
  }
  .opponent + .opponent {
    border-left: 0;
    border-top: 1px solid var(--ink);
  }
  .human-zone {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto 22rem 8rem auto auto auto;
    grid-template-areas: 'head' 'cols' 'lands' 'rail' 'zones' 'hand';
  }
  .human-zone.no-hand {
    grid-template-rows: auto 22rem 8rem auto auto auto;
  }
  .me-cols {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.5rem;
  }
  .me-rail {
    border-left: 0;
    border-top: 1px solid var(--ink);
    flex-direction: row;
    flex-wrap: wrap;
    align-items: flex-start;
  }
  .rail-piles {
    flex: 1 1 14rem;
  }
  .hand-band,
  .human-zone.no-hand .hand-band {
    grid-template-columns: minmax(0, 1fr);
  }
  .hand-wrap {
    height: 11rem;
  }
  .human-zone.no-hand .hand-wrap {
    height: auto;
  }
  .decision {
    border-left: 0;
    border-top: 1px solid var(--ink);
    padding: 0.75rem 1rem;
  }
  .info-drawer {
    flex-shrink: 0;
    min-height: 24rem;
  }
  .turn-ruler {
    --stop-w: 3.6rem;
  }
  .turn-ruler li:not(.on) {
    color: transparent;
  }
  .bar-links {
    gap: 0.75rem;
  }
}
</style>
