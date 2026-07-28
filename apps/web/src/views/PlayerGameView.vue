<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { LegalAction, ObjectId, TargetChoice } from '@mtg/shared';
import ActionLog from '../components/ActionLog.vue';
import CardImage from '../components/CardImage.vue';
import PermanentChip from '../components/PermanentChip.vue';
import StackPanel from '../components/StackPanel.vue';
import { useCardPreviewStore } from '../stores/cardPreview';
import { useGameStore } from '../stores/game';

const store = useGameStore();
const cardPreview = useCardPreviewStore();
const router = useRouter();
const selectedActionId = ref<number | null>(null);
const focusedSourceId = ref<ObjectId | null>(null);
const chosenTargets = ref<Record<number, ObjectId>>({});
const draggedId = ref<ObjectId | null>(null);

const state = computed(() => store.playerState);
const pending = computed(() => store.playerAction);
const request = computed(() => pending.value?.request ?? null);
const human = computed(
  () => state.value?.seats.find((seat) => seat.seat === state.value?.viewerSeat) ?? null,
);
const opponents = computed(
  () => state.value?.seats.filter((seat) => seat.seat !== state.value?.viewerSeat) ?? [],
);
const selectedAction = computed(
  () =>
    request.value?.legalActions.find((action) => action.id === selectedActionId.value) ?? null,
);
const immediateActions = computed(
  () => request.value?.legalActions.filter((action) => isImmediate(action)) ?? [],
);
const hasOnlyImmediateActions = computed(
  () =>
    request.value !== null &&
    request.value.legalActions.length > 0 &&
    immediateActions.value.length === request.value.legalActions.length,
);

watch(
  () => request.value?.requestId,
  () => {
    selectedActionId.value = null;
    focusedSourceId.value = null;
    chosenTargets.value = {};
  },
);

function permanentsFor(seat: string) {
  return state.value?.battlefield.filter((permanent) => permanent.controller === seat) ?? [];
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
const fallbackActions = computed(() =>
  (request.value?.legalActions ?? []).filter(
    (action) => !isImmediate(action) && sourceId(action) === null,
  ),
);
const actionableSourceIds = computed(() => new Set(sourceActions.value.map(sourceId).filter(Boolean)));
const selectedSourceName = computed(() =>
  focusedSourceId.value === null ? null : nameById.value.get(focusedSourceId.value) ?? null,
);

function targetSlots(action: LegalAction | null) {
  if (action === null) return [];
  const interaction = action.interaction ?? { kind: 'choice' as const };
  if (
    interaction.kind === 'source' ||
    interaction.kind === 'choice'
  ) {
    return interaction.targetSlots ?? action.targets ?? [];
  }
  return action.targets ?? [];
}

const canConfirm = computed(() =>
  targetSlots(selectedAction.value).every((slot) => chosenTargets.value[slot.slot] !== undefined),
);
const selectedTargetCount = computed(() => Object.keys(chosenTargets.value).length);
const targetCount = computed(() => targetSlots(selectedAction.value).length);
const recentBotActions = computed(() =>
  store.log
    .filter((line) => line.actorSeat !== null && line.actorSeat !== state.value?.viewerSeat)
    .slice(-4),
);

function isImmediate(action: LegalAction): boolean {
  return action.interaction?.kind === 'immediate';
}

function isRoutineAction(action: LegalAction): boolean {
  return (action.type === 'pass' || action.type === 'playLand') && targetSlots(action).length === 0;
}

function chooseAction(action: LegalAction): void {
  selectedActionId.value = action.id;
  chosenTargets.value = {};
  // A normal land play or pass should feel immediate. The safer, all-confirm workflow remains
  // available as a persisted preference; anything with targets or a non-routine consequence
  // always opens the composed-action review.
  if (!store.confirmRoutineActions && isRoutineAction(action)) {
    store.submitPlayerAction(action.id);
  }
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

function selectSource(id: ObjectId): void {
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
  if (chooseTarget(seat)) return;
  const attack = (request.value?.legalActions ?? []).find(
    (action) =>
      action.interaction?.kind === 'attack' &&
      action.interaction.defenderId === seat &&
      (focusedSourceId.value === null ||
        action.interaction.attackerId === focusedSourceId.value),
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

function dragStart(id: ObjectId): void {
  draggedId.value = id;
  if (selectedAction.value === null) {
    focusedSourceId.value = id;
    chosenTargets.value = {};
  }
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
      const value = cost as { kind?: unknown; amount?: unknown; counter?: unknown; count?: unknown };
      if (value.kind === 'tap') labels.push('Tap this');
      if (value.kind === 'sacrificeSelf') labels.push('Sacrifice this');
      if (value.kind === 'payLife' && typeof value.amount === 'number') labels.push(`Pay ${value.amount} life`);
      if (value.kind === 'removeCounters' && typeof value.counter === 'string' && typeof value.count === 'number') {
        labels.push(`Remove ${value.count} ${value.counter} counter${value.count === 1 ? '' : 's'}`);
      }
    }
  }
  return labels;
}

function actionLabel(action: LegalAction): string {
  const mode = actionData(action, 'modeLabel');
  const variant = actionData(action, 'castVariant');
  const ability = actionData(action, 'abilityDescription');
  if (typeof mode === 'string') return mode;
  if (typeof variant === 'string') return variant[0]?.toUpperCase() + variant.slice(1);
  if (typeof ability === 'string') return ability;
  if (action.type === 'playLand') return 'Play land';
  if (action.type === 'castSpell') return 'Cast';
  return action.type;
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

function resourceSummary(pool: Record<string, number>): string {
  const entries = Object.entries(pool).filter(([, amount]) => amount > 0);
  return entries.length === 0 ? '' : entries.map(([color, amount]) => `${amount}${color}`).join(' ');
}

function isLegalTarget(target: ObjectId | string): boolean {
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
  return Object.values(chosenTargets.value).includes(target as ObjectId);
}

function isPaymentSource(id: ObjectId): boolean {
  const sources = selectedAction.value === null ? undefined : actionData(selectedAction.value, 'paymentSourceIds');
  return Array.isArray(sources) && sources.includes(id);
}

function paymentSourceNames(action: LegalAction): string[] {
  const names = actionData(action, 'paymentSourceNames');
  return Array.isArray(names) && names.every((name) => typeof name === 'string')
    ? names as string[]
    : [];
}

function selectedTargetLabel(slot: string, choice: ObjectId): string {
  return `Target ${Number(slot) + 1}: ${nameById.value.get(choice) ?? choice}`;
}

function dropToBattlefield(): void {
  const source = draggedId.value;
  draggedId.value = null;
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
  if (source === null) return;
  const action = (request.value?.legalActions ?? []).find((candidate) => {
    const interaction = candidate.interaction ?? { kind: 'choice' as const };
    if (
      interaction.kind === 'attack' &&
      interaction.attackerId === source &&
      interaction.defenderId === target
    ) return true;
    if (
      interaction.kind === 'block' &&
      interaction.blockerId === source &&
      interaction.attackerId === target
    ) return true;
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

function abandon(): void {
  store.abandonGame();
  void router.push('/');
}
</script>

<template>
  <div class="player-game">
    <header class="player-bar">
      <strong>Player mode · {{ state?.viewerSeat ?? store.humanSeat }}</strong>
      <span v-if="state">{{ state.phase }}<template v-if="state.step"> · {{ state.step }}</template></span>
      <span v-if="state?.priorityPlayer">Priority: {{ state.priorityPlayer }}</span>
      <span :class="['connection', store.connection]">{{ store.connection }}</span>
      <div class="pace">
        Bot turns
        <button type="button" :class="{ active: store.paceMs === 0 }" @click="store.setPace(0)">Next choice</button>
        <button type="button" :class="{ active: store.paceMs === 400 }" @click="store.setPace(400)">Watch</button>
        <button type="button" :class="{ active: store.paceMs === 1200 }" @click="store.setPace(1200)">Slow</button>
      </div>
      <label class="routine-confirm">
        <input :checked="store.confirmRoutineActions" type="checkbox" @change="store.setConfirmRoutineActions(($event.target as HTMLInputElement).checked)" />
        Confirm passes & lands
      </label>
      <button type="button" @click="abandon">Abandon</button>
    </header>

    <div v-if="store.connection !== 'open'" class="paused">
      Reconnecting… the engine will not begin another bot decision while you are away.
    </div>

    <main v-if="state" class="player-layout">
      <section class="table">
        <div class="opponents">
          <article
            v-for="opponent in opponents"
            :key="opponent.seat"
            class="opponent"
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
              <strong>{{ opponent.seat }} · {{ opponent.label }}</strong>
              <span>{{ opponent.life }} life</span>
            </header>
            <p>{{ opponent.handSize }} cards · {{ opponent.librarySize }} library</p>
            <div class="permanents">
              <div
                v-for="permanent in permanentsFor(opponent.seat)"
                :key="permanent.id"
                class="object"
                :class="{
                  targetable: isLegalTarget(permanent.id),
                  'chosen-target': isChosenTarget(permanent.id),
                  actionable: actionableSourceIds.has(permanent.id),
                }"
                draggable="true"
                @dragstart="dragStart(permanent.id)"
                @dragover.prevent
                @drop.stop="dropOn(permanent.id)"
                @click.stop="selectSource(permanent.id)"
              >
                <PermanentChip :permanent="permanent" :count="1" />
              </div>
            </div>
          </article>
        </div>

        <section v-if="human" class="human-zone">
          <header>
            <strong>You · {{ human.seat }} · {{ human.label }}</strong>
            <span>{{ human.life }} life · {{ human.librarySize }} library</span>
          </header>
          <div class="resource-strip">
            {{ human.landsPlayedThisTurn === 0 ? 'Land available' : 'Land played' }}<template v-if="resourceSummary(human.manaPool)"> ? Pool {{ resourceSummary(human.manaPool) }}</template>
          </div>
          <div class="permanents" @dragover.prevent @drop="dropToBattlefield">
            <div
              v-for="permanent in permanentsFor(human.seat)"
              :key="permanent.id"
              class="object"
                :class="{
                  focused: focusedSourceId === permanent.id,
                  targetable: isLegalTarget(permanent.id),
                  'chosen-target': isChosenTarget(permanent.id),
                  'payment-source': isPaymentSource(permanent.id),
                  actionable: actionableSourceIds.has(permanent.id),
              }"
              draggable="true"
              @dragstart="dragStart(permanent.id)"
              @dragover.prevent
              @drop.stop="dropOn(permanent.id)"
              @click="selectSource(permanent.id)"
            >
              <PermanentChip :permanent="permanent" :count="1" />
            </div>
          </div>
          <div class="hand">
            <button
              v-for="card in human.hand ?? []"
              :key="card.id"
              type="button"
              class="hand-card"
              :class="{
                focused: focusedSourceId === card.id,
                actionable: actionableSourceIds.has(card.id),
                'chosen-target': isChosenTarget(card.id),
              }"
              draggable="true"
              @dragstart="dragStart(card.id)"
              @click="selectSource(card.id)"
              @mouseenter="showCardPreview(card, $event)"
              @mousemove="moveCardPreview"
              @mouseleave="hideCardPreview"
            >
              <CardImage :scryfall-id="card.scryfallId" :name="card.name" size="small" />
              <span>{{ card.name }}</span>
            </button>
          </div>
          <div v-if="human.commanders.some((commander) => commander.zone === 'command')" class="command-zone">
            <span>Command zone</span>
            <button
              v-for="commander in human.commanders.filter((entry) => entry.zone === 'command' && entry.objectId !== null)"
              :key="commander.cardId"
              type="button"
              class="commander-card"
              :class="{
                focused: focusedSourceId === commander.objectId,
                actionable: commander.objectId !== null && actionableSourceIds.has(commander.objectId),
                'chosen-target': commander.objectId !== null && isChosenTarget(commander.objectId),
              }"
              @click="commander.objectId !== null && selectSource(commander.objectId)"
              @mouseenter="showCardPreview(commander, $event)"
              @mousemove="moveCardPreview"
              @mouseleave="hideCardPreview"
            >
              <CardImage :scryfall-id="commander.scryfallId" :name="commander.name" size="small" />
              <span>{{ commander.name }}<small v-if="commander.taxGeneric > 0"> +{{ commander.taxGeneric }}</small></span>
            </button>
          </div>

          <section v-if="request" class="interaction-tray" :class="{ targeting: selectedAction !== null }">
            <template v-if="selectedAction">
              <div class="tray-heading">
                <strong>{{ actionData(selectedAction, 'sourceName') ?? selectedSourceName ?? selectedAction.description }}</strong>
                <span v-for="cost in actionCost(selectedAction)" :key="cost" class="cost-chip">{{ cost }}</span>
              </div>
              <div class="pending-stack" aria-live="polite">
                <span>Pending</span>
                <strong>{{ pendingSummary(selectedAction) }}</strong>
              </div>
              <p v-if="paymentSourceNames(selectedAction).length > 0" class="payment-preview">
                Auto-pay: {{ paymentSourceNames(selectedAction).join(' ? ') }}
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
                <button type="button" class="primary" :disabled="!canConfirm" @click="confirm">
                  {{ selectedAction.type === 'playLand' ? 'Play land' : 'Confirm' }}
                </button>
              </div>
            </template>
            <template v-else-if="focusedSourceId !== null && selectedSourceActions.length > 0">
              <div class="tray-heading"><strong>{{ selectedSourceName ?? 'Selected card' }}</strong><span>Choose an action</span></div>
              <div class="source-actions">
                <div v-for="action in selectedSourceActions" :key="action.id" class="source-action-row">
                  <button type="button" @click="chooseAction(action)">
                    <span>{{ actionLabel(action) }}</span>
                    <small>{{ actionCost(action).join(' · ') }}</small>
                  </button>
                  <button
                    v-if="action.type === 'activateAbility'"
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
            <p v-else class="tray-hint">Click a highlighted card or permanent to play, cast, or activate it.</p>
          </section>
        </section>
      </section>

      <aside class="rail">
        <section class="decision">
          <template v-if="request">
            <h3>Your action</h3>
            <p>{{ request.prompt }}</p>
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
            <p v-if="hasOnlyImmediateActions && store.ignoredAbilities.length > 0" class="yield-explanation">
              All other optional actions are currently yielded. Pass priority to continue, or resume an
              ability below to make it available again.
            </p>
            <details v-if="fallbackActions.length > 0" class="fallback-actions">
              <summary>More choices ({{ fallbackActions.length }})</summary>
              <button
                v-for="action in fallbackActions"
                :key="action.id"
                type="button"
                @click="chooseAction(action)"
              >
                {{ action.description }}
              </button>
            </details>
          </template>
          <p v-else class="thinking">Bots are deciding…</p>
          <div v-if="recentBotActions.length > 0" class="bot-summary">
            <strong>Recent opponent actions</strong>
            <p v-for="line in recentBotActions" :key="line.sequence">{{ line.text }}</p>
          </div>
          <div v-if="store.ignoredAbilities.length > 0" class="ignored-abilities">
            <strong>Yielded abilities</strong>
            <div v-for="ability in store.ignoredAbilities" :key="ability.key" class="action-row">
              <span>{{ ability.label }}</span>
              <button type="button" @click="store.resumePlayerAbility(ability.key)">Resume</button>
            </div>
          </div>
        </section>

        <StackPanel :state="state" />
        <ActionLog :lines="store.log" :follow="true" />
      </aside>
    </main>
    <p v-else class="waiting">Waiting for the player-safe board…</p>
  </div>
</template>

<style scoped>
.player-game { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: .6rem; padding: .6rem; }
.player-bar { display: flex; align-items: center; gap: .7rem; padding: .45rem .7rem; border: 1px solid var(--line); background: var(--surface); border-radius: 6px; font-size: .78rem; }
.pace { margin-left: auto; display: flex; align-items: center; gap: .25rem; color: var(--muted); }
button.active, button.selected, .focused { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.targetable { border-color: var(--ok) !important; box-shadow: 0 0 0 1px var(--ok); }
.chosen-target { border-color: var(--accent) !important; box-shadow: 0 0 0 2px var(--accent), inset 0 0 0 2px rgb(96 165 250 / .35); }
.payment-source { border-color:var(--warn) !important; box-shadow:0 0 0 2px var(--warn), inset 0 0 0 2px rgb(250 204 21 / .18); }
.opponent.chosen-target { background: rgb(96 165 250 / .1); }
.connection.open { color: var(--ok); }.connection.closed { color: var(--danger); }
.paused { border: 1px solid var(--warn); color: var(--warn); padding: .5rem; border-radius: 4px; }
.player-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0,1fr) 22rem; gap: .6rem; }
.table { min-height: 0; display: grid; grid-template-rows: minmax(0,1fr) minmax(15rem, .85fr); gap: .6rem; }
.opponents { min-height: 0; display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: .5rem; }
.opponent, .human-zone { min-width: 0; min-height: 0; overflow: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); padding: .5rem; }
.opponent.active { border-color: var(--accent); }
.opponent > header, .human-zone > header { display:flex; justify-content:space-between; gap:.4rem; font-size:.75rem; }
.opponent p { margin:.25rem 0; color:var(--muted); font-size:.7rem; }
.permanents { display:flex; flex-wrap:wrap; align-content:flex-start; gap:.3rem; }
.object { border:1px solid transparent; border-radius:4px; cursor:pointer; }
.actionable { border-color:rgb(96 165 250 / .75) !important; box-shadow:0 0 0 1px rgb(96 165 250 / .28); }
.actionable:hover { transform:translateY(-2px); }
.human-zone { display:flex; flex-direction:column; gap:.45rem; border-color:rgb(96 165 250 / .45); }
.resource-strip { display:inline-flex; align-self:flex-start; padding:.16rem .38rem; border:1px solid var(--line); border-radius:999px; color:var(--muted); font-size:.68rem; }
.human-zone .permanents { flex:1; overflow:auto; }
.hand { display:flex; gap:.35rem; overflow-x:auto; padding-top:.4rem; border-top:1px solid var(--line); }
.hand-card { width:78px; flex:0 0 78px; padding:.2rem; display:flex; flex-direction:column; gap:.2rem; font-size:.65rem; overflow:hidden; }
.command-zone { display:flex; align-items:center; gap:.35rem; padding-top:.3rem; border-top:1px solid var(--line); color:var(--muted); font-size:.68rem; }
.commander-card { display:flex; align-items:center; gap:.25rem; max-width:11rem; padding:.15rem; font-size:.65rem; text-align:left; }
.commander-card :deep(.card-image) { width:26px; }
.commander-card small { color:var(--warn); }
.interaction-tray { margin-top:.1rem; min-height:4.2rem; border:1px solid var(--line); background:var(--surface-2); border-radius:5px; padding:.45rem .55rem; }
.interaction-tray.targeting { border-color:var(--ok); box-shadow:0 0 0 1px rgb(74 222 128 / .25); }
.tray-heading { display:flex; align-items:center; flex-wrap:wrap; gap:.35rem; font-size:.72rem; }
.tray-heading > span:not(.cost-chip) { color:var(--muted); }
.tray-hint,.target-instruction { margin:.2rem 0; color:var(--muted); font-size:.72rem; }
.target-instruction { color:var(--ok); }
.pending-stack { display:flex; align-items:center; gap:.35rem; margin-top:.35rem; padding:.25rem .4rem; border-left:3px solid var(--accent); background:rgb(96 165 250 / .1); font-size:.72rem; }
.pending-stack > span { color:var(--muted); text-transform:uppercase; font-size:.61rem; letter-spacing:.04em; }
.payment-preview { margin:.3rem 0; color:var(--warn); font-size:.7rem; }
.cost-chip,.target-chip { display:inline-flex; border:1px solid var(--line); border-radius:999px; padding:.08rem .35rem; font-size:.66rem; color:var(--muted); }
.chosen-targets { display:flex; gap:.25rem; flex-wrap:wrap; margin-top:.35rem; }
.target-chip { color:var(--ok); border-color:rgb(74 222 128 / .55); }
.source-actions { display:flex; flex-wrap:wrap; gap:.3rem; margin-top:.4rem; }
.source-action-row { display:flex; gap:.25rem; }
.source-action-row > button:first-child { display:flex; align-items:center; gap:.35rem; text-align:left; }
.source-action-row small { color:var(--muted); }
.tray-actions { display:flex; justify-content:flex-end; gap:.35rem; margin-top:.45rem; }
.rail { min-height:0; display:flex; flex-direction:column; gap:.5rem; }
.decision { max-height:46%; overflow:auto; border:2px solid var(--accent); background:var(--surface); border-radius:6px; padding:.55rem; }
.decision h3,.decision p { margin:.15rem 0 .45rem; }
.quick-actions { display:flex; gap:.3rem; margin:.45rem 0; }
.yield-explanation { color:var(--muted); font-size:.72rem; line-height:1.35; }
.action-row { display:flex; align-items:center; gap:.3rem; }
.action-row > :first-child { min-width:0; flex:1; }
.yield-ability { flex:0 0 auto; color:var(--warn); font-size:.67rem !important; }
.ignored-abilities { margin-top:.7rem; padding-top:.55rem; border-top:1px solid var(--line); display:flex; flex-direction:column; gap:.35rem; font-size:.7rem; }
.ignored-abilities span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fallback-actions { margin-top:.6rem; font-size:.7rem; color:var(--muted); }
.fallback-actions summary { cursor:pointer; }
.fallback-actions button { display:block; width:100%; margin-top:.3rem; text-align:left; font-size:.7rem; }
button.primary { background:var(--accent); color:#08111f; font-weight:700; }
.thinking,.waiting { color:var(--muted); font-style:italic; }
.routine-confirm { display:flex; align-items:center; gap:.25rem; color:var(--muted); white-space:nowrap; }
.bot-summary { margin-top:.65rem; padding-top:.55rem; border-top:1px solid var(--line); font-size:.72rem; }.bot-summary p { margin:.2rem 0 0; color:var(--muted); }
.rail :deep(.log) { flex:1; min-height:0; }
@media (max-width: 900px) {
  .player-layout { grid-template-columns:1fr; overflow:auto; }
  .opponents { grid-template-columns:1fr; }
  .table { grid-template-rows:auto auto; }
  .rail { min-height:30rem; }
}
</style>
