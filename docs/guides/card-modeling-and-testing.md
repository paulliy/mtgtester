# Modeling a Card and Testing It — a Practical Guide

Quality problems in modeled cards mostly aren't "the parser crashed." They're a card that
interprets as `modeled: true`, has a green unit test, and is still wrong in a real game — wrong
trigger timing, a target filter that's too loose, an ability description the AI can't parse, an
interaction with combat/SBAs nobody exercised. This guide is the loop that catches that class of
bug: how a card gets modeled, and the ladder of increasingly-real tests to run before calling it
done, ending with actually casting it in a game against — and via — the AI.

There is currently **no dedicated single-card sandbox** ("load one card, cast it, see what
happens"). The closest thing to that is planned but unbuilt — see [§7](#7-the-gap-no-single-card-sandbox-yet).
Until then, "testing in a client" means assembling a small real decklist around the card and
running it through the same single-player/spectator UI a real match uses.

## 1. How a card becomes "modeled"

```
OracleCard (Scryfall projection)
  → interpretCard()            packages/engine/src/cards/interpret.ts
  → CardDefinition              packages/engine/src/cards/definition.ts
  → applyOverride()             packages/engine/src/cards/overrides/index.ts   (if one is registered)
  → CardDefinition, modeled: boolean, unmodeledReasons: string[]
```

`interpretCard` walks every line of Oracle text against what the engine implements — keyword
list, mana-ability grammar, ETB/enters-tapped patterns, a spell-effect sentence registry, a
trigger-pattern registry — and produces a `CardDefinition`
(`packages/engine/src/cards/definition.ts:44-132`): identity/typing, cost/P-T, and a behavior IR
(`keywords`, `manaAbilities`, `activatedAbilities`, `spellAbility`, `triggers`, `staticEffects`,
`ruleStatics`, replacement fields like `entersTapped`/`entersWithCounters`). Any line it can't
account for is recorded in `unmodeledReasons` and the card comes out `modeled: false`. **The
engine halts loudly** (`UnmodeledCardError`) the moment an unmodeled card's behavior is actually
needed — it never guesses or falls back to "close enough" (brief §6.3).

**Two ways a card gets to `modeled: true`:**

1. **The generic parser already handles it.** Common templated text (conditional-enters-tapped
   lands, basic keyword lines, "draw two cards") needs no per-card work — see
   `packages/engine/tests/interpret.test.ts:6-23` for a plain vanilla-creature/keyword example.
2. **A hand-authored override** in `packages/engine/src/cards/overrides/`. Per ADR 0009, ~94% of
   unparsed Oracle lines occur on exactly *one* card — not worth a permanent grammar rule. Most
   real-deck cards you'll model go this route.

### Writing an override

1. Run the card through `interpretCard` (a quick fixture test or `bun run coverage <deck>`) and
   copy its `unmodeledReasons` **verbatim** — the interpreter strips reminder text and replaces
   the card's own name with `~` before reporting a reason, so don't type the line from the card
   face.
2. Add or extend a deck-specific file under `overrides/` (one file per source deck, e.g.
   `draconic-destruction.ts`), and register it in `overrides/index.ts`.
3. A `CardOverride` (`overrides/index.ts:42-53`) is:
   ```ts
   { oracleId, name, handledLines: string[], def: Partial<CardDefinition> }
   ```
   `def` may **only compose existing, already-tested `Effect`/`Ability` primitives** — a new
   executor primitive is out of scope for an override and belongs in the engine itself.
4. `applyOverride` clears exactly one `unmodeledReasons` entry per `handledLines` string
   (one-for-one, not a filter) and merges `def` over the interpreted definition; `modeled` flips
   true only once every reason is cleared.

This has a **drift guard** you should understand before writing tests around it
(`overrides/index.ts:1-30`): if a card gets errata'd, its printed line stops matching
`handledLines`, the reason survives, and the card silently reverts to `modeled: false` rather than
keep playing stale behavior. If your override claims a line the card doesn't have, or has an empty
`def`, that's flagged, not silently ignored — see the anti-patterns test in
`packages/engine/tests/overrides.test.ts:39-63`. Practical consequence: **`handledLines` copy-paste
errors fail loudly, not silently** — if your override doesn't take effect, check that string
first.

Example, Dragonkin Berserker (`packages/engine/src/cards/overrides/draconic-destruction.ts:9-38`)
— a cost-reduction static plus a hand-authored Boast activated ability, with a comment explaining
that the generic parser's token-creation effect is deliberately carried over unchanged so
replacing the whole `activatedAbilities` array doesn't silently drop it:

```ts
const DRAGONKIN_BERSERKER_DEF = {
  ruleStatics: [{
    kind: 'costReduction' as const,
    appliesTo: 'activate' as const,
    amount: { kind: 'countPermanents' as const, selector: ofSubtype('Dragon'), scope: 'you' as const },
    filter: SELF,
  }],
  activatedAbilities: [{
    costs: [{ kind: 'mana' as const, cost: parseManaCost('{4}{R}').cost! }],
    timing: 'any' as const,
    requiresAttackedThisTurn: true as const,
    oncePerTurn: true,
    ability: { kind: 'activated' as const, targets: [], effects: [{ /* create 5/5 flying Dragon */ }] },
  }],
};
```

## 2. The testing pyramid

Run these roughly in order — each level is cheaper to iterate on than the next, and each catches
a different class of bug. **Never stop at level 1.**

### Level 1 — `modeled: true` smoke check (necessary, not sufficient)

```ts
expect(interpretCard(myCard()).modeled).toBe(true);
```

This only proves every line parsed to *something*. It proves nothing about whether that something
is correct. The override registry's own rule: **"every override gets a behavioral test, never a
`modeled === true` test"** (`overrides/index.ts:29`). Treat this as step one of a test, never the
whole test.

### Level 2 — fixture/unit behavioral test (fastest real signal)

Location: `packages/engine/tests/*.test.ts`, using the shared harness in
`packages/engine/tests/fixtures.ts`. This bypasses full cast/priority machinery and resolves the
card's ability directly — cheapest way to pin exact behavior.

Pattern (from `packages/engine/tests/delayed-triggers.test.ts:79-150`):

```ts
function pod(seed = 'my-card'): GameContext {
  const ctx = createGame(gameConfig([0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })), { seed }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  return ctx;
}

it('does the thing the card says', function* () {
  const ctx = pod();
  const target = spawn(ctx, 'P1', oracle({ name: 'Bear', typeLine: 'Creature — Bear', power: '3', toughness: '3' }));
  const def = interpretCard(myCard());

  yield* executeAbility(
    ctx,
    { cardId: 'c-1', name: def.name, oracleId: def.oracleId, controllerId: 'P1' },
    def.spellAbility!,
    [target.id],
  );

  expect(/* something in ctx.state */).toBe(/* expected */);
});
```

Test bodies are **generators** (`function* () { ... }`) because ability resolution can pause on
decisions. Key fixture helpers: `oracle()` (build an `OracleCard`), `spawn()` (permanent straight
onto the battlefield), `conjure()` (card object into hand/graveyard/library/exile/command),
`registerDef()` / `registerCustomDef()`, `executeAbility()` (resolve one ability directly),
`queueTriggersForEvent()` (fire an event trigger without playing it out — e.g. simulate combat
damage), and `pump()` (drive a generator to completion, auto-answering forced decisions and
defaulting to option 0 otherwise). For activated/mana-cost edge cases, `mana-restricted.test.ts`
shows the lower-level pattern of calling `canPay`/`allowanceFor`/`selectEntriesToSpend`/`payManaCost`
directly against constructed `ManaEntry[]`.

Write one of these for: the card's core effect, each triggered/activated ability separately, and
every edge case from [§4](#4-edge-case-checklist) that applies.

### Level 3 — whole-game engine test (through real legality/priority)

Level 2 calls `executeAbility` directly, skipping the legal-action menu and priority passing —
real bugs live there too (wrong timing restriction, missing from the menu, wrong targets offered).
Use `packages/engine/tests/fixtures.ts`'s whole-game harness instead:

```ts
const engine = makeEngine([{ cards: [...] }, { cards: [...] }, ...]);
const result = drive(engine, new RuleBasedProvider([
  whenChoose({ player: 'P1', option: 'My Card', turn: 3 }),
  whenChoose({ player: 'P1', prompt: /target/i, option: 'Bear' }),
]));
```

`drive()` loops `engine.advance()`/`engine.submit()` to completion; `RuleBasedProvider` answers
each surfaced decision by matching a rule against the actual legal-action menu (falling back to
the first/conservative option), so this exercises the card exactly as a real decision provider —
human or AI — would see it. This is the level that catches "the ability never shows up in the
menu when it should" or "the wrong things are offered as legal targets."

### Level 4 — CLI practice match (closest thing to "just cast it and see")

`bun run play-decks <deckA> <deckB> [more...] [--seed S] [--verbose]`
(`packages/server/src/cli/play-decks.ts`) plays real, curated decklists against each other —
unlike `pool --play`, which only builds auto-generated decks and can't target a specific card.
To manually playtest one card:

1. Build a small plaintext decklist (or point at a Moxfield/Archidekt URL) that maximizes the
   chance of drawing and casting the card early — low curve, few must-have combo pieces, your card
   plus support for its use case. It must still be a full **legal 100-card Commander deck**
   (`packages/server/src/decks/generate.ts:24`, CR 903.5a) — `play-decks` still halts on any
   unresolved/unmodeled required card (`play-decks.ts:10-11`); it is a playtest tool, not a
   substitute for `bun run coverage`.
2. Pair it against a second real deck (an opposing archetype relevant to the card's use case —
   e.g. a deck with fliers if you're testing a reach/flying-blocker card, or one with things to
   remove if you're testing removal).
3. Run with `--verbose` to get a turn-by-turn decision log
   (`[Turn N] [P1] (phase) → "<chosen action description>"`) and watch for your card actually
   getting cast, targeted correctly, and resolving as expected. `RandomDecisionProvider` drives
   both seats here (no `--ai` flag on this CLI) — good for a fast, cheap functional pass; it will
   *not* tell you whether a smart player/AI would actually choose to cast it.
4. Vary `--seed` across a few runs — a single seed proves the card *can* work, not that it always
   does.

### Level 5 — interactive single-player game (real UI, human-driven)

This is "cast test casting it" in the sense of actually playing the card yourself through the real
client:

1. `bun run dev` (server on :3001, web UI on :5173).
2. In `SetupView.vue`: choose **Import** (not Pool) so you control the decklist, set **Game
   mode → Single player**, pick your **human seat**, and paste a decklist containing the target
   card (same "small deck maximizing the odds of drawing/casting it" approach as level 4). By
   default only your seat needs an explicit deck; the other three auto-fill from the supported
   pool unless you check "Choose all four decks instead" to hand-pick every seat (e.g. to control
   what your card interacts with — attackers to block, artifacts to destroy, etc.).
3. Set opponent **Provider kind**: `random` for a fast functional pass (do targeting prompts,
   stack visuals, and resolution all work correctly for a human player?), or `ai` to also observe
   how AI-controlled opponents react to your card being on the battlefield/stack (do they hold up
   removal for it, play around it, etc.).
4. Play the game, actually casting the card at different points (on curve, held up as an instant,
   in response to something) and exercising each of its abilities. This is the level that surfaces
   UX-adjacent correctness bugs unit tests won't: a confusing targeting prompt, a legal-but-wrong
   default target order, a stack/priority sequencing issue only visible turn-by-turn.
5. An optional `seed` reproduces the shuffle (AI decisions can still vary run to run since the AI
   is a live model call, not seeded).

### Level 6 — spectator mode, AI vs. AI (does the *gameplay AI* use it well?)

Same setup screen, **Game mode → Spectator**, all four seats AI-driven (or use
`bun run pool --play --ai` / `bun run pool --play --ai --benchmark-json out.json` from the CLI for
an unattended run with AI call/latency/token/fallback stats). Nobody is manually piloting a seat —
this is the level that actually answers the part of the ask about testing "with the AI, the actual
gameplay AI": does a bot holding this card ever choose to cast it, and does it use its abilities
sensibly, across a real multi-turn game against other bots? See [§5](#5-testing-specifically-against-the-gameplay-ai)
for what to watch for.

### Level 7 — aggregate coverage signal

`bun run coverage` / `bun run coverage <deckUrlOrFile>` (`packages/server/src/cards/coverage.ts`)
reports per-deck and aggregate model coverage plus a ranked "blocking mechanics" breakdown across
27 non-exclusive `MECHANIC_FAMILIES` (activated abilities, token creation, combat triggers,
cost reduction, tutors, mass removal, etc. — `coverage.ts:24-52`). Not a per-card test, but run it
after modeling a card that was blocking a real fixture deck to confirm that deck's coverage
actually moved, and re-run `bun run modelled-cards` to confirm the card now shows up in the
generated list.

## 3. Edge-case checklist

Work through these for every card — most correspond to a real footgun the engine's design
explicitly calls out:

- **Zone changes / object identity** — does the card care about "this object" across a zone
  change? A card becomes a *new object* on zone change (CR 400.7,
  `packages/engine/src/state/objects.ts:1-2`); a "when this dies, ..." trigger must read
  last-known battlefield state, not the post-move object.
- **Triggered-ability timing** — does the trigger fire off *current* characteristics at the event,
  or does it need last-known info? Do "whenever you cast" triggers correctly fire at announcement,
  before the spell resolves (`queueCastTriggers`), not at resolution?
- **Targeting legality** — are the offered targets exactly what the card's text allows? Does the
  spell/ability correctly fizzle when its only target becomes illegal?
- **Replacement vs. triggered ability** — does "enters with N counters" use
  `entersWithCounters`/`entersTapped(Unless)` (a replacement applied as the permanent enters,
  CR 614.1c) rather than a trigger? Modeling it as a trigger means a 0/0 creature dies to SBAs
  before its own "trigger" ever resolves (`definition.ts:82-104`).
- **State-based actions** — does anything about this card interact with SBAs in a way that depends
  on ordering (see previous bullet; also see `sba.test.ts`)?
- **Mana restrictions/filters** — if the card produces or cares about restricted mana ("spend this
  mana only to cast..."), remember a restriction is a property of the *whole payment*, not a
  single mana symbol; restricted mana must be spent first out of a mixed pool
  (`packages/engine/src/mana/pool.ts:1-4`, CR 106.4/106.6).
- **Copy effects** — if this card copies something (or gets copied), does it read *printed*
  (copiable) characteristics, never current/derived state? Picking up temporary buffs or other
  layer effects when copying is the specific bug called out at `objects.ts:405-438`.
- **Layers / continuous effects** — does a static ability interact correctly with dependency order
  against other continuous effects (`staticEffects`/`continuous-types.ts`, ADRs 0005-0008,
  `layers.test.ts`, `abilities-layer6.test.ts`)?
- **Commander-specific rules** — does the card interact with commander tax (cast-count-scaled
  `{2}` increments) or commander damage tracking, and is that covered
  (`packages/engine/src/actions/legal.ts:566-589`, `commander.test.ts`)?
- **Rule-modifying statics vs. layer statics** — is "can't be countered" / cost reduction / casting
  from a non-hand zone modeled as a `ruleStatics` entry (modifies the rules of casting) rather than
  a `staticEffects` layer entry (CR 613, modifies a permanent's characteristics)? These are
  deliberately separate fields (`definition.ts:120-125`) — putting one in the wrong bucket is a
  quiet bug.
- **Token creation** — do token ETB triggers fire? Tokens should go through the same
  `makePermanent`/`queueTriggersForObject` path as a normal permanent, not a special case.
- **Mana value / X on the stack** — if the card reads a spell's mana value mid-resolution, does it
  correctly read the *announced* `{X}` value (CR 202.3b) rather than re-deriving it after `X` is
  gone from the stack object? (See the pump-before-destroy ordering comment in
  `draconic-destruction.ts:47-51` for why effect *order* itself can be the bug.)

## 4. Testing specifically against the gameplay AI

The engine has a two-tier AI (ADR 0016, ADR 0021): a per-turn **strategist** call (prefetched
asynchronously at the previous turn boundary so it overlaps untap/upkeep/draw and never blocks a
tactical decision) produces a structured plan; each **tactician** call (the actual per-menu-pick
decision) consults that plan but must still choose from the engine's real legal-action menu — it
cannot invent an action. This means AI quality for your card is really testing two things:

1. **Does the tactician ever pick a good, legal use of the card when it's advantageous** — not
   just when it's the only option? Run level 6 (spectator, AI vs. AI, or `pool --play --ai`)
   across a few seeds; watch whether bots holding the card actually cast it, and whether its
   activated/triggered choices (targets, modal choices) look sensible rather than default/first-option.
2. **Is the legal-action `description` string good enough for a model to parse correctly?** The
   tactician picks from `legalActions[].description` text, same as `RuleBasedProvider.decide()`
   does in tests (`fixtures.ts:367-388`) — a vague or ambiguous description is a real AI-quality
   bug even when the underlying `Effect`/`Ability` IR is perfectly correct. If you're not sure
   whether a description reads clearly, that's a good thing to sanity-check by eye, the same way
   you'd read `whenChoose({ option: '...' })` patterns in tests.

Practical setup: put the card in an AI-controlled seat's deck (single-player with an AI opponent
seat, or full spectator with `providerKind: ai` / `--ai`) and watch several turns/seeds, since
these are live model calls and behavior is not deterministic run to run the way `RandomDecisionProvider`
is. `bun run pool --play --ai --benchmark-json out.json` reports AI call/fallback/latency/token
stats for the whole game — useful as a general AI-health signal (e.g. did the AI fail closed and
fall back a lot this game?), though it's aggregate, not per-card.

## 5. The gap: no single-card sandbox yet

Everything above assembles single-card testing out of tools built for something else (unit
fixtures, whole-deck CLIs, the real match UI). A proper "pick a deck, goldfish it, run a scenario
like commander-cast-by-turn-N" workspace is planned but **not built** — see
[`docs/plans/phase-10-deck-testing-lab.md`](../plans/phase-10-deck-testing-lab.md) ("Deck Testing
Lab and Simulation Engine"), explicitly scoped to include saved decks, scenario/goldfish tests,
and batch simulation with card-level metrics. Until that lands, level 4/5 above (a small curated
real decklist through `play-decks` or the single-player UI) is the practical substitute — it's
slower to set up per-card than a true sandbox would be, so don't skip levels 2-3 first; they're
cheap and catch most correctness bugs before you burn time on a manual playtest.

## 6. Command cheat sheet

```bash
bun run test                              # levels 1-3: engine unit/fixture/whole-game tests
bun run coverage [deckUrlOrFile...]       # level 7: aggregate + blocking-mechanics report
bun run coverage --json
bun run modelled-cards                    # regenerate docs/modelled-cards.md
bun run play-decks <deckA> <deckB> [--seed S] [--verbose]   # level 4: curated-deck CLI playtest
bun run pool --play --ai [--seed S] [--benchmark-json f]    # level 6: generated-deck AI-vs-AI
bun run dev                               # levels 5-6: real client (server :3001 + web :5173)
```

## 7. Before calling a card done

- [ ] `modeled: true`, with `unmodeledReasons` empty for the printing you targeted.
- [ ] Level 2 fixture test(s) for the core effect and each ability, covering the applicable
      [edge cases](#3-edge-case-checklist).
- [ ] Level 3 whole-game test proving the ability appears correctly in the legal-action menu and
      resolves through real priority (not just via direct `executeAbility`).
- [ ] Level 4 or 5 manual playtest: cast it, use each ability, in a real (or CLI-simulated) game.
- [ ] Level 6 spectator/AI pass across a couple of seeds: the AI actually uses the card, and its
      action descriptions read unambiguously.
- [ ] If it unblocks a real fixture deck, `bun run coverage` shows the improvement and
      `bun run modelled-cards` lists it.
