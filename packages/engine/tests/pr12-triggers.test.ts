import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import type { PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { runCombatPhase } from '../src/combat/combat';
import { computeCharacteristics } from '../src/effects/continuous';
import { addMana } from '../src/mana/pool';
import { priorityCheckpoint } from '../src/sba/sba';
import { moveObject } from '../src/state/objects';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { hasKeyword } from '../src/state/queries';
import type { EnginePermanent, GameContext } from '../src/state/types';
import {
  bear,
  conjure,
  declareAttacks,
  declareBlocks,
  doom,
  oracle,
  pump,
  spawn,
} from './fixtures';
import {
  alias,
  battlefield,
  castFromHand,
  checkpoint,
  fixture,
  game,
  nextTurnOf,
  offeredTargets,
  pinned,
  player,
  priorityOption,
  resolve,
} from './pr12-helpers';

const BOLT = pinned('Black Bolt, Inhuman King');
const STAFF = pinned('Dingus Staff');
const ZURGO = pinned('Zurgo and Ojutai');

const lifeSpell = (): OracleCard =>
  oracle({
    name: 'Gain Test',
    typeLine: 'Sorcery',
    manaCost: '{1}',
    oracleText: 'You gain 1 life.',
  });
const cheapBear = (): OracleCard =>
  oracle({
    name: 'Cheap Bear',
    typeLine: 'Creature — Bear',
    manaCost: '{1}',
    power: '2',
    toughness: '2',
  });
const shock = (): OracleCard =>
  oracle({
    name: 'Shock Test',
    typeLine: 'Instant',
    manaCost: '{R}',
    colors: ['R'],
    oracleText: 'Shock Test deals 1 damage to any target.',
  });
const pinger = (): OracleCard =>
  oracle({
    name: 'Pinger',
    typeLine: 'Artifact',
    manaCost: '{1}',
    oracleText: '{T}: Pinger deals 1 damage to any target.',
  });
const rock = (): OracleCard =>
  oracle({ name: 'Test Rock', typeLine: 'Artifact', manaCost: '{2}', oracleText: '' });
const shatter = (): OracleCard =>
  oracle({
    name: 'Shatter Test',
    typeLine: 'Instant',
    manaCost: '{1}',
    oracleText: 'Destroy target artifact.',
  });
const wrath = (): OracleCard =>
  oracle({
    name: 'Wrath Test',
    typeLine: 'Sorcery',
    manaCost: '{1}',
    oracleText: 'Destroy all creatures.',
  });
const whelp = (): OracleCard =>
  oracle({
    name: 'Test Whelp',
    typeLine: 'Creature — Dragon',
    manaCost: '{1}',
    power: '2',
    toughness: '2',
  });

function turnOf(ctx: GameContext, playerId: string): void {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(playerId);
}

/** Put pending triggers on the stack, recording the first target slot's options. */
function checkpointTargets(ctx: GameContext, pick?: string): string[] {
  let offered: string[] = [];
  const answer = (decision: PendingDecision): DecisionOutcome => {
    const slot = decision.options[0]?.targets?.[0];
    if (slot !== undefined) {
      offered = [...slot.options];
      return {
        index: 0,
        targets: new Map([[slot.slot, pick ?? (slot.options[0] as string)]]),
      };
    }
    return { index: 0, targets: new Map() };
  };
  const decisions = pump(priorityCheckpoint(ctx), answer).decisions;
  // A single legal target is forced and never surfaced as a decision.
  if (offered.length === 0 && decisions.length === 0) {
    const top = ctx.state.stack.at(-1);
    offered = [...(top?.targets ?? [])].map(String);
  }
  return offered;
}

/** Attack with `attackers` at `defender`, no blocks; resolve everything with `answer`. */
function attackWith(
  ctx: GameContext,
  attackers: readonly EnginePermanent[],
  defender: string | ((attackerId: string) => string | null),
  answer: (decision: PendingDecision) => DecisionOutcome | undefined = () => undefined,
): PendingDecision[] {
  ctx.state.phase = 'combat';
  const ids = new Set(attackers.map((attacker) => attacker.id));
  return pump(runCombatPhase(ctx), (decision) => {
    if (decision.presentationAttackDeclaration !== undefined)
      return declareAttacks(decision, (id) =>
        ids.has(id) ? (typeof defender === 'string' ? defender : defender(id)) : null,
      );
    if (decision.presentationBlockDeclaration !== undefined)
      return declareBlocks(decision, () => null);
    const custom = answer(decision);
    if (custom !== undefined) return custom;
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    return { index: Math.max(pass, 0), targets: new Map() };
  }).decisions;
}

describe('PR12 Oracle pins', () => {
  it('pr12-oracle-pins — pins the seven reopened Oracle identities and full definitions', () => {
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Black Bolt, Inhuman King',
      'Dingus Staff',
      'Sivitri, Dragon Master',
      'Zurgo and Ojutai',
      'Bloomvine Regent // Claim Territory',
      'Marang River Regent // Coil and Catch',
      'Monster Manual // Zoological Study',
    ]);
    for (const { card, sha256 } of fixture.cards)
      expect(createHash('sha256').update(JSON.stringify(card)).digest('hex')).toBe(sha256);
  });

  it('pr12-modeled — all seven model with every reason cleared, for both identities', () => {
    for (const { card } of fixture.cards) {
      for (const identity of [card, alias(card)]) {
        const def = interpretCard(identity);
        expect(def.unmodeledReasons, identity.oracleId).toEqual([]);
        expect(def.modeled, identity.oracleId).toBe(true);
      }
    }
  });
});

describe('Black Bolt, Inhuman King', () => {
  it('bolt-c01 — flying', () => {
    const ctx = game('pr12-bolt-flying');
    expect(hasKeyword(ctx, spawn(ctx, 'P1', BOLT), 'flying')).toBe(true);
  });

  it('bolt-c02-positive — casting a noncreature spell gives it +2/+2 until end of turn', () => {
    const ctx = game('pr12-bolt-pump');
    const bolt = spawn(ctx, 'P1', BOLT);
    castFromHand(ctx, 'P1', lifeSpell(), new Map(), { C: 1 });
    checkpoint(ctx);
    expect(ctx.state.stack.map((entry) => entry.kind)).toEqual(['spell', 'triggeredAbility']);
    // The pump is mandatory: nothing asks "use it?" first.
    expect(resolve(ctx).map((d) => d.decisionType)).not.toContain('optionalTrigger');
    expect(computeCharacteristics(ctx, bolt).power).toBe(5);
    expect(computeCharacteristics(ctx, bolt).toughness).toBe(5);
  });

  it('bolt-c02-negative — creature spells and opponents’ spells do not trigger it', () => {
    const ctx = game('pr12-bolt-no-pump');
    spawn(ctx, 'P1', BOLT);
    castFromHand(ctx, 'P1', cheapBear(), new Map(), { C: 1 });
    checkpoint(ctx);
    expect(ctx.state.stack.map((entry) => entry.kind)).toEqual(['spell']);
    resolve(ctx);
    turnOf(ctx, 'P2');
    castFromHand(ctx, 'P2', lifeSpell(), new Map(), { C: 1 });
    checkpoint(ctx);
    expect(ctx.state.stack.map((entry) => entry.kind)).toEqual(['spell']);
  });

  it('bolt-c03-positive — an opponent’s spell targeting it destroys a nonland permanent that player controls', () => {
    const ctx = game('pr12-bolt-voice');
    const bolt = spawn(ctx, 'P1', BOLT);
    const theirs = spawn(ctx, 'P2', bear());
    const theirRock = spawn(ctx, 'P2', rock());
    const theirLand = battlefield(ctx, 'Plains').find((land) => land.controllerId === 'P2');
    const bystander = spawn(ctx, 'P3', bear());
    const mine = spawn(ctx, 'P1', bear());
    turnOf(ctx, 'P2');
    castFromHand(ctx, 'P2', shock(), new Map([[0, bolt.id]]), { R: 1 });
    const offered = checkpointTargets(ctx, theirs.id);
    expect(new Set(offered)).toEqual(new Set([theirs.id, theirRock.id]));
    if (theirLand !== undefined) expect(offered).not.toContain(theirLand.id);
    expect(offered).not.toContain(bystander.id);
    expect(offered).not.toContain(mine.id);
    // Lethal Voice is mandatory: nothing asks "use it?" first.
    expect(resolve(ctx).map((d) => d.decisionType)).not.toContain('optionalTrigger');
    expect(
      battlefield(ctx, 'Test Bear')
        .map((p) => p.controllerId)
        .sort(),
    ).toEqual(['P1', 'P3']);
    resolve(ctx);
    expect(bolt.damageMarked).toBe(1);
  });

  it('bolt-c03-ability — an opponent’s activated ability targeting it also triggers', () => {
    const ctx = game('pr12-bolt-ability');
    const bolt = spawn(ctx, 'P1', BOLT);
    const theirs = spawn(ctx, 'P2', bear());
    const rod = spawn(ctx, 'P2', pinger());
    turnOf(ctx, 'P2');
    const option = priorityOption(
      ctx,
      'P2',
      (payload) => payload.kind === 'activateAbility' && payload.objectId === rod.id,
    );
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player(ctx, 'P2'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, bolt.id]]),
      }),
    );
    const offered = checkpointTargets(ctx, theirs.id);
    expect(offered).toContain(theirs.id);
    expect(offered).toContain(rod.id);
    expect(resolve(ctx).map((d) => d.decisionType)).not.toContain('optionalTrigger');
    expect(battlefield(ctx, 'Test Bear')).toHaveLength(0);
  });

  it('bolt-c03-negative — its controller’s own spell, and an opponent’s spell at something else, do not trigger it', () => {
    const ctx = game('pr12-bolt-quiet');
    const bolt = spawn(ctx, 'P1', BOLT);
    const theirs = spawn(ctx, 'P2', bear());
    castFromHand(ctx, 'P1', shock(), new Map([[0, bolt.id]]), { R: 1 });
    checkpoint(ctx);
    // Only its own noncreature-spell pump triggers.
    expect(ctx.state.stack.map((entry) => entry.description)).toEqual([
      'Shock Test',
      'Black Bolt, Inhuman King — Whenever you cast a noncreature spell, ~ gets +2/+2 until end of turn.',
    ]);
    resolve(ctx);
    resolve(ctx);
    turnOf(ctx, 'P2');
    castFromHand(ctx, 'P2', shock(), new Map([[0, theirs.id]]), { R: 1 });
    checkpoint(ctx);
    expect(ctx.state.stack.map((entry) => entry.kind)).toEqual(['spell']);
  });

  it('bolt-c03-no-target — with no nonland permanent that player controls, the trigger is removed', () => {
    const ctx = game('pr12-bolt-empty');
    const bolt = spawn(ctx, 'P1', BOLT);
    turnOf(ctx, 'P2');
    castFromHand(ctx, 'P2', shock(), new Map([[0, bolt.id]]), { R: 1 });
    checkpoint(ctx);
    expect(ctx.state.stack.map((entry) => entry.kind)).toEqual(['spell']);
  });
});

describe('Dingus Staff', () => {
  it('dingus-c01-positive — an opponent’s creature dying deals 2 damage to that creature’s controller', () => {
    const ctx = game('pr12-dingus-opponent');
    spawn(ctx, 'P1', STAFF);
    const victim = spawn(ctx, 'P2', bear());
    castFromHand(ctx, 'P1', doom(), new Map([[0, victim.id]]), { B: 1, C: 1 });
    resolve(ctx);
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(1);
    // The trigger is mandatory: nothing asks "use it?" first.
    expect(resolve(ctx).map((d) => d.decisionType)).not.toContain('optionalTrigger');
    expect(player(ctx, 'P2').life).toBe(38);
    expect(player(ctx, 'P1').life).toBe(40);
  });

  it('dingus-c01-own — its controller’s own creature dying damages its controller', () => {
    const ctx = game('pr12-dingus-own');
    spawn(ctx, 'P1', STAFF);
    const mine = spawn(ctx, 'P1', bear());
    castFromHand(ctx, 'P1', doom(), new Map([[0, mine.id]]), { B: 1, C: 1 });
    resolve(ctx);
    checkpoint(ctx);
    resolve(ctx);
    expect(player(ctx, 'P1').life).toBe(38);
  });

  it('dingus-c01-lki — the controller as it died is damaged, not the owner', () => {
    const ctx = game('pr12-dingus-lki');
    spawn(ctx, 'P1', STAFF);
    const borrowed = spawn(ctx, 'P2', bear());
    borrowed.ownerId = 'P3';
    castFromHand(ctx, 'P1', doom(), new Map([[0, borrowed.id]]), { B: 1, C: 1 });
    resolve(ctx);
    checkpoint(ctx);
    resolve(ctx);
    expect(player(ctx, 'P2').life).toBe(38);
    expect(player(ctx, 'P3').life).toBe(40);
  });

  it('dingus-c01-each — creatures dying together each trigger it for their own controller', () => {
    const ctx = game('pr12-dingus-wrath');
    spawn(ctx, 'P1', STAFF);
    spawn(ctx, 'P2', bear());
    spawn(ctx, 'P3', bear());
    spawn(ctx, 'P3', bear());
    castFromHand(ctx, 'P1', wrath(), new Map(), { C: 1 });
    resolve(ctx);
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(3);
    resolve(ctx);
    resolve(ctx);
    resolve(ctx);
    expect(player(ctx, 'P2').life).toBe(38);
    expect(player(ctx, 'P3').life).toBe(36);
  });

  it('dingus-c01-negative — a noncreature permanent going to the graveyard does not trigger it', () => {
    const ctx = game('pr12-dingus-artifact');
    spawn(ctx, 'P1', STAFF);
    const target = spawn(ctx, 'P2', rock());
    castFromHand(ctx, 'P1', shatter(), new Map([[0, target.id]]), { C: 1 });
    resolve(ctx);
    checkpoint(ctx);
    expect(ctx.state.stack).toHaveLength(0);
    expect(player(ctx, 'P2').life).toBe(40);
  });
});

describe('Zurgo and Ojutai', () => {
  it('zurgo-c01 — flying and haste', () => {
    const ctx = game('pr12-zurgo-keywords');
    const zurgo = spawn(ctx, 'P1', ZURGO);
    expect(hasKeyword(ctx, zurgo, 'flying')).toBe(true);
    expect(hasKeyword(ctx, zurgo, 'haste')).toBe(true);
  });

  it('zurgo-c02 — hexproof on the turn it entered, not on a later turn', () => {
    const ctx = game('pr12-zurgo-hexproof');
    const zurgo = spawn(ctx, 'P1', ZURGO);
    expect(hasKeyword(ctx, zurgo, 'hexproof')).toBe(true);
    const grizzly = spawn(ctx, 'P1', bear());
    turnOf(ctx, 'P2');
    conjure(ctx, 'P2', shock(), 'hand');
    addMana(player(ctx, 'P2'), [{ symbol: 'R' }]);
    const offered = offeredTargets(ctx, 'P2', (payload) => payload.kind === 'castSpell');
    expect(offered).toContain(grizzly.id);
    expect(offered).not.toContain(zurgo.id);
    nextTurnOf(ctx, 'P2');
    expect(hasKeyword(ctx, zurgo, 'hexproof')).toBe(false);
  });

  it('zurgo-c03-positive — one trigger for its Dragons’ combat damage: one card to hand, the rest on the bottom, and one of those Dragons returned', () => {
    const ctx = game('pr12-zurgo-hit');
    const zurgo = spawn(ctx, 'P1', ZURGO);
    const other = spawn(ctx, 'P1', whelp());
    other.summoningSick = false;
    const me = player(ctx, 'P1');
    const top = me.library.slice(0, 3).map((card) => card.cardId);
    const handBefore = me.hand.length;
    const prompts: string[] = [];
    attackWith(ctx, [zurgo, other], 'P2', (decision) => {
      prompts.push(decision.prompt);
      // The trigger is mandatory: only its own look/return choices are asked, never "use it?".
      expect(decision.decisionType).not.toBe('optionalTrigger');
      if (/put a card from among the top 3/.test(decision.prompt)) {
        expect(decision.options.some((option) => option.type === 'decline')).toBe(false);
        expect(decision.options).toHaveLength(3);
        return { index: 1, targets: new Map() };
      }
      if (/return one of them/.test(decision.prompt)) {
        expect(decision.options.map((option) => option.description)).toEqual([
          'Return Zurgo and Ojutai',
          'Return Test Whelp',
          'Return none',
        ]);
        return { index: 1, targets: new Map() };
      }
      return undefined;
    });
    expect(player(ctx, 'P2').life).toBe(40 - 6);
    expect(prompts.filter((prompt) => /put a card from among the top 3/.test(prompt))).toHaveLength(
      1,
    );
    expect(me.hand.map((card) => card.cardId)).toContain(top[1]);
    expect(me.library.slice(-2).map((card) => card.cardId)).toEqual([top[0], top[2]]);
    expect(me.hand.some((card) => card.name === 'Test Whelp')).toBe(true);
    expect(me.hand.length).toBe(handBefore + 2);
    expect(battlefield(ctx, 'Zurgo and Ojutai')).toHaveLength(1);
  });

  it('zurgo-c03-multiplayer — groups damage and return choices separately for each damaged player', () => {
    const ctx = game('pr12-zurgo-multiplayer');
    const zurgo = spawn(ctx, 'P1', ZURGO);
    const other = spawn(ctx, 'P1', whelp());
    const third = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Other Whelp',
        typeLine: 'Creature — Dragon',
        manaCost: '{1}',
        power: '2',
        toughness: '2',
      }),
    );
    other.summoningSick = false;
    third.summoningSick = false;
    const handBefore = player(ctx, 'P1').hand.length;
    let selections = 0;
    const returnGroups: string[][] = [];
    attackWith(
      ctx,
      [zurgo, other, third],
      (id) => (id === third.id ? 'P3' : 'P2'),
      (decision) => {
        if (/put a card from among the top 3/.test(decision.prompt)) selections++;
        if (/return one of them/.test(decision.prompt)) {
          returnGroups.push(decision.options.map((option) => option.description));
          return {
            index: decision.options.findIndex((option) => option.type === 'decline'),
            targets: new Map(),
          };
        }
        return undefined;
      },
    );
    expect(player(ctx, 'P2').life).toBe(34);
    expect(player(ctx, 'P3').life).toBe(38);
    expect(selections).toBe(2);
    expect(player(ctx, 'P1').hand.length).toBe(handBefore + 2);
    expect(returnGroups).toHaveLength(2);
    expect(returnGroups).toEqual(
      expect.arrayContaining([
        ['Return Zurgo and Ojutai', 'Return Test Whelp', 'Return none'],
        ['Return Other Whelp', 'Return none'],
      ]),
    );
  });

  it('zurgo-c03-decline — returning a Dragon is optional', () => {
    const ctx = game('pr12-zurgo-keep');
    const zurgo = spawn(ctx, 'P1', ZURGO);
    attackWith(ctx, [zurgo], 'P2', (decision) =>
      /return one of them/.test(decision.prompt)
        ? {
            index: decision.options.findIndex((option) => option.type === 'decline'),
            targets: new Map(),
          }
        : undefined,
    );
    expect(battlefield(ctx, 'Zurgo and Ojutai')).toHaveLength(1);
    expect(player(ctx, 'P1').hand).toHaveLength(1);
  });

  it('zurgo-c03-negative — a non-Dragon’s or an opponent’s Dragon’s combat damage does not trigger it', () => {
    const ctx = game('pr12-zurgo-quiet');
    spawn(ctx, 'P1', ZURGO).summoningSick = false;
    const grizzly = spawn(ctx, 'P1', bear());
    grizzly.summoningSick = false;
    const library = player(ctx, 'P1').library.length;
    attackWith(ctx, [grizzly], 'P2');
    expect(player(ctx, 'P2').life).toBe(38);
    expect(player(ctx, 'P1').library.length).toBe(library);
    const enemy = game('pr12-zurgo-enemy');
    spawn(enemy, 'P1', ZURGO);
    const theirs = spawn(enemy, 'P2', whelp());
    theirs.summoningSick = false;
    turnOf(enemy, 'P2');
    const before = player(enemy, 'P1').library.length;
    attackWith(enemy, [theirs], 'P3');
    expect(player(enemy, 'P3').life).toBe(38);
    expect(player(enemy, 'P1').library.length).toBe(before);
  });

  it('zurgo-c03-left — a Dragon that has left the battlefield cannot be returned', () => {
    const ctx = game('pr12-zurgo-gone');
    const zurgo = spawn(ctx, 'P1', ZURGO);
    const other = spawn(ctx, 'P1', whelp());
    other.summoningSick = false;
    let returnOptions: string[] | undefined;
    attackWith(ctx, [zurgo, other], 'P2', (decision) => {
      if (/put a card from among the top 3/.test(decision.prompt)) {
        // The whelp leaves before the trigger resolves its return.
        pump(moveObject(ctx, other, { zone: 'graveyard' }));
        return { index: 0, targets: new Map() };
      }
      if (/return one of them/.test(decision.prompt))
        returnOptions = decision.options.map((option) => option.description);
      return undefined;
    });
    expect(returnOptions).toEqual(['Return Zurgo and Ojutai', 'Return none']);
  });
});
