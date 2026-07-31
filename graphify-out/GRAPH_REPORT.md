# Graph Report - .  (2026-07-30)

## Corpus Check
- 306 files · ~496,915 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2429 nodes · 7746 edges · 133 communities (104 shown, 29 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 89 edges (avg confidence: 0.77)
- Token cost: 471,679 input · 0 output

## Community Hubs (Navigation)
- Game State & Layer Engine
- Card Definitions & Trigger Tests
- Match Runner & Halt Handling
- Engine Config Constants
- Combat & Payment Presentation
- Ability Text Interpretation
- Match Session & Log Formatting
- Ability Cost Conditions
- Game Recording & Mana Metrics
- Player Game View (Vue)
- Action Application & Legality
- Deck Import & Coverage Snapshots
- Oracle Index & Deck Import CLI
- Selector & Turn Advancement
- Web App Routing & Debug View
- Commander Banned List (Cards)
- Comprehensive Rules: Keyword Abilities
- Card Coverage Measurement
- Supported Card Pool Builder
- Land Enters-Tapped Tests
- Companion Legality Checks
- AI Decision Requests
- Combat & Async Decision Tests
- AI Client Response Parsing
- Architecture Concepts (ADR Rationale)
- Mana Pool Management
- Combat Resolution
- AI Strategist Prompt Assembly
- Card Name Normalization & Scryfall
- Effect Resolution & Counters
- Continuous Effects Application
- WebSocket Game Client
- Ability Type Definitions
- Card Text Parsing & Overrides Registry
- Action Log & Commander Damage UI
- Human/Async Decision Providers
- Base TypeScript Config
- State-Based Actions
- Engine Driver & Debug Log
- AI Model Config & Providers
- Web App Package Manifest
- AI Client & Model Chain
- Decision Presentation Tests
- Ability & Stack Object Types
- Draconic Destruction Overrides
- Root Package Scripts
- Token Triumph Overrides & Selectors
- Decision Types & Engine API
- Mana Dynamic Tests
- AI Decision Cache & Mocks
- Web App Lint/Test Tooling Deps
- Scripted Decision Providers & PRNG
- AI Call Fallback & Logging
- Vue App Shell & Card Preview
- Spectator/Player State Builders
- Decision Panel (Vue)
- Card Text Parsing Helpers
- Seat Panel (Vue)
- Commander Rules & Banned Cards (Official Site)
- Engine tsconfig
- Playback Controls (Vue)
- Engine Package Manifest
- Continuous Effect Types
- Engine Errors
- AI Heuristics
- Player Action Targeting
- Shared Package Manifest
- Card Override Registry
- Shared tsconfig
- Card Image & Hand Strip (Vue)
- Brief & Phase Docs: Decision/Visibility Contracts
- Dev Server Launcher
- Layer Cache
- Layer System Tests
- Draconic Destruction Deck Fixture
- OpenRouter Provider Filtering
- Permanent Chip (Vue)
- Combat Plan Store
- Brief & Phase Docs: Engine Core & Coverage
- Root Workspace Manifest
- Activated Ability Tests
- Web App tsconfig
- Server Package Manifest
- Stack Panel (Vue)
- Server tsconfig
- Commander Rules (Brief Citations)
- Effect Value Scoping
- Combat Yield Stop List
- Generated Deck Fixtures 1-3
- Brief: Hybrid Architecture Rationale
- Creature/Card Type Tables
- Mana Preview Tests
- Counter Intelligence Deck Fixture
- Spectator Seek Tests
- Characteristics Source Test
- Living Energy Deck Fixture
- Necron Dynasties Deck Fixture
- Silverquill Influence Deck Fixture
- Vue Shims
- Spectator View Tests
- TS Project References
- Vite Config
- Brief: Mana Heuristic & Stats Phase
- Banned List: Channel & Fastbond
- Banned List: Hullbreacher & Leovold
- Generated Deck 4 Fixture
- ADR 0002: Deck Pipeline
- Brief: Phase 0 Foundations
- Brief: Phase 1 Deck Pipeline
- Phase 9: Progressive Disclosure
- Rules: Adventurer Cards
- Rules: Class Cards
- Rules: Controlling Another Player
- Rules: Ending Turns and Phases
- Rules: Flip Cards
- Rules: Flipping a Coin
- Rules: Handling Illegal Actions
- Rules: Leveler Cards
- Rules: Omen Cards
- Rules: Preparation Cards
- Rules: Prototype Cards
- Rules: Rad Counters
- Rules: Restarting the Game
- Rules: Split Cards
- Rules: Station Cards
- Rules: Subgames
- Rules: Substitute Cards
- Rules: Taking Shortcuts
- Rules: The Initiative
- Rules: The Monarch

## God Nodes (most connected - your core abstractions)
1. `oracle()` - 186 edges
2. `gameConfig()` - 102 edges
3. `forest()` - 100 edges
4. `createGame()` - 98 edges
5. `copies()` - 97 edges
6. `PlayerId` - 97 edges
7. `DecisionRequest` - 82 edges
8. `executeAbility()` - 79 edges
9. `interpretCard()` - 77 edges
10. `GameContext` - 77 edges

## Surprising Connections (you probably didn't know these)
- `Invalid Demo Deck (fails 100-card rule)` --conceptually_related_to--> `100-Card Deck Rule`  [INFERRED]
  packages/server/fixtures/invalid-demo.txt → docs/rules/Commander Rules _ Official Commander Website.pdf
- `Valid Mono-Green Demo Deck` --conceptually_related_to--> `100-Card Deck Rule`  [INFERRED]
  packages/server/fixtures/valid-mono-green.txt → docs/rules/Commander Rules _ Official Commander Website.pdf
- `Valid Mono-Green Demo Deck` --conceptually_related_to--> `Singleton Rule (no duplicate names, basic land exception)`  [INFERRED]
  packages/server/fixtures/valid-mono-green.txt → docs/rules/Commander Rules _ Official Commander Website.pdf
- `GroupedPermanent` --references--> `SpectatorPermanent`  [EXTRACTED]
  apps/web/src/components/SeatPanel.vue → packages/shared/src/spectator.ts
- `CombatPlanEntry` --references--> `ObjectId`  [EXTRACTED]
  apps/web/src/stores/combatPlan.ts → packages/shared/src/ids.ts

## Import Cycles
- 3-file cycle: `packages/engine/src/cards/ability.ts -> packages/engine/src/mana/cost.ts -> packages/engine/src/mana/pool.ts -> packages/engine/src/cards/ability.ts`
- 3-file cycle: `packages/engine/src/cards/ability.ts -> packages/engine/src/cards/condition.ts -> packages/engine/src/state/queries.ts -> packages/engine/src/cards/ability.ts`
- 3-file cycle: `packages/engine/src/cards/condition.ts -> packages/engine/src/state/queries.ts -> packages/engine/src/cards/definition.ts -> packages/engine/src/cards/condition.ts`
- 3-file cycle: `packages/engine/src/cards/ability.ts -> packages/engine/src/cards/condition.ts -> packages/engine/src/effects/continuous.ts -> packages/engine/src/cards/ability.ts`
- 3-file cycle: `packages/engine/src/cards/condition.ts -> packages/engine/src/effects/continuous.ts -> packages/engine/src/cards/continuous-types.ts -> packages/engine/src/cards/condition.ts`
- 3-file cycle: `packages/engine/src/cards/condition.ts -> packages/engine/src/effects/resolve.ts -> packages/engine/src/state/objects.ts -> packages/engine/src/cards/condition.ts`
- 3-file cycle: `packages/engine/src/cards/ability.ts -> packages/engine/src/cards/condition.ts -> packages/engine/src/state/types.ts -> packages/engine/src/cards/ability.ts`
- 3-file cycle: `packages/engine/src/cards/ability.ts -> packages/engine/src/cards/value.ts -> packages/engine/src/state/types.ts -> packages/engine/src/cards/ability.ts`
- 3-file cycle: `packages/engine/src/cards/condition.ts -> packages/engine/src/state/types.ts -> packages/engine/src/cards/definition.ts -> packages/engine/src/cards/condition.ts`
- 3-file cycle: `packages/engine/src/cards/definition.ts -> packages/engine/src/cards/value.ts -> packages/engine/src/state/types.ts -> packages/engine/src/cards/definition.ts`
- 3-file cycle: `packages/engine/src/cards/ability.ts -> packages/engine/src/cards/condition.ts -> packages/engine/src/effects/resolve.ts -> packages/engine/src/cards/ability.ts`
- 3-file cycle: `packages/engine/src/cards/condition.ts -> packages/engine/src/effects/resolve.ts -> packages/engine/src/cards/definition.ts -> packages/engine/src/cards/condition.ts`
- 4-file cycle: `packages/engine/src/cards/definition.ts -> packages/engine/src/cards/rule-statics.ts -> packages/engine/src/cards/value.ts -> packages/engine/src/state/types.ts -> packages/engine/src/cards/definition.ts`
- 4-file cycle: `packages/engine/src/cards/ability.ts -> packages/engine/src/cards/condition.ts -> packages/engine/src/mana/cost.ts -> packages/engine/src/mana/pool.ts -> packages/engine/src/cards/ability.ts`
- 4-file cycle: `packages/engine/src/cards/ability.ts -> packages/engine/src/cards/condition.ts -> packages/engine/src/effects/resolve.ts -> packages/engine/src/state/queries.ts -> packages/engine/src/cards/ability.ts`
- 4-file cycle: `packages/engine/src/cards/ability.ts -> packages/engine/src/cards/condition.ts -> packages/engine/src/state/queries.ts -> packages/engine/src/cards/definition.ts -> packages/engine/src/cards/ability.ts`
- 4-file cycle: `packages/engine/src/cards/condition.ts -> packages/engine/src/effects/resolve.ts -> packages/engine/src/state/queries.ts -> packages/engine/src/cards/definition.ts -> packages/engine/src/cards/condition.ts`
- 4-file cycle: `packages/engine/src/cards/condition.ts -> packages/engine/src/state/queries.ts -> packages/engine/src/cards/definition.ts -> packages/engine/src/cards/continuous-types.ts -> packages/engine/src/cards/condition.ts`
- 4-file cycle: `packages/engine/src/cards/ability.ts -> packages/engine/src/cards/condition.ts -> packages/engine/src/state/queries.ts -> packages/engine/src/effects/continuous.ts -> packages/engine/src/cards/ability.ts`
- 4-file cycle: `packages/engine/src/cards/condition.ts -> packages/engine/src/state/queries.ts -> packages/engine/src/effects/continuous.ts -> packages/engine/src/cards/continuous-types.ts -> packages/engine/src/cards/condition.ts`

## Hyperedges (group relationships)
- **CR 613 layer engine evolution across ADRs 0005-0008** — docs_decisions_0005_continuous_effects_layers, docs_decisions_0006_layer_dependency_ordering, docs_decisions_0007_characteristics_single_source_of_truth, docs_decisions_0008_compositional_selectors [EXTRACTED 1.00]
- **AI cost/latency control chain: decision budget, provider fallback, two-tier planning, request-shape fixes** — docs_decisions_0010_decision_call_budget, docs_decisions_0011_openai_compatible_provider, docs_decisions_0015_ai_request_shape, docs_decisions_0016_two_tier_ai_planning [INFERRED 0.85]
- **Card coverage measurement and backlog-closing effort across ADR 0009, 0013 roadmap/backlog, and 0020 plan** — docs_decisions_0009_supported_pool_decks, docs_decisions_0013_card_coverage_roadmap, docs_decisions_0013_missing_primitives, docs_decisions_0020_remaining_primitives_plan [EXTRACTED 1.00]
- **Engine-Authoritative Decision Architecture Spanning Brief and Phase 9** — docs_mtg_commander_ai_simulator_brief_engine_authority, docs_mtg_commander_ai_simulator_brief_decision_contract, docs_plans_phase_9_single_player_experience_intent_first_engine_last, docs_plans_phase_9_single_player_experience_stop_modes [INFERRED 0.85]
- **Phase 8-10 Post-Direct-Controls Experience Roadmap** — docs_plans_phase_8_action_animations_document, docs_plans_phase_9_single_player_experience_document, docs_plans_phase_10_deck_testing_lab_document [INFERRED 0.85]
- **Cards Banned for Explosive Early Mana Acceleration** — docs_rules_commander_banned_list_fastbond, docs_rules_commander_banned_list_channel, docs_rules_commander_banned_list_tolarian_academy, docs_rules_commander_banned_list_mana_crypt [INFERRED 0.75]
- **Decks Governed by Commander Format Deck-Construction Rules** — packages_server_fixtures_coverage_decks_counter_intelligence, packages_server_fixtures_coverage_decks_draconic_destruction, packages_server_fixtures_coverage_decks_living_energy, packages_server_fixtures_coverage_decks_necron_dynasties, packages_server_fixtures_coverage_decks_silverquill_influence, packages_server_fixtures_coverage_decks_urdragon, packages_server_fixtures_valid_mono_green, packages_server_fixtures_invalid_demo, docs_rules_commander_rules_official_commander_website [INFERRED 0.75]
- **Dragon Tribal Commander Decks** — packages_server_fixtures_coverage_decks_draconic_destruction, packages_server_fixtures_coverage_decks_urdragon [INFERRED 0.85]
- **White Aggro/Soldier Generated Test Decks** — packages_server_fixtures_generated_decks_generated_2_hawkeye_clint_barton, packages_server_fixtures_generated_decks_generated_3_tobias_andrion [INFERRED 0.85]

## Communities (133 total, 29 thin omitted)

### Community 0 - "Game State & Layer Engine"
Cohesion: 0.06
Nodes (74): createGame(), CardId, GameConfig, GameContext, ctx4(), sage(), ADR-0007, bloomvineRegent() (+66 more)

### Community 1 - "Card Definitions & Trigger Tests"
Cohesion: 0.05
Nodes (60): carnelianOrb(), dummyCommander(), hellkiteCourser(), herdHeirloom(), huntersInsight(), pod(), ADR-0010, oracle() (+52 more)

### Community 2 - "Match Runner & Halt Handling"
Cohesion: 0.06
Nodes (22): GameStatus, ManaMetricRecord, classifyHalt(), ComputeHaltError, DecisionEscalation, ESCALATION_TIMEOUT_MS, HaltInfo, MatchRunner (+14 more)

### Community 3 - "Engine Config Constants"
Cohesion: 0.07
Nodes (58): ApiCost, DEFAULT_DEBUG_FLAGS, DEFAULT_PACE_MS, TargetChoice, DECISION_TYPES, LOSS_REASONS, PHASES, STEPS (+50 more)

### Community 4 - "Combat & Payment Presentation"
Cohesion: 0.10
Nodes (44): DamageAssignment, ChooseCardSpec, PaymentPlan, MoveDestination, TriggerEventSubject, CombatState, EngineCardObject, EngineObject (+36 more)

### Community 5 - "Ability Text Interpretation"
Cohesion: 0.08
Nodes (53): countPermanents(), ABILITY_WORD_RE, ABILITY_WORDS, ALL_COLORS, ANY_SPELL, BASIC_LAND_MANA, CARD_TYPE_PLURALS, CARD_TYPE_SINGULARS (+45 more)

### Community 6 - "Match Session & Log Formatting"
Cohesion: 0.10
Nodes (9): formatPlayerLog(), formatSpectatorLog(), event(), MatchSession, GameServer, ORPHAN_GRACE_MS, SocketData, GameMode (+1 more)

### Community 7 - "Ability Cost Conditions"
Cohesion: 0.08
Nodes (41): CostReductionResult, AbilityCost, ManaRestriction, ManaSpendTrigger, TAP_COST, compare(), evaluateCondition(), isChoiceCondition() (+33 more)

### Community 8 - "Game Recording & Mana Metrics"
Cohesion: 0.08
Nodes (23): MANA_METRICS, finishingPositions(), GameRecorder, GameRow, GameSeatRecord, seatIndex(), SqliteLike, Call (+15 more)

### Community 9 - "Player Game View (Vue)"
Cohesion: 0.05
Nodes (39): actionableSourceIds, actionCost(), actionData(), actionLabel(), cancel(), canConfirm, cardPreview, chosenTargets (+31 more)

### Community 10 - "Action Application & Legality"
Cohesion: 0.12
Nodes (44): addManaCosts(), applyPriorityAction(), payActivationCosts(), queueBecomesTargetedTriggers(), queueWardTriggers(), resolveCastAbility(), activationCostReductionFor(), addManaCosts() (+36 more)

### Community 11 - "Deck Import & Coverage Snapshots"
Cohesion: 0.08
Nodes (35): DEFAULT_DECKS, main(), slugFor(), slugify(), toPlaintext(), DeckRow, ArchidektCard, ArchidektDeck (+27 more)

### Community 12 - "Oracle Index & Deck Import CLI"
Cohesion: 0.09
Nodes (32): line(), OracleIndex, SupportedPool, main(), parseArgs(), printResult(), readInput(), GameStore (+24 more)

### Community 13 - "Selector & Turn Advancement"
Cohesion: 0.16
Nodes (38): isPermanentCard(), SelectorCandidate, evaluateValue(), GameGen, drawCards(), endUntilEotEffects(), isTargetStillLegal(), advanceToNextTurnPlayer() (+30 more)

### Community 14 - "Web App Routing & Debug View"
Cohesion: 0.05
Nodes (32): router, routes, useGameStore, AiCall, categories, category, data, DebugData (+24 more)

### Community 15 - "Commander Banned List (Cards)"
Cohesion: 0.05
Nodes (41): Ancestral Recall (banned, optics), Balance (banned, resource denial), Biorhythm (banned, accidental elimination), Black Lotus (banned, optics), Chaos Orb (banned, manual dexterity), Dockside Extortionist (banned, treasure acceleration), Commander Banned List (mtgcommander.net), Emrakul, the Aeon's Torn (banned, game-warping finisher) (+33 more)

### Community 16 - "Comprehensive Rules: Keyword Abilities"
Cohesion: 0.07
Nodes (39): 904. Archenemy, 717. Attraction Cards, 702.165 Backup, 702.166 Bargain, 903.12 Brawl Option, 719. Case Cards, 900. Casual Variants (General), 903. Commander (+31 more)

### Community 17 - "Card Coverage Measurement"
Cohesion: 0.11
Nodes (30): EnginePlayerConfig, CardCoverage, classifyReason(), CoverageReport, DeckCards, DeckCoverage, measureCoverage(), MECHANIC_FAMILIES (+22 more)

### Community 18 - "Supported Card Pool Builder"
Cohesion: 0.13
Nodes (32): runToCompletion(), runToCompletionAsync(), configForRole(), basicLandsByColor(), buildSupportedPool(), commandersIn(), identityOf(), isUnlimited() (+24 more)

### Community 19 - "Land Enters-Tapped Tests"
Cohesion: 0.08
Nodes (31): setup4PlayerContext(), checkland(), ctxWithSeats(), land(), opponentLand(), playFromHand(), shockland(), slowland() (+23 more)

### Community 20 - "Companion Legality Checks"
Cohesion: 0.08
Nodes (28): CHECKS, CompanionCheck, companionConditionIssues(), isPermanent(), issue(), KAHEERA_TYPES, PERMANENT_TYPES, allowsAnyQuantity() (+20 more)

### Community 21 - "AI Decision Requests"
Cohesion: 0.13
Nodes (11): AiPrompt, SKIPPED_SOURCES, OpenAiDecisionProvider, RequestQueueInterface, validateResponse(), abilityKey(), isPass(), PendingHumanDecision (+3 more)

### Community 22 - "Combat & Async Decision Tests"
Cohesion: 0.18
Nodes (22): RandomDecisionProvider, pod(), attackWith(), combatContext(), playOnce(), pod(), bear(), bolt() (+14 more)

### Community 23 - "AI Client Response Parsing"
Cohesion: 0.12
Nodes (21): ACTION_ID_KEYS, balancedObjects(), extractJsonObject(), parseJsonResponse(), WIRE_EFFORT, AiResponseValidationError, AuthenticationError, DailyQuotaExhaustedError (+13 more)

### Community 24 - "Architecture Concepts (ADR Rationale)"
Cohesion: 0.10
Nodes (34): apps/web index.html (Vue app shell), MTG Commander AI Simulator — CLAUDE.md project instructions, Ability IR (data-driven card behavior representation), Authored Override Registry (hand-written Ability defs, drift-guarded), CR 613 Continuous Effects Layer System, Engine/AI Hybrid Split (engine authoritative, AI only chooses), MatchRunner (drives engine.advance/submit for playback), PlayerView (hidden-information-safe projection) (+26 more)

### Community 25 - "Mana Pool Management"
Cohesion: 0.09
Nodes (29): ManaEntry, addManaFromAbility(), addMana(), drainPool(), emptyPool(), ManaPoolHolder, removeMana(), resync() (+21 more)

### Community 26 - "Combat Resolution"
Cohesion: 0.15
Nodes (33): attackers(), blockersInCombat(), canAttack(), canBlock(), commitAttacker(), creaturesOf(), dealCombatDamage(), dealsInStep() (+25 more)

### Community 27 - "AI Strategist Prompt Assembly"
Cohesion: 0.11
Nodes (13): ADR-0016, assemblePrompt(), assembleStrategistPrompt(), BASIC_LAND_NAMES, OpenAiMessage, RecentSeatDecision, TacticalGuidance, RULES_PRIMER (+5 more)

### Community 28 - "Card Name Normalization & Scryfall"
Cohesion: 0.15
Nodes (23): looseKey(), normalizeApostrophes(), strictKey(), buildOracleIndex(), COLOR_SET, faceFallback(), NON_GAME_LAYOUTS, parseTypeLine() (+15 more)

### Community 29 - "Effect Resolution & Counters"
Cohesion: 0.16
Nodes (29): cardTypesInAllGraveyards(), chooseCard(), candidateOf(), selectPermanents(), addCounters(), affectedBy(), counterUnlessPays(), defOf() (+21 more)

### Community 30 - "Continuous Effects Application"
Cohesion: 0.12
Nodes (29): ContinuousOp, selectorIsEventOnly(), isDynamicValue(), affects(), Applicability, applyCounters(), applyGroup(), applyOne() (+21 more)

### Community 31 - "WebSocket Game Client"
Cohesion: 0.10
Nodes (12): ConnectionState, GameSocket, ServerMessageHandler, LOG, sent, Store, forest(), general() (+4 more)

### Community 32 - "Ability Type Definitions"
Cohesion: 0.12
Nodes (20): AlternativeCast, DynamicManaKind, Effect, IMPLEMENTED_KEYWORDS, ObjectTriggerWhen, PaymentPurpose, SearchDestination, SELF_SUBJECT (+12 more)

### Community 33 - "Card Text Parsing & Overrides Registry"
Cohesion: 0.25
Nodes (22): LAND_SUBTYPES, parseActivationCosts(), parseCardFilterPhrase(), parseEntersUnlessClause(), parseSearchFilter(), registerCOUNTER_INTELLIGENCEOverrides(), registerDRACONIC_DESTRUCTIONOverrides(), registerOverride() (+14 more)

### Community 34 - "Action Log & Commander Damage UI"
Cohesion: 0.08
Nodes (18): emit, props, scroller, Column, columns, damage, props, emit (+10 more)

### Community 35 - "Human/Async Decision Providers"
Cohesion: 0.13
Nodes (11): AsyncDecisionProvider, HumanDecisionProvider, PersistentAbilityYieldProvider, PlayerConnectionGate, resolve(), AsyncAdapter, DEFAULT_DEBUG_FLAGS, LIVE_PACE_MS (+3 more)

### Community 36 - "Base TypeScript Config"
Cohesion: 0.08
Nodes (25): compilerOptions, composite, declaration, declarationMap, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, isolatedModules (+17 more)

### Community 37 - "State-Based Actions"
Cohesion: 0.18
Nodes (23): computeCharacteristics(), matchesSelector(), payAbilityCosts(), describeTargetForLog(), markLoss(), placePendingTriggers(), processEliminations(), pushTriggerOnStack() (+15 more)

### Community 38 - "Engine Driver & Debug Log"
Cohesion: 0.14
Nodes (6): Engine, EngineDriver, DebugEntry, DecisionSource, TurnPlanManager, PlannedAction

### Community 39 - "AI Model Config & Providers"
Cohesion: 0.11
Nodes (20): AiModelProfile, DEEPSEEK, DEFAULT_AI_CONFIG, DEFAULT_MODEL_CHAIN, DEFAULT_PROVIDER, GEMINI, GROQ, loadAiConfig() (+12 more)

### Community 40 - "Web App Package Manifest"
Cohesion: 0.08
Nodes (23): dependencies, @mtg/shared, pinia, vue, vue-router, devDependencies, vite, @vitejs/plugin-vue (+15 more)

### Community 41 - "AI Client & Model Chain"
Cohesion: 0.13
Nodes (10): AiClient, OpenAiCompatibleClient, reasoningParams(), bodyOf(), fixturePrompt(), fixtureRequest(), okFetch(), send() (+2 more)

### Community 42 - "Decision Presentation Tests"
Cohesion: 0.10
Nodes (13): EffectSource, pod(), pod(), plains(), registerDef(), spawn(), castSpell(), farseek() (+5 more)

### Community 43 - "Ability & Stack Object Types"
Cohesion: 0.12
Nodes (19): Ability, TriggerScope, RuleStaticEntry, DelayedTrigger, EngineEmblem, EngineStackObject, PendingTrigger, UntilEotEffect (+11 more)

### Community 44 - "Draconic Destruction Overrides"
Cohesion: 0.09
Nodes (21): CLAN_DEFIANCE_DEF, DEMANDING_DRAGON_DEF, DRAGON_MAGE_DEF, DRAGONKIN_BERSERKER_DEF, DREAM_PILLAGER_DEF, FLAMEBLAST_DRAGON_DEF, FOE_RAZER_REGENT_DEF, FRONTIER_SIEGE_DEF (+13 more)

### Community 45 - "Root Package Scripts"
Cohesion: 0.10
Nodes (20): scripts, build, coverage, coverage:snapshot, decks, dev, dev:web, format (+12 more)

### Community 46 - "Token Triumph Overrides & Selectors"
Cohesion: 0.12
Nodes (18): registerTOKEN_TRIUMPHOverrides(), CHOSEN_COLOR, ENTERED_THIS_TURN, IN_COMBAT, IS_COMMANDER, IS_ENCHANTED, IS_EQUIPPED, IS_MONOCOLORED (+10 more)

### Community 47 - "Decision Types & Engine API"
Cohesion: 0.19
Nodes (16): DecisionOutcome, EngineActionOption, forcedOutcome(), isForced(), isPassOption(), PendingDecision, asRecord(), interactionFor() (+8 more)

### Community 48 - "Mana Dynamic Tests"
Cohesion: 0.13
Nodes (18): island(), artifact(), chromaticLantern(), commandTower(), ctxWithCommander(), dragon(), fellwarStone(), land() (+10 more)

### Community 49 - "AI Decision Cache & Mocks"
Cohesion: 0.15
Nodes (8): CachedAnswer, DecisionCache, digestDecision(), hashNumber(), hashString(), mix(), ANSWER, ADR-0007

### Community 50 - "Web App Lint/Test Tooling Deps"
Cohesion: 0.11
Nodes (19): eslint, @eslint/js, devDependencies, eslint, @eslint/js, @playwright/test, prettier, @types/bun (+11 more)

### Community 51 - "Scripted Decision Providers & PRNG"
Cohesion: 0.16
Nodes (9): choose(), chooseFirst(), DecisionProvider, firstTargets(), ScriptedDecisionProvider, ScriptedStep, hashSeedString(), Prng (+1 more)

### Community 52 - "AI Call Fallback & Logging"
Cohesion: 0.18
Nodes (11): CallMeta, firstTargets(), safestFallback(), AiCallLogger, CallResult, localCallMeta(), SqliteDb, DecisionEscalation (+3 more)

### Community 53 - "Vue App Shell & Card Preview"
Cohesion: 0.14
Nodes (8): cardPreview, SIZE_PX, store, style, cardPreview, props, PreviewCard, useCardPreviewStore

### Community 54 - "Spectator/Player State Builders"
Cohesion: 0.21
Nodes (14): presentedCard(), scryfallIdOf(), buildPlayerBoardState(), buildSpectatorState(), cardView(), commanderDamage(), commanderName(), commanderViews() (+6 more)

### Community 55 - "Decision Panel (Vue)"
Cohesion: 0.13
Nodes (9): cardPreview, emit, Group, groups, props, sourceLabel, sourceScryfallId, ActionSubject (+1 more)

### Community 56 - "Card Text Parsing Helpers"
Cohesion: 0.17
Nodes (14): interpretCard(), parseActivatedLine(), parseHuntersInsightBlock(), parseManaAbilityLine(), parseStaticLine(), splitActivation(), stripAbilityWord(), stripGenericAbilityLabel() (+6 more)

### Community 57 - "Seat Panel (Vue)"
Cohesion: 0.14
Nodes (14): cmdDamageTaken, exileCards, expanded, flexStyles, groupedLands, groupedNonlands, GroupedPermanent, groupPermanents() (+6 more)

### Community 58 - "Commander Rules & Banned Cards (Official Site)"
Cohesion: 0.15
Nodes (15): Commander Banned List (Official Commander Website), Banned Card: Channel, Format Philosophy (banlist rationale), Banned Card: Mana Crypt, Commander Rules (Official Commander Website), Color Identity Rule, Command Zone Tax (commander cast tax), Commander Damage Rule (21 points) (+7 more)

### Community 59 - "Engine tsconfig"
Cohesion: 0.14
Nodes (13): compilerOptions, lib, outDir, rootDir, types, extends, include, ES2023 (+5 more)

### Community 60 - "Playback Controls (Vue)"
Cohesion: 0.18
Nodes (11): canBack, canForward, confirmAbandon(), currentRound, dragTurn, emit, onScrubCommit(), props (+3 more)

### Community 61 - "Engine Package Manifest"
Cohesion: 0.15
Nodes (12): @mtg/engine, dependencies, @mtg/engine, @mtg/shared, exports, @mtg/shared, name, private (+4 more)

### Community 62 - "Continuous Effect Types"
Cohesion: 0.31
Nodes (12): ActivatedAbility, KeywordAbility, ManaAbilitySpec, Condition, Characteristics, StaticEffect, ADR-0005, ADR-0007 (+4 more)

### Community 63 - "Engine Errors"
Cohesion: 0.18
Nodes (5): EngineUsageError, IllegalDecisionError, UnmodeledCardError, drive(), RuleBasedProvider

### Community 64 - "AI Heuristics"
Cohesion: 0.26
Nodes (9): HARMLESS_COMBAT_STEPS, isPassAction(), numericData(), INSTANT, PASS, tryDeclineZeroPowerAttack(), tryDeferInstant(), tryHeuristic() (+1 more)

### Community 65 - "Player Action Targeting"
Cohesion: 0.27
Nodes (12): chooseAction(), chooseOpponent(), chooseTarget(), dropOn(), dropToBattlefield(), isImmediate(), isLegalTarget(), isRoutineAction() (+4 more)

### Community 66 - "Shared Package Manifest"
Cohesion: 0.17
Nodes (11): dependencies, @mtg/shared, exports, @mtg/shared, name, private, scripts, typecheck (+3 more)

### Community 67 - "Card Override Registry"
Cohesion: 0.26
Nodes (10): applyOverride(), getOverride(), normalizeLine(), OVERRIDES, quotedBody(), ADR-0004, ADR-0009, ADR-0010 (+2 more)

### Community 68 - "Shared tsconfig"
Cohesion: 0.17
Nodes (11): compilerOptions, outDir, rootDir, types, extends, include, src, ../../tsconfig.base.json (+3 more)

### Community 69 - "Card Image & Hand Strip (Vue)"
Cohesion: 0.18
Nodes (6): failed, props, showImage, src, TOKEN_SCRYFALL_IDS, cardPreview

### Community 70 - "Brief & Phase Docs: Decision/Visibility Contracts"
Cohesion: 0.18
Nodes (11): Engine DecisionRequest/DecisionResponse Contract, Invalid AI Response Handling Chain (Retry, Human, Fallback), Phase 3 — AI Integration, Phase 4 — Spectator UI, PlayerView Visibility Model (No Hidden State to AI), Motion Accessibility (Full/Reduced/Off), Pinia Animation Store / ActionAnimationLayer, Explicit ActionCue Contract (Not Log-Text Parsing) (+3 more)

### Community 71 - "Dev Server Launcher"
Cohesion: 0.22
Nodes (8): engines, bun, pipeTagged(), server, serverArgs, serverPort, spawnTagged(), waitForServer()

### Community 72 - "Layer Cache"
Cohesion: 0.36
Nodes (10): CACHE, digestOf(), foldCounters(), getCached(), hashString(), hashStringUncached(), LayerCacheEntry, mix() (+2 more)

### Community 73 - "Layer System Tests"
Cohesion: 0.24
Nodes (9): bloodMoon(), ctx4(), customDef(), land(), moonLandDef(), tarmogoyf(), ADR-0005, ADR-0006 (+1 more)

### Community 74 - "Draconic Destruction Deck Fixture"
Cohesion: 0.22
Nodes (10): Draconic Destruction (Starter Commander Precon), Atarka, World Render (Commander), Drakuseth, Maw of Flames, Sarkhan, the Dragonspeaker, Thundermaw Hellkite, Ur-Dragon Five-Color Tribal Deck, Dragon Tempest, Klauth, Unrivaled Ancient (+2 more)

### Community 75 - "OpenRouter Provider Filtering"
Cohesion: 0.29
Nodes (8): CacheEntry, clearNonCachingProvidersCache(), getNonCachingProviders(), nonCachingCache, OpenRouterEndpoint, OpenRouterEndpointPricing, OpenRouterEndpointsResponse, supportsCaching()

### Community 76 - "Permanent Chip (Vue)"
Cohesion: 0.22
Nodes (5): cardPreview, counterText, isCreature, marks, props

### Community 77 - "Combat Plan Store"
Cohesion: 0.25
Nodes (4): CombatPlanEntry, CombatPlanMode, OPPONENTS, useCombatPlanStore

### Community 78 - "Brief & Phase Docs: Engine Core & Coverage"
Cohesion: 0.22
Nodes (9): Modelled Cards by Engine (3854 cards), Card Behavior: Hybrid Boundary (Halt on Unmodelable Card), London Mulligan with Multiplayer Free-Mulligan Provision, Phase 2 — Engine Core, Seeded Randomness (Single PRNG per Game), Headless Batch Simulation Orchestration, Coverage as Part of Test Validity, Phase 10 — Deck Testing Lab and Simulation Engine (+1 more)

### Community 79 - "Root Workspace Manifest"
Cohesion: 0.22
Nodes (8): name, packageManager, private, type, version, workspaces, apps/*, packages/*

### Community 80 - "Activated Ability Tests"
Cohesion: 0.25
Nodes (7): dragon(), dragonsHoard(), optionsFor(), p1(), pod(), recklessBarbarian(), ADR-0010

### Community 81 - "Web App tsconfig"
Cohesion: 0.22
Nodes (8): compilerOptions, outDir, extends, include, src, ../../tsconfig.base.json, references, tests

### Community 82 - "Server Package Manifest"
Cohesion: 0.22
Nodes (8): exports, name, private, scripts, typecheck, type, types, version

### Community 83 - "Stack Panel (Vue)"
Cohesion: 0.25
Nodes (4): cardPreview, nameOf, props, topFirst

### Community 84 - "Server tsconfig"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, src, ../../tsconfig.base.json

### Community 85 - "Commander Rules (Brief Citations)"
Cohesion: 0.43
Nodes (7): Commander-Format Rules (Engine Implementation), 21 Combat Damage from a Single Commander Elimination Rule, Color Identity Rule, Commander Command-Zone Replacement Effect, Deck Construction Rules (100 Cards, Commander, Singleton), Commander Construction & Play Rules (mtgcommander.net), Wish Effects Do Not Function in Commander

### Community 86 - "Effect Value Scoping"
Cohesion: 0.29
Nodes (5): EffectRef, CARD_TYPES, ADR-0005, ADR-0007, ValueScope

### Community 87 - "Combat Yield Stop List"
Cohesion: 0.57
Nodes (6): BOARD_WIPE_OPS, breakYieldsForStop(), flattenEffects(), targetsPlayer(), threatensBoard(), threatensLifeOrHand()

### Community 88 - "Generated Deck Fixtures 1-3"
Cohesion: 0.29
Nodes (7): Generated Deck 1: Sliver Hivelord, Sliver Hivelord (Commander), Tobias Andrion (card in deck 1), Generated Deck 2: Hawkeye, Clint Barton, Hawkeye, Clint Barton (Commander), Generated Deck 3: Tobias Andrion, Tobias Andrion (Commander)

### Community 89 - "Brief: Hybrid Architecture Rationale"
Cohesion: 0.33
Nodes (6): Project Brief: MTG Commander AI Simulator, Engine Is Always Authoritative on Legality, Engine/AI Hybrid Architecture Split, Explicitly Out of Scope for v1, Intent First, Engine Last (Engine.submit() Sole Authority), Priority Stop Modes (Stop at Every Priority / Stop When I Can Act / Advance)

### Community 90 - "Creature/Card Type Tables"
Cohesion: 0.33
Nodes (5): CREATURE_TYPE_BY_LOWER, CREATURE_TYPES, NONCREATURE_SUBTYPE_BY_LOWER, PLANESWALKER_TYPES, SPELL_TYPES

### Community 91 - "Mana Preview Tests"
Cohesion: 0.47
Nodes (4): commandTower(), ctxWithCommander(), land(), painlandFilter()

### Community 92 - "Counter Intelligence Deck Fixture"
Cohesion: 0.33
Nodes (6): Counter Intelligence (Edge of Eternities Precon), Emry, Lurker of the Loch, Jhoira, Weatherlight Captain, Kilo, Apogee Mind (Commander), Shorikai, Genesis Engine, Sol Ring

### Community 93 - "Spectator Seek Tests"
Cohesion: 0.70
Nodes (3): forest(), general(), playGame()

### Community 94 - "Characteristics Source Test"
Cohesion: 0.40
Nodes (3): ALLOWED, SRC, ADR-0007

### Community 95 - "Living Energy Deck Fixture"
Cohesion: 0.40
Nodes (5): Living Energy (Aetherdrift Precon), Elder Gargaroth, Panharmonicon, Pia and Kiran Nalaar, Saheeli, Radiant Creator (Commander)

### Community 96 - "Necron Dynasties Deck Fixture"
Cohesion: 0.40
Nodes (5): Necron Dynasties (Warhammer 40,000 Precon), Living Death, Szarekh, the Silent King (Commander), The War in Heaven, Trazyn the Infinite

### Community 97 - "Silverquill Influence Deck Fixture"
Cohesion: 0.40
Nodes (5): Silverquill Influence Precon, Eriette of the Charmed Apple, Killian, Decisive Mentor (Commander), Land Tax, Shadrix Silverquill

### Community 98 - "Vue Shims"
Cohesion: 0.50
Nodes (3): ImportMeta, ImportMetaEnv, *.vue

### Community 99 - "Spectator View Tests"
Cohesion: 1.00
Nodes (3): forest(), general(), makeEngine()

### Community 100 - "TS Project References"
Cohesion: 0.50
Nodes (3): files, references, $schema

## Knowledge Gaps
- **579 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+574 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **29 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `oracle()` connect `Card Definitions & Trigger Tests` to `Game State & Layer Engine`, `Card Override Registry`, `Layer System Tests`, `Action Application & Legality`, `Decision Presentation Tests`, `Activated Ability Tests`, `Mana Dynamic Tests`, `Land Enters-Tapped Tests`, `Combat & Async Decision Tests`, `Card Text Parsing Helpers`, `Mana Pool Management`, `Mana Preview Tests`, `Engine Errors`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Why does `bun` connect `Dev Server Launcher` to `Match Session & Log Formatting`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Why does `PlayerId` connect `Combat & Payment Presentation` to `Game State & Layer Engine`, `Match Runner & Halt Handling`, `Engine Config Constants`, `Match Session & Log Formatting`, `Ability Cost Conditions`, `Game Recording & Mana Metrics`, `Action Application & Legality`, `Oracle Index & Deck Import CLI`, `Selector & Turn Advancement`, `Card Coverage Measurement`, `AI Decision Requests`, `Combat & Async Decision Tests`, `Mana Pool Management`, `Combat Resolution`, `AI Strategist Prompt Assembly`, `Effect Resolution & Counters`, `Human/Async Decision Providers`, `State-Based Actions`, `AI Client & Model Chain`, `Decision Presentation Tests`, `Ability & Stack Object Types`, `Decision Types & Engine API`, `Seat Panel (Vue)`, `Effect Value Scoping`, `Mana Preview Tests`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Are the 35 inferred relationships involving `forest()` (e.g. with `ctx4()` and `pod()`) actually correct?**
  _`forest()` has 35 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _579 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Game State & Layer Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.06253369272237197 - nodes in this community are weakly interconnected._
- **Should `Card Definitions & Trigger Tests` be split into smaller, more focused modules?**
  _Cohesion score 0.04616588419405321 - nodes in this community are weakly interconnected._