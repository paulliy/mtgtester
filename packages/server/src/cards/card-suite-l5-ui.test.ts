import { describe, expect, it } from 'vitest';
import type { EngineActionOption, PendingDecision } from '../../../engine/src/decisions';
import { interactionFor } from '../../../engine/src/engine';
import { executeAbility } from '../../../engine/src/effects/resolve';
import { createGame } from '../../../engine/src/state/game';
import type { GameContext } from '../../../engine/src/state/types';
import { copies, forest, gameConfig, oracle, pump, registerDef, spawn } from '../../../engine/tests/fixtures';
import { loadScryfallBulkOrNull } from './scryfall-bulk-fixture';
import { toOracleCard } from './scryfall';

const scryfallCards = loadScryfallBulkOrNull();
// data/scryfall-oracle-cards.json is gitignored and not fetched by CI (see scryfall-bulk-fixture.ts).
const SKIP = scryfallCards === null;

function getOracleCard(name: string) {
  const raw = (scryfallCards ?? []).find((c: any) => c.name === name);
  if (!raw) throw new Error(`Card not found in scryfall data: ${name}`);
  const oracleCard = toOracleCard(raw);
  if (!oracleCard) throw new Error(`Failed to convert scryfall data for: ${name}`);
  return oracleCard;
}

function pod(seed = 'l5-ui-suite'): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(4, forest) })), { seed }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

function frontendSourceId(option: EngineActionOption): string | null {
  const interaction = interactionFor(option);
  switch (interaction.kind) {
    case 'source':
      return interaction.sourceId;
    case 'attack':
      return interaction.attackerId;
    case 'block':
      return interaction.blockerId;
    case 'choice':
      return interaction.subjectId ?? null;
    default:
      return null;
  }
}

function isReachable(ctx: GameContext, playerId: string, option: EngineActionOption): boolean {
  const interaction = interactionFor(option);
  if (interaction.kind === 'immediate' || interaction.kind === 'order') return true;
  if (interaction.kind === 'attack' || interaction.kind === 'block') return true;
  const sourceId = frontendSourceId(option);
  if (sourceId === null) return true;
  const player = ctx.state.players.find((p) => p.id === playerId);
  const onScreen = new Set<string>([
    ...ctx.state.battlefield.map((p) => p.id),
    ...(player?.hand.map((c) => c.id) ?? []),
    ...(player?.commandZone.map((c) => c.id) ?? []),
  ]);
  return onScreen.has(sourceId);
}

function expectAllReachable(ctx: GameContext, decisions: PendingDecision[]): void {
  for (const decision of decisions) {
    for (const option of decision.options) {
      expect(
        isReachable(ctx, decision.player, option),
        `unreachable option "${option.description}" in decision "${decision.prompt}"`,
      ).toBe(true);
    }
  }
}

describe.skipIf(SKIP)('L5: Human UI Reachability Tests', () => {
  it('validates UI decision reachability for Path to Exile', () => {
    const ctx = pod();
    const target = spawn(ctx, 'P2', oracle({ name: 'Ogre', typeLine: 'Creature', manaCost: '{2}' }));
    const pathCard = getOracleCard('Path to Exile');
    const def = registerDef(ctx, pathCard);
    const perm = spawn(ctx, 'P1', pathCard);

    const { decisions } = pump(
      executeAbility(ctx, perm, def.spellAbility!, []),
      () => ({ index: 0, targets: new Map([[0, target.id]]) })
    );

    expectAllReachable(ctx, decisions);
  });

  it('validates UI decision reachability for Felidar Retreat modal choice', () => {
    const ctx = pod();
    const retreatCard = getOracleCard('Felidar Retreat');
    const def = registerDef(ctx, retreatCard);
    const perm = spawn(ctx, 'P1', retreatCard);

    const trigger = def.triggers?.[0];
    if (trigger) {
      const { decisions } = pump(
        executeAbility(ctx, perm, trigger, []),
        () => ({ index: 0, targets: new Map() })
      );
      expectAllReachable(ctx, decisions);
    }
  });

  it('validates UI decision reachability for Sylvan Reclamation targeting', () => {
    const ctx = pod();
    const ring = spawn(ctx, 'P2', oracle({ name: 'Sol Ring', typeLine: 'Artifact', manaCost: '{1}' }));
    const recCard = getOracleCard('Sylvan Reclamation');
    const def = registerDef(ctx, recCard);
    const perm = spawn(ctx, 'P1', recCard);

    const { decisions } = pump(
      executeAbility(ctx, perm, def.spellAbility!, []),
      () => ({ index: 0, targets: new Map([[0, ring.id]]) })
    );

    expectAllReachable(ctx, decisions);
  });
});
