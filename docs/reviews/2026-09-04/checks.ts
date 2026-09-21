import { createGame } from '../../../packages/engine/src/state/game';
import {
  computeAllCharacteristics,
  computeCharacteristics,
} from '../../../packages/engine/src/effects/continuous';
import { canPay, parseManaCost } from '../../../packages/engine/src/mana/cost';
import { computePriorityOptions } from '../../../packages/engine/src/actions/legal';
import { runPrioritySequence } from '../../../packages/engine/src/turn/priority';
import { priorityCheckpoint } from '../../../packages/engine/src/sba/sba';
import { landPlayLimitFor } from '../../../packages/engine/src/state/queries';
import { Engine } from '../../../packages/engine/src/engine';
import { resolveCondition } from '../../../packages/engine/src/cards/condition';
import { executeAbility } from '../../../packages/engine/src/effects/resolve';
import { buildPlayerView } from '../../../packages/engine/src/view/view';
import { buildPlayerBoardState } from '../../../packages/engine/src/view/spectator';
import {
  bear,
  bolt,
  conjure,
  forest,
  forestsPod,
  gameConfig,
  giantGrowth,
  mountain,
  oracle,
  pump,
  spawn,
} from '../../../packages/engine/tests/fixtures';

const ctx4 = () => {
  const ctx = createGame(gameConfig(forestsPod()));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 2;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
};
const out = (name: string, value: unknown) => console.log(JSON.stringify({ name, value }));

{
  const cost = parseManaCost('{W/U}{W/B}').cost!;
  out('hybrid-payment', {
    expected: true,
    actual: canPay(cost, [{ symbol: 'W' }, { symbol: 'U' }], []),
  });
}
{
  const ctx = ctx4();
  const card = oracle({
    name: 'Iymrith, Desert Doom',
    oracleId: 'd5efba91-8400-41a3-91c6-cb5e81f07976',
    typeLine: 'Legendary Creature — Dragon',
    power: '5',
    toughness: '5',
    oracleText:
      "Flying\nIymrith, Desert Doom has ward {4} as long as it's untapped.\nWhenever Iymrith, Desert Doom deals combat damage to a player, draw a card. Then if you have fewer than three cards in hand, draw cards equal to the difference.",
  });
  const perm = spawn(ctx, 'P1', card);
  const before = computeCharacteristics(ctx, perm).ward;
  perm.tapped = true;
  const after = computeCharacteristics(ctx, perm).ward;
  out('iymrith-cache', {
    modeled: ctx.defs.get(card.oracleId)?.modeled,
    before,
    after,
    expectedAfter: null,
  });
}
{
  const ctx = ctx4();
  ctx.state.phase = 'beginning';
  ctx.state.step = 'upkeep';
  spawn(ctx, 'P1', mountain());
  conjure(ctx, 'P1', bolt(), 'hand');
  const menu = computePriorityOptions(ctx, ctx.state.players[0]!);
  const result = runPrioritySequence(ctx).next();
  out('priority-upkeep', {
    hasCast: menu.some((x) => x.type === 'castSpell'),
    generatorDone: result.done,
    expectedDone: false,
  });
}
{
  const ctx = ctx4();
  spawn(ctx, 'P1', forest());
  spawn(ctx, 'P1', bear());
  conjure(ctx, 'P1', giantGrowth(), 'hand');
  const p = ctx.state.players[0]!;
  const main = computePriorityOptions(ctx, p)
    .filter((x) => x.type === 'castSpell')
    .map((x) => x.description);
  ctx.state.phase = 'combat';
  ctx.state.step = 'beginCombat';
  const combat = computePriorityOptions(ctx, p)
    .filter((x) => x.type === 'castSpell')
    .map((x) => x.description);
  out('pump-menu', { main, combat, expectedInMain: true });
}
{
  const ctx = ctx4();
  const watcher = oracle({
    name: 'Review Death Watcher',
    oracleText: 'Whenever another creature dies, draw a card.',
  });
  const a = spawn(ctx, 'P1', watcher);
  const b = spawn(ctx, 'P1', bear());
  a.damageMarked = 2;
  b.damageMarked = 2;
  pump(priorityCheckpoint(ctx));
  out('simultaneous-death', {
    graveyard: ctx.state.players[0]!.graveyard.map((x) => x.name),
    triggerCount: ctx.state.stack.length,
    expectedTriggerCount: 1,
    modeled: ctx.defs.get(watcher.oracleId)?.modeled,
  });
}
{
  const ctx = ctx4();
  const p = spawn(
    ctx,
    'P1',
    oracle({
      name: 'Review Exploration',
      typeLine: 'Enchantment',
      oracleText: 'You may play an additional land on each of your turns.',
    }),
  );
  p.faceDown = true;
  out('face-down-static', {
    limit: landPlayLimitFor(ctx, 'P1'),
    expected: 1,
    types: computeCharacteristics(ctx, p).types,
  });
}

{
  const ctx = ctx4();
  const hidden = conjure(
    ctx,
    'P1',
    oracle({
      name: 'Review Secret Creature',
      oracleText: 'When Review Secret Creature enters, draw a card.',
    }),
    'library',
  );
  pump(
    executeAbility(
      ctx,
      {
        cardId: 'review-source',
        oracleId: 'review-source',
        name: 'Review Manifest',
        controllerId: 'P1',
      },
      { kind: 'spell', targets: [], effects: [{ op: 'manifestTop' }] },
      [],
    ),
  );
  const perm = ctx.state.battlefield.find((p) => p.cardId === hidden.cardId)!;
  out('manifest', {
    faceDown: perm.faceDown,
    statuses: perm.statuses,
    queuedEntersTriggers: ctx.state.pendingTriggers.length,
    opponentBot: buildPlayerView(ctx, 'P2').battlefield.find((p) => p.id === perm.id),
    opponentHuman: buildPlayerBoardState(ctx, 'P2').battlefield.find((p) => p.id === perm.id),
    expectedName: 'Face-down permanent',
    expectedTriggers: 0,
  });
}
{
  const ctx = ctx4();
  ctx.state.players[0]!.life = 1;
  const result = pump(
    resolveCondition(
      ctx,
      { kind: 'mayPayLife', n: 2 },
      { cardId: 'review-source', controllerId: 'P1' },
      'Review Shock Land',
    ),
  );
  out('unaffordable-life-payment', {
    accepted: result.value,
    life: ctx.state.players[0]!.life,
    expectedAccepted: false,
  });
}
function medianTime(fn: () => void, repeats = 5) {
  fn();
  const times = [];
  for (let i = 0; i < repeats; i++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
}
for (const size of [20, 80, 160]) {
  const ctx = ctx4();
  for (let i = 0; i < size; i++) spawn(ctx, 'P1', bear());
  const repeated = medianTime(() => {
    for (let r = 0; r < 100; r++)
      for (const p of ctx.state.battlefield) computeCharacteristics(ctx, p);
  });
  const batch = medianTime(() => {
    for (let r = 0; r < 100; r++) {
      const map = computeAllCharacteristics(ctx);
      for (const p of ctx.state.battlefield) map.get(p.cardId);
    }
  });
  out('layer-benchmark', { size, passes: 100, repeatedMs: repeated, batchMs: batch });
}
for (const size of [8, 12, 16]) {
  const sources = Array.from({ length: size }, (_, i) => ({
    cardId: `m${i}`,
    units: [['G', 'W'] as const],
  }));
  const ms = medianTime(() => {
    canPay(parseManaCost('{' + size / 2 + '}{U}').cost!, [], sources);
  }, 3);
  out('unpayable-mana-benchmark', { size, ms });
}
for (const size of [1000, 10000, 100000]) {
  const engine = new Engine(gameConfig(forestsPod()));
  const s = engine.getState();
  s.eventLog = Array.from({ length: size }, (_, sequence) => ({
    sequence,
    turn: 1,
    phase: 'precombatMain',
    step: null,
    actorSeat: null,
    type: 'test',
    payload: {},
  }));
  out('event-poll-benchmark', {
    size,
    polls: 1000,
    ms: medianTime(() => {
      for (let i = 0; i < 1000; i++) engine.eventsSince(size);
    }),
  });
}
