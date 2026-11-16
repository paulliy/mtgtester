/**
 * Common blocking lines (hill-climb S3): rules lines that blocked several EDHREC cards each and
 * that need only parser work, because the engine primitive already existed and was tested through
 * an override. Each line shape has an interpretation test pinning the IR it produces, a negative
 * test for a near-miss wording it must still refuse, and the shapes whose semantics are new to the
 * interpreter (counter-and-exile on any spell, "another target" graveyard cards, conditional and
 * per-noun self cost reductions, an all-players activation lock) have a behavior test through the
 * normal cast, activation and trigger paths.
 *
 * The rule-static shapes that replaced deck overrides (enter tapped, one spell each turn, entering
 * doesn't trigger) keep their behavior tests in `white-black-control-entry.test.ts` and
 * `white-black-control-review-bugs.test.ts`, which now run against the interpreted definitions.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';
import { allOf, anyOf, not, OPPONENTS, OTHER, ofSupertype, ofType } from '../src/cards/selector';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { moveObject, playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, divination, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const pinnedCards = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/common-blocking-lines-oracle.json'), 'utf8'),
  ) as PinnedFixture
).cards;

function pinned(name: string): OracleCard {
  const entry = pinnedCards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`missing pinned Oracle fixture for ${name}`);
  return entry.card;
}

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

type Answer = (decision: PendingDecision, count: number) => DecisionOutcome;

/** The priority option for `objectId`, if it is legal for `playerId` now. */
function optionFor(ctx: GameContext, playerId: string, objectId: string) {
  return computePriorityOptions(ctx, playerById(ctx, playerId)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return 'objectId' in payload && payload.objectId === objectId;
  });
}

function take(
  ctx: GameContext,
  playerId: string,
  payload: PriorityActionPayload,
  targets: ReadonlyMap<number, string> = new Map(),
) {
  return pump(applyPriorityAction(ctx, playerById(ctx, playerId), payload, { index: 0, targets }));
}

/** Every player passes; pending triggers go on the stack and resolve. */
function settle(ctx: GameContext, answer?: Answer) {
  return pump(runPrioritySequence(ctx), (decision, count) => {
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    return answer?.(decision, count) ?? { index: 0, targets: new Map() };
  });
}

const mana = (symbols: string) =>
  [...symbols].map((symbol) => ({ symbol: symbol as 'C' | 'W' | 'U' | 'B' | 'R' | 'G' }));

/** A card carrying one rules line, for interpretation and negative tests. */
const lineCard = (oracleText: string, typeLine = 'Enchantment'): OracleCard =>
  oracle({ name: 'Line Probe', typeLine, manaCost: '{2}', oracleText });

describe('cards the common blocking lines unblock', () => {
  it('common-lines-pinned — the fixture matches its pins and every card models with no override', () => {
    expect(pinnedCards.length).toBe(55);
    for (const { sha256, card } of pinnedCards) {
      expect(createHash('sha256').update(canonical(card)).digest('hex'), card.name).toBe(sha256);
      for (const candidate of [card, { ...card, oracleId: fixtureOracleId(card.name) }]) {
        const def = interpretCard(candidate);
        expect(def.unmodeledReasons, `${card.name} ${candidate.oracleId}`).toEqual([]);
      }
      expect(getOverride(card.oracleId), card.name).toBeUndefined();
    }
  });
});

describe('rule-static lines', () => {
  it('common-lines-enter-tapped — the listed types an opponent controls enter tapped', () => {
    expect(interpretCard(pinned('Imposing Sovereign')).ruleStatics).toEqual([
      { kind: 'otherPermanentsEnterTapped', filter: allOf(ofType('Creature'), OPPONENTS) },
    ]);
    expect(interpretCard(pinned('Kismet')).ruleStatics).toEqual([
      {
        kind: 'otherPermanentsEnterTapped',
        filter: allOf(anyOf(ofType('Artifact'), ofType('Creature'), ofType('Land')), OPPONENTS),
      },
    ]);
    expect(interpretCard(pinned('Thalia, Heretic Cathar')).ruleStatics).toEqual([
      {
        kind: 'otherPermanentsEnterTapped',
        filter: allOf(
          anyOf(ofType('Creature'), allOf(ofType('Land'), not(ofSupertype('Basic')))),
          OPPONENTS,
        ),
      },
    ]);
  });

  it('common-lines-enter-tapped-negative — a quality or controller word the list does not know stays unread', () => {
    for (const text of [
      'Nontoken creatures your opponents control enter tapped.',
      'Creatures your opponents control with flying enter tapped.',
      'Artifacts or creatures your opponents control enter tapped.',
    ]) {
      expect(interpretCard(lineCard(text)).modeled, text).toBe(false);
    }
  });

  it('common-lines-activation-lock — every player, every permanent of the listed types', () => {
    expect(interpretCard(pinned('Null Rod')).ruleStatics).toEqual([
      {
        kind: 'cantActivateAbilities',
        who: 'all',
        yourTurnOnly: false,
        filter: ofType('Artifact'),
      },
    ]);
    expect(interpretCard(pinned('Clarion Conqueror')).ruleStatics).toEqual([
      {
        kind: 'cantActivateAbilities',
        who: 'all',
        yourTurnOnly: false,
        filter: anyOf(ofType('Artifact'), ofType('Creature'), ofType('Planeswalker')),
      },
    ]);
    // "you control" / "your opponents control" narrow who is locked: not this shape.
    for (const text of [
      "Activated abilities of artifacts you control can't be activated.",
      "Activated abilities of artifacts your opponents control can't be activated.",
    ]) {
      expect(interpretCard(lineCard(text)).modeled, text).toBe(false);
    }
  });

  it('common-lines-entering-no-triggers — Torpor Orb suppresses creature enters triggers only', () => {
    expect(interpretCard(pinned('Torpor Orb')).ruleStatics).toEqual([
      { kind: 'suppressObjectTriggers', events: ['enters'], filter: ofType('Creature') },
    ]);
  });

  it('common-lines-one-spell — each player one spell, or one noncreature spell, each turn', () => {
    expect(interpretCard(pinned('Eidolon of Rhetoric')).ruleStatics).toEqual([
      { kind: 'spellCastLimit', category: 'any', limit: 1 },
    ]);
    expect(
      interpretCard(lineCard("Each player can't cast more than one noncreature spell each turn."))
        .ruleStatics,
    ).toEqual([{ kind: 'spellCastLimit', category: 'noncreature', limit: 1 }]);
    expect(
      interpretCard(lineCard("Each player can't cast more than two spells each turn.")).modeled,
    ).toBe(false);
  });

  it('common-lines-null-rod — no player can activate an artifact ability, mana abilities included', () => {
    const ctx = pod('common-lines-null-rod');
    const relic = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Lab Relic',
        typeLine: 'Artifact',
        manaCost: '{1}',
        oracleText: '{1}, {T}: Draw a card.',
      }),
    );
    const rock = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Lab Rock',
        typeLine: 'Artifact',
        manaCost: '{1}',
        oracleText: '{T}: Add {C}.',
      }),
    );
    const trinket = conjure(
      ctx,
      'P1',
      oracle({ name: 'Lab Trinket', typeLine: 'Artifact', manaCost: '{1}' }),
      'hand',
    );
    // Without Null Rod: the draw ability (paid by the rock's mana) and the cast are both offered.
    expect(optionFor(ctx, 'P1', relic.id)).toBeDefined();
    expect(optionFor(ctx, 'P1', trinket.id)).toBeDefined();

    const rod = spawn(ctx, 'P2', pinned('Null Rod'));
    expect(optionFor(ctx, 'P1', relic.id)).toBeUndefined();
    // The rock is a mana ability of an artifact (CR 605.1a): it can no longer pay for the cast.
    expect(optionFor(ctx, 'P1', trinket.id)).toBeUndefined();
    expect(rock.tapped).toBe(false);

    pump(moveObject(ctx, rod, { zone: 'graveyard' }));
    expect(optionFor(ctx, 'P1', trinket.id)).toBeDefined();
  });
});

describe('spell and ability lines', () => {
  it('common-lines-dissipate-ir — any spell target, exiled if countered this way', () => {
    const def = interpretCard(pinned('Dissipate'));
    expect(def.spellAbility?.targets).toEqual([{ kind: 'spell' }]);
    expect(def.spellAbility?.effects).toEqual([
      { op: 'counter', target: 0, exileIfCountered: true },
    ]);
  });

  it('common-lines-dissipate — the countered spell goes to exile, not the graveyard', () => {
    const ctx = pod('common-lines-dissipate');
    const draw = conjure(ctx, 'P1', divination(), 'hand');
    addMana(playerById(ctx, 'P1'), mana('UC'));
    take(ctx, 'P1', optionFor(ctx, 'P1', draw.id)!.payload as PriorityActionPayload);
    const spell = ctx.state.stack.at(-1)!;

    const counter = conjure(ctx, 'P2', pinned('Dissipate'), 'hand');
    addMana(playerById(ctx, 'P2'), mana('UUC'));
    const option = optionFor(ctx, 'P2', counter.id);
    expect(option).toBeDefined();
    take(ctx, 'P2', option!.payload as PriorityActionPayload, new Map([[0, spell.id]]));
    pump(resolveTopOfStack(ctx));

    expect(ctx.state.stack).toHaveLength(0);
    expect(ctx.state.exile.map((object) => object.name)).toContain(divination().name);
    expect(playerById(ctx, 'P1').graveyard.map((object) => object.name)).not.toContain(
      divination().name,
    );
  });

  it('common-lines-keep-safe-ir — the spell target must target a permanent you control', () => {
    expect(interpretCard(pinned('Keep Safe')).spellAbility?.targets).toEqual([
      { kind: 'spell', spellTargetsPermanentYouControl: true },
    ]);
  });

  it('common-lines-protection-ir — the color is chosen on resolution; "you control" is kept', () => {
    const gods = interpretCard(pinned('Gods Willing')).spellAbility;
    expect(gods?.targets[0]).toEqual({ kind: 'creature', controller: 'you' });
    expect(gods?.effects[0]).toEqual({ op: 'grantChosenColorProtectionUntilEot', target: 0 });
    const any = interpretCard(
      lineCard(
        'Target creature gains protection from the color of your choice until end of turn.',
        'Instant',
      ),
    ).spellAbility;
    expect(any?.targets[0]).toEqual({ kind: 'creature' });
  });

  it('common-lines-player-graveyard-ir — any player as the target', () => {
    const trigger = interpretCard(pinned('Angel of Finality')).triggers[0];
    expect(trigger?.targets).toEqual([{ kind: 'player' }]);
    expect(trigger?.effects).toEqual([{ op: 'exileTargetPlayerGraveyard', target: 0 }]);
  });

  it('common-lines-another-target-ir — "another" excludes the source', () => {
    const trigger = interpretCard(pinned('Myr Retriever')).triggers[0];
    expect(trigger?.targets[0]).toMatchObject({
      kind: 'cardInGraveyard',
      filter: allOf(OTHER, ofType('Artifact')),
    });
  });

  it('common-lines-myr-retriever — returns another artifact card, never itself', () => {
    const ctx = pod('common-lines-retriever');
    const retriever = spawn(ctx, 'P1', pinned('Myr Retriever'));
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Lab Relic', typeLine: 'Artifact', manaCost: '{1}' }),
      'graveyard',
    );
    pump(moveObject(ctx, retriever, { zone: 'graveyard' }));
    const offered: string[] = [];
    settle(ctx, (decision) => {
      offered.push(...decision.options.map((option) => option.description));
      return { index: 0, targets: new Map() };
    });
    expect(offered.some((description) => description.includes('Myr Retriever'))).toBe(false);
    expect(playerById(ctx, 'P1').hand.map((object) => object.name)).toEqual(['Lab Relic']);
    expect(playerById(ctx, 'P1').graveyard.map((object) => object.name)).toEqual(['Myr Retriever']);

    // Alone in the graveyard it has no legal target, so it stays there.
    const lonely = pod('common-lines-retriever-alone');
    const only = spawn(lonely, 'P1', pinned('Myr Retriever'));
    pump(moveObject(lonely, only, { zone: 'graveyard' }));
    settle(lonely);
    expect(playerById(lonely, 'P1').hand).toHaveLength(0);
    expect(playerById(lonely, 'P1').graveyard.map((object) => object.name)).toEqual([
      'Myr Retriever',
    ]);
  });
});

describe('self cost reductions', () => {
  it('common-lines-cost-ir — a conditional and a per-noun reduction on the spell itself', () => {
    expect(interpretCard(pinned("Wizard's Retort")).ruleStatics).toEqual([
      {
        kind: 'costReduction',
        amount: { kind: 'const', n: 1 },
        selfOnly: true,
        condition: {
          kind: 'countPermanents',
          selector: { kind: 'subtype', value: 'Wizard' },
          scope: 'you',
          cmp: '>=',
          n: 1,
        },
      },
    ]);
    expect(interpretCard(pinned('Ghoultree')).ruleStatics).toEqual([
      {
        kind: 'costReduction',
        amount: {
          kind: 'countCardsInZone',
          zone: 'graveyard',
          selector: ofType('Creature'),
          owner: 'you',
        },
        selfOnly: true,
      },
    ]);
    // "if" clauses other than "you control …" are not read by this shape.
    expect(
      interpretCard(
        lineCard(
          'This spell costs {1} less to cast if it targets a creature.\nDraw a card.',
          'Instant',
        ),
      ).modeled,
    ).toBe(false);
  });

  it('common-lines-wizards-retort — {U}{U} casts it only while you control a Wizard', () => {
    const ctx = pod('common-lines-retort');
    // A spell to counter: P1 holds priority after casting it (CR 117.3c).
    const draw = conjure(ctx, 'P1', divination(), 'hand');
    addMana(playerById(ctx, 'P1'), mana('UC'));
    take(ctx, 'P1', optionFor(ctx, 'P1', draw.id)!.payload as PriorityActionPayload);

    const retort = conjure(ctx, 'P1', pinned("Wizard's Retort"), 'hand');
    addMana(playerById(ctx, 'P1'), mana('UU'));
    expect(optionFor(ctx, 'P1', retort.id)).toBeUndefined();
    spawn(ctx, 'P1', oracle({ name: 'Lab Wizard', typeLine: 'Creature — Human Wizard' }));
    expect(optionFor(ctx, 'P1', retort.id)).toBeDefined();
  });

  it('common-lines-ghoultree — one less for each creature card in your graveyard', () => {
    const ctx = pod('common-lines-ghoultree');
    const tree = conjure(ctx, 'P1', pinned('Ghoultree'), 'hand');
    addMana(playerById(ctx, 'P1'), mana('GCC'));
    for (let n = 0; n < 4; n++) conjure(ctx, 'P1', oracle({ name: `Lab Body ${n}` }), 'graveyard');
    // {7}{G} less 4 is {3}{G}: three mana is not enough.
    expect(optionFor(ctx, 'P1', tree.id)).toBeUndefined();
    conjure(ctx, 'P1', oracle({ name: 'Lab Body 4' }), 'graveyard');
    // Less 5 is {2}{G}.
    expect(optionFor(ctx, 'P1', tree.id)).toBeDefined();
    // A noncreature card does not count.
    const other = pod('common-lines-ghoultree-noncreature');
    const tree2 = conjure(other, 'P1', pinned('Ghoultree'), 'hand');
    addMana(playerById(other, 'P1'), mana('GCC'));
    for (let n = 0; n < 5; n++) {
      conjure(
        other,
        'P1',
        oracle({ name: `Lab Rite ${n}`, typeLine: 'Sorcery', oracleText: 'Draw a card.' }),
        'graveyard',
      );
    }
    expect(optionFor(other, 'P1', tree2.id)).toBeUndefined();
  });
});
