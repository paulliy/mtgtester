<script setup lang="ts">
/**
 * A placeholder page for the deal UI (ADR 0035), with sample data and no game behind it. It
 * mounts the same `DealPanel` and warning dialog the player view uses, and fakes the bots'
 * answers in the browser, so the panel can be looked at and clicked through without starting a
 * game or a server. Development builds only; nothing here is sent anywhere.
 */
import { onMounted, onUnmounted } from 'vue';
import type { Deal, DiplomacySeatState, PlayerBoardState, TableTalkLine } from '@mtg/shared';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import DealPanel from '../components/DealPanel.vue';
import { useGameStore } from '../stores/game';

const store = useGameStore();
let nextId = 10;
let sequence = 100;
const timers: ReturnType<typeof setTimeout>[] = [];

const offer: Deal = {
  id: 'deal-3',
  proposer: 'P3',
  parties: ['P3', 'P1'],
  obligations: [
    { kind: 'noAttack', by: 'P3', against: 'P1' },
    { kind: 'noAttack', by: 'P1', against: 'P3' },
    { kind: 'attackPlayer', by: 'P1', target: 'P4' },
  ],
  proposedTurn: 9,
  rounds: 2,
  status: 'proposed',
};
const inForce: Deal = {
  id: 'deal-2',
  proposer: 'P2',
  parties: ['P2', 'P4'],
  obligations: [
    { kind: 'noAttack', by: 'P2', against: 'P4' },
    { kind: 'noAttack', by: 'P4', against: 'P2' },
  ],
  proposedTurn: 8,
  rounds: 1,
  status: 'active',
};

function seatState(): DiplomacySeatState {
  return {
    turn: 9,
    slot: 'turnStart',
    canPropose: true,
    offers: [offer],
    deals: [inForce],
    trust: [
      { seat: 'P1', kept: 0, broken: 0 },
      { seat: 'P2', kept: 2, broken: 0 },
      { seat: 'P3', kept: 1, broken: 1 },
      { seat: 'P4', kept: 1, broken: 0 },
    ],
    partners: ['P2', 'P3'],
    maxRounds: 2,
    maxObligationsPerSide: 2,
  };
}

function talk(text: string, message: TableTalkLine['message']): TableTalkLine {
  return { sequence: sequence++, turn: 9, message, text };
}

function say(text: string): void {
  store.tableTalk = [
    ...store.tableTalk,
    talk(text, { kind: 'threatCall', turn: 9, from: 'P2', leader: 'P4', reasons: [] }),
  ];
}

function later(fn: () => void, ms = 600): void {
  timers.push(setTimeout(fn, ms));
}

/** Pretend to be the table: answer what the panel sends, as the bots would. */
function patch(fn: (state: DiplomacySeatState) => DiplomacySeatState): void {
  if (store.diplomacySeat !== null) store.diplomacySeat = fn(store.diplomacySeat);
}

let stopListening: (() => void) | null = null;
/**
 * The preview fills the shared game store with sample data, which would wipe a game in progress
 * (and the panel would send real proposals to it), so it only runs with no game loaded.
 */
const blocked = store.gameId !== null;

onMounted(() => {
  if (blocked) return;
  store.humanSeat = 'P1';
  store.diplomacy = true;
  store.playerState = {
    seats: ['P1', 'P2', 'P3', 'P4'].map((seat) => ({ seat, graveyard: [] })),
    eliminatedPlayers: [],
    battlefield: [],
    stack: [],
  } as unknown as PlayerBoardState;
  store.diplomacySeat = seatState();
  store.tableTalk = [
    talk('P2: P4 is the biggest threat (40 life, the biggest board, 21 power).', {
      kind: 'threatCall',
      turn: 9,
      from: 'P2',
      leader: 'P4',
      reasons: [],
    }),
    talk("P2 to P4: deal? P2 won't attack P4; P4 won't attack P2, for a round.", {
      kind: 'proposal',
      turn: 9,
      from: 'P2',
      to: 'P4',
      deal: inForce,
    }),
    talk('P4: deal.', {
      kind: 'response',
      turn: 9,
      from: 'P4',
      to: 'P2',
      dealId: inForce.id,
      answer: 'accept',
    }),
  ];

  stopListening = store.$onAction(({ name, args, after }) => {
    after(() => {
      if (name === 'proposeDeal') {
        const [terms] = args as Parameters<typeof store.proposeDeal>;
        const deal: Deal = {
          id: `deal-${nextId++}`,
          proposer: 'P1',
          parties: ['P1', terms.to],
          obligations: terms.obligations,
          proposedTurn: 9,
          rounds: terms.rounds,
          status: 'active',
        };
        patch((s) => ({ ...s, canPropose: false }));
        say(`P1 to ${terms.to}: deal? (${terms.obligations.length} promises)`);
        later(() => {
          // In the preview a reciprocal offer is accepted and a one-sided ask declined.
          const reciprocal = terms.obligations.some((o) => o.by === terms.to);
          const mine = terms.obligations.some((o) => o.by === 'P1');
          if (reciprocal && mine) {
            patch((s) => ({ ...s, deals: [...s.deals, deal] }));
            store.lastDealOutcome = { kind: 'accepted', dealId: deal.id };
            say(`${terms.to}: deal.`);
          } else {
            store.lastDealOutcome = { kind: 'declined' };
            say(`${terms.to}: no deal.`);
          }
        });
      } else if (name === 'answerDeal') {
        const [dealId, answer, counter] = args as Parameters<typeof store.answerDeal>;
        const answered = store.diplomacySeat?.offers.find((d) => d.id === dealId);
        if (answered === undefined) return;
        patch((s) => ({ ...s, offers: s.offers.filter((d) => d.id !== dealId) }));
        if (answer === 'accept') {
          patch((s) => ({ ...s, deals: [...s.deals, { ...answered, status: 'active' }] }));
          store.lastDealOutcome = { kind: 'accepted', dealId };
          say('P1: deal.');
        } else if (counter !== undefined) {
          store.lastDealOutcome = { kind: 'declined' };
          say('P1: no. Counter sent.');
          later(() => say(`${answered.proposer}: no deal.`));
        } else {
          store.lastDealOutcome = { kind: 'declined' };
          say('P1: no deal.');
        }
      } else if (name === 'requestDealDraft') {
        later(() => {
          store.dealDraft = {
            text: (args as Parameters<typeof store.requestDealDraft>)[0],
            terms: {
              to: 'P2',
              rounds: 1,
              obligations: [
                { kind: 'noAttack', by: 'P1', against: 'P2' },
                { kind: 'noAttack', by: 'P2', against: 'P1' },
              ],
            },
          };
          store.dealDraftPending = false;
        }, 800);
      } else if (name === 'confirmDealWarning' || name === 'cancelDealWarning') {
        store.dealWarning = null;
      }
    });
  });
});

onUnmounted(() => {
  if (blocked) return;
  stopListening?.();
  for (const timer of timers) clearTimeout(timer);
  store.diplomacySeat = null;
  store.diplomacy = false;
  store.humanSeat = null;
  store.playerState = null;
  store.tableTalk = [];
  store.lastDealOutcome = null;
  store.dealDraft = null;
  store.dealWarning = null;
});

function showWarning(): void {
  store.dealWarning = {
    requestId: 'preview',
    actionId: 0,
    messages: ['Deal deal-3 with P3: you promised not to attack P3. This may break it.'],
  };
}

function reset(): void {
  store.diplomacySeat = seatState();
  store.lastDealOutcome = null;
  store.dealDraft = null;
}

function moveSlot(): void {
  patch((s) => ({
    ...s,
    slot: s.slot === 'turnStart' ? 'afterAttackers' : 'turnStart',
    canPropose: true,
  }));
}
</script>

<template>
  <div class="preview">
    <header>
      <h2>Deals preview</h2>
      <p>
        Sample data, no game: you are P1, P4 leads, P3 has an offer waiting on you. Bot answers are
        faked in the browser. Development builds only.
      </p>
      <div v-if="!blocked" class="controls">
        <button type="button" @click="showWarning">Show the deal warning</button>
        <button type="button" @click="moveSlot">Switch negotiation slot</button>
        <button type="button" @click="reset">Reset sample</button>
      </div>
    </header>
    <p v-if="blocked" class="blocked" role="status">
      A game is loaded. Abandon it, or reload the page, to open the preview: it would overwrite the
      game's state.
    </p>
    <div v-else class="rail">
      <DealPanel />
    </div>
    <ConfirmDialog
      v-if="!blocked && store.dealWarning"
      title="This may break a deal"
      :message="`${store.dealWarning.messages.join(' ')} Everyone at the table sees a broken deal.`"
      confirm-label="Do it anyway"
      cancel-label="Go back"
      @cancel="store.cancelDealWarning()"
      @confirm="store.confirmDealWarning()"
    />
  </div>
</template>

<style scoped>
.preview {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 720px;
}
header p {
  margin: 4px 0 8px;
  color: var(--muted, #888);
}
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.rail {
  max-width: 380px;
}
</style>
