<script setup lang="ts">
/**
 * The combat lane (proposal "Combat, in one lane"): the band between the opponents and you that
 * shows a combat as one column per attacker, grouped by what it attacks, with its blockers under
 * it and a line saying what will happen. It replaces the combat strip, its legend, and the
 * standing curves across the board; the board keeps the real tiles, which still wear a short tag.
 *
 * While you declare, the lane is also where you place creatures: click one of yours on the board,
 * then a group (attackers) or an attacker's slot (blockers). The confirm button lives here too.
 * The decision panel keeps the per-creature list for the keyboard and for exact choices.
 *
 * The small cards here are pictures (aria-hidden, names drawn from a data attribute); readers get
 * the same combat as sentences from `lines`.
 */
import { computed } from 'vue';
import type { LaneCard, LaneGroup, LaneModel, LanePair } from '../lib/combatLane';
import { scryfallImageUrl } from '../lib/card';

const props = defineProps<{
  model: LaneModel | null;
  /** The combat in sentences, for screen readers (`combatSummary.lines`). */
  lines: readonly string[];
  /** The one-line recap once combat is over, or null. */
  recap: string | null;
  /** You are composing this declaration. */
  composing: boolean;
  /** Targets the creature you picked up can go to; empty when none is picked up. */
  aimTargets: ReadonlySet<string>;
  /** The engine refused the last declaration: why. */
  rejection: string | null;
  /** "Attack with all" applies (an ordinary attack declaration). */
  canAttackAll: boolean;
  /** What to do while you declare; the lane's own hint when null. */
  hint: string | null;
  /** Who the game waits on and what they do, when it is not you. */
  waiting: string | null;
}>();

const emit = defineEmits<{
  target: [targetId: string];
  sendHome: [subjectId: string];
  confirm: [];
  attackAll: [];
  reset: [];
  hide: [];
}>();

const chosen = computed(() => {
  const model = props.model;
  if (model === null) return 0;
  let n = 0;
  for (const group of model.groups) {
    for (const pair of group.pairs) {
      if (model.kind === 'attackers') n += pair.attacker.pending ? 1 : 0;
      else n += pair.blockers.filter((b) => b.pending).length;
    }
  }
  return n;
});

function art(card: LaneCard): string | null {
  if (card.scryfallId === null || card.scryfallId.length < 2) return null;
  return scryfallImageUrl(card.scryfallId, 'art_crop', card.imageFace);
}

/** Art that fails to load leaves the plain paper panel, as the board's tiles do. */
function hideImage(event: Event): void {
  (event.target as HTMLImageElement).style.display = 'none';
}

function damageShare(card: LaneCard): number {
  if (card.damageMarked <= 0) return 0;
  if (card.toughness === null || card.toughness <= 0) return 0.5;
  return Math.min(1, card.damageMarked / card.toughness);
}

function groupHot(group: LaneGroup): boolean {
  return (
    props.composing && props.model?.kind === 'attackers' && props.aimTargets.has(group.targetId)
  );
}

function slotHot(pair: LanePair): boolean {
  return (
    props.composing && props.model?.kind === 'blockers' && props.aimTargets.has(pair.attacker.id)
  );
}

function lifeLine(group: LaneGroup): string | null {
  if (group.lifeAfter === null) return null;
  const note = group.ifUnblocked ? ' if unblocked' : group.atLowest ? ' at lowest' : '';
  return `→ ${group.lifeAfter}${note}`;
}

function clickGroup(group: LaneGroup): void {
  if (props.composing && props.model?.kind === 'attackers') emit('target', group.targetId);
}

function clickSlot(pair: LanePair): void {
  if (props.composing && props.model?.kind === 'blockers' && pair.blockable)
    emit('target', pair.attacker.id);
}

function clickCard(card: LaneCard): void {
  if (props.composing && card.pending) emit('sendHome', card.id);
}

const confirmWord = computed(() => (props.model?.kind === 'attackers' ? 'attacks' : 'blocks'));
</script>

<template>
  <section
    v-if="model !== null"
    class="combat-lane"
    :class="[`kind-${model.kind}`, { composing }]"
    aria-label="Combat"
  >
    <div class="lane-head">
      <h2 class="lane-title">Combat · {{ model.title }}</h2>
      <p v-if="composing && rejection" class="lane-hint rejected">
        The engine refused that declaration: {{ rejection }}
      </p>
      <p v-else-if="composing && (hint ?? model.hint)" class="lane-hint">
        {{ hint ?? model.hint }}
      </p>
      <ol class="lane-beats" aria-hidden="true">
        <li
          v-for="(beat, i) in model.beats"
          :key="beat"
          :class="{ done: i < model.beat, now: i === model.beat }"
        >
          {{ beat }}
        </li>
      </ol>
      <ul class="dt-sr" aria-live="polite">
        <li v-for="(line, i) in lines" :key="i">{{ line }}</li>
      </ul>
    </div>

    <div class="lane-groups">
      <div
        v-for="group in model.groups"
        :key="group.targetId"
        class="lane-group"
        :class="{ theirs: !group.yours, hot: groupHot(group) }"
      >
        <div
          class="group-head"
          :class="{ clickable: composing && model.kind === 'attackers' }"
          @click="clickGroup(group)"
        >
          <span class="group-label">{{ group.label }}</span>
          <span v-if="group.life !== null" class="group-life">{{ group.life }}</span>
          <span v-if="lifeLine(group)" class="group-after">{{ lifeLine(group) }}</span>
        </div>
        <div class="group-pairs">
          <div v-for="pair in group.pairs" :key="pair.attacker.id" class="lane-pair">
            <div class="pair-cards">
              <div
                class="lane-card"
                :class="{
                  pending: pair.attacker.pending,
                  tapped: pair.attacker.tapped,
                  gone: pair.attacker.gone,
                  removable: composing && pair.attacker.pending,
                }"
                :data-name="pair.attacker.name"
                :title="
                  composing && pair.attacker.pending
                    ? `Send ${pair.attacker.name} home`
                    : pair.attacker.name
                "
                aria-hidden="true"
                @click="clickCard(pair.attacker)"
              >
                <span class="lane-art">
                  <img
                    v-if="art(pair.attacker)"
                    :src="art(pair.attacker)!"
                    alt=""
                    loading="lazy"
                    @error="hideImage"
                  />
                  <span
                    v-if="damageShare(pair.attacker) > 0"
                    class="lane-wash"
                    :style="{ height: `${damageShare(pair.attacker) * 100}%` }"
                  />
                </span>
                <span v-if="pair.attacker.power !== null" class="lane-pt"
                  >{{ pair.attacker.power }}/{{ pair.attacker.toughness }}</span
                >
              </div>
              <template v-if="model.kind !== 'attackers'">
                <span
                  class="pair-link"
                  :class="{
                    pending: pair.blockers.some((b) => b.pending),
                    open: pair.blockers.length === 0,
                  }"
                  aria-hidden="true"
                />
                <div class="pair-blockers">
                  <div
                    v-for="blocker in pair.blockers"
                    :key="blocker.id"
                    class="lane-card"
                    :class="{
                      pending: blocker.pending,
                      tapped: blocker.tapped,
                      gone: blocker.gone,
                      removable: composing && blocker.pending,
                    }"
                    :data-name="blocker.name"
                    :title="
                      composing && blocker.pending
                        ? `Take ${blocker.name} off this block`
                        : blocker.name
                    "
                    aria-hidden="true"
                    @click="clickCard(blocker)"
                  >
                    <span class="lane-art">
                      <img
                        v-if="art(blocker)"
                        :src="art(blocker)!"
                        alt=""
                        loading="lazy"
                        @error="hideImage"
                      />
                      <span
                        v-if="damageShare(blocker) > 0"
                        class="lane-wash"
                        :style="{ height: `${damageShare(blocker) * 100}%` }"
                      />
                    </span>
                    <span v-if="blocker.power !== null" class="lane-pt"
                      >{{ blocker.power }}/{{ blocker.toughness }}</span
                    >
                  </div>
                  <button
                    v-if="composing && model.kind === 'blockers' && pair.blockable"
                    type="button"
                    class="lane-slot"
                    :class="{ hot: slotHot(pair), more: pair.blockers.length > 0 }"
                    aria-label="Put the chosen blocker here"
                    :title="`Block ${pair.attacker.name}`"
                    @click="clickSlot(pair)"
                  >
                    {{ pair.blockers.length > 0 ? '+' : 'Block' }}
                  </button>
                  <span
                    v-else-if="
                      pair.blockers.length === 0 && model.kind === 'declared' && model.beat === 0
                    "
                    class="lane-slot quiet"
                    aria-hidden="true"
                    >Blocks next</span
                  >
                  <span
                    v-else-if="
                      pair.blockers.length === 0 && !group.yours && model.kind === 'blockers'
                    "
                    class="lane-slot quiet"
                    aria-hidden="true"
                    >Their blocks</span
                  >
                </div>
              </template>
            </div>
            <span
              v-if="pair.outcome"
              class="pair-outcome"
              :class="pair.outcome.tone"
              :data-text="pair.outcome.text"
              aria-hidden="true"
            />
          </div>
          <button
            v-if="composing && model.kind === 'attackers'"
            type="button"
            class="lane-slot attack-slot"
            :class="{ hot: groupHot(group), more: group.pairs.length > 0 }"
            :aria-label="`Send the chosen creature at ${group.label}`"
            @click="clickGroup(group)"
          >
            {{ group.pairs.length > 0 ? '+' : `Attack ${group.label}` }}
          </button>
        </div>
      </div>
    </div>

    <div class="lane-side">
      <template v-if="composing">
        <button type="button" class="dt-btn-primary lane-confirm" @click="emit('confirm')">
          Confirm {{ confirmWord
          }}<span class="lane-count" aria-hidden="true"> · {{ chosen }}</span>
        </button>
        <span class="lane-links">
          <button v-if="canAttackAll" type="button" class="lane-link" @click="emit('attackAll')">
            Attack with all
          </button>
          <button type="button" class="lane-link" @click="emit('reset')">Reset declaration</button>
        </span>
      </template>
      <p v-else-if="waiting" class="lane-waiting">{{ waiting }}</p>
      <button
        type="button"
        class="lane-hide"
        aria-label="Hide the combat lane"
        title="Hide"
        @click="emit('hide')"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M1 1 L11 11 M11 1 L1 11" />
        </svg>
      </button>
    </div>
  </section>
  <section v-else-if="recap !== null" class="combat-recap" aria-label="Combat recap">
    <span class="lane-title">Combat</span>
    <span class="recap-text">{{ recap }}</span>
    <button
      type="button"
      class="lane-hide"
      aria-label="Hide the combat recap"
      title="Hide"
      @click="emit('hide')"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M1 1 L11 11 M11 1 L1 11" />
      </svg>
    </button>
  </section>
</template>

<style scoped>
.combat-lane {
  --card-w: 3.1rem;
  position: relative;
  z-index: 6;
  display: grid;
  grid-template-columns: minmax(12rem, 17rem) minmax(0, 1fr) auto;
  border-bottom: 1px solid var(--ink);
  background: var(--paper-2);
  color: var(--ink);
}
.lane-head {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.7rem 1rem;
  border-right: 1px solid var(--rule);
}
.lane-title {
  margin: 0;
  font-family: var(--font-ui);
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.lane-hint {
  margin: 0;
  font-family: var(--font-body);
  font-size: 0.7rem;
  line-height: 1.35;
  color: var(--ink-soft);
}
.lane-hint.rejected {
  color: var(--danger);
}
.lane-beats {
  display: flex;
  margin: auto 0 0;
  padding: 0;
  list-style: none;
  font-family: var(--font-ui);
  font-size: 0.58rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.lane-beats li {
  position: relative;
  flex: 1;
  padding-top: 0.4rem;
  border-top: 1px solid var(--rule);
  white-space: nowrap;
}
.lane-beats li.done {
  border-top-color: var(--ink);
  color: var(--ink);
}
.lane-beats li.now {
  border-top: 2px solid var(--ink);
  padding-top: calc(0.4rem - 1px);
  color: var(--ink);
}
.lane-beats li.now::before {
  content: '';
  position: absolute;
  left: 0;
  top: -5px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warm);
}
.lane-groups {
  display: flex;
  gap: 0;
  padding: 0.6rem 0.9rem 0.7rem;
  overflow-x: auto;
}
.lane-group {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0 0.9rem;
  border-left: 1px solid var(--rule);
  transition: opacity 150ms var(--ease);
}
.lane-group:first-child {
  padding-left: 0;
  border-left: 0;
}
.lane-group.theirs {
  opacity: 0.55;
}
.group-head {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: nowrap;
}

.group-head.clickable {
  cursor: pointer;
}
.group-label {
  font-family: var(--font-ui);
  font-size: 0.66rem;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.group-life {
  font-family: var(--font-display);
  font-size: 1.25rem;
  line-height: 1;
}
.group-after {
  font-family: var(--font-body);
  font-size: 0.7rem;
  color: var(--danger);
}
.group-pairs {
  display: flex;
  gap: 0.8rem;
}
.lane-pair {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
}
.pair-cards {
  display: flex;
  align-items: center;
}
.pair-blockers {
  display: flex;
  gap: 0.3rem;
}
/* Attacker, then a short rule ending in a bar, then whoever blocks it. */
.pair-link {
  width: 0.8rem;
  height: 1px;
  position: relative;
  background: var(--ink);
}
.pair-link::after {
  content: '';
  position: absolute;
  right: 0;
  top: -0.45rem;
  width: 2px;
  height: calc(0.9rem + 1px);
  background: var(--ink);
}
.pair-link.pending,
.pair-link.open {
  background: none;
  border-top: 1px dashed var(--ink);
}
.pair-link.open::after {
  background: var(--rule);
}
.lane-card {
  position: relative;
  width: var(--card-w);
  aspect-ratio: 5 / 7;
  display: flex;
  flex-direction: column;
  padding: 0.22rem;
  gap: 0.15rem;
  border: 1px solid var(--ink);
  background: var(--paper);
}
.lane-card::before {
  content: attr(data-name);
  font-family: var(--font-ui);
  font-size: 0.5rem;
  line-height: 1.1;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lane-card.pending {
  border-style: dashed;
  box-shadow:
    0 0 0 2px var(--paper-2),
    0 0 0 3px var(--warm);
}
.lane-card.removable {
  cursor: pointer;
}
.lane-card.gone {
  opacity: 0.5;
}
.lane-card.gone::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to top right,
    transparent calc(50% - 0.75px),
    var(--danger) calc(50% - 0.75px),
    var(--danger) calc(50% + 0.75px),
    transparent calc(50% + 0.75px)
  );
}
.lane-art {
  position: relative;
  flex: 1;
  overflow: hidden;
  background: var(--paper-2);
}
.lane-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.lane-card.tapped .lane-art::after {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    135deg,
    transparent 0 4px,
    color-mix(in srgb, var(--paper) 70%, transparent) 4px 5px
  );
}
.lane-wash {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: color-mix(in srgb, var(--danger) 40%, transparent);
  border-top: 1px solid var(--danger);
}
.lane-pt {
  align-self: flex-end;
  padding: 0 0.15rem;
  border: 1px solid var(--ink);
  font-family: var(--font-ui);
  font-size: 0.55rem;
  line-height: 1.3;
}
.lane-slot {
  width: var(--card-w);
  aspect-ratio: 5 / 7;
  display: grid;
  place-items: center;
  padding: 0.2rem;
  border: 1px dashed var(--muted);
  background: transparent;
  color: var(--muted);
  font-family: var(--font-body);
  font-size: 0.62rem;
  line-height: 1.25;
  text-align: center;
}
button.lane-slot {
  cursor: pointer;
}
.lane-slot.more {
  width: calc(var(--card-w) * 0.45);
}
.lane-slot.quiet {
  border-color: var(--rule);
}
.lane-slot.attack-slot {
  width: calc(var(--card-w) * 1.4);
}
.lane-slot.attack-slot.more {
  width: calc(var(--card-w) * 0.45);
}
.lane-slot.hot,
.lane-group.hot .group-head {
  color: var(--ink);
}
.lane-slot.hot {
  border: 1.5px solid var(--warm);
  background: color-mix(in srgb, var(--warm) 14%, transparent);
}
.lane-slot:hover,
.lane-slot:focus-visible {
  border-color: var(--ink);
  color: var(--ink);
}
.pair-outcome {
  max-width: calc(var(--card-w) * 2 + 1.2rem);
  font-family: var(--font-body);
  font-size: 0.66rem;
  line-height: 1.3;
  text-align: center;
  color: var(--ink-soft);
}
.pair-outcome::before {
  /* Drawn from the attribute: a picture of the prediction, kept out of the page's text. */
  content: attr(data-text);
}
.pair-outcome.danger {
  color: var(--danger);
}
.lane-side {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: stretch;
  gap: 0.5rem;
  min-width: 11rem;
  padding: 0.7rem 2.4rem 0.7rem 1rem;
  border-left: 1px solid var(--rule);
}
.lane-confirm {
  white-space: nowrap;
}
.lane-count {
  opacity: 0.75;
}
.lane-links {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.2rem 0.8rem;
}
.lane-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--muted);
  font-family: var(--font-body);
  font-size: 0.72rem;
  cursor: pointer;
}
.lane-link::before {
  content: '[ ';
}
.lane-link::after {
  content: ' ]';
}
.lane-link:hover,
.lane-link:focus-visible {
  color: var(--ink);
}
.lane-waiting {
  margin: 0;
  font-family: var(--font-body);
  font-size: 0.78rem;
  line-height: 1.45;
  color: var(--ink-soft);
}
.lane-hide {
  position: absolute;
  top: 0.35rem;
  right: 0.35rem;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.lane-hide path {
  stroke: currentColor;
  stroke-width: 1.4;
}
.combat-recap {
  position: relative;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.45rem 2.6rem 0.45rem 1rem;
  border-bottom: 1px solid var(--ink);
  background: var(--paper-2);
}
.recap-text {
  font-family: var(--font-body);
  font-size: 0.8rem;
  color: var(--ink-soft);
}

/* Short screens: smaller cards, and the beats give their row back. */
@media (max-height: 820px) {
  .combat-lane {
    --card-w: 2.6rem;
  }
  .lane-beats {
    display: none;
  }
  .lane-head,
  .lane-side {
    padding-block: 0.45rem;
  }
}

/* Phones and narrow panes: the head and the button take their own rows; pairs become rows. */
@media (max-width: 760px) {
  .combat-lane {
    grid-template-columns: minmax(0, 1fr);
  }
  .lane-head {
    border-right: 0;
    border-bottom: 1px solid var(--rule);
  }
  .lane-groups {
    flex-direction: column;
    gap: 0.7rem;
  }
  .lane-group {
    padding: 0;
    border-left: 0;
  }
  .group-pairs {
    flex-direction: column;
    gap: 0.5rem;
  }
  .lane-pair {
    flex-direction: row;
    gap: 0.6rem;
  }
  .pair-outcome {
    text-align: left;
    max-width: none;
  }
  .lane-side {
    position: sticky;
    bottom: 0;
    border-left: 0;
    border-top: 1px solid var(--rule);
    background: var(--paper-2);
  }
}
</style>
