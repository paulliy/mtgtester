# Roadmap to 100% Card Coverage Across Supported Commander Decks

> **Executive Context**: The MTG Commander AI Simulator is at **Phase 4** (Spectator UI complete). Card coverage is the primary live constraint on end-to-end deck simulation. Because deck playability is **all-or-nothing** (an unmodeled card in hand or command zone triggers `UnmodeledCardError` and halts the engine per brief §6.3), 99% coverage of a deck produces 0 runnable games for that deck list.
> 
> As established in [ADR 0009](0009-supported-pool-decks.md), the strategic goal is to move real deck lists from 0 playable decks to **100% card coverage across all 7 target decks** (538 unique cards) through a combination of high-yield core parser extensions and authored overrides ([ADR 0004](0004-ability-effect-model.md) / [ADR 0010](0010-layer-system-and-statics.md)).

---

## 1. Baseline Coverage Diagnostics

Analysis of `bun run coverage --json` executed against the 7 target deck fixtures in `packages/server/fixtures/coverage-decks/`:

### Per-Deck Coverage & Unmodeled Gap

| Deck Name | Deck Type | Unique Cards | Modeled | Unmodeled | Current Coverage | Playability Status |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `urdragon.txt` | Custom User Deck | 93 | 64 | **29** | 68.8% | ❌ HALTED |
| `draconic-destruction.txt` | Starter Precon | 72 | 28 | **44** | 38.9% | ❌ HALTED |
| `token-triumph.txt` | Starter Precon | 73 | 27 | **46** | 37.0% | ❌ HALTED |
| `living-energy.txt` | Science! Precon | 87 | 27 | **60** | 31.0% | ❌ HALTED |
| `necron-dynasties.txt` | Warhammer 40k Precon | 71 | 9 | **62** | 12.7% | ❌ HALTED |
| `silverquill-influence.txt` | Strixhaven Precon | 86 | 17 | **69** | 19.8% | ❌ HALTED |
| `counter-intelligence.txt` | Universes Beyond Precon | 117 | 25 | **92** | 21.4% | ❌ HALTED |
| **AGGREGATE (Union)** | **All 7 Decks** | **538** | **143** | **395** | **26.6%** | **0/7 Playable** |

> [!IMPORTANT]
> **Key Metric Reality Check**:
> - **Aggregate Unique Cards**: 538
> - **Currently Modeled**: 143 (26.6%)
> - **Currently Unmodeled**: 395 (73.4%)
> - **Playable Real Decks**: 0 of 7.
> - **Average Blocking Mechanics per Card**: ~2.25. (Fixing a single mechanic unblocks only a subset of cards, because many unmodeled cards contain multiple unparsed lines).

---

### Top Blocking Mechanic Families

From `packages/server/src/cards/coverage.ts`, mechanics are categorized into non-exclusive families. Ranking by frequency across all 395 unmodeled cards:

| Rank | Mechanic Family | Blocking Count | Description / Key Examples |
| :---: | :--- | :---: | :--- |
| **1** | `activated ability (non-mana)` | **111** | `{T}: ...`, `{1}{B}, {T}: ...`, planeswalker `+1`/`-3` loyalty costs |
| **2** | `targeted spell effect` | **111** | "Destroy target permanent", "Exile target monocolored permanent" |
| **3** | `other` | **91** | Bespoke effects, overload, hideaway, replacement damage, modal spells |
| **4** | `draw/discard` | **74** | "Draw N cards", "Discards a card", "Mills 6 cards" |
| **5** | `token creation` | **60** | "Create two 1/1 Thopter tokens", "Create a 4/4 Dragon token" |
| **6** | `counter manipulation` | **57** | "+1/+1 counter on each creature", "Proliferate", energy `{E}` costs |
| **7** | `anthem / static buff` | **48** | "Other Dragon creatures get +1/+1", "Spells of chosen type cost less" |
| **8** | `graveyard recursion` | **41** | "Return target card from graveyard to battlefield/hand", "Unearth" |
| **9** | `combat trigger` | **38** | "Whenever one or more Dragons attack", "Whenever deals combat damage" |
| **10** | `phase/step trigger` | **35** | "At the beginning of your end step", "At beginning of upkeep" |
| **11** | `ability word prefix` | **35** | `Landfall —`, `Magecraft —`, `Metalcraft —`, `Eminence —` |
| **12** | `sacrifice outlet` | **31** | `{T}, Sacrifice this permanent: ...` |
| **13** | `aura statics` | **27** | "Enchant creature", "Enchanted creature gets +2/+2" |
| **14** | `keyword with cost` | **22** | `Equip {N}`, `Cycling {N}`, `Kicker {cost}`, `Crew N`, `Hideaway 4` |

---

## 2. Rules Interpreter & Engine Architecture

Understanding how cards are parsed and executed in `@mtg/engine`:

```
                 Scryfall Oracle Card Data (JSON)
                               │
                               ▼
               `interpretCard(card)` [interpret.ts]
                               │
       ┌───────────────────────┴───────────────────────┐
       │                                               │
Full-Line Regex Match                     Unrecognized Text / Cost
       │                                               │
       ▼                                               ▼
`CardDefinition` (AST)                     `unmodeledReasons[]`
 (Effects, Triggers, Statics)                          │
       │                                               ▼
       │                              Authored Override Lookup
       │                          `applyOverride(def)` [overrides/index.ts]
       │                                               │
       │                              Matches handledLines?
       │                              ├── YES ──> Clear reason & merge def
       │                              └── NO  ──> Retain `modeled: false`
       ▼                                               │
  `modeled: true`                                      ▼
       │                                      `UnmodeledCardError`
       ▼                                        (Halts Game Engine)
Engine State & Execution
```

1. **Full-Line Accounting ([interpret.ts](../packages/engine/src/cards/interpret.ts))**:
   - Every line of rules text in `card.oracleText` must be completely recognized by keyword matchers, mana ability parsers, enters-tapped clauses, static rule parsers (`parseRuleStaticLine`), trigger parsers (`parseTriggerLine`), or spell sentence parsers (`parseEffectSentence`).
   - If even **one** line fails to parse, `interpretCard` sets `modeled: false` and appends `unrecognized rules text: "<line>"` to `unmodeledReasons`.

2. **Authored Overrides & Drift Guard ([overrides/index.ts](../packages/engine/src/cards/overrides/index.ts))**:
   - Per [ADR 0009](0009-supported-pool-decks.md), ~94% of unparsed rules lines appear on exactly **one** card. Trying to expand general regexes for 400+ single-card mechanics creates fragile parser explosion.
   - `applyOverride` permits hand-crafted `CardDefinition` structures for specific cards, requiring a **byte-exact match** on `handledLines`. If oracle text changes or is errata'd, the drift guard rejects the override and halts safely.

3. **Engine Primitive Execution**:
   - Spells, triggers, and activated abilities decompose into `Effect` primitives (`dealDamage`, `draw`, `putCounters`, `graveyardToBattlefield`, etc.) executed deterministically by the rules engine (`packages/engine/src/game/`).

---

## 3. Multistep Roadmap to 100% Coverage

The plan is divided into **Phase 1: High-Yield Core Mechanics** (building parser/engine capabilities to unblock large clusters of cards) followed by **Phase 2: Deck-Targeted Resolution** (achieving 100% playability deck by deck).

---

### Step 1: Non-Mana Activated Abilities, Choice-of-Color Mana & Cost Keywords
*Expand `interpret.ts` and core engine activation handling for non-mana costs and common cost-bearing keywords.*

* **Mechanics Included**:
  * Activated abilities with costs: `{T}`, `{N}, {T}`, `{color}, {T}`, `{T}, Sacrifice this permanent`.
  * Choice-of-color mana & multi-colored land production: `{1}, {T}: Add {W}{U}` (Filter lands), `{T}: Add one mana of any color`.
  * Cost-bearing keywords: `Equip {N}`, `Cycling {N}`, `Kicker {cost}`, `Crew N`.
  * Stripping ability words: `Landfall —`, `Magecraft —`, `Metalcraft —`, `Eminence —` (enabling underlying rules text to parse).
* **Dependencies**: Existing mana payment system in `packages/engine/src/mana/payment.ts`.
* **Complexity & Effort**: **Medium** (3 weeks, 1 Engineer).
* **Target Decks**: Broad impact across all 7 decks (especially lands, artifacts, vehicles).
* **Projected Coverage Gain**:
  * Cards Unblocked: **+35 unique cards**
  * Aggregate Modeled: **178 / 538 (33.1%)**
  * `urdragon.txt` Progress: 64/93 → 70/93 (75.3%)
* **Testing & Validation**:
  * Unit tests in `packages/engine/test/cards/activated.test.ts` verifying cost validation, activation timing (instant vs sorcery speed for `Equip`/`Crew`), and priority passing.
  * Regression test against `bun run coverage` ensuring no existing modeled cards break.

---

### Step 2: Token Creation Engine & Trigger Extensions
*Implement a generic token creation pipeline and extend trigger parsers for ETB (other permanents) and phase boundaries.*

* **Mechanics Included**:
  * Token Creation: `Create N [P/T] [color] [type] token(s)` (Treasure, Pest, 4/4 Dragon, Thopter, Soldier, Cat).
  * ETB Triggers: `Whenever another [type] enters the battlefield...`, `Whenever a [type] you control enters...`.
  * Step/Phase Triggers: `At the beginning of your end step...`, `At the beginning of your upkeep...`.
* **Dependencies**: Step 1 (activated abilities that create tokens).
* **Complexity & Effort**: **Medium-High** (3 weeks, 1 Engineer).
* **Target Decks**: Major boost for `token-triumph.txt`, `draconic-destruction.txt`, and `urdragon.txt`.
* **Projected Coverage Gain**:
  * Cards Unblocked: **+45 unique cards**
  * Aggregate Modeled: **223 / 538 (41.4%)**
  * `urdragon.txt` Progress: 70/93 → 77/93 (82.8%)
  * `token-triumph.txt` Progress: 27/73 → 44/73 (60.3%)
* **Testing & Validation**:
  * Token state-based action tests: verifying tokens cease to exist upon leaving battlefield (CR 704.5d).
  * Trigger ordering tests: verifying APNAP order when multiple ETB/phase triggers fire simultaneously.

---

### Step 3: Counter Manipulation (+1/+1, -1/-1, Energy, Charge) & Proliferation
*Build counter state management on permanents/players, energy resource pools, and proliferation.*

* **Mechanics Included**:
  * Counter Operations: `put N +1/+1 counter(s) on target creature`, `put a gold/charge counter on ~`.
  * Energy Pool `{E}`: Resource tracking on `GameState.players[id].energy`, paying `{E}` for costs.
  * Counter Annihilation: +1/+1 and -1/-1 counter cancellation SBA (CR 704.5q).
  * Proliferate: Choosing permanents/players with counters and adding one of each existing type.
* **Dependencies**: Step 1 (paying counter/energy costs), Step 2 (triggers that place counters).
* **Complexity & Effort**: **High** (3.5 weeks, 1 Engineer).
* **Target Decks**: Essential prerequisite for `living-energy.txt` and `counter-intelligence.txt`.
* **Projected Coverage Gain**:
  * Cards Unblocked: **+52 unique cards**
  * Aggregate Modeled: **275 / 538 (51.1%)**
  * `living-energy.txt` Progress: 27/87 → 52/87 (59.8%)
  * `counter-intelligence.txt` Progress: 25/117 → 58/117 (49.6%)
* **Testing & Validation**:
  * Counter annihilation unit tests (`+1/+1` + `-1/-1` = 0).
  * Energy payment verification: confirming energy pools empty/persist across turns correctly (energy does NOT empty between steps).

---

### Step 4: Targeted Removal, Mass Removal, Graveyard Recursion & Modal Spells
*Complete core spell resolution primitives, modal spell selection, and graveyard interaction loops.*

* **Mechanics Included**:
  * Targeted Removal: "Destroy target permanent/creature/artifact", "Exile target monocolored permanent".
  * Mass Removal: "Destroy all creatures", "Exile all nonland permanents".
  * Modal Spells: `Choose one — \n• Mode A \n• Mode B` (CR 700.2, announcement-time mode selection).
  * Graveyard Recursion: "Return target card from your graveyard to your hand / the battlefield".
* **Dependencies**: Steps 1–3.
* **Complexity & Effort**: **High** (3.5 weeks, 1 Engineer).
* **Target Decks**: Unblocks interaction suites across all 7 decks.
* **Projected Coverage Gain**:
  * Cards Unblocked: **+55 unique cards**
  * Aggregate Modeled: **330 / 538 (61.3%)**
* **Testing & Validation**:
  * Modal spell selection decision request tests: verifying option menus present modes correctly during casting.
  * Graveyard zone transition tests: verifying CR 400.7 object identity updates on re-zoning.

---

### Step 5: 100% Playability Milestone 1 — `urdragon.txt` (The Ur-Dragon)
*Focus specifically on closing the remaining 12 unmodeled cards in `urdragon.txt` to achieve the simulator's first 100% real deck playability.*

* **Focus Cards & Mechanics**:
  * Bespoke Dragon Legendaries: Morophon (type choice & mana reduction), Sivitri (+1 attack cost penalty, -3 dragon tutor), Zurgo and Ojutai (hexproof turn entered, combat damage look top 3).
  * Adventure Layouts: *Monster Manual // Zoological Study*, *Marang River Regent // Coil and Catch*.
  * Dragon Mana Restrictions: *Orb of Dragonkind*, *Rivaz of the Claw* (restricted mana usage).
* **Methodology**: Parser extensions for shared rules + Authored Overrides in `packages/engine/src/cards/overrides/urdragon.ts`.
* **Dependencies**: Steps 1–4.
* **Complexity & Effort**: **Low-Medium** (1.5 weeks).
* **Projected Coverage Milestone**:
  * **`urdragon.txt` Coverage**: **93 / 93 (100.0%) — FIRST PLAYABLE REAL DECK! 🎉**
  * Aggregate Modeled: **353 / 538 (65.6%)**
  * Runnable Decks: **1 of 7**
* **Testing & Validation**:
  * Run `bun run coverage` confirming `urdragon.txt` reaches 100%.
  * Run `bun run decks packages/server/fixtures/coverage-decks/urdragon.txt` verifying deck validation pass.
  * Execute a 4-player game with `urdragon.txt` in the pod using seeded `RandomDecisionProvider`, asserting complete game execution to a winner without engine halts.

---

### Step 6: 100% Playability Milestone 2 — `draconic-destruction.txt` & `token-triumph.txt`
*Bring both starter precon decks to 100% card coverage.*

* **Focus Cards & Mechanics**:
  * `draconic-destruction.txt` (Remaining ~16 unmodeled): *Vandalblast* (Overload), *Atarka* combat grants, Dragon cost reducers.
  * `token-triumph.txt` (Remaining ~18 unmodeled): *Convoke* keyword, token duplication, anthem statics ("Creatures you control get +1/+1").
* **Dependencies**: Step 5.
* **Complexity & Effort**: **Medium** (2.5 weeks).
* **Projected Coverage Milestone**:
  * **`draconic-destruction.txt` Coverage**: **72 / 72 (100.0%) — DECK 2 PLAYABLE!**
  * **`token-triumph.txt` Coverage**: **73 / 73 (100.0%) — DECK 3 PLAYABLE!**
  * Aggregate Modeled: **410 / 538 (76.2%)**
  * Runnable Decks: **3 of 7**
* **Testing & Validation**:
  * End-to-end 3-deck games (`urdragon` vs `draconic-destruction` vs `token-triumph` vs `generated-pool`).
  * Byte-identical event log verification across identical seeds.

---

### Step 7: 100% Playability Milestone 3 — `living-energy.txt` & `silverquill-influence.txt`
*Bring Science! Energy precon and Silverquill Political precon to 100% card coverage.*

* **Focus Cards & Mechanics**:
  * `living-energy.txt` (Remaining ~22 unmodeled): Hybrid mana costs `{G/U}`, complex energy spenders, artifact activated abilities.
  * `silverquill-influence.txt` (Remaining ~25 unmodeled): Goad mechanics ("Target creature is goaded"), political choice cards, Aura attachments ("Enchant creature").
* **Dependencies**: Step 6.
* **Complexity & Effort**: **Medium-High** (3 weeks).
* **Projected Coverage Milestone**:
  * **`living-energy.txt` Coverage**: **87 / 87 (100.0%) — DECK 4 PLAYABLE!**
  * **`silverquill-influence.txt` Coverage**: **86 / 86 (100.0%) — DECK 5 PLAYABLE!**
  * Aggregate Modeled: **467 / 538 (86.8%)**
  * Runnable Decks: **5 of 7**
* **Testing & Validation**:
  * Goad constraint validation tests: verifying goaded creatures must attack a player other than the goader if able.
  * Hybrid mana payment tests: verifying payment solver evaluates `{G/U}` as either `{G}` or `{U}` accurately.

---

### Step 8: 100% Playability Milestone 4 — `necron-dynasties.txt` & `counter-intelligence.txt`
*Complete the final two complex artifact and graveyard precons to achieve 100% coverage across all supported decks.*

* **Focus Cards & Mechanics**:
  * `necron-dynasties.txt` (Remaining ~31 unmodeled): *Unearth* keyword, mono-black artifact synergy, graveyard triggers.
  * `counter-intelligence.txt` (Remaining ~40 unmodeled): *Affinity for artifacts*, *Improvise*, charge counter engines, proliferation loops, complex artifact vehicles.
* **Dependencies**: Step 7.
* **Complexity & Effort**: **High** (3.5 weeks).
* **Projected Coverage Milestone**:
  * **`necron-dynasties.txt` Coverage**: **71 / 71 (100.0%) — DECK 6 PLAYABLE!**
  * **`counter-intelligence.txt` Coverage**: **117 / 117 (100.0%) — DECK 7 PLAYABLE!**
  * **AGGREGATE COVERAGE**: **538 / 538 (100.0%) — ALL 7 TARGET DECKS 100% PLAYABLE! 🎉**
  * Runnable Decks: **7 of 7**
* **Testing & Validation**:
  * Full test suite execution (`bun test`).
  * `bun run coverage` output validation verifying 0 unmodeled cards across all input decks.
  * 7-deck round-robin tournament simulation driving Phase 3 AI evaluation against real decklists.

---

## 4. Plan Summary & Milestone Matrix

| Step | Focus Area / Mechanics | Dev Effort | Dependencies | Target Decks Unblocked | Aggregate Modeled Cards | Projected Deck Playability |
| :---: | :--- | :---: | :---: | :--- | :---: | :---: |
| **Baseline** | *Current State* | — | — | *None (Pool Decks Only)* | 143 / 538 (26.6%) | 0 / 7 Decks |
| **Step 1** | Non-Mana Activated Abilities & Cost Keywords | 3.0 wks | Engine Mana | All Decks (Broad) | 178 / 538 (33.1%) | 0 / 7 Decks |
| **Step 2** | Token Creation Engine & ETB/Phase Triggers | 3.0 wks | Step 1 | Token Triumph, Ur-Dragon | 223 / 538 (41.4%) | 0 / 7 Decks |
| **Step 3** | Counters (+1/+1, Energy, Charge) & Proliferate | 3.5 wks | Step 1, 2 | Counter Intel, Living Energy | 275 / 538 (51.1%) | 0 / 7 Decks |
| **Step 4** | Targeted Removal, Mass Removal & Modals | 3.5 wks | Steps 1–3 | All Decks (Interaction) | 330 / 538 (61.3%) | 0 / 7 Decks |
| **Step 5** | **100% Deck 1: Ur-Dragon** | 1.5 wks | Steps 1–4 | `urdragon.txt` | 353 / 538 (65.6%) | **1 / 7 Decks (Ur-Dragon)** |
| **Step 6** | **100% Decks 2 & 3: Draconic & Token** | 2.5 wks | Step 5 | `draconic`, `token-triumph` | 410 / 538 (76.2%) | **3 / 7 Decks** |
| **Step 7** | **100% Decks 4 & 5: Energy & Silverquill** | 3.0 wks | Step 6 | `living-energy`, `silverquill` | 467 / 538 (86.8%) | **5 / 7 Decks** |
| **Step 8** | **100% Decks 6 & 7: Necron & Counter Intel** | 3.5 wks | Step 7 | `necron`, `counter-intel` | **538 / 538 (100.0%)** | **7 / 7 Decks (100% Complete!)** |

**Total Estimated Duration**: ~23.5 Developer Weeks (~5.5 Months for 1 Engineer, ~3 Months for a 2-Person Team).

---

## 5. Quality Assurance & Verification Protocol

To ensure no rules regressions or non-deterministic bugs enter the engine as coverage expands:

1. **Drift Guard Integrity Verification**:
   - Every authored override added under `packages/engine/src/cards/overrides/` MUST include exact `handledLines` matching `unmodeledReasons` output.
   - Run `bun test` to ensure `applyOverride` drift guards raise errors if card oracle lines change.

2. **Deterministic Replay Checks**:
   - Every newly playable deck list must pass a 100-game deterministic seed test:
     $$\text{Seed}_A \longrightarrow \text{EventLog}_A \equiv \text{EventLog}_B \longleftarrow \text{Seed}_A$$
   - Verification command: `bun run pool --play` (or equivalent deck runner).

3. **Rules Legality Verification**:
   - Validate all target decks against standard Commander rules:
     `bun run decks --no-save packages/server/fixtures/coverage-decks/*.txt`
   - Confirm 7/7 report `VALID` independently of card interpretation.

4. **CI Coverage Tracking**:
   - Integrate `bun run coverage --json` into CI pipeline to block regressions on modeled card count.

---

> [!TIP]
> **Actionable Next Step**: Begin **Step 1** by extending `packages/engine/src/cards/interpret.ts` to parse simple `{T}: ...` and `{cost}, {T}: ...` activated abilities and cost keywords (`Equip`, `Crew`), creating `packages/engine/test/cards/activated.test.ts` for unit test coverage.
