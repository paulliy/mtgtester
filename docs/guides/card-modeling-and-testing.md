# Modeling a Card and Testing It — a Practical Guide

Quality problems in modeled cards mostly aren't "the parser crashed." They're a card that
interprets as `modeled: true`, has a green unit test, and is still wrong in a real game — wrong
trigger timing, a target filter that's too loose, an ability description the AI can't parse, an
interaction with combat/SBAs nobody exercised. This guide is the loop that catches that class of
bug: how a card gets modeled, and the ladder of increasingly-real tests to run before calling it
done, ending with actually casting it in a game against — and via — the AI.

This is the repository's canonical card-completion standard. `CLAUDE.md`, `AGENTS.md`, pull
requests, manifests, and CI point here rather than restating weaker variants.

The viewer privacy boundary must never return opponent decklists or private card data.

## Completion rule

A card has four independent states:

1. **Implementation** — `unsupported`, `implemented-unreviewed`, or `implemented-reviewed`.
2. **Engine evidence** — generated results from pinned-fixture interpretation, positive and
   negative behavior, targeting, costs, timing, zone changes, and the normal cast/activation path.
3. **Viewer evidence** — generated results and Playwright traces from the real frontend, backend,
   WebSocket protocol, and production engine, bound to the tested revision and scenario/Oracle
   hashes.
4. **Gameplay-AI evidence** — separately reported observations for scripted, heuristic, or live
   LLM providers. This is quality evidence, never a correctness gate.

`modeled: true`, deck membership, a registry snapshot, a mocked UI test, aggregate coverage, or an
agent's completion statement proves none of states 2–4. A newly completed card requires reviewed
implementation plus current engine and viewer evidence. Existing modeled cards remain
`implemented-unreviewed` until audited to this standard.

For every Oracle clause changed, record this checklist in the verification manifest and pull
request:

- exact Oracle clause and pinned Oracle hash;
- implementation primitive or explicit unsupported reason;
- positive test/scenario ID;
- negative test/scenario ID;
- applicable cost, targeting, timing, zone-change, and normal cast/activation scenario IDs;
- required viewer scenario IDs;
- separate gameplay-AI scenario IDs, if quality is evaluated.

The manifest declares requirements and mappings. Tools generate pass/fail/skip evidence; humans do
not handwrite success flags.

The Card Test Lab now runs deterministic prepared scenarios through the production engine and
WebSocket protocol. Its Playwright suite drives the real frontend and backend and retains traces.
Use it for reproducible clause-level viewer evidence. A curated 100-card match remains necessary
when a card depends on deck construction or longer game context; gameplay-AI evidence is evaluated
separately.

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
   unparsed Oracle lines occur on exactly _one_ card — not worth a permanent grammar rule. Most
   real-deck cards you'll model go this route.

### Writing an override

1. Run the card through `interpretCard` (a quick fixture test or `bun run coverage <deck>`) and
   copy its `unmodeledReasons` **verbatim** — the interpreter strips reminder text and replaces
   the card's own name with `~` before reporting a reason, so don't type the line from the card
   face.
2. Add or extend a deck-specific file under `overrides/` (one file per source deck, e.g.
   `draconic-destruction.ts`), and register it in `overrides/index.ts`.
3. Register the card with **`defineCard`**, and build its `def` from the shared builders in
   [`cards/templates.ts`](../../packages/engine/src/cards/templates.ts) and the token catalog in
   [`cards/tokens.ts`](../../packages/engine/src/cards/tokens.ts):

   ```ts
   defineCard(
     '06b77a80-…',
     'Dragonkin Berserker',
     ['Boast — {4}{R}: Create a 5/5 red Dragon creature token with flying.'],
     {
       activatedAbilities: [
         activated({
           costs: [mana('{4}{R}')],
           requiresAttackedThisTurn: true,
           oncePerTurn: true,
           effects: [{ op: 'createToken', spec: DRAGON_5_5_FLYING, count: constant(1) }],
           description: 'Boast — {4}{R}: Create a 5/5 red Dragon creature token with flying',
         }),
       ],
     },
   );
   ```

   `defineCard` registers the card under **both** its real Scryfall id and the `oracle-<slug>`
   fixture id `tests/fixtures.ts::oracle()` derives from the name — so a test can build the card
   by name and still get its behavior. Writing the two registrations separately is how cards ended
   up behaving differently depending on which id loaded them.

   Use `unimplemented(oracleId, name, handledLines)` for a card whose lines you want catalogued but
   whose behavior isn't authored yet. It registers an empty patch, which `applyOverride`
   deliberately refuses to honor — the card stays `modeled: false`, so this is a visible backlog
   marker, never a way to make a card count as handled.

   Use `unsupportedCard(oracleId, name, reason)` when an existing implementation is confirmed
   incorrect, including when the generic parser would otherwise report it modeled. This explicit
   containment overrides prior authored behavior and removes the card from the supported pool
   until a faithful implementation replaces it.

   Reach for a builder rather than a literal: `spell` / `triggered` / `activated` for ability
   envelopes, `onEtb()` / `onDies()` / `whenEnters(sel)` / `onUpkeep()` for trigger heads,
   `mana('{2}{R}')` / `TAP` / `SAC_SELF` for costs, `targetSlots` when an ability has more than one
   target, `lord` / `auraBuff` / `costReductionFor` for statics. ESLint blocks the two primitives
   these replace (`registerOverride`, `parseManaCost`) inside `overrides/`.

   `def` may **only compose existing, already-tested `Effect`/`Ability` primitives** — a new
   executor primitive is out of scope for an override and belongs in the engine itself. If a card
   needs a cost or effect that doesn't exist, leave it `unimplemented` rather than approximating.
   A substitute cost, broader target, wrong event, or executable `noOp` is not partial support:
   contain it with `unsupportedCard`. Six cards once carried fields that were not in the IR at all,
   and every one of them silently did
   nothing (see `tests/silverquill-malformed-fields.test.ts`).

4. `applyOverride` clears exactly one `unmodeledReasons` entry per `handledLines` string
   (one-for-one, not a filter) and merges `def` over the interpreted definition; `modeled` flips
   true only once every reason is cleared. The merge is a **shallow spread, so arrays are replaced
   wholesale** — setting `activatedAbilities` discards every ability the parser found, which is why
   `draconic-destruction.ts:17` has to hand-carry one back.

**Never inline a `TokenSpec`.** Add it to `cards/tokens.ts` and reference the const. A token is
pure data, so one written out per file is one that drifts: before the catalog there were three
different Treasures (one with no costs at all — a free repeatable any-color mana source) and a
Soldier that was white in four places and white-green in two.

Changing authored card data will fail `tests/override-defs.test.ts`, which pins the whole registry.
That's a tripwire, not an error — confirm the diff is what you meant, then regenerate with
`bun run scripts/snapshot-override-defs.ts`. Never regenerate to make it pass without reading the
diff: a card quietly losing an ability looks exactly like a card intentionally gaining one.

This has a **drift guard** you should understand before writing tests around it
(`overrides/index.ts:1-30`): if a card gets errata'd, its printed line stops matching
`handledLines`, the reason survives, and the card silently reverts to `modeled: false` rather than
keep playing stale behavior. If your override claims a line the card doesn't have, or has an empty
`def`, that's flagged, not silently ignored — see the anti-patterns test in
`packages/engine/tests/overrides.test.ts:39-63`. Practical consequence: **`handledLines` copy-paste
errors fail loudly, not silently** — if your override doesn't take effect, check that string
first.

Do not copy old literal `CardDefinition` examples from reviews or snapshots. They bypass the
current builders and quickly become misleading. The `defineCard` example above and executable
tests in the current tree are authoritative.

## 2. The testing pyramid

Run these roughly in order — each level is cheaper to iterate on than the next, and each catches
a different class of bug. **Never stop at level 1.**

### Level 1 — `modeled: true` smoke check (necessary, not sufficient)

```ts
expect(interpretCard(myCard()).modeled).toBe(true);
```

This only proves every line parsed to _something_. It proves nothing about whether that something
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
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  return ctx;
}

it('does the thing the card says', () => {
  const ctx = pod();
  const target = spawn(
    ctx,
    'P1',
    oracle({ name: 'Bear', typeLine: 'Creature — Bear', power: '3', toughness: '3' }),
  );
  const def = interpretCard(myCard());

  pump(
    executeAbility(
      ctx,
      { cardId: 'c-1', name: def.name, oracleId: def.oracleId, controllerId: 'P1' },
      def.spellAbility!,
      [target.id],
    ),
  );

  expect(/* something in ctx.state */).toBe(/* expected */);
});
```

Vitest callbacks are normal functions. Ability resolution is the generator, and `pump()` drives it
to completion while supplying explicit decisions where choices matter. A generator-bodied Vitest
callback is not a supported test pattern and may never execute the assertions as intended. Key
fixture helpers: `oracle()` (build an `OracleCard`), `spawn()` (permanent straight
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
   _not_ tell you whether a smart player/AI would actually choose to cast it.
4. Vary `--seed` across a few runs — a single seed proves the card _can_ work, not that it always
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

### Level 6 — spectator mode, AI vs. AI (does the _gameplay AI_ use it well?)

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
  change? A card becomes a _new object_ on zone change (CR 400.7,
  `packages/engine/src/state/objects.ts:1-2`); a "when this dies, ..." trigger must read
  last-known battlefield state, not the post-move object.
- **Triggered-ability timing** — does the trigger fire off _current_ characteristics at the event,
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
  mana only to cast..."), remember a restriction is a property of the _whole payment_, not a
  single mana symbol; restricted mana must be spent first out of a mixed pool
  (`packages/engine/src/mana/pool.ts:1-4`, CR 106.4/106.6).
- **Copy effects** — if this card copies something (or gets copied), does it read _printed_
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
  correctly read the _announced_ `{X}` value (CR 202.3b) rather than re-deriving it after `X` is
  gone from the stack object? (See the pump-before-destroy ordering comment in
  `draconic-destruction.ts:47-51` for why effect _order_ itself can be the bug.)

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

## 5. Card Test Lab and real-viewer evidence

`packages/server/src/cards/card-test-scenarios.ts` registers deterministic prepared games with
pinned Oracle hashes and clause IDs. The scenario must drive the production engine through legal
actions, payment, priority, the stack, and resolution. Its server test verifies the authoritative
state and event stream.

`apps/web/e2e/card-test-lab.spec.ts` then drives the real Vue viewer against the real lab backend
over WebSocket. Assert the actual interaction and result, and retain the Playwright trace. The
verification manifest names the required scenario IDs; the card gate rejects missing registered
scenarios. Re-run the browser suite after changing engine action presentation or the viewer.

Prepared lab states are intentionally narrow. Use a legal curated deck and multiple seeds for
interaction that needs normal game progression. Report gameplay-AI decisions separately from rules
and viewer correctness.

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

- [ ] A pinned offline fixture records the real Oracle ID, full Oracle text/faces, retrieval date,
      and content hash.
- [ ] Every Oracle clause maps to an implementation primitive or explicit unsupported status and
      to positive and negative scenario IDs.
- [ ] `modeled: true` and empty `unmodeledReasons` hold for both the real Oracle ID and fixture
      alias. This is a prerequisite, not proof.
- [ ] Normal Vitest callbacks run fixture behavior tests for every ability and applicable
      [edge case](#3-edge-case-checklist); decision generators are driven with `pump()`.
- [ ] Whole-game tests prove costs, targets, timing, and normal cast/activation through legality,
      priority, the stack, and resolution. Direct `executeAbility` tests alone are insufficient.
- [ ] The Card Test Lab runs each declared deterministic scenario through the production engine.
- [ ] Playwright drives the real frontend and backend for each required viewer scenario and
      retains assertions, trace, revision, Oracle hash, and scenario hash.
- [ ] Generated engine and viewer evidence is current for the tested revision. Mocked UI checks,
      screenshots without assertions, and manually written pass flags do not count.
- [ ] Aggregate coverage and `modelled-cards.md` are refreshed only as inventory.
- [ ] Gameplay-AI quality, when evaluated, is reported separately and cannot make a rules failure
      pass or block a correct card solely because a provider made a poor strategic choice.
