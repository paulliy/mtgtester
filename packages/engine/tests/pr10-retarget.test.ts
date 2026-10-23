import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { commanderFor, conjure, oracle, pump, spawn } from './fixtures';
import {
  asActive,
  bear,
  castFromHand,
  castOption,
  choose,
  exactMana,
  labShock,
  p,
  pinned,
  pinnedDefinition,
  pod,
} from './pr10-helpers';

const SWAT = pinned('Deflecting Swat');

/** P2 casts Lab Shock at P1's creature; returns that spell and the two creatures. */
function shockAtP1Creature(seed: string) {
  const ctx = pod(seed);
  const mine = spawn(ctx, 'P1', bear('Swat Defender'));
  const theirs = spawn(ctx, 'P2', bear('Swat Attacker'));
  const restore = asActive(ctx, 'P2');
  const shock = castFromHand(ctx, 'P2', labShock(), new Map([[0, mine.id]]));
  restore();
  return { ctx, mine, theirs, shock };
}

function resolveAll(
  ctx: ReturnType<typeof pod>,
  answer?: (decision: PendingDecision) => DecisionOutcome,
) {
  const decisions: PendingDecision[] = [];
  while (ctx.state.stack.length > 0)
    decisions.push(...pump(resolveTopOfStack(ctx), answer).decisions);
  return decisions;
}

describe('PR10.01 Deflecting Swat', () => {
  it('pr10-deflecting-swat-pinned-oracle-supported — both clauses are modeled', () => {
    const def = pinnedDefinition('Deflecting Swat');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.commanderFreeCast).toBe(true);
    expect(def.spellAbility?.targets).toEqual([{ kind: 'stackObject' }]);
    expect(def.spellAbility?.effects).toEqual([{ op: 'chooseNewTargets', target: 0 }]);
  });

  it('pr10-deflecting-swat-redirects-spell — a normal cast moves the spell to a new target', () => {
    const { ctx, mine, theirs, shock } = shockAtP1Creature('pr10-swat-redirect');
    castFromHand(ctx, 'P1', SWAT, new Map([[0, shock.id]]));
    const stackSize = ctx.state.stack.length;
    pump(resolveTopOfStack(ctx), choose('Swat Attacker'));
    // Not a copy: the same spell remains, now aimed elsewhere.
    expect(ctx.state.stack).toHaveLength(stackSize - 1);
    expect(ctx.state.stack[0]!.id).toBe(shock.id);
    expect(ctx.state.stack[0]!.targets).toEqual([theirs.id]);
    resolveAll(ctx);
    expect(mine.damageMarked).toBe(0);
    expect(theirs.damageMarked).toBe(2);
  });

  it('pr10-deflecting-swat-may-keep — keeping every target leaves the spell unchanged', () => {
    const { ctx, mine, shock } = shockAtP1Creature('pr10-swat-keep');
    castFromHand(ctx, 'P1', SWAT, new Map([[0, shock.id]]));
    const { decisions } = pump(resolveTopOfStack(ctx), choose('Keep'));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.options[0]!.description).toBe('Keep Swat Defender as the target');
    expect(ctx.state.stack[0]!.targets).toEqual([mine.id]);
    expect(ctx.state.eventLog.some((event) => event.type === 'stackTargetsChanged')).toBe(false);
  });

  it('pr10-deflecting-swat-legal-new-targets — offers only legal targets, never itself or the spell', () => {
    const { ctx, shock } = shockAtP1Creature('pr10-swat-legal');
    spawn(ctx, 'P3', bear('Hexproof Bear', { oracleText: 'Hexproof', keywords: ['Hexproof'] }));
    castFromHand(ctx, 'P1', SWAT, new Map([[0, shock.id]]));
    const { decisions } = pump(resolveTopOfStack(ctx), choose('Keep'));
    const offered = decisions[0]!.options.map((option) => option.description);
    expect(offered).toContain('Target Swat Attacker');
    expect(offered).toContain('Target P3');
    // Hexproof is checked against the spell's controller, P2, who does not control it.
    expect(offered).not.toContain('Target Hexproof Bear');
    expect(offered.some((description) => description.includes('Lab Shock'))).toBe(false);
  });

  it('pr10-deflecting-swat-ability — retargets an activated ability on the stack', () => {
    const ctx = pod('pr10-swat-ability');
    const mine = spawn(ctx, 'P1', bear('Ability Victim'));
    const other = spawn(ctx, 'P3', bear('Ability Bystander'));
    const pinger = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Lab Pinger',
        typeLine: 'Creature — Human',
        power: '1',
        toughness: '1',
        oracleText: '{T}: Lab Pinger deals 1 damage to any target.',
      }),
    );
    pinger.summoningSick = false;
    const restore = asActive(ctx, 'P2');
    const activate = applyPriorityActionFor(ctx, 'P2', 'Lab Pinger');
    pump(activate(new Map([[0, mine.id]])));
    restore();
    const ability = ctx.state.stack.at(-1)!;
    expect(ability.kind).toBe('activatedAbility');
    castFromHand(ctx, 'P1', SWAT, new Map([[0, ability.id]]));
    pump(resolveTopOfStack(ctx), choose('Ability Bystander'));
    expect(ctx.state.stack.at(-1)!.targets).toEqual([other.id]);
    resolveAll(ctx);
    expect(mine.damageMarked).toBe(0);
    expect(other.damageMarked).toBe(1);
  });

  it('pr10-deflecting-swat-ward — a newly chosen warded target triggers ward', () => {
    const { ctx, shock } = shockAtP1Creature('pr10-swat-ward');
    // Ward triggers only for an opponent of the permanent's controller: the spell's P2.
    spawn(ctx, 'P3', bear('Warded Bear', { oracleText: 'Ward {2}', keywords: ['Ward'] }));
    castFromHand(ctx, 'P1', SWAT, new Map([[0, shock.id]]));
    pump(resolveTopOfStack(ctx), choose('Warded Bear'));
    expect(ctx.state.pendingTriggers.some((trigger) => trigger.sourceName === 'Warded Bear')).toBe(
      true,
    );
  });

  it('pr10-deflecting-swat-targetless — a spell without targets resolves Swat with no choice', () => {
    const ctx = pod('pr10-swat-targetless');
    const restore = asActive(ctx, 'P2');
    const draw = castFromHand(
      ctx,
      'P2',
      oracle({
        name: 'Lab Divination',
        typeLine: 'Sorcery',
        manaCost: '{1}',
        cmc: 1,
        power: null,
        toughness: null,
        oracleText: 'Draw a card.',
      }),
    );
    restore();
    castFromHand(ctx, 'P1', SWAT, new Map([[0, draw.id]]));
    const { decisions } = pump(resolveTopOfStack(ctx));
    expect(decisions).toHaveLength(0);
    expect(ctx.state.stack.map((entry) => entry.id)).toEqual([draw.id]);
  });

  it('pr10-deflecting-swat-commander-free-cast — free only while you control a commander', () => {
    const { ctx, shock } = shockAtP1Creature('pr10-swat-free');
    const swat = conjure(ctx, 'P1', SWAT, 'hand');
    expect(castOption(ctx, 'P1', swat.id, 'commanderFree')).toBeUndefined();
    const commander = spawn(ctx, 'P1', commanderFor('R', 'Lab Commander'));
    commander.isCommander = true;
    const free = castOption(ctx, 'P1', swat.id, 'commanderFree');
    expect(free, 'commander free cast is offered').toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), free!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, shock.id]]),
      }),
    );
    expect(ctx.state.stack.at(-1)!.sourceCardId).toBe(swat.cardId);
  });

  it('pr10-deflecting-swat-insufficient-cost — the printed cast needs {2}{R}', () => {
    const { ctx } = shockAtP1Creature('pr10-swat-short');
    const swat = conjure(ctx, 'P1', SWAT, 'hand');
    addMana(p(ctx, 'P1'), exactMana(interpretCard(SWAT)).slice(0, -1));
    expect(castOption(ctx, 'P1', swat.id)).toBeUndefined();
  });

  it('pr10-deflecting-swat-needs-target — not castable with an empty stack', () => {
    const ctx = pod('pr10-swat-empty');
    const swat = conjure(ctx, 'P1', SWAT, 'hand');
    addMana(p(ctx, 'P1'), exactMana(interpretCard(SWAT)));
    expect(castOption(ctx, 'P1', swat.id)).toBeUndefined();
  });
});

/** The real activation action of `name`'s first activated ability. */
function applyPriorityActionFor(ctx: ReturnType<typeof pod>, playerId: string, name: string) {
  return (targets: Map<number, string>) => {
    const option = computePriorityOptions(ctx, p(ctx, playerId)).find(
      (candidate) => candidate.type === 'activateAbility' && candidate.description.includes(name),
    );
    if (option === undefined) throw new Error(`${name} has no activation option`);
    return applyPriorityAction(ctx, p(ctx, playerId), option.payload as PriorityActionPayload, {
      index: 0,
      targets,
    });
  };
}

const BEND = pinned('Bolt Bend');
const big = (name: string) => bear(name, { power: '4', toughness: '4' });

describe('PR10.11 Bolt Bend', () => {
  it('pr10-bolt-bend-pinned-oracle-supported — both clauses are modeled', () => {
    const def = pinnedDefinition('Bolt Bend');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.spellAbility?.targets).toEqual([
      { kind: 'stackObject', spellHasSingleTarget: true },
    ]);
  });

  it('pr10-bolt-bend-changes-target — the spell must move to another legal target', () => {
    const { ctx, mine, theirs, shock } = shockAtP1Creature('pr10-bend-change');
    castFromHand(ctx, 'P1', BEND, new Map([[0, shock.id]]));
    const { decisions } = pump(resolveTopOfStack(ctx), choose('Swat Attacker'));
    const offered = decisions[0]!.options.map((option) => option.description);
    // "Change the target" has no keep option, and the old target is not offered.
    expect(offered).not.toContain('Target Swat Defender');
    expect(offered.some((description) => description.startsWith('Keep'))).toBe(false);
    expect(ctx.state.stack.map((entry) => entry.id)).toEqual([shock.id]);
    resolveAll(ctx);
    expect(mine.damageMarked).toBe(0);
    expect(theirs.damageMarked).toBe(2);
  });

  it('pr10-bolt-bend-ability — changes the target of an ability with a single target', () => {
    const ctx = pod('pr10-bend-ability');
    const mine = spawn(ctx, 'P1', bear('Bend Victim'));
    const other = spawn(ctx, 'P4', bear('Bend Bystander'));
    const pinger = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Bend Pinger',
        typeLine: 'Creature — Human',
        power: '1',
        toughness: '1',
        oracleText: '{T}: Bend Pinger deals 1 damage to any target.',
      }),
    );
    pinger.summoningSick = false;
    const restore = asActive(ctx, 'P2');
    pump(applyPriorityActionFor(ctx, 'P2', 'Bend Pinger')(new Map([[0, mine.id]])));
    restore();
    const ability = ctx.state.stack.at(-1)!;
    castFromHand(ctx, 'P1', BEND, new Map([[0, ability.id]]));
    pump(resolveTopOfStack(ctx), choose('Bend Bystander'));
    resolveAll(ctx);
    expect(mine.damageMarked).toBe(0);
    expect(other.damageMarked).toBe(1);
  });

  it('pr10-bolt-bend-single-target-only — a spell with two targets is not a legal target', () => {
    const ctx = pod('pr10-bend-two-targets');
    const a = spawn(ctx, 'P1', bear('Bend First'));
    const b = spawn(ctx, 'P1', bear('Bend Second'));
    const restore = asActive(ctx, 'P2');
    const twin = castFromHand(
      ctx,
      'P2',
      oracle({
        name: 'Lab Twin Bolt',
        typeLine: 'Instant',
        manaCost: '{R}',
        cmc: 1,
        colors: ['R'],
        power: null,
        toughness: null,
        oracleText: 'Target creature gets +2/+2 until end of turn.\nTarget player draws a card.',
      }),
      new Map([
        [0, a.id],
        [1, 'P1'],
      ]),
    );
    restore();
    expect(twin.targets.filter((id) => id !== undefined)).toHaveLength(2);
    const bend = conjure(ctx, 'P1', BEND, 'hand');
    addMana(p(ctx, 'P1'), exactMana(interpretCard(BEND)));
    expect(castOption(ctx, 'P1', bend.id), 'no single-target object on the stack').toBeUndefined();
    void b;
  });

  it('pr10-bolt-bend-no-other-target — keeps the target when no other one is legal', () => {
    const ctx = pod('pr10-bend-keep');
    const only = spawn(ctx, 'P1', bear('Bend Only'));
    const restore = asActive(ctx, 'P2');
    const kill = castFromHand(
      ctx,
      'P2',
      oracle({
        name: 'Lab Smite',
        typeLine: 'Instant',
        manaCost: '{W}',
        cmc: 1,
        colors: ['W'],
        power: null,
        toughness: null,
        oracleText: 'Destroy target creature.',
      }),
      new Map([[0, only.id]]),
    );
    restore();
    castFromHand(ctx, 'P1', BEND, new Map([[0, kill.id]]));
    const { decisions } = pump(resolveTopOfStack(ctx));
    expect(decisions).toHaveLength(0);
    expect(ctx.state.stack[0]!.targets).toEqual([only.id]);
  });

  it('pr10-bolt-bend-ferocious-reduction — costs {R} while you control a creature with power 4+', () => {
    const { ctx, shock } = shockAtP1Creature('pr10-bend-reduced');
    spawn(ctx, 'P1', big('Bend Brute'));
    const bend = conjure(ctx, 'P1', BEND, 'hand');
    addMana(p(ctx, 'P1'), [{ symbol: 'R' }]);
    const option = castOption(ctx, 'P1', bend.id);
    expect(option, 'reduced to {R}').toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, shock.id]]),
      }),
    );
    expect(p(ctx, 'P1').manaEntries).toHaveLength(0);
    expect(ctx.state.stack.at(-1)!.sourceCardId).toBe(bend.cardId);
  });

  it('pr10-bolt-bend-no-reduction — an opponent’s or a smaller creature does not reduce it', () => {
    const { ctx } = shockAtP1Creature('pr10-bend-unreduced');
    spawn(ctx, 'P2', big('Their Brute'));
    spawn(ctx, 'P1', bear('My Cub', { power: '3', toughness: '3' }));
    const bend = conjure(ctx, 'P1', BEND, 'hand');
    addMana(p(ctx, 'P1'), [{ symbol: 'R' }]);
    expect(castOption(ctx, 'P1', bend.id)).toBeUndefined();
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }]);
    expect(castOption(ctx, 'P1', bend.id), 'still short of {3}{R}').toBeUndefined();
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }]);
    expect(castOption(ctx, 'P1', bend.id)).toBeDefined();
  });
});
