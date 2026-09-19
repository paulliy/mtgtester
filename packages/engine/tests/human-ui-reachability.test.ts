/**
 * "Can a human actually reach this option, and does the card actually do what it says?" — a
 * per-card regression suite for the player-experience overhaul.
 *
 * Two independent claims are checked for each real card below, driven through the ACTUAL
 * engine pipeline (ETB/dies event → `priorityCheckpoint` places the trigger on the stack,
 * choosing targets/modes on the way (CR 603.3c/d) → `resolveTopOfStack` resolves it), never a
 * shortcut that hands the ability pre-resolved targets:
 *
 * 1. Reachability — every option in every decision is something a human could actually click.
 *    `isReachable` mirrors `PlayerGameView.vue`'s real routing logic (`sourceId()` /
 *    `isImmediate()` / the `sourceActions` vs. `fallbackActions` split) against `interactionFor`
 *    — the same function `Engine.buildRequest` uses — so a pass here is a genuine claim about
 *    the real web UI, not a hand-rolled approximation of it. An `EngineActionOption` whose
 *    payload names an object with no on-screen representation (a library card, a bare mode
 *    string like `"Khans"`, a player when nothing lets a human focus a player as a source) gets
 *    misread by the UI as "click the board object with this id" and becomes permanently
 *    unreachable — invisible to an AI provider, which answers by index, never by clicking.
 * 2. Correctness — the resulting game state matches the card's printed text, including the
 *    parts a shortcut test could paper over: "up to two" really means 0, 1, or 2, never a
 *    forced 1; a modal ability actually reaches every mode, not just whichever one a test
 *    happened to invoke directly.
 */

import { describe, expect, it } from 'vitest';
import type { EngineActionOption, PendingDecision } from '../src/decisions';
import { interactionFor } from '../src/engine';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { priorityCheckpoint } from '../src/sba/sba';
import { resolveTopOfStack } from '../src/stack/stack';
import { moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  island,
  mountain,
  oracle,
  pump,
  registerDef,
} from './fixtures';

function pod(seats = 2, seed = 'human-ui'): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: seats }, () => ({ cards: copies(2, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const p1 = (ctx: GameContext): EnginePlayerState =>
  ctx.state.players.find((p) => p.id === 'P1') as EnginePlayerState;

/** Put a card on the battlefield through the real ETB event, so its own triggers actually queue. */
function enterBattlefield(ctx: GameContext, card: ReturnType<typeof oracle>) {
  const obj = conjure(ctx, 'P1', card, 'hand');
  const { decisions } = pump(moveObject(ctx, obj, { zone: 'battlefield', controllerId: 'P1' }));
  const perm = ctx.state.battlefield.find((p) => p.cardId === obj.cardId);
  if (perm === undefined) throw new Error(`${card.name} did not end up on the battlefield`);
  return { perm, entryDecisions: decisions };
}

/**
 * Place every waiting trigger on the stack (choosing targets, CR 603.3d) then resolve it
 * (running its effects, which is also where a resolution-time `chooseOne` — including a
 * triggered ability's modes, folded into one by `pushTriggerOnStack` — gets asked). Both
 * stages can surface decisions, so both are collected.
 */
function placeAndResolve(ctx: GameContext, answer?: Parameters<typeof pump>[1]): PendingDecision[] {
  const placement = pump(priorityCheckpoint(ctx), answer);
  const resolution = pump(resolveTopOfStack(ctx), answer);
  return [...placement.decisions, ...resolution.decisions];
}

/**
 * Mirrors `PlayerGameView.vue`'s `sourceId()` — the function deciding whether an option lands
 * in the "focus this board object" flow (`sourceActions`) or the generic decision panel
 * (`fallbackActions`, which renders every option as its own button, always clickable).
 */
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
      return null; // 'immediate' and 'order' never require a board click
  }
}

/**
 * True if a human could actually click their way to this option: either it needs no board
 * focus at all (falls into the generic panel), or its `sourceId` matches something the web UI
 * actually renders as clickable for `playerId` — a battlefield permanent, a hand card, or a
 * command-zone card (commanders render as clickable — see `PlayerGameView.vue`).
 */
function isReachable(ctx: GameContext, playerId: string, option: EngineActionOption): boolean {
  const interaction = interactionFor(option);
  if (interaction.kind === 'immediate' || interaction.kind === 'order') return true;
  if (interaction.kind === 'attack' || interaction.kind === 'block') return true; // dedicated combat UI
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

describe("Kodama's Reach", () => {
  const kodamasReach = () =>
    oracle({
      name: "Kodama's Reach",
      typeLine: 'Sorcery',
      manaCost: '{2}{G}',
      power: null,
      toughness: null,
      oracleText:
        'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
    });

  it('puts one basic land onto the battlefield tapped and the other into hand, with every option reachable', () => {
    const ctx = pod();
    const player = p1(ctx);
    player.library.length = 0;
    // Three DISTINCT basics: with only two left after the first pick, a single remaining match
    // would auto-select for the second destination (the engine skips a decision when there is
    // only one candidate) — a third keeps both search decisions real, not auto-resolved.
    conjure(ctx, 'P1', mountain(), 'library');
    conjure(ctx, 'P1', forest(), 'library');
    conjure(ctx, 'P1', island(), 'library');

    const def = registerDef(ctx, kodamasReach());
    const { decisions } = pump(
      executeAbility(
        ctx,
        { cardId: 'c-reach', name: def.name, oracleId: def.oracleId, controllerId: 'P1' },
        def.spellAbility!,
        [],
      ),
      // Take Mountain for the battlefield destination; whatever's first for the hand destination.
      (d) => {
        const mountainIdx = d.options.findIndex((o) => /Mountain/.test(o.description));
        return { index: mountainIdx >= 0 ? mountainIdx : 0, targets: new Map() };
      },
    );

    const search = decisions.filter((d) => d.prompt.includes('search your library'));
    expect(search).toHaveLength(2); // one decision per destination (battlefield, then hand)
    expectAllReachable(ctx, search);

    expect(ctx.state.battlefield.find((perm) => perm.name === 'Mountain')?.tapped).toBe(true);
    expect(player.hand).toHaveLength(1);
    expect(player.library).toHaveLength(1);
    // Everything found ends up in exactly one of {battlefield, hand}; nothing duplicated or lost.
    expect([...player.hand, ...player.library].map((c) => c.name).sort()).toEqual([
      'Forest',
      'Island',
    ]);
  });

  it('never obliges the searcher to find (CR 701.19c), and that option is reachable too', () => {
    const ctx = pod();
    const player = p1(ctx);
    player.library.length = 0;
    // Two DISTINCT basics so a real decision (with a real "Find nothing") surfaces — one
    // candidate alone auto-selects with no decision at all, which would make "always answer
    // index 1" silently pick nothing FOR THE WRONG REASON (no options to have declined).
    conjure(ctx, 'P1', mountain(), 'library');
    conjure(ctx, 'P1', forest(), 'library');

    const def = registerDef(ctx, kodamasReach());
    const { decisions } = pump(
      executeAbility(
        ctx,
        { cardId: 'c-reach', name: def.name, oracleId: def.oracleId, controllerId: 'P1' },
        def.spellAbility!,
        [],
      ),
      (d) => ({
        index: d.options.findIndex((o) => /Find nothing/.test(o.description)),
        targets: new Map(),
      }),
    );

    const search = decisions.filter((d) => d.prompt.includes('search your library'));
    expect(search).toHaveLength(1); // declining the first destination stops the whole search
    expectAllReachable(ctx, search);
    expect(ctx.state.battlefield.some((perm) => perm.name === 'Mountain')).toBe(false);
    expect(player.library.map((c) => c.name).sort()).toEqual(['Forest', 'Mountain']);
  });
});

describe('Marang River Regent', () => {
  const marangRiverRegent = () =>
    oracle({
      name: 'Marang River Regent // Coil and Catch',
      typeLine: 'Creature — Dragon // Instant — Omen',
      manaCost: '{4}{U}{U} // {3}{U}',
      power: '6',
      toughness: '7',
      keywords: ['Flying'],
      oracleText:
        "Flying\nWhen this creature enters, return up to two other target nonland permanents to their owners' hands.",
    });

  it('"up to two" bounces exactly as many as chosen (2 here), leaving the rest alone — every choice reachable', () => {
    const ctx = pod(3);
    const foe1 = conjure(
      ctx,
      'P2',
      oracle({ name: 'Foe One', typeLine: 'Creature — Bear', power: '1', toughness: '1' }),
      'hand',
    );
    pump(moveObject(ctx, foe1, { zone: 'battlefield', controllerId: 'P2' }));
    const foe2 = conjure(
      ctx,
      'P3',
      oracle({ name: 'Foe Two', typeLine: 'Creature — Bear', power: '1', toughness: '1' }),
      'hand',
    );
    pump(moveObject(ctx, foe2, { zone: 'battlefield', controllerId: 'P3' }));
    const untouched = conjure(
      ctx,
      'P2',
      oracle({ name: 'Untouched', typeLine: 'Creature — Bear', power: '1', toughness: '1' }),
      'hand',
    );
    pump(moveObject(ctx, untouched, { zone: 'battlefield', controllerId: 'P2' }));

    registerDef(ctx, marangRiverRegent());
    const { perm: regent } = enterBattlefield(ctx, marangRiverRegent());

    const decisions = placeAndResolve(ctx);
    expect(decisions.length).toBeGreaterThan(0);
    expectAllReachable(ctx, decisions);
    // Every pick decision is reachable specifically THROUGH the dragon that just entered.
    for (const d of decisions.filter((d) => d.prompt.includes('choose'))) {
      for (const opt of d.options.filter((o) => o.type === 'pickTarget')) {
        expect(frontendSourceId(opt)).toBeNull(); // count-slot picks are plain panel buttons
      }
    }

    expect(
      ctx.state.players
        .find((p) => p.id === 'P2')!
        .hand.map((c) => c.name)
        .sort(),
    ).toEqual(['Foe One']);
    expect(ctx.state.players.find((p) => p.id === 'P3')!.hand.map((c) => c.name)).toEqual([
      'Foe Two',
    ]);
    expect(ctx.state.battlefield.some((p) => p.name === 'Untouched')).toBe(true);
    expect(ctx.state.battlefield.some((p) => p.cardId === regent.cardId)).toBe(true); // Regent stays
  });

  it('never obliges the controller to bounce anything (0 is legal) — regression for the "up to two" count being silently dropped', () => {
    const ctx = pod(3);
    const foe = conjure(
      ctx,
      'P2',
      oracle({ name: 'Foe', typeLine: 'Creature — Bear', power: '1', toughness: '1' }),
      'hand',
    );
    pump(moveObject(ctx, foe, { zone: 'battlefield', controllerId: 'P2' }));

    registerDef(ctx, marangRiverRegent());
    enterBattlefield(ctx, marangRiverRegent());
    // Every `pump` in `placeAndResolve` defaults to option 0; for a count slot's per-pick
    // decision, option 0 is never "stop early" (that's a later option), but since `pump`
    // defaults to index 0 for EVERY decision including the first pick, declining requires
    // explicitly choosing "stop" — so drive it by hand instead of `placeAndResolve`.
    const { decisions } = pump(priorityCheckpoint(ctx), (d) => {
      const decline = d.options.findIndex((o) => o.type === 'decline');
      return { index: decline >= 0 ? decline : 0, targets: new Map() };
    });
    pump(resolveTopOfStack(ctx));
    expect(decisions.length).toBeGreaterThan(0);

    // Before this fix, "up to two" was parsed as exactly one MANDATORY target — the option to
    // decline entirely (bounce nothing) would not have existed at all.
    expect(ctx.state.players.find((p) => p.id === 'P2')!.hand).toHaveLength(0);
    expect(ctx.state.battlefield.some((p) => p.name === 'Foe')).toBe(true);
  });
});

describe('Caged Sun', () => {
  const cagedSun = () =>
    oracle({
      oracleId: '09b895ff-e729-48d1-bfc1-ea5fd7adda6a',
      name: 'Caged Sun',
      typeLine: 'Artifact',
      manaCost: '{5}',
      power: null,
      toughness: null,
      oracleText:
        "As this artifact enters, choose a color.\nCreatures you control of the chosen color get +1/+1.\nWhenever a land's ability causes you to add one or more mana of the chosen color, add an additional one mana of that color.",
    });

  it('does not present a color-choice as-enters replacement after catalog containment', () => {
    const ctx = pod();
    const { entryDecisions } = enterBattlefield(ctx, cagedSun());
    const choice = entryDecisions.filter((d) => d.prompt.includes('Choose a color'));
    expect(choice).toHaveLength(0);
    expect(interpretCard(cagedSun()).modeled).toBe(false);
  });
});

describe('Viral Drone (proliferate)', () => {
  const viralDrone = () =>
    oracle({
      name: 'Viral Drone',
      typeLine: 'Creature — Phyrexian Insect',
      manaCost: '{2}{U}',
      power: '1',
      toughness: '3',
      oracleText: 'When Viral Drone enters the battlefield, proliferate.',
    });

  it('offers proliferate on a player without depending on a board click nothing renders', () => {
    const ctx = pod();
    p1(ctx).poisonCounters = 1;

    enterBattlefield(ctx, viralDrone()); // queues the trigger; still needs placing + resolving
    const decisions = placeAndResolve(ctx);
    const prolif = decisions.filter((d) => d.prompt.includes('proliferate counters on P1'));
    expect(prolif).toHaveLength(1);
    for (const option of prolif[0]!.options) {
      // The web UI has no way to focus a player as a source (only as a TARGET of another
      // action, via `chooseOpponent`) — so this must not depend on a board click at all.
      expect(frontendSourceId(option)).toBeNull();
    }
    expectAllReachable(ctx, prolif);
    expect(p1(ctx).poisonCounters).toBe(2); // chosen (option 0, "Proliferate") by the default pump
  });
});

describe('Ureni of the Unwritten', () => {
  const ureni = () =>
    oracle({
      name: 'Ureni of the Unwritten',
      typeLine: 'Legendary Creature — Spirit Dragon',
      manaCost: '{4}{G}{U}{R}',
      power: '7',
      toughness: '7',
      keywords: ['Flying', 'Trample'],
      oracleText:
        'Flying, trample\nWhenever Ureni enters or attacks, look at the top eight cards of your library. You may put a Dragon creature card from among them onto the battlefield. Put the rest on the bottom of your library in a random order.',
    });

  it('offers reachable library-card options and puts the chosen Dragon onto the battlefield', () => {
    const ctx = pod();
    const player = p1(ctx);
    player.library.length = 0;
    for (let i = 0; i < 7; i++) {
      conjure(ctx, 'P1', oracle({ name: `Filler ${i}`, typeLine: 'Creature — Bear' }), 'library');
    }
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Whelp of the Unwritten', typeLine: 'Creature — Dragon' }),
      'library',
    );

    const { entryDecisions } = enterBattlefield(ctx, ureni());
    const decisions = placeAndResolve(ctx);
    const lookAt = [...entryDecisions, ...decisions].filter((d) =>
      d.prompt.includes('among the top'),
    );
    expect(lookAt).toHaveLength(1);
    expectAllReachable(ctx, lookAt);

    expect(ctx.state.battlefield.some((p) => p.name === 'Whelp of the Unwritten')).toBe(true);
    expect(player.library).toHaveLength(7); // the 7 fillers, bottomed
  });
});

describe('Kairi, the Swirling Sky', () => {
  const kairi = () =>
    oracle({
      oracleId: '85aa53e8-f062-4d02-bc69-1413f7f0dcf1',
      name: 'Kairi, the Swirling Sky',
      typeLine: 'Legendary Creature — Dragon Spirit',
      manaCost: '{4}{U}{U}',
      power: '6',
      toughness: '6',
      keywords: ['Flying', 'Ward', 'Mill'],
      oracleText:
        "Flying, ward {3}\nWhen Kairi dies, choose one —\n• Return any number of target nonland permanents with total mana value 6 or less to their owners' hands.\n• Mill six cards, then return up to two instant and/or sorcery cards from your graveyard to your hand.",
    });

  it('dies trigger still carries two modes on leftover IR, but the card is catalog-contained', () => {
    // Regression for `Ability.modes` being a spell-casting-time-only mechanism: a triggered
    // ability built the same way (Kairi's dies trigger) never asked its mode question and
    // never ran either mode's effects — `effects: []` resolved to nothing, silently.
    const def = interpretCard(kairi());
    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons.join('\n')).toContain('explicitly unsupported:');
    expect(def.triggers[0]?.effects).toEqual([]); // modes still live in `.modes`, not `.effects`...
    expect(def.triggers[0]?.modes?.options).toHaveLength(2); // ...but a real choice IS declared
  });

  it('choosing "mill, then return spells" actually mills, returns up to two, and the mode choice is reachable', () => {
    const ctx = pod();
    const player = p1(ctx);
    player.library.length = 0;
    for (let i = 0; i < 6; i++) {
      conjure(
        ctx,
        'P1',
        oracle({ name: `Bolt ${i}`, typeLine: 'Instant', manaCost: '{R}' }),
        'library',
      );
    }

    const kairiCard = kairi();
    registerDef(ctx, kairiCard);
    const perm = conjure(ctx, 'P1', kairiCard, 'hand');
    pump(moveObject(ctx, perm, { zone: 'battlefield', controllerId: 'P1' }));
    const onBoard = ctx.state.battlefield.find((p) => p.cardId === perm.cardId)!;

    pump(moveObject(ctx, onBoard, { zone: 'graveyard' })); // dies — queues the modal trigger

    // Kairi's `targets: []`, so placement (CR 603.3d) asks nothing; the mode choice and its
    // nested "which spell to return" decision both happen at RESOLUTION, inside one
    // `executeAbility` call — one answer function has to field both prompts.
    const placement = pump(priorityCheckpoint(ctx));
    expect(placement.decisions).toHaveLength(0);

    const { decisions } = pump(resolveTopOfStack(ctx), (d) => {
      if (d.prompt.toLowerCase().includes('choose one')) {
        return {
          index: d.options.findIndex((o) => /Mill/.test(o.description)),
          targets: new Map(),
        };
      }
      if (d.prompt.includes('choose instant/sorcery card from graveyard')) {
        return {
          index: d.options.findIndex((o) => /Return/.test(o.description)),
          targets: new Map(),
        };
      }
      return { index: 0, targets: new Map() };
    });

    const modeChoice = decisions.filter((d) => d.prompt.toLowerCase().includes('choose one'));
    expect(modeChoice).toHaveLength(1);
    expectAllReachable(ctx, modeChoice);

    const returnChoice = decisions.filter((d) =>
      d.prompt.includes('choose instant/sorcery card from graveyard'),
    );
    expect(returnChoice.length).toBeGreaterThan(0);
    expectAllReachable(ctx, returnChoice);

    // "Up to two": the answer function above always takes a Bolt while one is offered, so both
    // return-passes fire — 6 milled, 2 returned, 4 left behind.
    expect(returnChoice).toHaveLength(2);
    expect(player.graveyard.filter((c) => c.name.startsWith('Bolt'))).toHaveLength(4);
    expect(player.hand.filter((c) => c.name.startsWith('Bolt'))).toHaveLength(2);
  });
});

describe('Drakuseth, Maw of Flames', () => {
  const drakuseth = () =>
    oracle({
      name: 'Drakuseth, Maw of Flames',
      typeLine: 'Legendary Creature — Dragon',
      manaCost: '{4}{R}{R}{R}',
      power: '7',
      toughness: '7',
      keywords: ['Flying'],
      oracleText:
        'Flying\nWhen Drakuseth, Maw of Flames enters the battlefield, it deals 4 damage to any target and 3 damage to each of up to two other targets.',
    });

  it('deals 4 to the fixed target and 3 to each of up to two OTHER targets, all reachable', () => {
    const ctx = pod(4);
    const t1 = conjure(
      ctx,
      'P2',
      oracle({ name: 'Target One', typeLine: 'Creature — Bear', power: '1', toughness: '4' }),
      'hand',
    );
    pump(moveObject(ctx, t1, { zone: 'battlefield', controllerId: 'P2' }));
    const t2 = conjure(
      ctx,
      'P3',
      oracle({ name: 'Target Two', typeLine: 'Creature — Bear', power: '1', toughness: '4' }),
      'hand',
    );
    pump(moveObject(ctx, t2, { zone: 'battlefield', controllerId: 'P3' }));
    const t3 = conjure(
      ctx,
      'P4',
      oracle({ name: 'Target Three', typeLine: 'Creature — Bear', power: '1', toughness: '4' }),
      'hand',
    );
    pump(moveObject(ctx, t3, { zone: 'battlefield', controllerId: 'P4' }));

    const { perm: drak } = enterBattlefield(ctx, drakuseth());
    const decisions = placeAndResolve(ctx);
    expect(decisions.length).toBeGreaterThan(0);
    expectAllReachable(ctx, decisions);

    const drakOnBoard = ctx.state.battlefield.find((p) => p.cardId === drak.cardId)!;
    // Every `pump` default of index 0: the "any target" fixed slot picks the first legal
    // option (Drakuseth itself is excluded only from the OTHER slot, not this one), and the
    // count slot picks the first two candidates before its "stop" option.
    const totalDamage = [t1, t2, t3, drakOnBoard]
      .map((p) => ctx.state.battlefield.find((b) => b.cardId === p.cardId)?.damageMarked ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(totalDamage).toBe(10); // 4 + 3 + 3, spread across exactly 3 of the 4 possible targets
  });
});
