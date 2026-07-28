<script setup lang="ts">
/**
 * The deck setup screen (brief §10.2, §8).
 *
 * Two paths, and the default is deliberately the generated one. The engine halts on any
 * unmodeled card, so a real decklist is all-or-nothing and usually nothing (ADR 0009) — a
 * screen offering only four Moxfield URLs would produce a halt on turn one for essentially
 * every deck a user owns. Imported decks are still supported and are pre-flighted, so the
 * blocking card names come back here rather than as a mid-game halt.
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { GameMode, ProviderKind, SeatSource } from '@mtg/shared';
import { useGameStore } from '../stores/game';

const store = useGameStore();
const router = useRouter();

const SEATS = 4;

type Mode = 'pool' | 'import';

const mode = ref<Mode>('pool');
const gameMode = ref<GameMode>('spectator');
const humanSeat = ref('P1');
const advancedPodSetup = ref(false);
const providerKind = ref<ProviderKind>('random');
const seed = ref('');
const inputs = ref<string[]>(Array.from({ length: SEATS }, () => ''));
const tags = ref<string[]>(Array.from({ length: SEATS }, () => ''));

const canStart = computed(() =>
  mode.value === 'pool'
    ? true
    : gameMode.value === 'singlePlayer' && !advancedPodSetup.value
      ? (inputs.value[Number(humanSeat.value.slice(1)) - 1]?.trim().length ?? 0) > 0
      : inputs.value.every((v) => v.trim().length > 0),
);

function sourceFor(index: number): SeatSource {
  if (mode.value === 'pool') return { kind: 'pool' };
  // Player mode's normal path has one subject deck. The remaining seats are generated,
  // supported opponents unless the player explicitly opts into configuring the whole pod.
  if (
    gameMode.value === 'singlePlayer' &&
    !advancedPodSetup.value &&
    index + 1 !== Number(humanSeat.value.slice(1))
  ) {
    return { kind: 'pool' };
  }
  const raw = inputs.value[index]?.trim() ?? '';
  const tag = tags.value[index]?.trim() ?? '';
  const isUrl = /^https?:\/\//i.test(raw);
  if (isUrl) return { kind: 'url', url: raw, ...(tag !== '' && { archetypeTag: tag }) };
  return { kind: 'plaintext', text: raw, ...(tag !== '' && { archetypeTag: tag }) };
}

function start(): void {
  const sources = Array.from({ length: SEATS }, (_, i) => sourceFor(i));
  store.startGame(
    sources,
    providerKind.value,
    seed.value.trim(),
    gameMode.value,
    humanSeat.value,
  );
  void router.push('/game');
}
</script>

<template>
  <div class="setup">
    <h2>New game</h2>
    <p class="lede">Watch four bots simulate Commander, or play one seat against three bots.</p>

    <fieldset>
      <legend>Game mode</legend>
      <label class="choice">
        <input v-model="gameMode" type="radio" value="spectator" />
        <span>
          <strong>Spectator simulation</strong>
          <em>Four bots play while you watch, scrub, and inspect every hand.</em>
        </span>
      </label>
      <label class="choice">
        <input v-model="gameMode" type="radio" value="singlePlayer" />
        <span>
          <strong>Play against three bots</strong>
          <em>Your choices pause indefinitely; opponents' hidden cards stay hidden.</em>
        </span>
      </label>
      <label v-if="gameMode === 'singlePlayer'" class="human-seat">
        Your seat
        <select v-model="humanSeat">
          <option v-for="index in SEATS" :key="index" :value="`P${index}`">P{{ index }}</option>
        </select>
      </label>
    </fieldset>

    <fieldset>
      <legend>Decks</legend>
      <label class="choice">
        <input v-model="mode" type="radio" value="pool" />
        <span>
          <strong>Generate from the engine-supported pool</strong>
          <em>
            Always playable. The engine halts on cards it cannot model, so a generated deck is
            the reliable path until card coverage grows (ADR 0009).
          </em>
        </span>
      </label>
      <label class="choice">
        <input v-model="mode" type="radio" value="import" />
        <span>
          <strong>Import decklists</strong>
          <em>
            Moxfield / Archidekt URL, or a pasted plaintext list. Each deck is validated and
            pre-flighted; any card the engine cannot model is reported here before the game
            starts.
          </em>
        </span>
      </label>

      <div v-if="mode === 'import'" class="decks">
        <p v-if="gameMode === 'singlePlayer' && !advancedPodSetup" class="hint">
          Import your deck; the other three seats use generated, engine-supported opponents.
        </p>
        <div
          v-for="index in SEATS"
          v-show="gameMode !== 'singlePlayer' || advancedPodSetup || index === Number(humanSeat.slice(1))"
          :key="index"
          class="deck-row"
        >
          <span class="seat">P{{ index }}</span>
          <textarea
            v-model="inputs[index - 1]"
            rows="2"
            placeholder="https://moxfield.com/decks/… or a pasted decklist"
          ></textarea>
          <input
            v-model="tags[index - 1]"
            type="text"
            placeholder="archetype tag (optional)"
          />
        </div>
        <label v-if="gameMode === 'singlePlayer'" class="advanced-pod">
          <input v-model="advancedPodSetup" type="checkbox" />
          <span>Choose all four decks instead</span>
        </label>
      </div>
    </fieldset>

    <fieldset>
      <legend>{{ gameMode === 'singlePlayer' ? 'Bot opponents' : 'Players' }}</legend>
      <label class="choice">
        <input v-model="providerKind" type="radio" value="random" />
        <span>
          <strong>Random bots</strong>
          <em>Fast, free, and fully seeded. Best for learning the controls or a quick game.</em>
        </span>
      </label>
      <label class="choice">
        <input v-model="providerKind" type="radio" value="ai" />
        <span>
          <strong>AI bots</strong>
          <em>Uses strategic bot decisions and may spend API budget.</em>
        </span>
      </label>
    </fieldset>

    <fieldset>
      <legend>Replay seed <span class="optional">(optional)</span></legend>
      <input v-model="seed" type="text" placeholder="leave blank for a fresh seed" />
      <p class="hint">
        Leave this blank for a fresh game. Use a seed when you want to repeat a known shuffle;
        AI decisions may still vary.
      </p>
    </fieldset>

    <div v-if="store.errors.length > 0" class="errors">
      <h3>Setup failed</h3>
      <ul>
        <li v-for="(error, index) in store.errors" :key="index">{{ error }}</li>
      </ul>
    </div>

    <button type="button" class="primary" :disabled="!canStart" @click="start">Start game</button>
  </div>
</template>

<style scoped>
.setup {
  max-width: 48rem;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
h2 {
  margin: 0;
}
.lede {
  margin: 0;
  color: var(--muted);
}
fieldset {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0.7rem 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
legend {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  padding: 0 0.3rem;
}
.choice {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  cursor: pointer;
}
.choice span {
  display: flex;
  flex-direction: column;
}
.choice em {
  color: var(--muted);
  font-size: 0.78rem;
  font-style: normal;
}
.human-seat {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.8rem;
}
.human-seat select {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0.3rem;
}
.decks {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border-top: 1px solid var(--line);
  padding-top: 0.6rem;
}
.deck-row {
  display: grid;
  grid-template-columns: 2rem 1fr 14rem;
  gap: 0.5rem;
  align-items: start;
}
.seat {
  font-weight: 700;
  padding-top: 0.4rem;
}
.hint {
  margin: 0;
  color: var(--muted);
  font-size: 0.78rem;
}
.errors {
  border: 1px solid var(--danger);
  border-radius: 4px;
  padding: 0.6rem 0.8rem;
}
.errors h3 {
  margin: 0 0 0.3rem;
  font-size: 0.85rem;
  color: var(--danger);
}
.errors ul {
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.8rem;
  white-space: pre-wrap;
}
button.primary {
  align-self: flex-start;
  padding: 0.5rem 1.2rem;
  font-weight: 600;
}
.optional { text-transform:none; letter-spacing:0; }
.advanced-pod { display:flex; align-items:center; gap:.45rem; font-size:.78rem; color:var(--muted); }
</style>
