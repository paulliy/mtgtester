import { applyPriorityAction } from '../packages/engine/src/actions/apply';
import {
  computePriorityOptions,
  type PriorityActionPayload,
} from '../packages/engine/src/actions/legal';
import { computeCharacteristics } from '../packages/engine/src/effects/continuous';
import { resolveTopOfStack } from '../packages/engine/src/stack/stack';
import { createGame } from '../packages/engine/src/state/game';
import {
  bear,
  copies,
  forest,
  gameConfig,
  oracle,
  pump,
  spawn,
} from '../packages/engine/tests/fixtures';

const seed = 'browser-trial-batch-2026-09-05:s1:g1';
const ctx = createGame(
  gameConfig(
    [0, 1, 2, 3].map(() => ({ cards: copies(4, forest) })),
    { seed },
  ),
);
ctx.state.currentTurnPlayer = 'P1';
ctx.state.activePlayerIndex = 0;
ctx.state.turnNumber = 28;
ctx.state.phase = 'precombatMain';
ctx.state.step = null;

const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
const horn = spawn(
  ctx,
  'P1',
  oracle({
    name: 'Revelsong Horn',
    typeLine: 'Artifact',
    manaCost: '{2}',
    oracleText:
      '{1}, {T}, Tap an untapped creature you control: Target creature gets +1/+1 until end of turn.',
  }),
);
const manaCreature = spawn(
  ctx,
  'P1',
  oracle({ name: 'Mana Creature', oracleText: '{T}: Add {G}.' }),
);
const paymentCreature = spawn(ctx, 'P1', bear());

const activation = computePriorityOptions(ctx, player).find((option) => {
  const payload = option.payload as PriorityActionPayload;
  return payload.kind === 'activateAbility' && payload.objectId === horn.id;
});
if (!activation) throw new Error('Revelsong Horn activation was not legal in the payable state.');
if (!activation.targets?.[0]?.options.includes(paymentCreature.id)) {
  throw new Error('The intended creature was not offered as a Revelsong Horn target.');
}

pump(
  applyPriorityAction(ctx, player, activation.payload as PriorityActionPayload, {
    index: 0,
    targets: new Map([[0, paymentCreature.id]]),
  }),
);
if (!horn.tapped || !manaCreature.tapped || !paymentCreature.tapped) {
  throw new Error('The Horn payment did not reserve and tap all required objects.');
}
if (ctx.state.stack.length !== 1) {
  throw new Error('The paid Horn ability was not put on the stack.');
}

pump(resolveTopOfStack(ctx));
const resolvedPower = computeCharacteristics(ctx, paymentCreature).power;
if (resolvedPower !== 3) {
  throw new Error(`The Horn ability resolved with power ${resolvedPower}; expected 3.`);
}

console.log(
  JSON.stringify(
    {
      seed,
      turn: ctx.state.turnNumber,
      source: horn.name,
      target: paymentCreature.name,
      resolvedPower,
      halted: false,
    },
    null,
    2,
  ),
);
