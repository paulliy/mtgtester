import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import type { PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import type { GameContext } from '../src/state/types';
import { conjure, oracle, pump, spawn } from './fixtures';
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

/** P2 casts Lab Shock at P1's creature. */
function shockAt(seed: string) {
  const ctx = pod(seed);
  const mine = spawn(ctx, 'P1', bear('Copy Defender'));
  const theirs = spawn(ctx, 'P2', bear('Copy Attacker'));
  const restore = asActive(ctx, 'P2');
  const shock = castFromHand(ctx, 'P2', labShock(), new Map([[0, mine.id]]));
  restore();
  return { ctx, mine, theirs, shock };
}

function resolveAll(ctx: GameContext, answer?: (decision: PendingDecision) => DecisionOutcome) {
  while (ctx.state.stack.length > 0) pump(resolveTopOfStack(ctx), answer);
}

const labBear = () =>
  oracle({
    name: 'Lab Creature Spell',
    typeLine: 'Creature — Bear',
    manaCost: '{1}',
    cmc: 1,
    power: '2',
    toughness: '2',
  });

for (const name of ['Reverberate', 'Flare of Duplication'] as const) {
  const card = pinned(name);
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '-');

  describe(`PR10 ${name}`, () => {
    it(`pr10-${slug}-pinned-oracle-supported — the copy clause is modeled`, () => {
      const def = pinnedDefinition(name);
      expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
      expect(def.spellAbility?.effects).toEqual([
        { op: 'copyTargetSpell', target: 0, newTargets: true },
      ]);
    });

    it(`pr10-${slug}-copy-new-target — the copy is a separate spell aimed where you choose`, () => {
      const { ctx, mine, theirs, shock } = shockAt(`pr10-${slug}-new`);
      castFromHand(ctx, 'P1', card, new Map([[0, shock.id]]));
      pump(resolveTopOfStack(ctx), choose('Copy Attacker'));
      const copy = ctx.state.stack.at(-1)!;
      expect(copy.id).not.toBe(shock.id);
      expect(copy.controllerId).toBe('P1');
      expect(copy.card).toBeNull();
      expect(copy.targets).toEqual([theirs.id]);
      // The original keeps its own target.
      expect(ctx.state.stack.find((entry) => entry.id === shock.id)!.targets).toEqual([mine.id]);
      // A copy is not cast.
      expect(
        ctx.state.eventLog.filter(
          (event) => event.type === 'castSpell' && event.payload['player'] === 'P1',
        ),
      ).toHaveLength(1);
      resolveAll(ctx);
      expect(theirs.damageMarked).toBe(2);
      expect(mine.damageMarked).toBe(2);
    });

    it(`pr10-${slug}-copy-keep-target — keeping the target copies the original choice`, () => {
      const { ctx, mine, shock } = shockAt(`pr10-${slug}-keep`);
      castFromHand(ctx, 'P1', card, new Map([[0, shock.id]]));
      pump(resolveTopOfStack(ctx), choose('Keep'));
      expect(ctx.state.stack.at(-1)!.targets).toEqual([mine.id]);
      resolveAll(ctx);
      expect(mine.damageMarked).toBe(4);
    });

    it(`pr10-${slug}-instant-or-sorcery-only — a creature spell is not a legal target`, () => {
      const ctx = pod(`pr10-${slug}-creature`);
      const restore = asActive(ctx, 'P2');
      castFromHand(ctx, 'P2', labBear());
      restore();
      const inHand = conjure(ctx, 'P1', card, 'hand');
      addMana(p(ctx, 'P1'), exactMana(interpretCard(card)));
      expect(castOption(ctx, 'P1', inHand.id)).toBeUndefined();
    });

    it(`pr10-${slug}-insufficient-cost — not castable short one mana`, () => {
      const { ctx } = shockAt(`pr10-${slug}-short`);
      const inHand = conjure(ctx, 'P1', card, 'hand');
      addMana(p(ctx, 'P1'), exactMana(interpretCard(card)).slice(0, -1));
      expect(castOption(ctx, 'P1', inHand.id)).toBeUndefined();
    });
  });
}

describe('PR10.14 Flare of Duplication alternative cost', () => {
  const card = pinned('Flare of Duplication');

  function altOption(ctx: GameContext, objectId: string) {
    return castOption(ctx, 'P1', objectId, 'nonMana');
  }

  it('pr10-flare-of-duplication-sacrifice-cost — sacrificing a nontoken red creature casts it free', () => {
    const { ctx, shock } = shockAt('pr10-flare-sac');
    const red = spawn(ctx, 'P1', bear('Red Volunteer', { colors: ['R'], manaCost: '{R}' }));
    const inHand = conjure(ctx, 'P1', card, 'hand');
    const option = altOption(ctx, inHand.id);
    expect(option, 'sacrifice alternative cost is offered').toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, shock.id]]),
      }),
      choose('Red Volunteer'),
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.id === red.id)).toBe(false);
    expect(
      p(ctx, 'P1').graveyard.some((graveyardCard) => graveyardCard.name === 'Red Volunteer'),
    ).toBe(true);
    expect(ctx.state.stack.at(-1)!.sourceCardId).toBe(inHand.cardId);
  });

  it('pr10-flare-of-duplication-sacrifice-filter — a token or nonred creature does not pay it', () => {
    const { ctx } = shockAt('pr10-flare-no-sac');
    spawn(ctx, 'P1', bear('Green Volunteer', { colors: ['G'], manaCost: '{G}' }));
    const token = spawn(ctx, 'P1', bear('Red Token', { colors: ['R'] }));
    token.isToken = true;
    spawn(ctx, 'P2', bear('Their Red', { colors: ['R'], manaCost: '{R}' }));
    const inHand = conjure(ctx, 'P1', card, 'hand');
    expect(altOption(ctx, inHand.id)).toBeUndefined();
  });
});

describe('PR10.12 Display of Power', () => {
  const card = pinned('Display of Power');

  it('pr10-display-of-power-pinned-oracle-supported — both clauses are modeled', () => {
    const def = pinnedDefinition('Display of Power');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.cantBeCopied).toBe(true);
  });

  it('pr10-display-of-power-copies-each — copies every chosen spell, each with new targets', () => {
    const { ctx, mine, theirs, shock } = shockAt('pr10-display-each');
    const other = spawn(ctx, 'P3', bear('Third Bear'));
    const restore = asActive(ctx, 'P3');
    const second = castFromHand(ctx, 'P3', labShock(), new Map([[0, mine.id]]));
    restore();
    // A flash creature spell is on the stack too, but Display of Power targets only instants and sorceries.
    const flashRestore = asActive(ctx, 'P3');
    const flashBear = castFromHand(
      ctx,
      'P3',
      oracle({
        name: 'Lab Flash Bear',
        typeLine: 'Creature — Bear',
        manaCost: '{1}',
        cmc: 1,
        power: '2',
        toughness: '2',
        oracleText: 'Flash',
      }),
    );
    flashRestore();
    expect(ctx.state.stack.some((entry) => entry.id === flashBear.id)).toBe(true);
    const display = conjure(ctx, 'P1', card, 'hand');
    addMana(p(ctx, 'P1'), exactMana(interpretCard(card)));
    const option = castOption(ctx, 'P1', display.id);
    expect(option).toBeDefined();
    const targetMenus = pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
      // Counted targets are picked one at a time; the first offered spell is the earliest.
      (decision) => {
        expect(
          decision.options.map((entry) => entry.description).join(' | '),
          'the creature spell is not a legal target',
        ).not.toContain('Lab Flash Bear');
        return choose('Lab Shock (on the stack)')(decision);
      },
    ).decisions;
    const offered = targetMenus.flatMap((decision) =>
      decision.options.map((entry) => entry.description),
    );
    expect(offered.some((description) => description.includes('Lab Shock'))).toBe(true);
    expect(offered.some((description) => description.includes('Lab Flash Bear'))).toBe(false);
    expect(ctx.state.stack.at(-1)!.countTargets).toEqual({ 0: [shock.id, second.id] });
    let call = 0;
    pump(resolveTopOfStack(ctx), (decision) =>
      choose(call++ === 0 ? 'Copy Attacker' : 'Third Bear')(decision),
    );
    const copies = ctx.state.stack.filter((entry) => entry.controllerId === 'P1');
    expect(copies.map((entry) => entry.targets)).toEqual([[theirs.id], [other.id]]);
  });

  it('pr10-display-of-power-zero-targets — may be cast choosing no spells', () => {
    const { ctx } = shockAt('pr10-display-zero');
    const display = conjure(ctx, 'P1', card, 'hand');
    addMana(p(ctx, 'P1'), exactMana(interpretCard(card)));
    expect(castOption(ctx, 'P1', display.id)).toBeDefined();
  });

  it('pr10-display-of-power-cant-be-copied — Reverberate targeting it creates no copy', () => {
    const { ctx, shock } = shockAt('pr10-display-uncopyable');
    const restore = asActive(ctx, 'P2');
    // P2 answers with Display of Power, which P1 then tries to Reverberate.
    const display = conjure(ctx, 'P2', card, 'hand');
    addMana(p(ctx, 'P2'), exactMana(interpretCard(card)));
    const option = castOption(ctx, 'P2', display.id);
    pump(
      applyPriorityAction(ctx, p(ctx, 'P2'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
      (decision) =>
        choose(
          decision.prompt.startsWith('Choose target 1')
            ? 'Lab Shock (on the stack)'
            : 'Choose no more targets',
        )(decision),
    );
    expect(ctx.state.stack.at(-1)!.countTargets).toEqual({ 0: [shock.id] });
    restore();
    const displayEntry = ctx.state.stack.at(-1)!;
    castFromHand(ctx, 'P1', pinned('Reverberate'), new Map([[0, displayEntry.id]]));
    const before = ctx.state.stack.length;
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.stack).toHaveLength(before - 1);
    expect(ctx.state.stack.at(-1)!.id).toBe(displayEntry.id);
  });
});
