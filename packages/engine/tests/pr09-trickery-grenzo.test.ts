import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { Prng } from '../src/rng/prng';
import { ofType } from '../src/cards/selector';
import type { ManaEntry } from '../src/cards/ability';
import { addMana } from '../src/mana/pool';
import { runCombatPhase } from '../src/combat/combat';
import { cleanupStep } from '../src/turn/turn';
import { resolveTopOfStack } from '../src/stack/stack';
import { moveObject, playerById } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import {
  copies,
  conjure,
  declareAttacks,
  declareNoBlocks,
  forest,
  gameConfig,
  oracle,
  pump,
  spawn,
} from './fixtures';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
) as {
  cards: { sha256: string; card: OracleCard }[];
};
function pinned(name: string): OracleCard {
  const entry = fixture.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing PR09 pin ${name}`);
  expect(createHash('sha256').update(JSON.stringify(entry.card)).digest('hex')).toBe(entry.sha256);
  return entry.card;
}
const facePins = JSON.parse(
  readFileSync(new URL('./fixtures/selected-spell-faces-oracle.json', import.meta.url), 'utf8'),
) as { cards: { card: OracleCard }[] };
const foulmire = facePins.cards.find(({ card }) => card.name.startsWith('Foulmire Knight'))!.card;
const TRICKERY = pinned("Tibalt's Trickery");
const GRENZO = pinned('Grenzo, Havoc Raiser');
const CHIMIL = pinned('Chimil, the Inner Sun');

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
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
  for (const player of ctx.state.players) {
    player.hand = [];
    player.library = [];
  }
  return ctx;
}
const p = (ctx: GameContext, id: string): EnginePlayerState => playerById(ctx, id);
const simpleSpell = (name: string, cost = '{1}') =>
  oracle({
    name,
    typeLine: 'Instant',
    manaCost: cost,
    cmc: cost.length > 2 ? 2 : 1,
    oracleText: 'Draw a card.',
  });
const card = (name: string, typeLine: string, cost = '{1}') =>
  oracle({
    name,
    typeLine,
    manaCost: cost,
    cmc: cost.length > 2 ? 2 : 1,
    power: typeLine.includes('Creature') ? '2' : null,
    toughness: typeLine.includes('Creature') ? '2' : null,
    oracleText: typeLine.includes('Creature') ? '' : '',
  });
function pass(d: PendingDecision): DecisionOutcome {
  const index = d.options.findIndex(
    (option) =>
      option.type === 'pass' ||
      (option.payload as Partial<PriorityActionPayload> | undefined)?.kind === 'pass',
  );
  if (index < 0) throw new Error(`No pass option: ${d.prompt}`);
  return { index, targets: new Map() };
}
function choose(d: PendingDecision, re: RegExp): DecisionOutcome {
  const index = d.options.findIndex((option) => re.test(option.description));
  if (index < 0)
    throw new Error(`No ${re} option: ${d.options.map((o) => o.description).join(' | ')}`);
  const option = d.options[index]!;
  return {
    index,
    targets: new Map((option.targets ?? []).map((target) => [target.slot, target.options[0]!])),
  };
}
function addLibrary(ctx: GameContext, owner: string, definitions: OracleCard[]) {
  const objects = definitions.map((definition) => conjure(ctx, owner, definition, 'library'));
  p(ctx, owner).library = objects;
  return objects;
}
function castFromHand(
  ctx: GameContext,
  playerId: string,
  definition: OracleCard,
  symbols: ('B' | 'C' | 'G' | 'R' | 'U' | 'W')[],
  targets = new Map<number, string>(),
) {
  const object = conjure(ctx, playerId, definition, 'hand');
  addMana(
    p(ctx, playerId),
    symbols.map((symbol) => ({ symbol })),
  );
  const option = computePriorityOptions(ctx, p(ctx, playerId)).find(
    (candidate) =>
      candidate.type === 'castSpell' &&
      (candidate.payload as PriorityActionPayload).kind === 'castSpell' &&
      (candidate.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>).objectId ===
        object.id,
  );
  if (option === undefined) throw new Error(`${definition.name} has no normal cast option`);
  pump(
    applyPriorityAction(ctx, p(ctx, playerId), option.payload as PriorityActionPayload, {
      index: 0,
      targets,
    }),
  );
  return object;
}
function castTrickery(ctx: GameContext, targetId: string) {
  const spell = castFromHand(ctx, 'P1', TRICKERY, ['R', 'C'], new Map([[0, targetId]]));
  return spell;
}
function normalCastOnStack(
  ctx: GameContext,
  playerId: string,
  definition: OracleCard,
  symbols: ('B' | 'C' | 'G' | 'R' | 'U' | 'W')[],
) {
  castFromHand(ctx, playerId, definition, symbols);
  const stackObject = ctx.state.stack.at(-1);
  if (stackObject === undefined || stackObject.kind !== 'spell')
    throw new Error(`${definition.name} did not remain on the stack`);
  return stackObject;
}
function resolveTrickery(ctx: GameContext, castResult: boolean) {
  return pump(resolveTopOfStack(ctx), (d) => {
    if (d.options.some((option) => option.type === 'castFree'))
      return choose(d, castResult ? /Cast .* free/ : /^Decline the free cast$/);
    return pass(d);
  });
}
function setTop(ctx: GameContext, ownerId: string, definitions: OracleCard[]) {
  const cards = addLibrary(ctx, ownerId, definitions);
  p(ctx, ownerId).library = cards;
  return cards;
}
function resolveGrenzo(ctx: GameContext, mode: 'goad' | 'exile', targetId?: string) {
  const grenzo = ctx.state.battlefield.find(
    (permanent) => permanent.name === 'Grenzo, Havoc Raiser',
  )!;
  const attackers = [grenzo];
  const ids = new Set(attackers.map((attacker) => attacker.id));
  return pump(runCombatPhase(ctx), (d) => {
    if (d.decisionType === 'declareAttackers')
      return declareAttacks(d, (id) => (ids.has(id) ? 'P2' : null));
    // Grenzo's trigger is mandatory: its mode is chosen, never a "use this ability?" question.
    expect(d.decisionType).not.toBe('optionalTrigger');
    if (d.options.some((option) => /Goad|Exile their top card/.test(option.description)))
      return choose(d, mode === 'goad' ? /Goad/ : /Exile their top card/);
    if (d.decisionType === 'declareBlockers') return declareNoBlocks(d);
    if (d.decisionType === 'chooseTargets') {
      if (targetId !== undefined) {
        const targetSlot = d.options[0]?.targets?.find((slot) => slot.options.includes(targetId));
        if (targetSlot !== undefined)
          return { index: 0, targets: new Map([[targetSlot.slot, targetId]]) };
      }
      return { index: 0, targets: new Map() };
    }
    return d.decisionType === 'priority' ? pass(d) : pass(d);
  });
}

describe('PR09 Trickery and Grenzo', () => {
  it('pr09-trickery-target-any-spell — can target spells controlled by you or an opponent', () => {
    for (const targetController of ['P1', 'P2']) {
      const ctx = pod(`pr09-trickery-target-${targetController}`);
      const target = normalCastOnStack(
        ctx,
        targetController,
        simpleSpell(`Target ${targetController}`),
        ['C'],
      );
      if (targetController === 'P1') addMana(p(ctx, 'P1'), [{ symbol: 'R' }, { symbol: 'C' }]);
      castTrickery(ctx, target.id);
      expect(ctx.state.stack.some((entry) => entry.id === target.id)).toBe(true);
      expect(ctx.state.stack.at(-1)?.description).toContain("Tibalt's Trickery");
    }
    expect(interpretCard(TRICKERY).spellAbility?.targets?.[0]?.kind).toBe('spell');
  });

  it('pr09-trickery-seeded-random-mills — the seeded result mills exactly one, two, or three cards', () => {
    for (const wanted of [0, 1, 2]) {
      let seed = '';
      for (let i = 0; i < 500; i++) {
        const candidate = `trickery-mill-${wanted}-${i}`;
        if (new Prng(candidate).nextInt(3) === wanted) {
          seed = candidate;
          break;
        }
      }
      expect(seed).not.toBe('');
      const ctx = pod(seed);
      const target = normalCastOnStack(ctx, 'P2', simpleSpell(`Target ${wanted}`), ['C']);
      const millCards = Array.from({ length: 5 }, (_, i) =>
        card(`Mill ${wanted}-${i}`, 'Land', '{0}'),
      );
      const hit = simpleSpell(`Hit ${wanted}`);
      setTop(ctx, 'P2', [...millCards, hit]);
      castTrickery(ctx, target.id);
      resolveTrickery(ctx, false);
      expect(ctx.state.eventLog.filter((event) => event.type === 'mill')).toHaveLength(wanted + 1);
      expect(
        p(ctx, 'P2').graveyard.filter((entry) => entry.name.startsWith(`Mill ${wanted}-`)),
      ).toHaveLength(wanted + 1);
    }
  });

  it('pr09-trickery-public-exile-and-different-name — reveals/exiles publicly, skips lands and same-name spells, then offers a different spell', () => {
    const ctx = pod('pr09-trickery-different-name');
    const targetCard = simpleSpell('Same Name');
    const target = normalCastOnStack(ctx, 'P2', targetCard, ['C']);
    const cards = setTop(ctx, 'P2', [
      ...Array.from({ length: 4 }, () => simpleSpell('Same Name')),
      ...Array.from({ length: 4 }, (_, index) =>
        card(`Trickery Skip Land ${index}`, 'Land', '{0}'),
      ),
      simpleSpell('Different Name'),
    ]);
    castTrickery(ctx, target.id);
    const resolved = resolveTrickery(ctx, false);
    expect(
      resolved.decisions.some((d) =>
        d.options.some((option) => /Different Name/.test(option.description)),
      ),
    ).toBe(true);
    const exiled = ctx.state.eventLog.filter(
      (event) => event.type === 'zoneChange' && event.payload['to'] === 'exile',
    );
    expect(exiled.length).toBeGreaterThan(0);
    const exiledNames = exiled.map((event) => event.payload['name']);
    expect(exiledNames).toContain('Different Name');
    expect(exiledNames).toContain('Same Name');
    expect(exiledNames.some((name) => String(name).startsWith('Trickery Skip Land'))).toBe(true);
    expect(
      exiled.every(
        (event) =>
          event.payload['owner'] === 'P2' && typeof event.payload['newObjectId'] === 'string',
      ),
    ).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(false);
    expect(cards.some((entry) => p(ctx, 'P2').library.includes(entry))).toBe(true);
  });

  it('pr09-trickery-decline-bottom-repeatable — declining leaves every exiled physical card in deterministic seeded bottom order', () => {
    const run = (seed: string) => {
      const ctx = pod(seed);
      const target = normalCastOnStack(ctx, 'P2', simpleSpell('Decline Target'), ['C']);
      const cards = setTop(ctx, 'P2', [
        ...Array.from({ length: 5 }, (_, index) => card(`Decline Land ${index}`, 'Land', '{0}')),
        simpleSpell('Decline Hit'),
        card('Tail Land A', 'Land', '{0}'),
        card('Tail Land B', 'Land', '{0}'),
      ]);
      castTrickery(ctx, target.id);
      resolveTrickery(ctx, false);
      expect(ctx.state.exile).toHaveLength(0);
      return {
        names: p(ctx, 'P2').library.map((entry) => entry.name),
        graveyard: p(ctx, 'P2').graveyard.map((entry) => entry.name),
        ids: cards.map((entry) => entry.cardId),
        presentIds: [...p(ctx, 'P2').library, ...p(ctx, 'P2').graveyard].map(
          (entry) => entry.cardId,
        ),
      };
    };
    const first = run('pr09-trickery-bottom-seed');
    const second = run('pr09-trickery-bottom-seed');
    expect(first.names).toEqual(second.names);
    expect(first.names.length).toBeGreaterThan(2);
    expect(first.ids.every((id) => first.presentIds.includes(id))).toBe(true);
    expect(first.names).toContain('Decline Hit');
    expect(first.names).toContain('Tail Land A');
    expect(first.names).toContain('Tail Land B');
    expect(
      first.names.length +
        first.graveyard.filter((name) => name.startsWith('Decline Land ')).length,
    ).toBe(8);
  });

  it('pr09-trickery-empty-and-fizzle — empty library is safe; absent target does not mill or exile', () => {
    const empty = pod('pr09-trickery-empty');
    const emptyTarget = normalCastOnStack(empty, 'P2', simpleSpell('Empty Target'), ['C']);
    castTrickery(empty, emptyTarget.id);
    resolveTrickery(empty, false);
    expect(p(empty, 'P2').hasLost).toBe(false);
    expect(p(empty, 'P2').graveyard.some((entry) => entry.name === 'Empty Target')).toBe(true);

    const fizzled = pod('pr09-trickery-fizzle');
    const target = normalCastOnStack(fizzled, 'P2', simpleSpell('Gone Target'), ['C']);
    setTop(fizzled, 'P2', [simpleSpell('Fizzle Top')]);
    castTrickery(fizzled, target.id);
    fizzled.state.stack.splice(
      fizzled.state.stack.findIndex((entry) => entry.id === target.id),
      1,
    );
    resolveTrickery(fizzled, false);
    expect(fizzled.state.eventLog.some((event) => event.type === 'mill')).toBe(false);
    expect(
      fizzled.state.eventLog.some(
        (event) => event.type === 'zoneChange' && event.payload['to'] === 'exile',
      ),
    ).toBe(false);
    expect(p(fizzled, 'P2').library.map((entry) => entry.name)).toEqual(['Fizzle Top']);
  });

  it('pr09-trickery-counter-prevented-still-resolves — Chimil protects the spell from countering but Trickery still mills and offers its different-name hit', () => {
    const ctx = pod('pr09-trickery-prevented');
    spawn(ctx, 'P2', CHIMIL);
    const target = normalCastOnStack(ctx, 'P2', simpleSpell('Protected Original'), ['C']);
    setTop(ctx, 'P2', [
      ...Array.from({ length: 5 }, (_, index) => card(`Protected Mill ${index}`, 'Land', '{0}')),
      simpleSpell('Protected Hit'),
    ]);
    castTrickery(ctx, target.id);
    const result = resolveTrickery(ctx, true);
    expect(ctx.state.eventLog.some((event) => event.type === 'counterPrevented')).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'mill')).toBe(true);
    expect(
      result.decisions.some((d) =>
        d.options.some((option) => /Protected Hit/.test(option.description)),
      ),
    ).toBe(true);
    expect(ctx.state.stack.some((entry) => entry.id === target.id)).toBe(true);
  });

  it('pr09-trickery-freecast-normal-stack — casts a different-name hit without mana onto the ordinary stack', () => {
    const ctx = pod('pr09-trickery-freecast-stack');
    const target = normalCastOnStack(ctx, 'P2', simpleSpell('Freecast Counter Target'), ['C']);
    const hit = card('Freecast Result Creature', 'Creature — Test', '{6}');
    setTop(ctx, 'P2', [
      ...Array.from({ length: 4 }, (_, index) => card(`Freecast Mill ${index}`, 'Land', '{0}')),
      hit,
    ]);
    castTrickery(ctx, target.id);
    resolveTrickery(ctx, true);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === hit.name,
      ),
    ).toBe(true);
    expect(
      ctx.state.stack.some(
        (entry) => entry.kind === 'spell' && entry.description.includes(hit.name),
      ),
    ).toBe(true);
    expect(
      ctx.state.exile.some(
        (entry) => entry.name === hit.name && entry.playableUntilEotBy !== undefined,
      ),
    ).toBe(false);
    pump(resolveTopOfStack(ctx));
    expect(
      ctx.state.battlefield.some(
        (permanent) => permanent.name === hit.name && permanent.controllerId === 'P2',
      ),
    ).toBe(true);
  });

  it('pr09-trickery-no-permission-after-decline — decline does not grant a lasting cast permission', () => {
    const ctx = pod('pr09-trickery-no-permission');
    const target = normalCastOnStack(ctx, 'P2', simpleSpell('No Permission Target'), ['C']);
    setTop(ctx, 'P2', [
      card('No Permission Mill', 'Land', '{0}'),
      simpleSpell('No Permission Hit'),
    ]);
    castTrickery(ctx, target.id);
    resolveTrickery(ctx, false);
    expect(ctx.state.exile).toHaveLength(0);
    expect(ctx.state.stack.every((entry) => entry.description !== 'No Permission Hit')).toBe(true);
  });

  it('pr09-grenzo-actual-damage-modes — combat damage to a player announces one mode and damage to a planeswalker does not', () => {
    const ctx = pod('pr09-grenzo-damage');
    const grenzo = spawn(ctx, 'P1', GRENZO);
    grenzo.summoningSick = false;
    spawn(ctx, 'P2', card('Damage Target Creature', 'Creature — Test'));
    const result = resolveGrenzo(ctx, 'exile');
    expect(
      result.decisions.some((decision) =>
        decision.options.some((option) => /Goad|Exile/.test(option.description)),
      ),
    ).toBe(true);
    // An opponent's creature dealing combat damage does not trigger your Grenzo.
    const foeCtx = pod('pr09-grenzo-opponent-creature');
    spawn(foeCtx, 'P1', GRENZO);
    const foeAttacker = spawn(foeCtx, 'P2', card('Opposing Grenzo Attacker', 'Creature — Test'));
    foeAttacker.summoningSick = false;
    setTop(foeCtx, 'P3', [simpleSpell('Foe Damage Sentinel')]);
    Object.assign(foeCtx.state, { currentTurnPlayer: 'P2', activePlayerIndex: 1 });
    const foeResult = pump(runCombatPhase(foeCtx), (d) => {
      if (d.decisionType === 'declareAttackers')
        return declareAttacks(d, (id) => (id === foeAttacker.id ? 'P3' : null));
      expect(d.options.map((option) => option.description).join(' | ')).not.toMatch(
        /Goad|Exile their top card/,
      );
      if (d.decisionType === 'declareBlockers') return declareNoBlocks(d);
      return pass(d);
    });
    expect(foeResult.decisions.length).toBeGreaterThan(0);
    expect(p(foeCtx, 'P3').life).toBe(38);
    expect(foeCtx.state.exile).toHaveLength(0);
    expect(p(foeCtx, 'P3').library).toHaveLength(1);
    const pwCtx = pod('pr09-grenzo-planeswalker');
    const attacker = spawn(pwCtx, 'P1', GRENZO);
    attacker.summoningSick = false;
    const walker = spawn(
      pwCtx,
      'P2',
      oracle({ name: 'Test Planeswalker', typeLine: 'Planeswalker — Test', loyalty: '5' }),
    );
    setTop(pwCtx, 'P2', [simpleSpell('Planeswalker Damage Sentinel')]);
    const ids = new Set([attacker.id]);
    pump(runCombatPhase(pwCtx), (d) =>
      d.decisionType === 'declareAttackers'
        ? declareAttacks(d, (id, subject) =>
            ids.has(id)
              ? (subject.planeswalkers.find((pw) => pw.objectId === walker.id)?.objectId ?? null)
              : null,
          )
        : pass(d),
    );
    expect(pwCtx.state.pendingTriggers.some((trigger) => trigger.sourceName === GRENZO.name)).toBe(
      false,
    );
  });

  it('pr09-grenzo-goad-only-damaged-player — the goad mode targets a creature controlled by the damaged player', () => {
    const ctx = pod('pr09-grenzo-goad');
    const grenzo = spawn(ctx, 'P1', GRENZO);
    grenzo.summoningSick = false;
    const p2Creature = spawn(ctx, 'P2', card('P2 Goad Target', 'Creature — Test'));
    spawn(ctx, 'P2', card('P2 Second Goad Target', 'Creature — Test'));
    const p3Creature = spawn(ctx, 'P3', card('P3 Untouched', 'Creature — Test'));
    const result = resolveGrenzo(ctx, 'goad', p2Creature.id);
    expect(
      result.decisions.some((d) => d.options.some((option) => /Goad/.test(option.description))),
    ).toBe(true);
    const targetDecision = result.decisions.find(
      (decision) => decision.decisionType === 'chooseTargets',
    );
    const legalTargetIds = (targetDecision?.options ?? [])
      .flatMap((option) => option.targets ?? [])
      .flatMap((slot) => slot.options);
    expect(legalTargetIds).toContain(p2Creature.id);
    expect(legalTargetIds).not.toContain(p3Creature.id);
    expect(p2Creature.goadedBy?.length ?? 0).toBeGreaterThan(0);
    expect(p3Creature.goadedBy ?? []).toHaveLength(0);
  });

  it('pr09-grenzo-exile-mode-no-targets — the exile mode resolves without a target choice', () => {
    const ctx = pod('pr09-grenzo-mode-two');
    const grenzo = spawn(ctx, 'P1', GRENZO);
    grenzo.summoningSick = false;
    setTop(ctx, 'P2', [simpleSpell('Grenzo Mode Spell', '{U}')]);
    const result = resolveGrenzo(ctx, 'exile');
    expect(result.decisions.some((d) => d.decisionType === 'chooseTargets')).toBe(false);
    expect(ctx.state.exile.some((entry) => entry.name === 'Grenzo Mode Spell')).toBe(true);
  });

  it('pr09-grenzo-damaged-player-top-paid-permission — exiles the damaged player’s top incarnation and grants paid casting to Grenzo’s controller', () => {
    const ctx = pod('pr09-grenzo-paid-permission');
    const grenzo = spawn(ctx, 'P1', GRENZO);
    grenzo.summoningSick = false;
    const [original] = setTop(ctx, 'P2', [simpleSpell('Grenzo Top Spell', '{U}')]);
    resolveGrenzo(ctx, 'exile');
    const exiled = ctx.state.exile.find((entry) => entry.cardId === original!.cardId)!;
    expect(exiled.id).not.toBe(original!.id);
    expect(exiled.ownerId).toBe('P2');
    expect(exiled.playableUntilEotBy).toBe('P1');
    expect(exiled.castOnlyUntilEot).toBe(true);
    expect(
      computePriorityOptions(ctx, p(ctx, 'P1')).some(
        (option) => (option.payload as { objectId?: string }).objectId === exiled.id,
      ),
    ).toBe(false);
    expect(
      computePriorityOptions(ctx, p(ctx, 'P2')).some(
        (option) => (option.payload as { objectId?: string }).objectId === exiled.id,
      ),
    ).toBe(false);
  });

  it('pr09-grenzo-permission-source-departure-expiry — the paid permission survives Grenzo leaving, then expires at cleanup', () => {
    const ctx = pod('pr09-grenzo-expiry');
    const grenzo = spawn(ctx, 'P1', GRENZO);
    grenzo.summoningSick = false;
    const [original] = setTop(ctx, 'P2', [simpleSpell('Grenzo Expiry Spell', '{U}')]);
    resolveGrenzo(ctx, 'exile');
    const exiled = ctx.state.exile.find((entry) => entry.cardId === original!.cardId)!;
    addMana(p(ctx, 'P1'), [{ symbol: 'R' }, { symbol: 'C' }]);
    pump(moveObject(ctx, grenzo, { zone: 'graveyard' }));
    expect(
      computePriorityOptions(ctx, p(ctx, 'P1')).some(
        (option) =>
          option.type === 'castSpell' &&
          (option.payload as { objectId?: string }).objectId === exiled.id,
      ),
    ).toBe(true);
    pump(cleanupStep(ctx));
    expect(exiled.playableUntilEotBy).toBeUndefined();
    expect(exiled.spendAsAnyColorUntilEot).toBeUndefined();
  });

  it('pr09-grenzo-any-color-replaces-colored-only-and-keeps-generic — red mana can pay blue but still needs generic mana', () => {
    const ctx = pod('pr09-grenzo-any-color');
    const grenzo = spawn(ctx, 'P1', GRENZO);
    grenzo.summoningSick = false;
    const [original] = setTop(ctx, 'P2', [simpleSpell('Grenzo Blue Spell', '{1}{U}')]);
    resolveGrenzo(ctx, 'exile');
    const exiled = ctx.state.exile.find((entry) => entry.cardId === original!.cardId)!;
    addMana(p(ctx, 'P1'), [{ symbol: 'R' }]);
    const notEnough = computePriorityOptions(ctx, p(ctx, 'P1')).some(
      (option) =>
        option.type === 'castSpell' &&
        (option.payload as { objectId?: string }).objectId === exiled.id,
    );
    expect(notEnough).toBe(false);
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }]);
    const paidCast = computePriorityOptions(ctx, p(ctx, 'P1')).find(
      (option) =>
        option.type === 'castSpell' &&
        (option.payload as { objectId?: string }).objectId === exiled.id,
    );
    expect(paidCast).toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), paidCast!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(p(ctx, 'P1').manaEntries).toHaveLength(0);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'Grenzo Blue Spell',
      ),
    ).toBe(true);
    expect(p(ctx, 'P2').graveyard.some((card) => card.cardId === exiled.cardId)).toBe(true);
  });

  it('pr09-grenzo-any-color-keeps-spend-restrictions — any-color permission does not bypass mana restrictions', () => {
    const ctx = pod('pr09-grenzo-restriction');
    const grenzo = spawn(ctx, 'P1', GRENZO);
    grenzo.summoningSick = false;
    const [original] = setTop(ctx, 'P2', [simpleSpell('Grenzo Restricted Blue Spell', '{U}')]);
    resolveGrenzo(ctx, 'exile');
    const exiled = ctx.state.exile.find((entry) => entry.cardId === original!.cardId)!;
    const restricted: ManaEntry = {
      symbol: 'R',
      restriction: {
        purposes: ['castSpell'],
        filter: ofType('Creature'),
        description: 'Only creature spells',
      },
    };
    addMana(p(ctx, 'P1'), [restricted]);
    expect(
      computePriorityOptions(ctx, p(ctx, 'P1')).some(
        (option) =>
          option.type === 'castSpell' &&
          (option.payload as { objectId?: string }).objectId === exiled.id,
      ),
    ).toBe(false);
    addMana(p(ctx, 'P1'), [{ symbol: 'R' }]);
    expect(
      computePriorityOptions(ctx, p(ctx, 'P1')).some(
        (option) =>
          option.type === 'castSpell' &&
          (option.payload as { objectId?: string }).objectId === exiled.id,
      ),
    ).toBe(true);
  });

  it('pr09-grenzo-no-land-play — land top card receives cast-only permission, never a land-play action', () => {
    const ctx = pod('pr09-grenzo-land');
    const grenzo = spawn(ctx, 'P1', GRENZO);
    grenzo.summoningSick = false;
    const [original] = setTop(ctx, 'P2', [card('Grenzo Exiled Land', 'Land', '{0}')]);
    resolveGrenzo(ctx, 'exile');
    const exiled = ctx.state.exile.find((entry) => entry.cardId === original!.cardId)!;
    expect(exiled.playableUntilEotBy).toBe('P1');
    expect(
      computePriorityOptions(ctx, p(ctx, 'P1')).some(
        (option) =>
          option.type === 'playLand' &&
          (option.payload as { objectId?: string }).objectId === exiled.id,
      ),
    ).toBe(false);
  });
});

it('pr09-trickery-adventure-face-name — treats Profane Insight as different from the Foulmire Knight library card', () => {
  const ctx = pod('pr09-trickery-adventure-name');
  const p1 = playerById(ctx, 'P1');
  const adventureCard = conjure(ctx, 'P1', foulmire, 'hand');
  addMana(p1, [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'B' }]);
  const adventureOption = computePriorityOptions(ctx, p1).find((option) => {
    const payload = option.payload as Partial<PriorityActionPayload>;
    return (
      payload.kind === 'castSpell' &&
      payload.objectId === adventureCard.id &&
      payload.alternativeCast === 'adventure'
    );
  });
  expect(adventureOption).toBeDefined();
  pump(
    applyPriorityAction(ctx, p1, adventureOption!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  const adventureSpell = ctx.state.stack.at(-1)!;
  expect(adventureSpell.kind).toBe('spell');
  if (adventureSpell.kind !== 'spell') throw new Error('Adventure did not create a spell');
  expect(adventureSpell.description).toBe('Profane Insight');

  const pad = oracle({
    name: 'Trickery name-check pad',
    typeLine: 'Land',
    manaCost: '',
    cmc: 0,
    oracleText: '',
  });
  const library = [...Array.from({ length: 12 }, () => pad), foulmire].map((definition) =>
    conjure(ctx, 'P1', definition, 'library'),
  );
  p1.library = library;
  const trickeryCard = conjure(ctx, 'P1', TRICKERY, 'hand');
  addMana(p1, [{ symbol: 'R' }, { symbol: 'C' }]);
  const trickeryOption = computePriorityOptions(ctx, p1).find((option) => {
    const payload = option.payload as Partial<PriorityActionPayload>;
    return payload.kind === 'castSpell' && payload.objectId === trickeryCard.id;
  });
  expect(trickeryOption).toBeDefined();
  pump(
    applyPriorityAction(ctx, p1, trickeryOption!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map([[0, adventureSpell.id]]),
    }),
  );
  let freeCastWasOffered = false;
  pump(resolveTopOfStack(ctx), (decision) => {
    const index = decision.options.findIndex((option) =>
      /Cast Foulmire Knight/.test(option.description),
    );
    if (index >= 0) {
      freeCastWasOffered = true;
      return { index, targets: new Map() };
    }
    const passIndex = decision.options.findIndex((option) => option.type === 'pass');
    return { index: Math.max(0, passIndex), targets: new Map() };
  });
  expect(freeCastWasOffered).toBe(true);
  const freeCast = ctx.state.stack.at(-1)!;
  expect(freeCast.description).toBe('Foulmire Knight // Profane Insight');
  expect(freeCast.card?.name).toBe('Foulmire Knight // Profane Insight');
});
