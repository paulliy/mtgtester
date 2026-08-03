# Project Brief: MTG Commander AI Simulator

**Audience:** Claude Code
**Status:** v1 specification — read this document in full before writing any code.

> **This document is the original v1 spec and is frozen as history.** v1 (Phases 0-5
> below) shipped. The project has since continued through Phases 6-10 — single-player
> mode, direct player controls, action-and-presentation polish, and a planned deck-testing
> lab — which are **not** described in this document; they exist only as ADRs under
> `docs/decisions/` (see `0018` through `0021`) and plans under `docs/plans/`. Two specific
> claims below are now **out of date** and superseded by ADRs rather than by an edit here:
> - §1's "the human never controls a seat in v1" — single-player mode
>   (`docs/decisions/0018-single-player-mode.md`, `0019-direct-player-controls.md`) added a
>   human-controlled seat.
> - §2/§7.2's Gemini-only (`@google/genai`) AI stack — replaced by a multi-provider
>   OpenAI-compatible client defaulting to OpenRouter, plus a two-tier strategist/tactician
>   split (`docs/decisions/0011-openai-compatible-provider.md`,
>   `0016-two-tier-ai-planning.md`, `0021-player-experience-overhaul.md`).
>
> Where anything else in this document conflicts with a numbered ADR, the ADR wins. See
> `CLAUDE.md` for a current-state summary.

---

## 1. What we are building

A local application that plays complete, rules-accurate games of **Magic: The Gathering Commander** between **four AI-controlled players**, so that a human spectator can evaluate how their decks actually perform.

The user supplies four decklists (Moxfield or Archidekt links). The application imports and validates them, seats four AI players, and plays a full Commander game to completion — correctly handling the stack, priority, triggered abilities, combat, state-based actions, and Commander-specific rules. The human watches, controls playback pace, and reviews accumulated statistics about each deck across many games.

**This is a deck-evaluation tool, not a game you play.** The human never controls a seat in v1. They watch, they scrub through history, and they read the stats.

### 1.1 Definition of done for v1

> **The application is complete when the user can paste in four decklists, press start, and watch a legal four-player Commander game play from opening hands to a single surviving winner, with all rules correctly enforced, and afterwards see per-deck statistics persisted for that game.**

Anything not required to hit that bar is out of scope for v1. Section 15 lists explicitly deferred features — do not build them.

### 1.2 The core design tension (read this carefully)

MTG's rules are enormous. There are two naive approaches, and both fail:

- **Fully hard-coded engine** — implement every card's behavior in TypeScript. This is what Forge and XMage do, and it takes years. Not viable.
- **Fully LLM-refereed** — let the AI reason about everything from oracle text. Cheap to build, but it will produce illegal plays, forget the stack exists, and disagree with itself between calls. Not acceptable given the rules-fidelity requirement.

**We are building a hybrid, and the split is the single most important architectural decision in this project:**

| The **engine** owns (deterministic TypeScript) | The **AI** owns (Gemini) |
|---|---|
| Turn structure and phases | Which legal action to take |
| The stack — LIFO ordering, resolution, responses | What to target, when there is a choice |
| Priority passing in APNAP order | Whether to mulligan, and what to bottom |
| State-based actions (CR 704) | Attack and block declarations |
| Zones and zone transitions | Ordering of simultaneous triggers it controls |
| Mana pool, costs, legality of payment | Optional trigger yes/no decisions |
| Combat damage math | Modal spell mode choices, X values |
| All win/loss conditions | Strategic reasoning generally |
| Commander tax, commander damage, color identity | |
| **Generating the complete set of legal actions** | |
| Applying whatever the AI chose | |

**The engine is always authoritative.** The AI never asserts what is legal. The engine computes every legal option at every decision point, presents them as a numbered menu, and the AI picks one. If the AI returns anything not on the menu, the engine rejects it (see §7.7). This design is what makes full rules fidelity achievable and keeps API costs sane — the AI is doing strategy, never adjudication.

---

## 2. Tech stack — use exactly this

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript, strict mode | One language across the whole stack |
| Monorepo | Bun workspaces | Bun is the package manager and runtime |
| Engine | Pure TypeScript, zero framework deps | Must be importable and testable in isolation |
| Server | Bun HTTP + WebSocket | Holds the AI provider API key; never expose it client-side |
| AI SDK | Hand-rolled OpenAI-compatible client (`packages/server/src/ai/client.ts`) | **As shipped** — not `@google/genai`. Works against OpenRouter, Groq, Gemini, DeepSeek, or OpenAI's `chat/completions` endpoint via a preset registry. See §7.2 (updated) and `docs/decisions/0011-openai-compatible-provider.md` |
| Model | OpenRouter free/cheap-tier models by default (configurable, per-role) | Two role profiles — **strategist** and **tactician** — each with their own model fallback chain. See §7.2 (updated) |
| Database | SQLite via `bun:sqlite` | File-based, zero setup |
| Frontend | Vue 3 (`<script setup>`) + Vite | |
| State | Pinia, setup-store style | |
| Routing | Vue Router | |
| Utilities | VueUse where helpful | |
| Styling | Plain CSS. Flat, minimal, functional | No 3D, no animation library, no component framework |
| Lint/format | ESLint flat config + Prettier | |
| Unit tests | Vitest | |
| E2E tests | Playwright | Minimal in v1 — see §12 |

### 2.1 Repository structure

**As originally planned (this section is otherwise unchanged from the v1 spec):**

```
mtg-commander-sim/
├── packages/
│   ├── engine/                 # Pure TS rules engine. No I/O, no network, no framework.
│   │   ├── src/
│   │   │   ├── state/          # GameState, zones, players, objects
│   │   │   ├── turn/           # Phases, steps, turn loop
│   │   │   ├── stack/          # The stack, priority, APNAP
│   │   │   ├── sba/            # State-based actions
│   │   │   ├── combat/         # Attackers, blockers, damage
│   │   │   ├── actions/        # Legal action generation + application
│   │   │   ├── commander/      # Commander-format rules
│   │   │   ├── rng/            # Seeded PRNG
│   │   │   └── log/            # Event log emission
│   │   └── tests/              # Fixture-based rules tests — heavy coverage here
│   ├── server/                 # Bun server: orchestration, Gemini, SQLite, WebSocket
│   │   ├── src/
│   │   │   ├── ai/             # Gemini client, prompt assembly, queue, fallback
│   │   │   ├── cards/          # Scryfall resolution + local card cache
│   │   │   ├── decks/          # Moxfield/Archidekt import, validation, snapshotting
│   │   │   ├── db/             # SQLite schema + queries
│   │   │   ├── match/          # Match orchestration, compute-ahead, hold-and-wait
│   │   │   └── ws/             # WebSocket protocol
│   └── shared/                 # Types shared between engine, server, and web
├── apps/
│   └── web/                    # Vue 3 spectator UI
├── docs/
│   ├── rules/                  # Reference documentation — see §3
│   ├── project-brief.md        # This file
│   └── decisions/              # ADR-style notes for significant choices you make
├── data/                       # Card cache, gitignored
└── CLAUDE.md                   # Implementation guide you maintain as you go
```

**As it actually stands today:** `packages/shared` is its own workspace member (not just
a prose-only mention), `packages/engine` also grew `cards/` (the card-DSL ability
interpreter and per-card overrides), `mana/`, `effects/`, `flow/`, `view/`, and
`providers/` beyond the original list. `packages/server/src/ai/` holds the
OpenAI-compatible client and the strategist/tactician split (not a Gemini client — see
§7.2). `packages/server/src/cli/` holds every CLI entry point (`serve`, `import-decks`,
`pool`, `play-decks`, `coverage`, `snapshot-coverage-decks`, `snapshot-deck-oracle`,
`modelled-cards`). `apps/web` is now a spectator **and** player UI (single-player mode,
§15), not spectator-only.

---

## 3. Reference documentation

Fetch these before implementing rules logic. Store them as **plain text or markdown**, never PDF.

| Document | Source | Save as |
|---|---|---|
| Comprehensive Rules | Wizards' official rules page, `.txt` download | `docs/rules/comprehensive-rules.txt` |
| Commander construction & play rules | `https://mtgcommander.net/index.php/rules/` | `docs/rules/commander-rules.md` |
| Commander banned list | `https://mtgcommander.net/index.php/banned-list/` | `docs/rules/commander-banned-list.md` |
| Scryfall bulk data (`oracle-cards`) | Scryfall bulk-data API | `data/scryfall-oracle-cards.json` — **gitignored**, 100MB+ |
| Scryfall API docs | Scryfall developer docs | Reference only; no need to vendor |

**On the Comprehensive Rules:** this file is your reference for implementing the engine. It is **not** something you send to Gemini on every call — see §7.4. Keyword ability definitions live at CR 702.x, so no separate keyword glossary is needed.

**On Scryfall bulk data:** it is far too large to load wholesale into memory per game. On deck import, resolve each card name against the bulk file once, and persist only the cards in that deck into a local SQLite card cache. Games read from the cache, not the bulk file.

---

## 4. Game and match semantics

- A **game** is a single Commander game with four players. It runs until **one player remains** — eliminated players are removed and the game continues among survivors. There is no "match" of multiple games; the user starts games one at a time and watches them.
- **Draws should not occur.** If the engine reaches a genuine draw state (e.g. simultaneous loss, or an unbreakable loop), **halt, log it prominently as a probable rules bug, and surface it to the user**, who can start a fresh game. Do not silently reroll.
- **Every game is fully seeded.** One PRNG, seeded once per game, governs *all* randomness: library shuffles, starting-player determination, coin flips, die rolls, "choose at random" effects, and mulligan reshuffles. Same seed + same decklists + same AI responses ⇒ identical game. The seed is displayed in the UI and stored with the game record.
- **Reruns use a new seed.** When the user starts another game with the same pod, generate a fresh seed. The old seed is still stored, so any game can be inspected later.
- **AI responses are not deterministic**, so seed-replay reproduces the *engine* deterministically but not necessarily the whole game. Log every AI request/response (§13) so that a specific game can be replayed exactly from the log if needed.

---

## 5. The rules engine

This is the hardest and most important package. Build it first, build it carefully, and test it heavily. It has no network access, no database access, and no knowledge that an AI exists — it exposes decision points and receives decisions.

### 5.1 Core loop shape

The engine should be driven as a state machine that advances until it needs a decision, then yields:

```ts
type EngineStep =
  | { kind: 'continue' }                     // engine advanced on its own
  | { kind: 'decision'; request: DecisionRequest }  // needs a player choice
  | { kind: 'gameOver'; result: GameResult };

// The orchestrator loops: advance() → if 'decision', get a choice → submit() → repeat.
engine.advance(): EngineStep;
engine.submit(decision: DecisionResponse): void;
```

**Critical:** if a decision point has exactly **one** legal option, the engine resolves it itself and does **not** yield a decision. No AI call is made. This is both a correctness convenience and the single biggest cost lever in the project.

### 5.2 Game state

Model game objects as identity-stable entities, not as values that get copied between zones. A card moving zones becomes a new object per CR 400.7, but you still need a stable `oracleId` link back to card data.

```ts
interface GameState {
  seed: string;
  turnNumber: number;
  activePlayerIndex: number;
  priorityPlayerIndex: number | null;
  phase: Phase;
  step: Step | null;
  stack: StackObject[];
  players: PlayerState[];
  battlefield: PermanentState[];   // shared zone, each permanent has a controller
  exile: GameObject[];
  turnOrder: PlayerId[];           // seating; survivors only after eliminations
  eliminatedPlayers: PlayerId[];
  effects: ContinuousEffect[];     // for layer application
  eventLog: GameEvent[];
}

interface PlayerState {
  id: PlayerId;
  deckId: string;
  life: number;                    // starts at 40
  hand: GameObject[];
  library: GameObject[];           // order is secret to the AI
  graveyard: GameObject[];         // public, ordered
  commandZone: GameObject[];       // one or two commanders (Partner)
  commanderCastCount: Record<ObjectId, number>;  // for commander tax
  commanderDamageTaken: Record<ObjectId, number>; // keyed by source commander
  manaPool: ManaPool;
  landsPlayedThisTurn: number;
  hasLost: boolean;
  lossReason: LossReason | null;
  companion: GameObject | null;
}
```

### 5.3 Turn structure

Implement the full phase/step structure per CR 500–514:

1. **Beginning phase** — Untap step (no priority), Upkeep step, Draw step
2. **Precombat main phase**
3. **Combat phase** — Beginning of combat, Declare attackers, Declare blockers, Combat damage (with first-strike sub-step when applicable), End of combat
4. **Postcombat main phase**
5. **Ending phase** — End step, Cleanup step (no priority unless triggers/SBAs occur)

**Multiplayer note:** in a game with three or more players, the starting player **does** draw a card on their first turn. Do not implement the two-player "skip first draw" rule.

### 5.4 Priority and APNAP

This is where most rules bugs will live. Get it exactly right.

- After any spell is cast, ability is activated, ability triggers and is put on the stack, or a permanent enters via any action, **the active player receives priority, then each other player in turn order** (APNAP — active player, non-active players).
- A spell or ability on the stack only resolves after **all** players pass priority in succession.
- After a resolution, the active player receives priority again.
- Players receive priority at the start of most steps and phases (exceptions: untap, and cleanup unless something happens).

**Worked example — implement so this works correctly:**

> Player A attacks Player B with a 2/2. Blockers are declared: Player B blocks with a 3/3. Before combat damage, **priority opens again** — Player A gets priority first (active player), and may cast Giant Growth on their 2/2 to make it 5/5 and win the exchange. Player B and the other two players then each get priority in turn order and may respond. Only once all four players pass in succession does anything resolve. Then combat damage is dealt.

**Every action reopens a full APNAP priority round.** Do not shortcut this. Do not batch it. A player with zero legal responses at a priority window is auto-passed by the engine with no AI call.

Decision points are always resolved **sequentially in APNAP order**, never in parallel. This keeps rules-correctness tractable and keeps request bursts under the API rate limit.

### 5.5 The stack

- Last-in, first-out.
- Spells and abilities go on the stack; **mana abilities do not** (they resolve immediately, per CR 605).
- When multiple abilities controlled by the **same player** trigger simultaneously, that player chooses the order they go on the stack — this is an AI decision if there is more than one ordering.
- When abilities controlled by **different players** trigger simultaneously, they go on the stack in APNAP order.
- Targets are chosen on announcement, and legality is rechecked on resolution — a spell whose targets have all become illegal is countered by game rules and does not resolve.

### 5.6 State-based actions

Check SBAs (CR 704) **every time a player would receive priority**, repeatedly until none apply, before that player actually gets priority. Implement at minimum:

- Player at 0 or less life loses
- Player who attempted to draw from an empty library loses (checked at next SBA check, not immediately)
- Player with 10 or more poison counters loses
- **Player who has been dealt 21 or more combat damage by a single commander loses** (Commander-specific)
- Creature with toughness ≤ 0 is put into its owner's graveyard
- Creature with lethal damage marked, or damage from a deathtouch source, is destroyed
- Planeswalker with 0 loyalty goes to graveyard
- Legend rule — controller chooses which to keep (AI decision if more than one option)
- Auras attached illegally, or attached to nothing, go to graveyard
- Equipment/Fortifications attached illegally become unattached
- Tokens that have left the battlefield cease to exist
- +1/+1 and −1/−1 counters annihilate in pairs
- Commander in graveyard or exile may be moved to the command zone (see §5.7)

### 5.7 Commander-format rules

Sourced from the official Commander rules (`docs/rules/commander-rules.md`):

- **Deck**: exactly 100 cards including the commander. Singleton — no two cards with the same English name, except basic lands and cards whose text overrides this (e.g. Relentless Rats).
- **Color identity**: a card's color identity is its color plus the color of any mana symbols in its rules text. It is fixed before the game and cannot be changed by game effects. No card in the deck may have a color in its identity that is not in the commander's color identity.
- **Life total**: 40.
- **Command zone**: commanders start there. A commander may be cast from the command zone subject to normal timing rules, with an **additional {2} for each time it has previously been cast from the command zone** (commander tax).
- **Commander replacement effect**: if a commander would go to graveyard, exile, hand, or library from anywhere, its owner may instead put it into the command zone. This is a choice, so it is an AI decision. It may apply more than once to the same event.
- **Commander-ness is not a characteristic** — it is a property of the physical card. It cannot be copied or overwritten, and persists through status changes and change of control.
- **21 combat damage** from a single commander eliminates a player. Track damage per (victim, commander) pair. Note this is **combat damage only**, not all damage.
- **Wish effects do not function** — abilities that bring cards from outside the game (Living Wish, Karn the Great Creator, Spawnsire, etc.) do nothing in Commander.
- **Partner / Partner With / Backgrounds**: a deck may have two commanders when legally permitted. Combined color identity governs deck legality. Each has its own independent commander tax and its own independent 21-damage tracker.
- **Companion**: adheres to color identity and singleton rules, is effectively a 101st card, and starts outside the game. Implement the standard {3} cost to move it to hand.

### 5.8 Mulligans

Standard **London mulligan** with the multiplayer free-mulligan provision:

1. Each player draws 7.
2. In turn order, each player declares whether they will mulligan. Then all mulliganing players do so simultaneously.
3. A mulliganing player shuffles their hand back, draws a new 7.
4. On keeping, the player puts a number of cards on the bottom of their library equal to `max(0, mulligansTaken - 1)` — **because this game has 3+ players, the first mulligan is free** and does not count toward the bottom-cards penalty. This is CR 103.4c and is confirmed by the Commander Rules Committee.
5. Maximum of 8 mulligans (at which point the player bottoms all 7).
6. Cards put on the bottom are **private** — other players do not see them.

Both decisions are AI decisions: *keep or mulligan*, and *which cards to bottom*. The AI knows its own decklist and its commander, so it can reason about whether a hand supports its game plan.

### 5.9 Seeded randomness

Single PRNG instance per game (a small, well-tested algorithm like xoshiro128** or mulberry32 — do not use `Math.random()` anywhere in the engine). Everything random draws from it in a deterministic call order. Write a test that runs the same seed twice with scripted decisions and asserts byte-identical event logs.

---

## 6. Card behavior: the hybrid boundary in practice

The engine cannot hard-code every card. Here is how card behavior actually resolves:

1. **Engine-native mechanics** — anything structural gets real implementations: mana costs and payment, land drops, tapping, summoning sickness, combat, counters, keyword abilities from CR 702 (flying, trample, deathtouch, lifelink, first/double strike, vigilance, haste, hexproof, indestructible, flash, menace, reach, ward, etc.), and zone changes. These are a bounded, enumerable set — implement them properly.

2. **Card-specific effects** — driven by oracle text. Each card in play carries its oracle text, and when its effect resolves, the engine presents the AI with the choices the effect requires (targets, modes, X values, optional yes/no) and applies the mechanical outcome. The engine validates that whatever the AI chose is a legal choice for that effect.

3. **Anything the engine genuinely cannot model** — halt with a clear, loud error identifying the card and the situation, rather than guessing or silently continuing. A visible failure is enormously more useful than a wrong game. Log these; they become the backlog of mechanics to implement next.

**Design the effect layer so mechanics can be added incrementally** without touching the turn loop or the stack. Expect to iterate here.

---

## 7. AI player integration

### 7.1 Visibility model — the AI must never cheat

Each AI player's context contains **exactly** this and nothing more:

| Visible | Not visible |
|---|---|
| Its own hand | Other players' hands |
| Its own complete decklist | Other players' decklists |
| Its own graveyard, and **all** graveyards | Any player's library order — including its own |
| All battlefields, with all public state | Face-down cards' identities |
| All exile (public portions) | Cards bottomed during other players' mulligans |
| All commanders in all command zones | Other players' AI reasoning |
| All life totals, commander damage, counters | |
| The full public game/action log | |
| The stack, with all objects and targets | |

The AI knows *what its own deck contains* but not *what order it is in* — exactly like a real player. Build the context assembler so it physically cannot access hidden state: pass it a `PlayerView` projection derived from `GameState`, never `GameState` itself. Write a test asserting that a `PlayerView` contains no hidden information.

Opponents' strategies must be **inferred** from their commanders and their visible plays. That inference is the interesting part of the simulation — do not shortcut it by leaking decklists.

### 7.2 AI provider configuration (updated — supersedes the original Gemini-only plan)

The original plan below (Gemini via `@google/genai`) was **not** what got built. What
shipped instead, and is current:

- **A hand-rolled OpenAI-compatible client**, not a vendor SDK — `packages/server/src/ai/client.ts`'s
  `OpenAiCompatibleClient` hits any provider's `chat/completions` endpoint. Rationale in
  `docs/decisions/0011-openai-compatible-provider.md`.
- **Multiple providers, OpenRouter by default.** `packages/server/src/ai/config.ts` has a
  `PROVIDERS` preset registry — `openrouter` (default), `groq`, `gemini`, `deepseek`,
  `openai`. `resolveProvider()` auto-detects from whichever `*_API_KEY` env var is set,
  or honors an explicit `AI_PROVIDER` override. See `.env.example` for the full list of
  env vars and every provider's key.
- **Two role profiles, not one model.** `AiConfig` carries a `strategist` and a
  `tactician` `AiModelProfile`, each with its own model fallback chain, reasoning
  settings, token budget, and request timeout — `configForRole(config, role)` flattens
  one into a usable client config. OpenRouter's defaults: strategist =
  `deepseek/deepseek-v4-flash`, `tencent/hy3` (reasoning on, effort `medium`, since it
  plans once per turn); tactician = `qwen/qwen3.7-flash`,
  `sao10k/l3-lunaris-8b:nitro`, `poolside/laguna-s-2.1` (reasoning off, ~85 max output
  tokens, since it is a fast menu pick). See §7.6 (updated) for what strategist and
  tactician actually mean.
- **Model selection is configurable in one place**, per role: `AI_STRATEGIST_MODELS` /
  `AI_TACTICIAN_MODELS` (or the provider preset's defaults if unset). Reasoning is off by
  default for the tactician (a decision is a menu pick; thinking tokens are billed) and on
  by default for the strategist.
- **Rate limits are not hardcoded.** `AI_RPM_LIMIT`, `AI_MAX_RETRIES`, and per-role
  request timeouts are all config, with conservative defaults — see `.env.example`.
- Whether a given provider uses free-tier requests for model training is a per-provider
  policy question, not something this client controls; check the active provider's terms.

### 7.3 The decision contract

The engine emits a `DecisionRequest`; the AI returns a `DecisionResponse` that must reference an option by `id`.

**Sample request** (assembled by the server from the engine's decision point plus the player's view):

```json
{
  "requestId": "g7f3a-t9-d142",
  "gameId": "g7f3a",
  "turn": 9,
  "activePlayer": "P2",
  "decidingPlayer": "P1",
  "phase": "combat",
  "step": "declareBlockers",
  "decisionType": "priority",
  "prompt": "You have priority. Blockers have been declared. Choose an action.",
  "context": {
    "you": {
      "seat": "P1",
      "life": 31,
      "commanders": [
        { "name": "Atraxa, Praetors' Voice", "zone": "battlefield", "castCount": 1 }
      ],
      "hand": [
        { "id": "o-3312", "name": "Giant Growth", "manaCost": "{G}", "typeLine": "Instant",
          "oracleText": "Target creature gets +3/+3 until end of turn." },
        { "id": "o-3318", "name": "Swords to Plowshares", "manaCost": "{W}", "typeLine": "Instant",
          "oracleText": "Exile target creature. Its controller gains life equal to its power." }
      ],
      "availableMana": { "W": 1, "G": 2, "generic": 0 },
      "graveyard": ["Cultivate", "Sol Ring"]
    },
    "opponents": [
      { "seat": "P2", "life": 40, "handSize": 4, "librarySize": 71,
        "commanders": [{ "name": "Krenko, Mob Boss", "zone": "battlefield", "castCount": 2 }],
        "commanderDamageDealtToYou": 6 }
    ],
    "battlefield": [
      { "id": "o-1201", "controller": "P1", "name": "Llanowar Elves", "power": 1, "toughness": 1,
        "tapped": true, "status": ["attacking"], "blockedBy": ["o-2044"] },
      { "id": "o-2044", "controller": "P2", "name": "Goblin Token", "power": 1, "toughness": 1,
        "tapped": false, "status": ["blocking"] }
    ],
    "stack": [],
    "recentLog": [
      "T9 P1: attacks P2 with Llanowar Elves",
      "T9 P2: blocks Llanowar Elves with Goblin Token"
    ]
  },
  "legalActions": [
    { "id": 0, "type": "pass", "description": "Pass priority" },
    { "id": 1, "type": "castSpell", "card": "Giant Growth", "cost": "{G}",
      "targets": [{ "slot": 0, "options": ["o-1201", "o-2044"] }],
      "description": "Cast Giant Growth targeting a creature" },
    { "id": 2, "type": "castSpell", "card": "Swords to Plowshares", "cost": "{W}",
      "targets": [{ "slot": 0, "options": ["o-1201", "o-2044"] }],
      "description": "Cast Swords to Plowshares targeting a creature" }
  ]
}
```

**Sample response** — the AI must return only this JSON, no prose, no code fences:

```json
{
  "requestId": "g7f3a-t9-d142",
  "actionId": 1,
  "targets": [{ "slot": 0, "choice": "o-1201" }],
  "note": "Pumping my attacker to survive the block and trade up."
}
```

The `note` field is short, optional, and stored in the debug log only. It is **not** shown in the spectator log (§10.2). Cap it at one sentence to avoid paying for output tokens you don't display.

Use the SDK's structured-output / JSON-mode support so responses conform to a schema rather than relying on prompt discipline alone.

### 7.4 Context construction and cost minimization

This is the difference between a tool you can run all day and one that burns your quota in twenty minutes.

**Static context (identical across all calls, cached):**
- The role framing: "You are playing a game of four-player Commander."
- A **compact rules primer** — turn structure, phases, priority/APNAP, how the stack works, Commander-specific rules (40 life, command zone, tax, 21 commander damage), win conditions. Target ~1,500 tokens, hand-written. **Never send the Comprehensive Rules file to Gemini.** It is a reference for *you* while implementing the engine, not runtime context.
- Output format specification.

Use **Gemini context caching** for this block so it is not re-billed on every call.

**Dynamic context (per call):**
- The player's own view (§7.1)
- **Oracle text only for cards that are currently relevant** — cards in the deciding player's hand, all permanents on the battlefield, objects on the stack, and commanders in command zones. **Do not send oracle text for cards not in play.** A card sitting in a library or an irrelevant graveyard contributes nothing to this decision and costs tokens on every call.
- A trimmed recent action log (last ~15 entries), not the full game history.
- The legal action menu.

**Additional cost controls, all required:**
- **No call when there is only one legal option** — the engine auto-resolves (§5.1). In practice this eliminates the large majority of priority windows, since most of the time a player has nothing to respond with.
- **No call when a player has zero legal responses** — auto-pass.
- Keep responses terse: option id, targets, one-sentence note.
- Track and display per-game API call count and token usage in the debug panel, so cost regressions are visible immediately.

### 7.5 Request queue and rate limiting

Required from day one, not as a later optimization. A single combat step in a four-player game can generate a burst of requests that exceeds free-tier RPM.

- All Gemini calls go through **one queue** with configurable concurrency (default: 1, since decisions are sequential anyway).
- Enforce a configurable client-side RPM ceiling with token-bucket pacing.
- On HTTP 429: **exponential backoff with jitter** (1s, 2s, 4s, 8s...), capped, with a maximum retry count.
- Distinguish RPM/TPM exhaustion (recoverable in seconds) from RPD exhaustion (not recoverable today) using the error body, and surface a clear message to the user in the latter case rather than retrying forever.
- Surface queue depth and current wait state in the UI so the user understands why playback paused.

### 7.6 Deciding-player turn timing (updated — one deliberate exception)

Tactical decisions (menu picks) are strictly sequential in APNAP order, each on the
tactician's own request queue. Never fire parallel tactical requests for multiple
players at the same priority window.

**The one exception, added post-v1:** the active player's **strategist** call is
prefetched asynchronously ahead of that player's turn — fired at the previous turn's
boundary so it overlaps untap/upkeep/draw — and runs on its own separate request queue so
it can never queue behind, or block, a tactical decision. It is fire-and-forget: the
tactician reads whatever plan has landed (or `null` if the strategist hasn't finished
yet) rather than waiting on it. See `packages/server/src/ai/strategy-coordinator.ts` and
`docs/decisions/0021-player-experience-overhaul.md` §1.

### 7.7 Invalid AI response handling

When a response does not match any legal option, is malformed, references a nonexistent target, or fails schema validation:

1. **Retry once** with a corrective message appended: the validation error, and the legal action menu restated.
2. If the retry also fails and the game is in **live mode with the user watching**: **pause and surface the choice to the user.** Show the decision request, the invalid response, and the legal action menu, and let the human pick an action. Wait 5 seconds for input; if none arrives, proceed to step 3.
3. **Fall back to the safest legal action**, and log it prominently as a fallback event (visible in both the debug log and, as a warning marker, the spectator timeline).

**"Safest legal action" is defined as the most conservative available option, in this priority order:** pass priority → decline optional triggers → do not attack → do not block → do not activate abilities. **Never** choose a fallback that is irreversible or self-harming: never sacrifice, discard, mill, exile your own permanents, or use targeted removal as a fallback.

**During compute-ahead (§10.1), there is no human present to consult.** In that situation the engine **halts the compute-ahead entirely** at that point and waits — it does not silently apply a fallback in turns the user has not yet watched. The user catches up to the halt point and resolves it there. This is a single consistent rule: *problematic states are never resolved unsupervised.*

---

## 8. Deck import and validation

### 8.1 Input

The user provides four **Moxfield or Archidekt deck URLs**. Support both. Each service exposes deck contents via a public API endpoint derivable from the deck URL — implement a small adapter per service behind a shared interface so a third source can be added later.

Also accept a **plain-text decklist paste** as a fallback (`1 Sol Ring` per line, with a commander designation), since it costs almost nothing to support and saves you when an import breaks.

### 8.2 Resolution and snapshotting

1. Parse the deck into `(quantity, cardName)` pairs plus commander designation(s) and optional companion.
2. Resolve each name against the Scryfall oracle data. On ambiguity or failure, report the specific unresolved names to the user — do not guess.
3. **Snapshot the resolved deck at import time** into the database, including full card data. Historical stats must never change because someone edited the deck on Moxfield later. Re-importing the same URL creates a **new snapshot**, and the UI should make clear these are distinct deck versions.

### 8.3 Validation

Validate against `docs/rules/commander-rules.md` and the banned list. On failure, **reject the deck and report every specific problem**, not just the first:

- Exactly 100 cards including the commander (101 with a companion)
- Commander is a legal commander (legendary creature, or a card that explicitly says it can be your commander)
- Partner / Partner With / Background pairings are legal if two commanders are declared
- Singleton, except basic lands and cards whose oracle text overrides the restriction
- Every card's color identity is a subset of the commander's combined color identity
- No banned cards
- Companion, if present, satisfies its own deck-building condition, plus color identity and singleton

### 8.4 Deck metadata

At import the user may enter an optional **archetype tag** — a free-text field, e.g. `"Gruul aggro dinosaurs"`, `"Azorius control"`, `"Rakdos combo"`. If left blank, default it to `"<color identity> — <commander name>"`.

This tag is what powers the "what kind of deck do I lose to" statistic. **Manual entry in v1.** Automatic inference from the decklist is a deferred feature (§15) — structure the field so an inference pass can populate it later without a schema change.

---

## 9. Persistence and statistics

SQLite via `bun:sqlite`. Suggested schema — adjust as needed but preserve the capabilities:

```
decks               id, name, source_url, source_type, archetype_tag, created_at
deck_snapshots      id, deck_id, commander_names, color_identity, card_list_json, imported_at
games               id, seed, started_at, ended_at, turn_count, winner_seat, status
game_players        game_id, seat, deck_snapshot_id, finished_position,
                    eliminated_on_turn, loss_reason, eliminated_by_seat,
                    mulligans_taken, opening_hand_size
game_events         game_id, sequence, turn, phase, step, actor_seat,
                    event_type, payload_json          -- the full replayable action log
game_state_snapshots  game_id, turn, state_json       -- one per turn, for scrubbing
ai_calls            game_id, sequence, seat, model, prompt_tokens, response_tokens,
                    request_json, response_json, was_retry, was_fallback, latency_ms
mana_metrics        game_id, seat, turn, lands_in_hand, lands_drawn_cumulative,
                    spells_castable, unspent_mana, on_curve
```

### 9.1 Statistics to compute

Per deck (aggregated across all games it has played):

- **Win rate** — wins / games played
- **Average finishing position** (1st through 4th)
- **Average game length** in turns
- **Cause of elimination**, broken down by: combat damage, commander damage, non-combat life loss, deckout, poison, other
- **Who eliminated it** — by opponent commander name, opponent color identity, and opponent archetype tag. This is the "what type of deck do I lose to" view.
- **Mulligan frequency** — average mulligans taken, and distribution
- **Mana flood rate** and **mana drought rate** (defined below)

### 9.2 Mana flood and drought — tunable heuristic

There is no standard definition, so implement this as an explicitly **configurable heuristic** in `config/mana-metrics.ts`, with all thresholds as named constants, and document it in the UI so the user knows what the number means.

**Proposed defaults:**

- **Flooded on a turn** if, over the trailing 5 draws, ≥4 were lands **AND** the player ended the turn with ≥3 unspent mana available while holding no castable nonland cards.
- **Drought on a turn** if the player missed a land drop (had no land to play) **AND** either held ≥2 uncastable cards, or was below `turnNumber - 1` total lands in play.
- A game counts as **flooded** / **drought-affected** if the condition held on ≥3 turns.

Log the raw per-turn inputs (`mana_metrics` table) rather than only the boolean, so thresholds can be retuned retroactively without replaying games.

---

## 10. Spectator UI

Vue 3 + Pinia. **Flat, minimal, functional.** No 3D, no card art required (card names as text are fine), no animation beyond simple state transitions. The information density matters far more than the aesthetics here.

### 10.1 Playback model

Two ways to advance a game, with one shared rule:

- **Live-ish mode** — the engine computes forward continuously while the user watches, staying at most **5 turns ahead** of the user's current view position. This cap is a deliberate API-cost guard.
- **Jump-ahead** — the user requests a specific turn; the engine computes forward to it. Still capped at 5 turns beyond the user's position per computation batch.

**You can scrub freely backward, never forward past what has been computed.** All past turn states and the complete action log are persisted (`game_state_snapshots`, `game_events`), so the user can move to any already-played turn and inspect the exact board state, then step forward action by action from there.

**Hold-and-wait:** if compute-ahead encounters a problematic state — an invalid AI response that survived retry, an unmodelable card, an engine error, or a draw — it **stops immediately at that point** and does not compute further. The UI marks where it stopped and why. The user scrubs to that point and resolves it. Nothing ambiguous is ever resolved without the user present.

### 10.2 Views required

- **Board view** — all four players' battlefields, life totals, hand sizes, library counts, command zones with tax, commander damage grid (a 4×4 matrix is the clearest presentation), and the stack with current targets
- **Player detail** — click a seat to expand: full battlefield, graveyard, exile. The active game's hands are visible to the spectator (you are watching, not playing) but clearly marked as spectator-only information
- **Action log** — chronological, minimal format, no AI reasoning:
  ```
  T9  P1  attacks P2 with Llanowar Elves
  T9  P2  blocks Llanowar Elves with Goblin Token
  T9  P1  casts Giant Growth targeting Llanowar Elves
  T9  --  Giant Growth resolves — Llanowar Elves is 4/4
  T9  --  combat damage: Goblin Token destroyed
  ```
- **Timeline scrubber** — jump to any computed turn, step forward/back one action at a time
- **Deck import screen** — four URL inputs, archetype tag fields, validation errors shown per-deck and per-problem
- **Stats screen** — per-deck aggregates from §9.1, with the "who beats me" breakdown
- **Debug panel** — see §13, toggleable

---

## 11. WebSocket protocol

The server owns the engine and the AI calls; the frontend is a view. Push updates rather than polling.

Server → client: `gameStarted`, `stateSnapshot`, `eventBatch`, `decisionPending`, `computeHalted`, `apiWaiting`, `gameOver`, `error`.
Client → server: `startGame`, `jumpToTurn`, `setPlaybackMode`, `resolveHeldDecision`, `abandonGame`.

Keep the payloads flat and serializable; the frontend should not need engine code to interpret them.

---

## 12. Testing

Rules fidelity is the top priority of this project, so tests are not optional and not a later phase.

**Engine unit tests (Vitest) — the bulk of the coverage:**
- **Fixture-based rules scenarios**: construct a specific board state, apply a scripted sequence of actions, assert the exact resulting state. Every one of these is a regression guard.
- Required scenario coverage at minimum: stack LIFO resolution; countering a spell; a spell fizzling when its only target becomes illegal; the Giant-Growth-during-blocks example from §5.4 end to end; APNAP ordering with four players; simultaneous triggers controlled by the same player and by different players; every state-based action in §5.6; commander tax accumulating over multiple casts; the commander replacement effect from graveyard, exile, hand, and library; commander damage reaching 21 across multiple combats; the legend rule; first strike creating a second damage step; player elimination mid-game with the game continuing correctly among survivors; London mulligan with the free first mulligan producing the correct hand sizes.
- **Determinism test**: same seed + same scripted decisions ⇒ byte-identical event log.
- **Visibility test**: a `PlayerView` never contains another player's hand, any library order, or another player's decklist.

**Server tests:**
- Deck validation accepts known-legal decks and rejects known-illegal ones with the correct specific error (each rule in §8.3 gets a test)
- Invalid-AI-response handling walks the full chain: retry → user prompt → safest fallback
- Queue respects the configured RPM ceiling and backs off correctly on a simulated 429

**Playwright — minimal in v1:** import four decks, start a game, confirm it reaches a winner and the stats page updates.

**Mock the AI in all automated tests.** Never hit the real Gemini API from the test suite.

---

## 13. Debug suite

Explicitly a first-class deliverable, not an afterthought. Build this early — it is how you will find rules bugs, and rules bugs are the main risk to this project.

**Internal debug log**, kept entirely separate from the minimal spectator action log:
- Every SBA check and what it found
- Every priority pass, with which player and why
- Every stack push and resolution, with full object state
- Every legal-action set generated, at every decision point
- Every zone change
- Every continuous effect applied

**Toggleable debug flags**, controllable from the UI at runtime:
- `showAIRequests` — display the exact payload sent to Gemini, including the assembled context
- `showAIResponses` — display the raw response, including the reasoning note
- `showLegalActions` — display the option menu at each decision point
- `showSBAChecks`
- `showPriorityPasses`
- `showTokenUsage` — running per-game call count and token totals
- `verboseEngine` — the full internal log, streamed

**Debug panel requirements:**
- Filter the log by turn, by player, and by event type
- Inspect any individual AI call: request, response, retry status, fallback status, latency, tokens
- Export a full game (event log + all AI calls + seed) as a single JSON file for offline inspection
- Prominent, unmissable markers wherever a fallback action was taken or the engine halted

---

## 14. How to work through this

### 14.1 Phases and checkpoints

Work in phases. **Stop at every phase boundary and get explicit approval before proceeding.**

**Phase 0 — Foundations.** Monorepo, tooling, shared types, docs fetched into `docs/rules/`, Scryfall bulk data cached, `CLAUDE.md` started.

**Phase 1 — Deck pipeline.** Moxfield/Archidekt import, Scryfall resolution, full validation, snapshotting, SQLite schema. Verifiable independently: paste four real decklists, get four validated snapshots or precise errors.

**Phase 2 — Engine core.** Game state, zones, seeded RNG, turn structure, priority/APNAP, the stack, state-based actions, combat, Commander rules, mulligans, legal action generation. **Driven by scripted decisions, no AI involved yet.** This phase is done when a full four-player game plays to a winner using a scripted/random decision provider, with the test suite from §12 green. **This is the largest and highest-risk phase — go slowest here.**

**Phase 3 — AI integration.** Gemini client, `PlayerView` projection, context assembly with caching, decision contract, queue and backoff, invalid-response handling chain. Done when four Gemini-driven players complete a game.

**Phase 4 — Spectator UI.** Board view, action log, timeline scrubber, playback modes, compute-ahead with hold-and-wait, deck import screen.

**Phase 5 — Stats and debug suite.** Aggregate statistics, mana metrics, the stats screen, and the full debug panel. (Build the *internal debug logging* in Phase 2 as you go — only the panel and stats UI wait until here.)

**v1 ends here.** Everything below was planned and executed after v1 shipped, is not
covered by the rest of this document, and is recorded in ADRs/plans rather than as an
edit to this brief:

**Phase 6 — Single-player Commander.** A human-controlled seat became supported —
directly superseding §15's "human-controlled seats" exclusion below. See
`docs/decisions/0018-single-player-mode.md`.

**Phase 7 — Direct player controls.** A faithful UI adapter over the same legal-action
contract the AI uses — the human never gets capabilities the engine didn't already expose
as legal actions. See `docs/decisions/0019-direct-player-controls.md`.

**Phase 8 — Action animations.** Plan in `docs/plans/phase-8-action-animations.md`,
largely executed via ADR 0021 with explicit scope cuts (no SVG arrow overlay, no board
change-feedback flashing, limited drag polish — see that ADR's "Scope cuts" section).

**Phase 9 — Single-player experience.** Plan in
`docs/plans/phase-9-single-player-experience.md`; substantially executed by
`docs/decisions/0021-player-experience-overhaul.md` (async strategist prefetch, §7.6;
yield-until-end-of-turn fix; combat batching; keyboard/turn legibility; a presentation
contract for the UI).

**Phase 10 — Deck testing lab and simulation engine.** Planned in
`docs/plans/phase-10-deck-testing-lab.md`. **Not started** — no implementation exists yet.

### 14.2 Within-phase working agreement

Between phase boundaries, do **not** run ahead silently. For each meaningful unit of work:

1. **State the plan before implementing it.** What you are about to build, and how it fits the phase.
2. **Ask questions when anything is ambiguous.** A question costs a minute; a wrong assumption in the turn loop costs a rewrite. Ambiguity in rules interpretation especially — ask.
3. **After implementing, demonstrate what you did and why.** Show the actual behavior — a passing test, a sample game log, a screenshot. Not a description of what you intended.
4. **Explicitly report divergence from this brief.** If you departed from the plan, say so clearly: what you changed, why the original approach did not work, and what the consequence is. Divergence is fine and often correct — silent divergence is not.
5. **Record significant architectural decisions** in `docs/decisions/` so the reasoning survives.

Go slowly. This is a rules-fidelity project — a fast wrong engine is worth nothing, and correctness compounds.

---

## 15. Explicitly out of scope for v1

Do not build these. They are noted so you can leave clean seams where they will eventually attach.

- **Human-controlled seats.** v1 is AI-vs-AI only. (The human *does* get the invalid-response override in §7.7 — that is not a playable seat.) **Superseded post-v1:** Phase 6 (§14.1) added single-player mode with one human-controlled seat plus three AI; see `docs/decisions/0018-single-player-mode.md` and `0019-direct-player-controls.md`. Spectator (four AI seats, no playable seat) remains the other supported mode.
- **Post-game AI self-reflection commentary.** Cut from v1.
- **Automatic archetype tagging.** Manual field only; leave the schema ready for inference later.
- **AI reasoning in the spectator log.** Reasoning notes go to the debug log only.
- **Batch/headless simulation of many games.** Games are watched, one at a time.
- **Best-of-N matches, tournaments, brackets.** A game ends; another game is started manually.
- **Deck editing in-app.** Import only.
- **More or fewer than four players.** Four seats. Structure the code so the count is a parameter rather than hardcoded, but only four is supported and tested in v1.

