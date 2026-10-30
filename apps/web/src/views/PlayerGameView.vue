<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import type { ManaPool } from '@mtg/shared';
import { ATTACKS_TARGET, turnPositionLabel } from '@mtg/shared';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { ObjectId, TargetChoice } from '@mtg/shared';
import type { DecisionRequest, LegalAction } from '../lib/protocol';
import ActionLog from '../components/ActionLog.vue';
import CardImage from '../components/CardImage.vue';
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
import StackPanel from '../components/StackPanel.vue';
import ZonePile from '../components/ZonePile.vue';
import ZoneStrip from '../components/ZoneStrip.vue';
import { useBoardAnchors } from '../composables/useBoardAnchors';
import { useCombatStrikes } from '../composables/useCombatStrikes';
import { useLifeFlash, useLifeFlashBySeat } from '../composables/useLifeFlash';
import {
  buttonLabel,
  costChips,
  entryFor,
  pendingLabel,
  promptOf,
} from '../lib/actionPresentation';
import { CONNECTION_LABELS } from '../lib/socket';
import { groupByXFamily, type XActionGroup } from '../lib/xFamilies';
import { groupPermanents, stackKey } from '../lib/stackPermanents';
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
const { registerAnchor, setRoot, disposeRoot } = useBoardAnchors();
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

function onBoardDragOver(event: DragEvent): void {
  if (tableRef.value === null || draggedId.value === null) return;
  const rect = tableRef.value.getBoundingClientRect();
  dragPointer.value = { x: event.clientX - rect.left, y: event.clientY - rect.top };
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
const thinkingLabel = computed(() => {
  const board = state.value;
  if (board === null) return 'Getting the game ready…';
  const seat = board.priorityPlayer ?? board.activePlayer;
  if (seat === board.viewerSeat) return 'Resolving your action…';
  const name = board.seats.find((entry) => entry.seat === seat)?.label ?? seat;
  return `${name} is deciding…`;
});

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
 * Whether each pile (lands, graveyard, exile) is open, remembered across games the way the game
 * info column is: someone who likes their lands spread out keeps them that way.
 */
type Pile = 'lands' | 'graveyard' | 'exile';
const PILE_KEY = (pile: Pile) => `mtg.playerPile.${pile}`;
function readPile(pile: Pile): boolean {
  try {
    return localStorage.getItem(PILE_KEY(pile)) === 'true';
  } catch {
    return false;
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
  const targets = zoneTargetIds.value;
  if (targets.length === 0) return false;
  const seatCards = [
    ...(state.value?.seats.find((s) => s.seat === seat)?.graveyard ?? []),
    ...exileFor(seat),
  ];
  return seatCards.some((card) => targets.includes(card.id));
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

/** Only show cards the server explicitly included in this viewer's authorized top reveal. */
function revealedLibraryTopsFor(seat: string) {
  return (
    state.value?.revealedLibraryTops
      ?.filter((entry) => entry.player === seat)
      .map((entry) => entry.card) ?? []
  );
}

/**
 * Groups identical tokens/creatures (same name, state, P/T, counters — see `stackPermanents.ts`)
 * into one tile with a count badge, so a wide go-wide board doesn't clog the screen with a dozen
 * duplicate chips. Combat declaration never clicks these tiles directly (the assignment tray
 * below lists every subject individually with its own buttons), so grouping never hides a
 * creature that still needs its own attack/block decision.
 */
function groupedPermanentsFor(seat: string) {
  return groupPermanents(permanentsFor(seat));
}

const humanLifeFlash = useLifeFlash(() => human.value?.seat);
const opponentLifeFlash = useLifeFlashBySeat();

/**
 * Card size scales inversely with how crowded its zone is (design handoff: "adaptive card
 * sizing"), so a packed board still fits and a sparse one still reads clearly. `refN` is the
 * "comfortable" reference count for that zone; own and opponent zones carry separate base
 * sizes/scales so opponents render smaller by default without shrinking the human's board.
 */
function adaptiveWidth(
  baseW: number,
  count: number,
  refN: number,
  scale: number,
  capH?: number,
): number {
  const factor = Math.min(1.35, Math.max(0.6, Math.sqrt(refN / Math.max(count, 1))));
  const width = baseW * factor * scale;
  if (capH === undefined) return Math.round(width);
  // 63:88 card ratio — convert the height cap to the equivalent width cap.
  return Math.round(Math.min(width, (capH * 63) / 88));
}

/**
 * Battlefield chips no longer scale off card *count* — that shrank a sparse board just because
 * a few more permanents came down, well before the row ran out of room. `--chip-w`/`--chip-min`
 * (below, in `.object`) hand sizing to the browser instead: a flex basis it shrinks from only
 * once the actual row width can't fit everything at full size.
 */
const humanPermWidth = 120;
const humanPermMinWidth = 54;
const humanLandWidth = 96;
const handCardWidth = computed(() => adaptiveWidth(96, human.value?.hand?.length ?? 0, 5, 1, 150));
const opponentPermWidth = 92;
const opponentPermMinWidth = 40;

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

function sourceId(action: LegalAction): string | null {
  const interaction = action.interaction ?? { kind: 'choice' as const };
  if (interaction.kind === 'source') return interaction.sourceId;
  if (interaction.kind === 'attack') return interaction.attackerId;
  if (interaction.kind === 'block') return interaction.blockerId;
  if (interaction.kind === 'choice') return interaction.subjectId ?? null;
  return null;
}

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
    name: nameById.value.get(id) ?? id,
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
const opponentColumns = computed(() =>
  opponents.value
    .map((opponent) =>
      opponent.seat === state.value?.activePlayer ? 'minmax(0, 1.5fr)' : 'minmax(0, 1fr)',
    )
    .join(' '),
);

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
function tryPlanAssign(target: ObjectId | string): boolean {
  if (combatPlan.mode !== 'composing' || focusedSourceId.value === null) return false;
  if (!combatPlan.isLegalTarget(focusedSourceId.value, target)) return false;
  combatPlan.assign(focusedSourceId.value, target);
  focusedSourceId.value = null;
  return true;
}

function selectSource(id: ObjectId): void {
  if (combatPlan.mode === 'composing') {
    if (tryPlanAssign(id)) return;
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

function dropOn(target: ObjectId | string): void {
  const source = draggedId.value;
  draggedId.value = null;
  dragPointer.value = null;
  if (source === null) return;
  if (combatPlan.mode === 'composing') {
    if (combatPlan.isLegalTarget(source, target as string))
      combatPlan.assign(source, target as string);
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
    <OpeningHand
      v-if="openingHand"
      :request="openingHand.request"
      :cards="openingHand.hand"
      :mulligans-taken="openingHand.mulligansTaken"
      @choose="store.submitPlayerAction"
    />
    <!-- Game status lives in the app's top bar, as on the spectator board, so the table keeps the
         height a second bar took. Settings and game info open from buttons there. -->
    <Teleport to="#top-bar-status" defer>
      <span v-if="state" class="turn-badge" :class="{ 'your-turn': isYourTurn }">
        Turn {{ state.turnNumber }} · {{ isYourTurn ? 'Your turn' : state.activePlayer }}
      </span>
      <span v-if="state" class="phase-label">{{ turnPositionLabel(state.phase, state.step) }}</span>
      <span v-if="state?.priorityPlayer" class="priority-label"
        >Priority:
        {{ state.priorityPlayer === state.viewerSeat ? 'You' : state.priorityPlayer }}</span
      >
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
      <CopyGameReportButton />
      <button
        type="button"
        class="bar-toggle"
        :aria-expanded="settingsOpen"
        aria-controls="player-settings"
        @click="settingsOpen = !settingsOpen"
      >
        Settings
      </button>
      <button
        type="button"
        class="bar-toggle"
        :aria-expanded="infoOpen"
        aria-controls="player-game-info"
        @click="toggleInfo"
      >
        {{ infoOpen ? 'Hide game info' : 'Game info' }}
      </button>
    </Teleport>

    <!-- Bot pace, confirmations, motion and Abandon: set once, rarely touched, so folded away. -->
    <div v-show="settingsOpen" id="player-settings" class="settings-menu" aria-label="Settings">
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
      <section ref="tableRef" class="table" @dragover="onBoardDragOver">
        <CombatOverlay
          :drag-source-id="draggedId"
          :pointer="dragPointer"
          :permanents="state.battlefield"
        />
        <div class="opponents" :style="{ '--opponent-columns': opponentColumns }">
          <article
            v-for="opponent in opponents"
            :key="opponent.seat"
            :ref="seatAnchorRef(opponent.seat)"
            class="opponent"
            :data-seat="opponent.seat"
            :class="{
              active: opponent.seat === state.activePlayer,
              targetable: isLegalTarget(opponent.seat),
              'chosen-target': isChosenTarget(opponent.seat),
            }"
            @click="chooseOpponent(opponent.seat)"
            @dragover.prevent
            @drop="dropOn(opponent.seat)"
          >
            <!-- One line, as on the spectator board: who, their colors, their counts, then the
                 zones button beside the life total. -->
            <header>
              <span class="id-badge">{{ opponent.seat }}</span>
              <span
                v-for="commander in opponent.commanders"
                :key="commander.cardId"
                class="cmdr-thumb"
                @mouseenter="showCardPreview(commander, $event)"
                @mousemove="moveCardPreview"
                @mouseleave="hideCardPreview"
              >
                <CardImage
                  :scryfall-id="commander.scryfallId"
                  :name="commander.name"
                  size="small"
                />
              </span>
              <strong
                class="seat-name"
                @mouseenter="
                  opponent.commanders[0] && showCardPreview(opponent.commanders[0], $event)
                "
                @mousemove="moveCardPreview"
                @mouseleave="hideCardPreview"
                >{{ opponent.label }}</strong
              >
              <DeckColors :commanders="opponent.commanders" />
              <span class="meta-item opp-meta" title="Cards in hand"
                >{{ opponent.handSize }} in hand</span
              >
              <span class="meta-item" title="Cards in library"
                ><b>lib</b> {{ opponent.librarySize }}</span
              >
              <span class="meta-item" title="Cards in graveyard"
                ><b>gy</b> {{ opponent.graveyard.length }}</span
              >
              <span class="meta-item" title="Cards in exile"
                ><b>exile</b> {{ exileFor(opponent.seat).length }}</span
              >
              <span class="spacer" />
              <span
                v-if="state.monarchSeat === opponent.seat"
                class="monarch-badge"
                title="This player is the monarch"
                >MONARCH</span
              >
              <button
                type="button"
                class="zones-toggle"
                :aria-expanded="zonesShown(opponent.seat)"
                @click.stop="toggleZones(opponent.seat)"
              >
                {{ zonesShown(opponent.seat) ? '▾ zones' : '▸ zones' }}
              </button>
              <span
                class="life-badge"
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
            <TransitionGroup tag="div" name="board-card" class="permanents">
              <div
                v-for="group in groupedPermanentsFor(opponent.seat)"
                :key="group.permanent.id"
                class="object"
                :style="{
                  '--chip-w': opponentPermWidth + 'px',
                  '--chip-min': opponentPermMinWidth + 'px',
                }"
                :class="{
                  targetable: isLegalTarget(group.permanent.id),
                  'chosen-target': isChosenTarget(group.permanent.id),
                  actionable: actionableSourceIds.has(group.permanent.id),
                }"
                draggable="true"
                @dragstart="dragStart(group.permanent.id, $event)"
                @dragend="dragEnd"
                @dragover.prevent
                @drop.stop="dropOn(group.permanent.id)"
                @click.stop="selectSource(group.permanent.id)"
              >
                <PermanentChip
                  :permanent="group.permanent"
                  :count="group.count"
                  :name-by-id="nameById"
                />
              </div>
            </TransitionGroup>
            <div v-show="zonesShown(opponent.seat)" class="zones-strip opponent-zones" @click.stop>
              <ZoneStrip
                label="Graveyard"
                :cards="opponent.graveyard"
                :selectable-ids="zoneTargetIds"
                @select="chooseTarget"
              />
              <ZoneStrip
                label="Exile"
                :cards="exileFor(opponent.seat)"
                :selectable-ids="zoneTargetIds"
                @select="chooseTarget"
              />
              <ZoneStrip
                v-if="revealedLibraryTopsFor(opponent.seat).length > 0"
                label="Top of library"
                :cards="revealedLibraryTopsFor(opponent.seat)"
                :selectable-ids="zoneTargetIds"
                @select="chooseTarget"
              />
            </div>
          </article>
        </div>

        <section
          v-if="human"
          :ref="seatAnchorRef(human.seat)"
          class="human-zone"
          :class="{ 'your-turn': isYourTurn }"
        >
          <header
            :class="{
              targetable: isLegalTarget(human.seat),
              'chosen-target': isChosenTarget(human.seat),
            }"
            @click="chooseOpponent(human.seat)"
          >
            <span class="id-badge you">You · {{ human.seat }}</span>
            <!-- The commander once, as a thumbnail: in the command zone it is the card you click
                 to cast it, glowing when you can. -->
            <span class="command-zone">
              <template v-for="commander in human.commanders" :key="commander.cardId">
                <button
                  v-if="commander.zone === 'command' && commander.objectId !== null"
                  type="button"
                  class="commander-card cmdr-thumb"
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
                  <CardImage
                    :scryfall-id="commander.scryfallId"
                    :name="commander.name"
                    size="small"
                  />
                </button>
                <span
                  v-else
                  class="cmdr-thumb"
                  @mouseenter="showCardPreview(commander, $event)"
                  @mousemove="moveCardPreview"
                  @mouseleave="hideCardPreview"
                >
                  <CardImage
                    :scryfall-id="commander.scryfallId"
                    :name="commander.name"
                    size="small"
                  />
                </span>
              </template>
            </span>
            <strong
              class="seat-name"
              @mouseenter="human.commanders[0] && showCardPreview(human.commanders[0], $event)"
              @mousemove="moveCardPreview"
              @mouseleave="hideCardPreview"
              >{{ human.label }}</strong
            >
            <DeckColors :commanders="human.commanders" />
            <!-- Your own counts in full words: your row has the room, and they are yours. -->
            <span class="meta-item"><b>Hand</b> {{ human.hand?.length ?? human.handSize }}</span>
            <span class="meta-item"><b>Library</b> {{ human.librarySize }}</span>
            <span class="meta-item"><b>Graveyard</b> {{ human.graveyard.length }}</span>
            <span class="meta-item"><b>Exile</b> {{ humanExile.length }}</span>
            <span class="spacer" />
            <span
              v-for="commander in taxedCommanders"
              :key="commander.cardId"
              class="cmdr-tax"
              :title="`Commander tax: casting ${commander.name} costs {${commander.taxGeneric}} more`"
              >+{{ commander.taxGeneric }}</span
            >
            <span
              v-if="state.monarchSeat === human.seat"
              class="monarch-badge"
              title="You are the monarch"
              >MONARCH</span
            >
            <span
              class="life-badge"
              :class="{
                low: human.life <= 10,
                'flash-damage': humanLifeFlash === 'damage',
                'flash-heal': humanLifeFlash === 'heal',
              }"
              >{{ human.life }}</span
            >
          </header>
          <!-- Your board, then your lands, then your graveyard and exile as piles: Arena's layout. -->
          <div class="battle-row">
            <TransitionGroup
              tag="div"
              name="board-card"
              class="permanents"
              @dragover.prevent
              @drop="dropToBattlefield"
            >
              <div
                v-for="group in humanBoardGroups"
                :key="group.permanent.id"
                class="object"
                :style="{
                  '--chip-w': humanPermWidth + 'px',
                  '--chip-min': humanPermMinWidth + 'px',
                }"
                :class="{
                  focused: focusedSourceId === group.permanent.id,
                  targetable: isLegalTarget(group.permanent.id),
                  'chosen-target': isChosenTarget(group.permanent.id),
                  'payment-source': isPaymentSource(group.permanent.id),
                  actionable: actionableSourceIds.has(group.permanent.id),
                  'makes-mana': (manaByGroup.get(group.permanent.id) ?? []).length > 0,
                }"
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
                />
                <ManaTaps
                  v-if="(manaByGroup.get(group.permanent.id) ?? []).length > 0"
                  :actions="manaByGroup.get(group.permanent.id)!"
                  :presentation="request?.presentation?.actions"
                  @tap="tapForMana"
                />
              </div>
            </TransitionGroup>
            <!-- Lands: a pile showing how many are untapped, or spread out to use one by one. -->
            <div
              v-if="humanLands.length > 0"
              id="player-lands"
              class="land-area"
              :class="{ spread: landsShown }"
            >
              <template v-if="landsShown">
                <button
                  type="button"
                  class="pile-close"
                  aria-controls="player-lands"
                  :aria-expanded="true"
                  @click.stop="togglePile('lands')"
                >
                  ▾ Lands ({{ humanLands.length }}) · {{ untappedLandCount }} untapped
                </button>
                <TransitionGroup tag="div" name="board-card" class="permanents lands">
                  <div
                    v-for="group in humanLandGroups"
                    :key="group.permanent.id"
                    class="object"
                    :style="{
                      '--chip-w': humanLandWidth + 'px',
                      '--chip-min': humanPermMinWidth + 'px',
                    }"
                    :class="{
                      focused: focusedSourceId === group.permanent.id,
                      targetable: isLegalTarget(group.permanent.id),
                      'chosen-target': isChosenTarget(group.permanent.id),
                      'payment-source': isPaymentSource(group.permanent.id),
                      actionable: actionableSourceIds.has(group.permanent.id),
                      'makes-mana': (manaByGroup.get(group.permanent.id) ?? []).length > 0,
                    }"
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
            <div class="piles">
              <ZonePile
                label="Graveyard"
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
              <ZonePile
                v-if="humanExile.length > 0"
                label="Exile"
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
            </div>
          </div>

          <TransitionGroup
            tag="div"
            name="hand-card"
            class="hand"
            :class="{ 'has-playable': playableSources.length > 0 && selectedAction === null }"
          >
            <button
              v-for="card in human.hand ?? []"
              :key="card.id"
              type="button"
              class="hand-card"
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
              <CardImage
                :scryfall-id="card.scryfallId"
                :name="card.name"
                :is-token="card.isToken === true"
                size="small"
              />
              <span v-if="playableVerbById.get(card.id)" class="play-tag">{{
                playableVerbById.get(card.id)
              }}</span>
              <span>{{ card.name }}</span>
            </button>
          </TransitionGroup>

          <!-- An open graveyard or exile pile spreads its cards here, under your hand. -->
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
                  sourceNameOf(selectedAction) ?? selectedSourceName ?? selectedAction.description
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
                v-if="selectedEntry?.payment !== undefined && selectedEntry.payment.summary !== ''"
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
                <button type="button" @click="cancel">Cancel</button>
                <button
                  ref="confirmButtonRef"
                  type="button"
                  class="primary"
                  :disabled="!canConfirm"
                  @click="confirm"
                >
                  {{ selectedAction.type === 'playLand' ? 'Play land' : 'Confirm' }}
                </button>
              </div>
            </template>
            <template v-else-if="combatPlan.mode === 'composing'">
              <div class="tray-heading">
                <strong>{{ combatHeading }}</strong>
                <span
                  >{{ combatPlan.order.length }} creature{{
                    combatPlan.order.length === 1 ? '' : 's'
                  }}</span
                >
              </div>
              <p
                v-if="combatPlan.rejectionMessage !== null"
                class="target-instruction combat-interrupted"
              >
                The engine rejected that declaration: {{ combatPlan.rejectionMessage }} Fix the
                flagged creature(s) and confirm again.
              </p>
              <p v-else class="target-instruction">{{ combatInstruction }}</p>
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
                      :class="{ primary: combatPlan.assignment.get(entry.subjectId) === optionId }"
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
              <div class="tray-actions">
                <button type="button" @click="cancelCombatPlan">Reset declaration</button>
                <button type="button" class="primary" @click="confirmCombatPlan">
                  Confirm {{ combatPlan.kind === 'attackers' ? 'attacks' : 'blocks' }}
                </button>
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
                    <small>{{ costChips(entryOf(xGroupPreviewAction(group))).join(' · ') }}</small>
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
            <p v-else class="tray-hint">
              Click a highlighted card or permanent to play, cast, or activate it.
            </p>
          </section>
        </section>
      </section>

      <aside class="rail">
        <section class="decision" :data-request-id="request?.requestId">
          <template v-if="request && !openingHand">
            <DecisionPanel
              v-if="fallbackRequest && immediateActions.length === 0"
              :request="fallbackRequest"
              @choose="chooseFallbackAction"
            />
            <template v-else>
              <h3>Your action</h3>
              <p class="prompt">{{ promptOf(request) }}</p>
              <div v-if="immediateActions.length > 0" class="quick-actions">
                <button
                  v-for="action in immediateActions"
                  :key="action.id"
                  type="button"
                  class="primary"
                  @click="chooseAction(action)"
                >
                  {{ action.description }}
                </button>
              </div>
              <div
                v-if="
                  playableSources.length > 0 &&
                  selectedAction === null &&
                  combatPlan.mode === 'idle'
                "
                class="playable-now"
              >
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
                resume a spell or ability below to make it available again.
              </p>
              <DecisionPanel
                v-if="fallbackRequest"
                :request="fallbackRequest"
                @choose="chooseFallbackAction"
              />
            </template>
          </template>
          <p v-else-if="!request" class="thinking" role="status" aria-live="polite">
            <span class="thinking-mark" aria-hidden="true" />
            {{ thinkingLabel }}
          </p>
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
        </section>

        <StackPanel
          :state="state"
          :is-legal-target="isLegalTarget"
          :is-chosen-target="isChosenTarget"
          @select="selectSource"
        />
        <DealPanel v-if="store.diplomacy && store.diplomacySeat" />
      </aside>
      <!-- Commander damage and the log stay mounted while hidden, so the log keeps following play
           and opening the drawer shows it already at the present. -->
      <aside v-show="infoOpen" id="player-game-info" class="info-drawer" aria-label="Game info">
        <div class="info-head">
          <h2>Game info</h2>
          <button type="button" class="info-close" aria-label="Close game info" @click="toggleInfo">
            ×
          </button>
        </div>
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
/* The top bar's status, teleported into the app's nav. */
.phase-label,
.priority-label {
  font-size: 0.78rem;
  color: var(--muted);
  white-space: nowrap;
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
.bar-toggle {
  font-size: 0.75rem;
  padding: 0.15rem 0.55rem;
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
.spacer {
  flex: 1;
}
.cmdr-thumb {
  width: 22px;
  flex-shrink: 0;
  padding: 0;
  border-radius: 3px;
  overflow: hidden;
  border: 1px solid rgb(96 165 250 / 0.4);
  cursor: zoom-in;
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
  font-weight: 800;
  color: #1c1917;
  background: #d6d3d1;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.35);
}
.mana-dot:first-of-type {
  margin-left: 0.15rem;
}
.mana-W {
  background: #f8f4d8;
}
.mana-U {
  background: #a9cdf0;
}
.mana-B {
  background: #b5aaa6;
}
.mana-R {
  background: #f0a184;
}
.mana-G {
  background: #9bcb98;
}
.battle-row {
  flex: 1;
  min-height: 150px;
  display: flex;
  gap: 0.5rem;
  overflow: hidden;
}
.battle-row .permanents {
  flex: 1.4;
  min-width: 0;
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
/* Graveyard and exile piles at the row's right end. */
.piles {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding-left: 0.4rem;
  border-left: 1px dashed var(--line);
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
.commander-card.cmdr-thumb {
  width: 26px;
  cursor: pointer;
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
  color: #08111f;
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
.rail {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
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
  color: #fff;
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
  color: #fff;
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
  color: #08111f;
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
.thinking-mark {
  width: 0.52rem;
  height: 0.52rem;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 0 rgb(96 165 250 / 0.45);
  animation: thinkingPulse 1.35s ease-out infinite;
}
@keyframes thinkingPulse {
  0% {
    box-shadow: 0 0 0 0 rgb(96 165 250 / 0.45);
  }
  75%,
  100% {
    box-shadow: 0 0 0 0.48rem rgb(96 165 250 / 0);
  }
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
@media (max-width: 900px) {
  .player-layout {
    display: flex;
    flex-direction: column;
    overflow: auto;
  }
  .opponents {
    grid-template-columns: 1fr;
  }
  .table {
    flex-shrink: 0;
    grid-template-rows: auto auto;
  }
  .rail {
    flex-shrink: 0;
    min-height: 30rem;
  }
  .info-drawer {
    flex-shrink: 0;
    min-height: 24rem;
  }
}
</style>
