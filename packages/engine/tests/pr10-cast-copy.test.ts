import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import type { PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlGiftOverrides } from '../src/cards/overrides/white-black-control-gifts';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { priorityCheckpoint } from '../src/sba/sba';
import { queueStepTriggers } from '../src/turn/turn';
import type { GameContext } from '../src/state/types';
import { conjure, oracle, pump, spawn } from './fixtures';
import {
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

/** State-based actions, then waiting triggers onto the stack (CR 117.5). */
function putPendingTriggersOnStack(ctx: GameContext) {
  pump(priorityCheckpoint(ctx));
}

function resolveAll(ctx: GameContext, answer?: (decision: PendingDecision) => DecisionOutcome) {
  for (let guard = 0; guard < 50; guard++) {
    putPendingTriggersOnStack(ctx);
    if (ctx.state.stack.length === 0) return;
    pump(resolveTopOfStack(ctx), answer);
  }
  throw new Error('stack did not settle');
}

const labDraw = () =>
  oracle({
    name: 'Lab Divination',
    typeLine: 'Sorcery',
    manaCost: '{1}',
    cmc: 1,
    power: null,
    toughness: null,
    oracleText: 'Draw a card.',
  });
const labArtifact = () =>
  oracle({
    name: 'Lab Trinket',
    typeLine: 'Artifact',
    manaCost: '{1}',
    cmc: 1,
    power: null,
    toughness: null,
  });
const labCreature = () =>
  oracle({
    name: 'Lab Creature Spell',
    typeLine: 'Creature — Bear',
    manaCost: '{1}',
    cmc: 1,
    power: '2',
    toughness: '2',
  });

describe('PR10.19 Galvanic Iteration', () => {
  const card = pinned('Galvanic Iteration');

  it('pr10-galvanic-iteration-pinned-oracle-supported — both clauses are modeled', () => {
    const def = pinnedDefinition('Galvanic Iteration');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(
      def.alternativeCasts?.some(
        (alt) =>
          alt.kind === 'nonMana' &&
          alt.from === 'graveyard' &&
          alt.exileOnResolution === true &&
          alt.description === 'Flashback {1}{U}{R}',
      ),
    ).toBe(true);
  });

  it('pr10-galvanic-iteration-copies-next — copies the next instant or sorcery, with new targets', () => {
    const ctx = pod('pr10-galvanic-next');
    const a = spawn(ctx, 'P2', bear('Galvanic First'));
    const b = spawn(ctx, 'P3', bear('Galvanic Second'));
    castFromHand(ctx, 'P1', card);
    resolveAll(ctx);
    expect(ctx.state.delayedTriggers).toHaveLength(1);
    const shock = castFromHand(ctx, 'P1', labShock(), new Map([[0, a.id]]));
    expect(ctx.state.delayedTriggers).toHaveLength(0);
    putPendingTriggersOnStack(ctx);
    // The delayed trigger is above the spell; resolving it copies the spell.
    pump(resolveTopOfStack(ctx), choose('Galvanic Second'));
    const copy = ctx.state.stack.at(-1)!;
    expect(copy.id).not.toBe(shock.id);
    expect(copy.card).toBeNull();
    expect(copy.targets).toEqual([b.id]);
    resolveAll(ctx);
    expect(a.damageMarked).toBe(2);
    expect(b.damageMarked).toBe(2);
  });

  it('pr10-galvanic-iteration-only-next — only the next matching spell is copied', () => {
    const ctx = pod('pr10-galvanic-once');
    castFromHand(ctx, 'P1', card);
    resolveAll(ctx);
    castFromHand(ctx, 'P1', labDraw());
    resolveAll(ctx);
    const handBefore = p(ctx, 'P1').hand.length;
    castFromHand(ctx, 'P1', labDraw());
    putPendingTriggersOnStack(ctx);
    expect(ctx.state.stack).toHaveLength(1);
    resolveAll(ctx);
    expect(p(ctx, 'P1').hand.length).toBe(handBefore + 1);
  });

  it('pr10-galvanic-iteration-ignores-other-spells — a creature or artifact spell does not use it up', () => {
    const ctx = pod('pr10-galvanic-filter');
    castFromHand(ctx, 'P1', card);
    resolveAll(ctx);
    castFromHand(ctx, 'P1', labCreature());
    putPendingTriggersOnStack(ctx);
    expect(ctx.state.stack).toHaveLength(1);
    resolveAll(ctx);
    castFromHand(ctx, 'P1', labArtifact());
    putPendingTriggersOnStack(ctx);
    expect(ctx.state.stack).toHaveLength(1);
    expect(ctx.state.delayedTriggers).toHaveLength(1);
  });

  it('pr10-galvanic-iteration-opponent-spell — an opponent’s instant does not trigger it', () => {
    const ctx = pod('pr10-galvanic-opponent');
    const target = spawn(ctx, 'P1', bear('Galvanic Mine'));
    castFromHand(ctx, 'P1', card);
    resolveAll(ctx);
    castFromHand(ctx, 'P2', labShock(), new Map([[0, target.id]]));
    putPendingTriggersOnStack(ctx);
    expect(ctx.state.stack).toHaveLength(1);
    expect(ctx.state.delayedTriggers).toHaveLength(1);
  });

  it('pr10-galvanic-iteration-this-turn — the delayed trigger lapses at cleanup', () => {
    const ctx = pod('pr10-galvanic-expiry');
    castFromHand(ctx, 'P1', card);
    resolveAll(ctx);
    expect(ctx.state.delayedTriggers[0]!.expiry).toBe('cleanup');
    expect(ctx.state.delayedTriggers[0]!.once).toBe(true);
  });

  it('pr10-galvanic-iteration-countered — copies the spell even after it left the stack', () => {
    const ctx = pod('pr10-galvanic-lki');
    const a = spawn(ctx, 'P2', bear('Galvanic Victim'));
    castFromHand(ctx, 'P1', card);
    resolveAll(ctx);
    const shock = castFromHand(ctx, 'P1', labShock(), new Map([[0, a.id]]));
    putPendingTriggersOnStack(ctx);
    // The original leaves the stack before the copy trigger resolves.
    ctx.state.stack = ctx.state.stack.filter((entry) => entry.id !== shock.id);
    pump(resolveTopOfStack(ctx), choose('Keep'));
    expect(ctx.state.stack).toHaveLength(1);
    resolveAll(ctx);
    expect(a.damageMarked).toBe(2);
  });

  it('pr10-galvanic-iteration-flashback — can be cast from the graveyard for {1}{U}{R}', () => {
    const ctx = pod('pr10-galvanic-flashback');
    const inGraveyard = conjure(ctx, 'P1', card, 'graveyard');
    addMana(p(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'U' }, { symbol: 'R' }]);
    const option = castOption(ctx, 'P1', inGraveyard.id, 'nonMana');
    expect(option, 'flashback is offered').toBeDefined();
    pump(
      applyPriorityAction(ctx, p(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    resolveAll(ctx);
    expect(ctx.state.exile.some((exiled) => exiled.cardId === inGraveyard.cardId)).toBe(true);
    expect(ctx.state.delayedTriggers).toHaveLength(1);
  });

  it('pr10-galvanic-iteration-insufficient-cost — not castable short one mana', () => {
    const ctx = pod('pr10-galvanic-short');
    const inHand = conjure(ctx, 'P1', card, 'hand');
    addMana(p(ctx, 'P1'), exactMana(interpretCard(card)).slice(0, -1));
    expect(castOption(ctx, 'P1', inHand.id)).toBeUndefined();
  });
});

describe('PR10.26 Cosmic Crucible', () => {
  const card = pinned('Cosmic Crucible');

  it('pr10-cosmic-crucible-pinned-oracle-supported — both clauses are modeled', () => {
    const def = pinnedDefinition('Cosmic Crucible');
    expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
    expect(def.triggers.map((trigger) => trigger.trigger?.when)).toEqual([
      'precombatMain',
      'castsSpell',
    ]);
  });

  it('pr10-cosmic-crucible-first-main-mana — adds four mana in any combination of colors', () => {
    const ctx = pod('pr10-crucible-mana');
    spawn(ctx, 'P1', card);
    queueStepTriggers(ctx, 'precombatMain');
    putPendingTriggersOnStack(ctx);
    const { decisions } = pump(resolveTopOfStack(ctx), () => ({
      index: 0,
      targets: new Map(),
      manaSplit: { W: 0, U: 1, B: 0, R: 1, G: 2 },
    }));
    expect(decisions[0]!.manaSplit).toEqual({ amount: 4, colors: ['W', 'U', 'B', 'R', 'G'] });
    expect(
      p(ctx, 'P1')
        .manaEntries.map((entry) => entry.symbol)
        .sort(),
    ).toEqual(['G', 'G', 'R', 'U']);
  });

  it("pr10-cosmic-crucible-only-your-first-main — not an opponent's main phase", () => {
    const ctx = pod('pr10-crucible-opponent-main');
    spawn(ctx, 'P1', card);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    queueStepTriggers(ctx, 'precombatMain');
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('pr10-cosmic-crucible-copies-noncreature — may copy a noncreature spell with new targets', () => {
    const ctx = pod('pr10-crucible-copy');
    spawn(ctx, 'P1', card);
    const a = spawn(ctx, 'P2', bear('Crucible First'));
    const b = spawn(ctx, 'P3', bear('Crucible Second'));
    castFromHand(ctx, 'P1', labShock(), new Map([[0, a.id]]));
    putPendingTriggersOnStack(ctx);
    const { decisions } = pump(resolveTopOfStack(ctx), (decision) =>
      decision.prompt.endsWith('?')
        ? choose('Copy Lab Shock')(decision)
        : choose('Crucible Second')(decision),
    );
    expect(decisions[0]!.options.map((option) => option.description)).toContain("Don't copy it");
    expect(ctx.state.stack.at(-1)!.targets).toEqual([b.id]);
    resolveAll(ctx);
    expect(a.damageMarked).toBe(2);
    expect(b.damageMarked).toBe(2);
  });

  it('pr10-cosmic-crucible-copies-permanent-spell — a copied artifact spell becomes a token', () => {
    const ctx = pod('pr10-crucible-artifact');
    spawn(ctx, 'P1', card);
    castFromHand(ctx, 'P1', labArtifact());
    putPendingTriggersOnStack(ctx);
    const { decisions } = pump(resolveTopOfStack(ctx), choose('Copy Lab Trinket'));
    expect(decisions).toHaveLength(1);
    expect(ctx.state.stack.at(-1)!.permanentSpellCopy).toBeDefined();
    resolveAll(ctx);
    const trinkets = ctx.state.battlefield.filter((perm) => perm.name === 'Lab Trinket');
    expect(trinkets).toHaveLength(2);
    expect(trinkets.filter((perm) => perm.isToken)).toHaveLength(1);
  });

  it('pr10-cosmic-crucible-copy-may-target-original — the copy may target the spell it copies', () => {
    const ctx = pod('pr10-crucible-target-original');
    spawn(ctx, 'P1', card);
    const shock = castFromHand(ctx, 'P2', labShock(), new Map([[0, 'P3']]));
    const negate = castFromHand(
      ctx,
      'P1',
      oracle({
        name: 'Lab Negate',
        typeLine: 'Instant',
        manaCost: '{U}',
        cmc: 1,
        colors: ['U'],
        power: null,
        toughness: null,
        oracleText: 'Counter target spell.',
      }),
      new Map([[0, shock.id]]),
    );
    putPendingTriggersOnStack(ctx);
    pump(resolveTopOfStack(ctx), (decision) =>
      decision.prompt.endsWith('?')
        ? choose('Copy Lab Negate')(decision)
        : choose('Target Lab Negate')(decision),
    );
    const copy = ctx.state.stack.at(-1)!;
    expect(copy.description).toBe('Copy of Lab Negate');
    expect(copy.targets).toEqual([negate.id]);
  });

  it('pr10-cosmic-crucible-copy-keeps-gift — a copy of a gifted spell keeps the promised gift', () => {
    registerWhiteBlackControlGiftOverrides();
    const ctx = pod('pr10-crucible-gift');
    spawn(ctx, 'P1', card);
    const truce = (
      JSON.parse(
        readFileSync('packages/engine/tests/fixtures/white-black-control-oracle.json', 'utf8'),
      ) as { cards: { card: OracleCard }[] }
    ).cards.find((entry) => entry.card.name === "Dawn's Truce")!.card;
    const before = p(ctx, 'P2').hand.length;
    castFromHand(ctx, 'P1', truce, new Map(), (decision) =>
      decision.prompt.startsWith('Promise an opponent a gift')
        ? choose('Promise P2 a gift')(decision)
        : { index: 0, targets: new Map() },
    );
    putPendingTriggersOnStack(ctx);
    pump(resolveTopOfStack(ctx), choose("Copy Dawn's Truce"));
    expect(ctx.state.stack.at(-1)!.giftRecipientId).toBe('P2');
    resolveAll(ctx);
    expect(p(ctx, 'P2').hand.length).toBe(before + 2);
  });

  it('pr10-cosmic-crucible-once-each-turn — a second spell that turn is not copied', () => {
    const ctx = pod('pr10-crucible-once');
    spawn(ctx, 'P1', card);
    castFromHand(ctx, 'P1', labDraw());
    putPendingTriggersOnStack(ctx);
    pump(resolveTopOfStack(ctx), choose('Copy Lab Divination'));
    resolveAll(ctx);
    castFromHand(ctx, 'P1', labDraw());
    putPendingTriggersOnStack(ctx);
    const before = ctx.state.stack.length;
    const { decisions } = pump(resolveTopOfStack(ctx));
    // The ability still triggers, but the copy was already made this turn.
    expect(decisions).toHaveLength(0);
    expect(ctx.state.stack).toHaveLength(before - 1);
  });

  it('pr10-cosmic-crucible-decline-keeps-turn-use — declining leaves the once-each-turn copy available', () => {
    const ctx = pod('pr10-crucible-decline');
    spawn(ctx, 'P1', card);
    castFromHand(ctx, 'P1', labDraw());
    putPendingTriggersOnStack(ctx);
    pump(resolveTopOfStack(ctx), choose("Don't copy it"));
    resolveAll(ctx);
    castFromHand(ctx, 'P1', labDraw());
    putPendingTriggersOnStack(ctx);
    const { decisions } = pump(resolveTopOfStack(ctx), choose('Copy Lab Divination'));
    expect(decisions).toHaveLength(1);
    expect(ctx.state.stack.at(-1)!.card).toBeNull();
  });

  it('pr10-cosmic-crucible-not-creature — a creature spell does not trigger it', () => {
    const ctx = pod('pr10-crucible-creature');
    spawn(ctx, 'P1', card);
    castFromHand(ctx, 'P1', labCreature());
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('pr10-cosmic-crucible-cant-be-copied — Display of Power is not copied', () => {
    const ctx = pod('pr10-crucible-display');
    spawn(ctx, 'P1', card);
    const display = conjure(ctx, 'P1', pinned('Display of Power'), 'hand');
    addMana(p(ctx, 'P1'), exactMana(interpretCard(pinned('Display of Power'))));
    pump(
      applyPriorityAction(
        ctx,
        p(ctx, 'P1'),
        castOption(ctx, 'P1', display.id)!.payload as PriorityActionPayload,
        { index: 0, targets: new Map() },
      ),
      choose('Choose no more targets'),
    );
    putPendingTriggersOnStack(ctx);
    const { decisions } = pump(resolveTopOfStack(ctx));
    expect(decisions).toHaveLength(0);
    expect(ctx.state.stack).toHaveLength(1);
  });
});
