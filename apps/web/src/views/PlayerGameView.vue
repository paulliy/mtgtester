<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import type { ManaPool } from '@mtg/shared';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type {
  DecisionRequest,
  LegalAction,
  ObjectId,
  PlayerBoardSeat,
  TargetChoice,
} from '@mtg/shared';
import ActionLog from '../components/ActionLog.vue';
import CardImage from '../components/CardImage.vue';
import CombatOverlay from '../components/CombatOverlay.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import CopyGameReportButton from '../components/CopyGameReportButton.vue';
import DecisionPanel from '../components/DecisionPanel.vue';
import GlobalCounters from '../components/GlobalCounters.vue';
import PermanentChip from '../components/PermanentChip.vue';
import StackPanel from '../components/StackPanel.vue';
import ZoneStrip from '../components/ZoneStrip.vue';
import { useBoardAnchors } from '../composables/useBoardAnchors';
import { useCombatStrikes } from '../composables/useCombatStrikes';
import { useLifeFlash, useLifeFlashBySeat } from '../composables/useLifeFlash';
import { actionLabel } from '../lib/actionLabels';
import { isTokenTypeLine } from '../lib/card';
import { CONNECTION_LABELS } from '../lib/socket';
import { playerFacingPrompt, turnPositionLabel } from '../lib/turnLabels';
import { groupPermanents } from '../lib/stackPermanents';
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
onMounted(() => setRoot(tableRef.value));
onUnmounted(() => {
  disposeRoot();
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
 * MTGA-style attack animation (extends §9.8.1): every freshly pushed board is diffed for combat
 * damage and translated into a lunge vector for the striking permanent, via anchors already
 * registered for the combat overlay. Skipped entirely under reduced motion, matching how
 * `CombatOverlay.vue` and the drag-cursor line are gated.
 */
const combatStrikes = useCombatStrikes();
watch(state, (next) => {
  if (next !== null && !store.reducedMotion) combatStrikes.observe(next);
});

const pending = computed(() => store.playerAction);
const request = computed(() => pending.value?.request ?? null);
const human = computed(
  () => state.value?.seats.find((seat) => seat.seat === state.value?.viewerSeat) ?? null,
);
const opponents = computed(
  () => state.value?.seats.filter((seat) => seat.seat !== state.value?.viewerSeat) ?? [],
);
const humanExile = computed(
  () => state.value?.exile.filter((card) => card.owner === state.value?.viewerSeat) ?? [],
);
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

const humanLifeFlash = useLifeFlash(() => human.value?.life ?? 0);
const opponentLifeFlash = useLifeFlashBySeat(() =>
  opponents.value.map((opp) => ({ seat: opp.seat, life: opp.life })),
);

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
const humanPermWidth = 108;
const humanPermMinWidth = 54;
const handCardWidth = computed(() => adaptiveWidth(96, human.value?.hand?.length ?? 0, 5, 1, 150));
const commanderWidth = 78;
const opponentPermWidth = 70;
const opponentPermMinWidth = 40;

function primaryCommander(opponent: PlayerBoardSeat) {
  return opponent.commanders[0] ?? null;
}

/** "P2" -> "P2 (Krenko, Mob Boss)" for combat-tray option labels; falls back to the raw id. */
function seatLabel(seatId: string): string {
  const seat = state.value?.seats.find((s) => s.seat === seatId);
  return seat === undefined ? seatId : seat.label;
}

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

const sourceActions = computed(() =>
  (request.value?.legalActions ?? []).filter(
    (action) => !isImmediate(action) && sourceId(action) !== null,
  ),
);
const selectedSourceActions = computed(() =>
  focusedSourceId.value === null
    ? []
    : sourceActions.value.filter((action) => sourceId(action) === focusedSourceId.value),
);
interface XActionGroup {
  key: string;
  actions: LegalAction[];
  /** Same as `actions[0]`/`actions[actions.length - 1]` — stored so callers never index an
   * array TS can't prove is non-empty. */
  first: LegalAction;
  min: number;
  max: number;
}

/**
 * A {X} spell/ability offers one whole `LegalAction` per affordable X (brief: "the option menu
 * is the contract" — `legal.ts` enumerates every value up front so nothing needs a second
 * legality check). Rendered flat that's one button per value — up to however much mana the
 * player has, sometimes dozens. Collapsed here into a single numeric-input row per X-family
 * (same source, same mode); picking a number just looks up the matching pre-enumerated action,
 * so legality is still exactly what the engine offered, nothing computed client-side.
 */
const selectedSourceGrouped = computed(() => {
  const plain: LegalAction[] = [];
  const byKey = new Map<string, LegalAction[]>();
  for (const action of selectedSourceActions.value) {
    const x = actionData(action, 'x');
    if (typeof x !== 'number') {
      plain.push(action);
      continue;
    }
    const modeLabel = actionData(action, 'modeLabel');
    const key = `${action.type}|${typeof modeLabel === 'string' ? modeLabel : ''}`;
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [action]);
    else list.push(action);
  }
  const xGroups: XActionGroup[] = [];
  for (const [key, actions] of byKey) {
    // Only one affordable X value: no real choice to make, render it like any other button.
    if (actions.length < 2) {
      plain.push(...actions);
      continue;
    }
    const sorted = [...actions].sort(
      (a, b) => (actionData(a, 'x') as number) - (actionData(b, 'x') as number),
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (first === undefined || last === undefined) continue; // unreachable: length >= 2
    xGroups.push({
      key,
      actions: sorted,
      first,
      min: actionData(first, 'x') as number,
      max: actionData(last, 'x') as number,
    });
  }
  return { plain, xGroups };
});

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
  return group.actions.find((action) => actionData(action, 'x') === x);
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
const VERB_LABELS: Record<(typeof PLAYABLE_VERBS)[number], string> = {
  playLand: 'Play',
  castSpell: 'Cast',
  activateAbility: 'Activate',
};

/**
 * One entry per card or permanent the engine currently offers to play, cast, or activate, with
 * the verb for its best action. Drives the "Playable now" list and the tags on hand cards; both
 * select the source exactly as clicking the card does, so nothing here decides legality.
 */
const playableSources = computed(() => {
  const best = new Map<string, number>();
  for (const action of sourceActions.value) {
    if (action.interaction?.kind !== 'source') continue;
    const rank = (PLAYABLE_VERBS as readonly string[]).indexOf(action.type);
    if (rank < 0) continue;
    const id = action.interaction.sourceId;
    const current = best.get(id);
    if (current === undefined || rank < current) best.set(id, rank);
  }
  return [...best].map(([id, rank]) => ({
    id,
    verb: VERB_LABELS[PLAYABLE_VERBS[rank] ?? 'activateAbility'],
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
  if (submission !== null) store.submitPlayerAction(submission.actionId, submission.targets);
  else combatPlan.reopen(request.value);
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
  if (confirmingAbandon.value || pendingPass.value !== null) return;

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

function actionData(action: LegalAction, key: string): unknown {
  return action.data?.[key];
}

function actionCost(action: LegalAction): string[] {
  const mana = actionData(action, 'manaCost');
  const costs = actionData(action, 'abilityCosts');
  const labels: string[] = [];
  if (typeof mana === 'string') labels.push(mana);
  if (Array.isArray(costs)) {
    for (const cost of costs) {
      if (typeof cost !== 'object' || cost === null) continue;
      const value = cost as {
        kind?: unknown;
        amount?: unknown;
        counter?: unknown;
        count?: unknown;
      };
      if (value.kind === 'tap') labels.push('Tap this');
      if (value.kind === 'sacrificeSelf') labels.push('Sacrifice this');
      if (value.kind === 'payLife' && typeof value.amount === 'number')
        labels.push(`Pay ${value.amount} life`);
      if (
        value.kind === 'removeCounters' &&
        typeof value.counter === 'string' &&
        typeof value.count === 'number'
      ) {
        labels.push(
          `Remove ${value.count} ${value.counter} counter${value.count === 1 ? '' : 's'}`,
        );
      }
      if (
        value.kind === 'removeCountersFromAmong' &&
        typeof value.counter === 'string' &&
        typeof value.count === 'number'
      ) {
        labels.push(
          `Remove ${value.count} ${value.counter} counter${value.count === 1 ? '' : 's'} from a permanent you control`,
        );
      }
    }
  }
  return labels;
}

function pendingSummary(action: LegalAction): string {
  const source = actionData(action, 'sourceName');
  const label = typeof source === 'string' ? source : actionLabel(action);
  if (action.type === 'playLand') return `Play ${label}`;
  if (action.type === 'castSpell') return `Cast ${label}`;
  if (action.type === 'activateAbility') return `Activate ${label}`;
  return action.description;
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

/** The highest tax on any of your commanders — what recasting the next one adds. */
const commanderTax = computed(() =>
  Math.max(0, ...(human.value?.commanders ?? []).map((commander) => commander.taxGeneric)),
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
  const sources =
    selectedAction.value === null
      ? undefined
      : actionData(selectedAction.value, 'paymentSourceIds');
  return Array.isArray(sources) && sources.includes(id);
}

function paymentSourceNames(action: LegalAction): string[] {
  const names = actionData(action, 'paymentSourceNames');
  return Array.isArray(names) && names.every((name) => typeof name === 'string')
    ? (names as string[])
    : [];
}

/** "Forest ×2, Sol Ring" — repeated sources counted rather than listed again. */
function paymentSourceSummary(action: LegalAction): string {
  const counts = new Map<string, number>();
  for (const name of paymentSourceNames(action)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ');
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
    <header class="player-bar">
      <strong>Player mode · {{ state?.viewerSeat ?? store.humanSeat }}</strong>
      <span v-if="state" class="turn-badge" :class="{ 'your-turn': isYourTurn }">
        Turn {{ state.turnNumber }} · {{ isYourTurn ? 'Your turn' : state.activePlayer }}
      </span>
      <span v-if="state">{{ turnPositionLabel(state.phase, state.step) }}</span>
      <span v-if="state?.priorityPlayer"
        >Priority:
        {{ state.priorityPlayer === state.viewerSeat ? 'You' : state.priorityPlayer }}</span
      >
      <span :class="['connection', store.connection]">{{
        CONNECTION_LABELS[store.connection]
      }}</span>
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
      <button type="button" @click="confirmingAbandon = true">Abandon</button>
    </header>

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

    <main v-if="state" class="player-layout">
      <section ref="tableRef" class="table" @dragover="onBoardDragOver">
        <CombatOverlay :drag-source-id="draggedId" :pointer="dragPointer" />
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
            <header>
              <span class="id-badge">{{ opponent.seat }}</span>
              <strong>{{ opponent.label }}</strong>
              <span
                v-if="state.monarchSeat === opponent.seat"
                class="monarch-badge"
                title="This player is the monarch"
                >MONARCH</span
              >
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
            <div class="opp-meta">
              <div v-if="primaryCommander(opponent)" class="opp-cmdr-thumb">
                <CardImage
                  :scryfall-id="primaryCommander(opponent)!.scryfallId"
                  :name="primaryCommander(opponent)!.name"
                  size="small"
                />
              </div>
              <span>{{ opponent.handSize }} in hand · {{ opponent.librarySize }} in library</span>
            </div>
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
            <div class="zones-strip opponent-zones" @click.stop>
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
            <strong>You · {{ human.seat }} · {{ human.label }}</strong>
            <span
              class="life-badge"
              :class="{
                low: human.life <= 10,
                'flash-damage': humanLifeFlash === 'damage',
                'flash-heal': humanLifeFlash === 'heal',
              }"
              >{{ human.life }}</span
            >
            <span
              v-if="state.monarchSeat === human.seat"
              class="monarch-badge"
              title="You are the monarch"
              >MONARCH</span
            >
          </header>
          <GlobalCounters
            :energy="human.energy"
            :poison-counters="human.poisonCounters"
            :counters="human.counters"
          />
          <div class="resource-strip" aria-label="Your resources">
            <span class="resource" :class="{ ready: human.landsPlayedThisTurn === 0 }">{{
              human.landsPlayedThisTurn === 0 ? 'Land drop available' : 'Land played'
            }}</span>
            <span
              class="resource"
              title="Mana you can spend on anything right now: floating mana plus sources that need no mana to activate and whose mana has no spending restriction."
              >Mana ready <strong>{{ state.viewerMana.units }}</strong
              ><template v-if="state.viewerMana.colors.length > 0">
                · {{ state.viewerMana.colors.join(' ') }}</template
              ></span
            >
            <span v-if="resourceSummary(human.manaPool)" class="resource"
              >Floating <strong>{{ resourceSummary(human.manaPool) }}</strong></span
            >
            <span v-if="commanderTax > 0" class="resource"
              >Commander tax <strong>+{{ commanderTax }}</strong></span
            >
            <span class="resource"
              >Hand <strong>{{ human.hand?.length ?? human.handSize }}</strong></span
            >
            <span class="resource"
              >Library <strong>{{ human.librarySize }}</strong></span
            >
            <span class="resource"
              >Graveyard <strong>{{ human.graveyard.length }}</strong></span
            >
            <span v-if="humanExile.length > 0" class="resource"
              >Exile <strong>{{ humanExile.length }}</strong></span
            >
          </div>
          <div class="battle-row">
            <TransitionGroup
              tag="div"
              name="board-card"
              class="permanents"
              @dragover.prevent
              @drop="dropToBattlefield"
            >
              <div
                v-for="group in groupedPermanentsFor(human.seat)"
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
              </div>
            </TransitionGroup>
            <div
              v-if="human.commanders.some((commander) => commander.zone === 'command')"
              class="command-zone"
            >
              <span class="command-zone-label">Command</span>
              <button
                v-for="commander in human.commanders.filter(
                  (entry) => entry.zone === 'command' && entry.objectId !== null,
                )"
                :key="commander.cardId"
                type="button"
                class="commander-card"
                :style="{ width: commanderWidth + 'px' }"
                :class="{
                  focused: focusedSourceId === commander.objectId,
                  actionable:
                    commander.objectId !== null && actionableSourceIds.has(commander.objectId),
                  'chosen-target':
                    commander.objectId !== null && isChosenTarget(commander.objectId),
                }"
                @click="commander.objectId !== null && selectSource(commander.objectId)"
                @mouseenter="showCardPreview(commander, $event)"
                @mousemove="moveCardPreview"
                @mouseleave="hideCardPreview"
              >
                <CardImage
                  :scryfall-id="commander.scryfallId"
                  :name="commander.name"
                  size="small"
                />
                <span
                  >{{ commander.name
                  }}<small v-if="commander.taxGeneric > 0">
                    +{{ commander.taxGeneric }}</small
                  ></span
                >
              </button>
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
                :is-token="isTokenTypeLine(card.typeLine)"
                size="small"
              />
              <span v-if="playableVerbById.get(card.id)" class="play-tag">{{
                playableVerbById.get(card.id)
              }}</span>
              <span>{{ card.name }}</span>
            </button>
          </TransitionGroup>

          <div class="zones-strip">
            <ZoneStrip
              label="Graveyard"
              :cards="human.graveyard"
              :selectable-ids="zoneTargetIds"
              :actionable-ids="zoneSourceIds"
              @select="chooseTarget"
              @activate="selectSource"
            />
            <ZoneStrip
              label="Exile"
              :cards="humanExile"
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
                  actionData(selectedAction, 'sourceName') ??
                  selectedSourceName ??
                  selectedAction.description
                }}</strong>
                <span v-for="cost in actionCost(selectedAction)" :key="cost" class="cost-chip">{{
                  cost
                }}</span>
              </div>
              <div class="pending-stack" aria-live="polite">
                <span>Pending</span>
                <strong>{{ pendingSummary(selectedAction) }}</strong>
              </div>
              <p v-if="paymentSourceNames(selectedAction).length > 0" class="payment-preview">
                Auto-pay: {{ paymentSourceSummary(selectedAction) }}
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
                <strong>{{
                  combatPlan.kind === 'attackers' ? 'Declare attackers' : 'Declare blockers'
                }}</strong>
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
              <p v-else class="target-instruction">
                Click a creature, then its opponent or target, or choose an option below. Unassigned
                creatures
                {{ combatPlan.kind === 'attackers' ? 'stay home' : 'do not block' }}.
              </p>
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
                          ? seatLabel(optionId)
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
                      {{ combatPlan.kind === 'attackers' ? 'Stay home' : 'No block' }}
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
                    <span>{{ actionLabel(xGroupPreviewAction(group)) }}</span>
                    <small>{{ actionCost(xGroupPreviewAction(group)).join(' · ') }}</small>
                  </button>
                </div>
                <div
                  v-for="action in selectedSourceGrouped.plain"
                  :key="action.id"
                  class="source-action-row"
                >
                  <button type="button" @click="chooseAction(action)">
                    <span>{{ actionLabel(action) }}</span>
                    <small>{{ actionCost(action).join(' · ') }}</small>
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
        <section class="decision">
          <template v-if="request">
            <DecisionPanel
              v-if="fallbackRequest && immediateActions.length === 0"
              :request="fallbackRequest"
              @choose="chooseFallbackAction"
            />
            <template v-else>
              <h3>Your action</h3>
              <p class="prompt">{{ playerFacingPrompt(request.prompt) }}</p>
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
          <p v-else class="thinking" role="status" aria-live="polite">
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
          <template #actions><CopyGameReportButton /></template>
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
.player-bar {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.45rem 0.7rem;
  border: 1px solid var(--line);
  background: var(--surface);
  border-radius: 6px;
  font-size: 0.78rem;
}
.turn-badge {
  color: var(--muted);
  font-weight: 600;
}
.turn-badge.your-turn {
  color: var(--accent);
}
.pace {
  margin-left: auto;
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
  align-items: center;
  gap: 0.35rem;
  font-size: 0.72rem;
  flex-shrink: 0;
}
.opponent > header strong {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.opp-meta {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  color: var(--muted);
  font-size: 0.72rem;
  flex-shrink: 0;
}
.opp-cmdr-thumb {
  width: 20px;
  flex-shrink: 0;
  border-radius: 3px;
  overflow: hidden;
  border: 1px solid rgb(96 165 250 / 0.4);
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
.human-zone {
  gap: 0.4rem;
  border-color: rgb(96 165 250 / 0.45);
}
.human-zone.your-turn {
  border-color: var(--accent);
  box-shadow: 0 0 10px rgb(110 168 254 / 0.25);
}
.resource-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin: 0.15rem 0 0.25rem;
}
.resource {
  padding: 0.14rem 0.5rem;
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
.battle-row {
  flex: 1;
  min-height: 150px;
  display: flex;
  gap: 0.5rem;
  overflow: hidden;
}
.battle-row .permanents {
  flex: 1;
  min-width: 0;
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
.command-zone {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  border-left: 1px dashed var(--line);
  padding-left: 0.45rem;
}
.command-zone-label {
  font-size: 0.58rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  flex-shrink: 0;
}
/*
 * Natural card size, shrinking only when the battle row is shorter than the card. `flex: 1`
 * here (and on the image) stretched the commander to the full height of an empty battlefield —
 * a strip hundreds of pixels tall with the art cropped to a sliver (browser trial, Turn 4).
 */
.commander-card {
  flex: 0 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2rem;
  padding: 0.1rem;
  font-size: 0.6rem;
  text-align: center;
}
.commander-card :deep(.card-image) {
  width: 100%;
  flex: 0 1 auto;
  min-height: 0;
}
.commander-card small {
  color: var(--warn);
}
.interaction-tray {
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
.assignment-options button.muted {
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
.rail :deep(.log) {
  flex: 1;
  min-height: 7rem;
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
}
</style>
