import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Color, OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { computeCharacteristics } from '../src/effects/continuous';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import { queueStepTriggers } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import { runCombatPhase } from '../src/combat/combat';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import type { GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  oracle,
  pump,
  spawn,
} from './fixtures';

const pins = (
  JSON.parse(
    readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
  ) as { cards: { sha256: string; card: OracleCard }[] }
).cards;
function pin(name: string): OracleCard {
  const entry = pins.find((entry) => entry.card.name === name)!;
  expect(createHash('sha256').update(JSON.stringify(entry.card)).digest('hex')).toBe(entry.sha256);
  return entry.card;
}
const DARK = pin('Dark Confidant');
const ETALI = pin('Etali, Primal Conqueror // Etali, Primal Sickness');
const SONG = pin("Songbirds' Blessing");
const FORGE = pin('Mystic Forge');
function pod(seed: string) {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(16, forest) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  return ctx;
}
const p = playerById;
function answer(decision: PendingDecision): DecisionOutcome {
  const index = Math.max(
    0,
    decision.options.findIndex((option) => option.type === 'pass' || option.type === 'decline'),
  );
  return {
    index,
    targets: new Map(
      (decision.options[index]?.targets ?? []).map((slot) => [slot.slot, slot.options[0]!]),
    ),
  };
}
function settle(ctx: GameContext, choose = answer) {
  return pump(runPrioritySequence(ctx), choose);
}
function fund(ctx: GameContext, card: OracleCard) {
  const cost = interpretCard(card).manaCost!;
  addMana(p(ctx, 'P1'), [
    ...Object.entries(cost.colored).flatMap(([symbol, n]) =>
      Array.from({ length: n }, () => ({ symbol: symbol as Color })),
    ),
    ...Array.from({ length: cost.generic }, () => ({ symbol: 'C' as const })),
  ]);
}
function cast(
  ctx: GameContext,
  card: OracleCard,
  targets = new Map<number, string>(),
  choose = answer,
) {
  const object = conjure(ctx, 'P1', card, 'hand');
  fund(ctx, card);
  const option = computePriorityOptions(ctx, p(ctx, 'P1')).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  });
  expect(option).toBeDefined();
  pump(
    applyPriorityAction(ctx, p(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
  );
  settle(ctx, choose);
  return ctx.state.battlefield.find((permanent) => permanent.cardId === object.cardId)!;
}
function upkeep(ctx: GameContext, player: string) {
  Object.assign(ctx.state, {
    currentTurnPlayer: player,
    activePlayerIndex: ctx.state.turnOrder.indexOf(player),
    phase: 'beginning',
    step: 'upkeep',
  });
  queueStepTriggers(ctx, 'upkeep');
  return settle(ctx);
}
function library(ctx: GameContext, card: OracleCard) {
  const object = conjure(ctx, 'P1', card, 'library');
  p(ctx, 'P1').library = [object];
  return object;
}

describe('PR09 audited Oracle edges', () => {
  it('pr09-monstrous-vortex-characteristic-power-on-stack — a defining ability uses the spell’s current power before it enters', () => {
    for (const count of [4, 5]) {
      const ctx = pod(`pr09-vortex-cda-${count}`);
      spawn(ctx, 'P1', pin('Monstrous Vortex'));
      for (let i = 0; i < count; i++)
        spawn(
          ctx,
          'P1',
          oracle({
            name: `CDA Bear ${i}`,
            typeLine: 'Creature — Bear',
            power: '2',
            toughness: '2',
          }),
        );
      const hit = library(
        ctx,
        oracle({
          name: 'CDA Discover Hit',
          typeLine: 'Sorcery',
          manaCost: '{1}',
          cmc: 1,
          oracleText: 'You gain 1 life.',
        }),
      );
      const star = oracle({
        name: 'Star World',
        typeLine: 'Creature — Test',
        manaCost: '{5}{G}',
        power: '*',
        toughness: '1',
        oracleText: "Star World's power is equal to the number of creatures you control.",
      });
      expect(interpretCard(star).modeled).toBe(true);
      cast(ctx, star);
      expect(p(ctx, 'P1').hand.some((card) => card.cardId === hit.cardId)).toBe(count === 5);
      expect(p(ctx, 'P1').library.some((card) => card.cardId === hit.cardId)).toBe(count === 4);
    }
  });
  it('pr09-mystic-forge-selected-face-permission — a colorless Adventure can be cast from the top even when its creature face is colored', () => {
    const ctx = pod('pr09-forge-face');
    spawn(ctx, 'P1', FORGE);
    const source = (
      JSON.parse(
        readFileSync(
          new URL('./fixtures/selected-spell-faces-oracle.json', import.meta.url),
          'utf8',
        ),
      ) as { cards: { card: OracleCard }[] }
    ).cards.find(({ card }) => card.name.startsWith('Foulmire'))!.card;
    const card: OracleCard = {
      ...source,
      oracleId: 'lab-pr09-colorless-adventure',
      name: 'Colored Knight // Colorless Insight',
      backFace: { ...source.backFace!, name: 'Colorless Insight', manaCost: '{2}', colors: [] },
    };
    expect(interpretCard(card).modeled).toBe(true);
    const top = library(ctx, card);
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }]);
    const options = computePriorityOptions(ctx, p(ctx, 'P1')).filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === top.id;
    });
    expect(options).toHaveLength(1);
    const payload = options[0]!.payload as PriorityActionPayload;
    expect(payload.kind === 'castSpell' && payload.alternativeCast).toBe('adventure');
    pump(applyPriorityAction(ctx, p(ctx, 'P1'), payload, { index: 0, targets: new Map() }));
    expect(ctx.state.stack.at(-1)?.spellDefinition?.name).toBe('Colorless Insight');
    expect(p(ctx, 'P1').manaEntries).toHaveLength(0);
  });
  it('pr09-mystic-forge-face-filter-cannot-leak — a permitted artifact creature face does not permit its colored Adventure', () => {
    const ctx = pod('pr09-forge-face-negative');
    spawn(ctx, 'P1', FORGE);
    const source = (
      JSON.parse(
        readFileSync(
          new URL('./fixtures/selected-spell-faces-oracle.json', import.meta.url),
          'utf8',
        ),
      ) as { cards: { card: OracleCard }[] }
    ).cards.find(({ card }) => card.name.startsWith('Foulmire'))!.card;
    const card: OracleCard = {
      ...source,
      oracleId: 'lab-pr09-artifact-adventure',
      name: 'Artifact Knight // Colored Insight',
      typeLine: 'Artifact Creature — Knight',
      types: ['Artifact', 'Creature'],
      subtypes: ['Knight'],
      manaCost: '{2}',
      colors: [],
      backFace: { ...source.backFace!, name: 'Colored Insight' },
    };
    expect(interpretCard(card).modeled).toBe(true);
    const top = library(ctx, card);
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'B' }]);
    const options = computePriorityOptions(ctx, p(ctx, 'P1')).filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === top.id;
    });
    expect(options.length).toBeGreaterThan(0);
    expect(
      options.every((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'castSpell' && payload.alternativeCast === undefined;
      }),
    ).toBe(true);
  });
  it('pr09-dark-confidant-upkeep-reveal-hand-life — normal casting precedes a real upkeep reveal and mana-value life loss', () => {
    const ctx = pod('pr09-confidant');
    cast(ctx, DARK);
    const top = library(
      ctx,
      oracle({
        name: 'Confidant five',
        manaCost: '{5}',
        cmc: 5,
        typeLine: 'Sorcery',
        oracleText: 'You gain 1 life.',
      }),
    );
    const before = p(ctx, 'P1').life;
    upkeep(ctx, 'P1');
    expect(p(ctx, 'P1').life).toBe(before - 5);
    expect(p(ctx, 'P1').hand.some((card) => card.cardId === top.cardId)).toBe(true);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'revealCard' && event.payload['cardId'] === top.cardId,
      ),
    ).toBe(true);
    expect(
      ctx.state.eventLog.filter(
        (event) => event.type === 'draw' && event.payload['cardId'] === top.cardId,
      ),
    ).toHaveLength(0);
  });
  it('pr09-dark-confidant-opponent-empty-and-zero — opponent upkeeps do not trigger and empty libraries do not cause a draw loss', () => {
    const ctx = pod('pr09-confidant-negative');
    cast(ctx, DARK);
    const land = library(ctx, forest());
    upkeep(ctx, 'P2');
    expect(p(ctx, 'P1').library).toEqual([land]);
    expect(p(ctx, 'P1').life).toBe(40);
    upkeep(ctx, 'P1');
    expect(p(ctx, 'P1').life).toBe(40);
    expect(p(ctx, 'P1').hand.some((card) => card.cardId === land.cardId)).toBe(true);
    p(ctx, 'P1').library = [];
    upkeep(ctx, 'P1');
    expect(p(ctx, 'P1').hasLost).toBe(false);
    expect(p(ctx, 'P1').attemptedDrawFromEmptyLibrary).toBe(false);
  });
  it('pr09-etali-transform-cost-and-sorcery-timing — the printed Phyrexian activation requires nine mana plus green or two life', () => {
    const ctx = pod('pr09-etali-transform');
    const etali = cast(ctx, ETALI);
    const activation = () =>
      computePriorityOptions(ctx, p(ctx, 'P1')).find((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'activateAbility' && payload.objectId === etali.id;
      });
    addMana(
      p(ctx, 'P1'),
      Array.from({ length: 8 }, () => ({ symbol: 'C' as const })),
    );
    expect(activation()).toBeUndefined();
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }]);
    ctx.state.phase = 'combat';
    ctx.state.step = 'declareBlockers';
    expect(activation()).toBeUndefined();
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    const option = activation();
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    settle(ctx);
    expect(p(ctx, 'P1').life).toBe(38);
    expect(etali.transformed).toBe(true);
    const characteristics = computeCharacteristics(ctx, etali);
    expect(characteristics.power).toBe(11);
    expect(characteristics.keywords).toEqual(expect.arrayContaining(['trample', 'indestructible']));
    expect(etali.name).toBe('Etali, Primal Sickness');
    cast(
      ctx,
      oracle({
        name: 'Audit destruction',
        typeLine: 'Sorcery',
        manaCost: '{B}',
        oracleText: 'Destroy target creature.',
      }),
      new Map([[0, etali.id]]),
    );
    expect(ctx.state.battlefield).toContain(etali);
  });
  it('pr09-etali-back-face-poison — transformed combat damage adds poison in addition to ordinary life loss', () => {
    const ctx = pod('pr09-etali-poison');
    const etali = spawn(ctx, 'P1', ETALI);
    etali.summoningSick = false;
    addMana(p(ctx, 'P1'), [
      ...Array.from({ length: 9 }, () => ({ symbol: 'C' as const })),
      { symbol: 'G' },
    ]);
    const option = computePriorityOptions(ctx, p(ctx, 'P1')).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === etali.id;
    })!;
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), option.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    settle(ctx);
    p(ctx, 'P2').life = 100;
    pump(runCombatPhase(ctx), (decision) =>
      decision.decisionType === 'declareAttackers'
        ? declareAttacks(decision, (id) => (id === etali.id ? 'P2' : null))
        : decision.decisionType === 'declareBlockers'
          ? declareBlocks(decision, () => null)
          : answer(decision),
    );
    expect(p(ctx, 'P2').life).toBe(89);
    expect(p(ctx, 'P2').poisonCounters).toBe(11);
    expect(p(ctx, 'P2').hasLost).toBe(true);
  });
  it('pr09-printed-flying-and-trample-combat — flyers exclude ground blockers and Carnosaur tramples over a legal blocker', () => {
    for (const name of [
      'Armored Skyhunter',
      'Szarekh, the Silent King',
      'Trumpeting Carnosaur',
      'Etali, Primal Conqueror // Etali, Primal Sickness',
    ]) {
      const ctx = pod('pr09-keyword-' + name);
      const source = spawn(ctx, 'P1', pin(name));
      source.summoningSick = false;
      const blocker = spawn(
        ctx,
        'P2',
        oracle({ name: 'Ground blocker', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
      );
      let sawBlockMenu = false;
      pump(runCombatPhase(ctx), (decision) => {
        if (decision.decisionType === 'declareAttackers')
          return declareAttacks(decision, (id) => (id === source.id ? 'P2' : null));
        if (decision.decisionType === 'declareBlockers') {
          sawBlockMenu = true;
          const eligible = decision.presentationBlockDeclaration?.subjects.find(
            (subject) => subject.subjectId === blocker.id,
          );
          if (name !== 'Trumpeting Carnosaur' && !name.startsWith('Etali')) {
            expect(eligible?.attackers.map((target) => target.attackerId) ?? []).not.toContain(
              source.id,
            );
            return declareBlocks(decision, () => null);
          }
          return declareBlocks(decision, (id) => (id === blocker.id ? source.id : null));
        }
        if (decision.decisionType === 'assignCombatDamage')
          return { index: 0, targets: new Map(), combatDamageSplit: { [blocker.id]: 2, P2: 5 } };
        return answer(decision);
      });
      if (name === 'Trumpeting Carnosaur' || name.startsWith('Etali')) {
        expect(sawBlockMenu).toBe(true);
        expect(p(ctx, 'P2').life).toBe(35);
      } else expect(p(ctx, 'P2').life).toBe(40 - (interpretCard(pin(name)).power ?? 0));
    }
  });
  it('pr09-songbirds-enchant-and-legal-aura-entry — normal Aura casting enchants a creature and its attack puts the revealed Aura on a legal host', () => {
    const ctx = pod('pr09-songbirds-positive');
    const host = spawn(
      ctx,
      'P1',
      oracle({ name: 'Blessed host', typeLine: 'Creature — Bird', power: '2', toughness: '2' }),
    );
    host.summoningSick = false;
    const source = cast(ctx, SONG, new Map([[0, host.id]]));
    expect(source.attachedTo).toBe(host.id);
    const hit = library(
      ctx,
      oracle({
        name: 'Revealed legal aura',
        typeLine: 'Enchantment — Aura',
        manaCost: '{W}',
        oracleText: 'Enchant creature\nEnchanted creature gets +1/+1.',
      }),
    );
    pump(runCombatPhase(ctx), (decision) => {
      if (decision.decisionType === 'declareAttackers')
        return declareAttacks(decision, (id) => (id === host.id ? 'P2' : null));
      if (decision.decisionType === 'declareBlockers') return declareBlocks(decision, () => null);
      if (decision.options.some((option) => option.type === 'putAura'))
        return {
          index: decision.options.findIndex((option) => option.type === 'putAura'),
          targets: new Map(),
        };
      if (decision.options.some((option) => option.type === 'attachAura'))
        return {
          index: decision.options.findIndex((option) => option.payload === host.id),
          targets: new Map(),
        };
      return answer(decision);
    });
    const entered = ctx.state.battlefield.find((permanent) => permanent.cardId === hit.cardId);
    expect(entered?.attachedTo).toBe(host.id);
  });
});
