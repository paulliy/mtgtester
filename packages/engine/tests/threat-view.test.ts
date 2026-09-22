import { describe, expect, it } from 'vitest';
import { createGame } from '../src/state/game';
import { buildPlayerView } from '../src/view/view';
import { conjure, gameConfig, oracle, spawn } from './fixtures';
import { assessThreats } from '../../server/src/ai/threat';
import { request } from '../../server/src/ai/threat/fixtures';

const context = () =>
  createGame(
    gameConfig([{ cards: [] }, { cards: [] }, { cards: [] }], { seed: 'threat-observation' }),
  );
describe('public threat projection', () => {
  it('hidden hand and library permutations leave assessment byte-identical', () => {
    const ctx = context();
    const hand = conjure(ctx, 'P2', oracle({ name: 'Hidden hand A' }), 'hand');
    const library = conjure(ctx, 'P2', oracle({ name: 'Hidden library A' }), 'library');
    spawn(ctx, 'P2', oracle({ name: 'Visible attacker', power: '7' }));
    const before = assessThreats(buildPlayerView(ctx, 'P1'), request);
    hand.name = 'SECRET HAND B';
    hand.oracleText = 'Counter target spell.';
    hand.oracleId = 'another-hidden-card';
    library.name = 'SECRET LIBRARY B';
    ctx.state.players[1]!.library.reverse();
    const after = assessThreats(buildPlayerView(ctx, 'P1'), request);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain('SECRET');
  });
  it('face-down identities and abilities do not leak through capabilities', () => {
    const ctx = context();
    const perm = spawn(
      ctx,
      'P2',
      oracle({
        name: 'SECRET ENGINE',
        oracleText: 'At the beginning of your upkeep, draw a card.',
      }),
    );
    perm.faceDown = true;
    const view = buildPlayerView(ctx, 'P1');
    const p = view.battlefield[0]!;
    expect(p.capabilities?.engines).toEqual([]);
    expect(p.capabilities?.mana).toEqual([]);
    expect(p.capabilities?.unsupported).toEqual(['face-down-abilities']);
    expect(JSON.stringify(view)).not.toContain('SECRET ENGINE');
  });
  it('only closed unconditional periodic engine effects receive semantic features', () => {
    const ctx = context();
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Periodic engine',
        oracleText: 'At the beginning of your upkeep, draw a card.',
      }),
    );
    spawn(
      ctx,
      'P2',
      oracle({ name: 'Attack engine', oracleText: 'Whenever this creature attacks, draw a card.' }),
    );
    const board = buildPlayerView(ctx, 'P1').battlefield;
    expect(board[0]!.capabilities?.engines).toEqual([
      { kind: 'draw', amount: 1, horizon: 'controller-turn' },
    ]);
    expect(board[1]!.capabilities?.engines).toEqual([]);
    expect(board[1]!.capabilities?.unsupported).toContain('conditional-or-complex-engine');
  });
  it('current tapped/sick state controls projected mana without revealing private feasibility', () => {
    const ctx = context();
    const p = spawn(ctx, 'P2', oracle({ name: 'Mana elf', oracleText: '{T}: Add {G}.' }), {
      summoningSick: true,
    });
    expect(buildPlayerView(ctx, 'P1').battlefield[0]!.capabilities?.mana[0]!.available).toBe(false);
    p.summoningSick = false;
    expect(buildPlayerView(ctx, 'P1').battlefield[0]!.capabilities?.mana[0]!.available).toBe(true);
    p.tapped = true;
    expect(buildPlayerView(ctx, 'P1').battlefield[0]!.capabilities?.mana[0]!.available).toBe(false);
  });
  it('damage history is a whitelist, distinguishes direction and never copies raw payloads', () => {
    const ctx = context();
    ctx.state.eventLog.push({
      sequence: 1,
      turn: 1,
      phase: 'combat',
      step: null,
      actorSeat: null,
      type: 'damage',
      payload: { controller: 'P2', target: 'P1', amount: 5, combat: true, secretExtra: 'SECRET' },
    });
    ctx.state.eventLog.push({
      sequence: 2,
      turn: 1,
      phase: 'combat',
      step: null,
      actorSeat: 'P2',
      type: 'draw',
      payload: { name: 'SECRET DRAW' },
    });
    const facts = buildPlayerView(ctx, 'P1').threatFacts!;
    expect(facts.pressure).toEqual([
      { sequence: 1, turn: 1, actor: 'P2', recipient: 'P1', amount: 5, kind: 'combat' },
    ]);
    expect(JSON.stringify(facts)).not.toContain('SECRET');
  });
  it('removing a public source immediately removes dependent features', () => {
    const ctx = context();
    spawn(
      ctx,
      'P2',
      oracle({ name: 'Engine', oracleText: 'At the beginning of your upkeep, draw a card.' }),
    );
    expect(
      assessThreats(buildPlayerView(ctx, 'P1'), request).opponents[0]!.components.E.value,
    ).toBeGreaterThan(0);
    ctx.state.battlefield = [];
    expect(
      assessThreats(buildPlayerView(ctx, 'P1'), request).opponents[0]!.components.E.value,
    ).toBe(0);
  });
  it('projects constant stack damage, but refuses mixed or conditional resolution claims', () => {
    const ctx = context();
    ctx.state.stack.push({
      id: 'burn',
      sourceId: 'burn-source',
      controllerId: 'P2',
      kind: 'spell',
      description: 'Forty damage',
      targets: ['P1'],
      card: null,
      ability: {
        kind: 'spell',
        targets: [],
        effects: [{ op: 'dealDamage', target: 0, amount: { kind: 'const', n: 40 } }],
      },
      sourceOracleId: 'burn-oracle',
      sourceCardId: 'burn-card',
      isCommanderCast: false,
    });
    expect(buildPlayerView(ctx, 'P1').stack[0]!.impacts).toEqual([
      { source: 'burn', recipient: 'P1', amount: 40, kind: 'damage' },
    ]);
    expect(assessThreats(buildPlayerView(ctx, 'P1'), request).opponents[0]!.urgency).toBe(1);
    ctx.state.stack[0]!.ability!.effects.unshift({ op: 'draw', count: { kind: 'const', n: 1 } });
    expect(buildPlayerView(ctx, 'P1').stack[0]!.impacts).toEqual([]);
    expect(assessThreats(buildPlayerView(ctx, 'P1'), request).opponents[0]!.urgency).toBe(4);
  });
  it('does not mislabel infect-source stack damage as lethal life loss', () => {
    const ctx = context();
    const p = spawn(
      ctx,
      'P2',
      oracle({ name: 'Infect source', oracleText: 'Infect', keywords: ['infect'] }),
    );
    ctx.state.players[0]!.life = 1;
    ctx.state.stack.push({
      id: 'ping',
      sourceId: p.id,
      controllerId: 'P2',
      kind: 'activatedAbility',
      description: 'One damage',
      targets: ['P1'],
      card: null,
      ability: {
        kind: 'activated',
        targets: [],
        effects: [{ op: 'dealDamage', target: 0, amount: { kind: 'const', n: 1 } }],
      },
      sourceOracleId: p.oracleId,
      sourceCardId: p.cardId,
      isCommanderCast: false,
    });
    expect(buildPlayerView(ctx, 'P1').stack[0]!.impacts).toEqual([]);
    expect(
      assessThreats(buildPlayerView(ctx, 'P1'), request).opponents.every((o) => o.urgency === 4),
    ).toBe(true);
  });
});
