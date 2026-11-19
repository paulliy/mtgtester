# Compiled-card sweep, 2026-11-19 (issue #95, phases 1 and 2)

This is a list for review. Nothing here has been retired. Every card under "Retirement candidates"
uses a shape that already got a sibling card retired, and I read each one against its Oracle text.
Whether to retire each card is the owner's call.

Base: `main` at `15ee003c`, 1,125 promoted compiled cards. Rerun with:

```bash
bun run scripts/card-compiler/gap-sweep.ts --json sweep.json --markdown sweep.md
```

## How the sweep works

`scripts/card-compiler/gap-sweep.ts` has two parts.

1. **Shape detectors.** There are 28 detectors, one per engine gap or misreading named in #95 or in
   `docs/reviews/compiled-card-retired.json`. Each one matches an IR shape in a card's patch. Each
   detector lists the retired cards it was written from, and the script reports its recall on
   them. **Every detector matches every one of its retired examples.** The sweep started at 40
   live hits. Reading each one against its Oracle text cleared 28 of them (see below), and I
   tightened the detectors to match, so a rerun prints only the 20 below.
2. **Facet counts** (`packages/engine/src/cards/facets.ts`) compare "another", intervening "if",
   "until end of turn", "you may" and "target" counts between the text and the IR. This is a weak
   gate for compiled cards. It flags only 25 of the 99 known-wrong retired patches, and when I
   hand-checked all 49 of its intervening-if and target-count flags on live cards, none was a real
   error. Its `other` facet was the exception: it pointed straight at the owner's "other on
   self-eligible costs" backlog, which is now a shape detector.

## Retirement candidates (20)

Each card below has the same shape as one already retired. The retired card is named, so the
reason carries over.

| Card                           | Rank  | Batch     | Shape                         | Same as retired                 | Note                                                                                                                               |
| ------------------------------ | ----- | --------- | ----------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Dawn's Reflection              | 8963  | chunk-011 | `mana-activation-rider`       | Fertile Ground, Market Festival | The rider also augments the land's non-tap mana abilities.                                                                         |
| Heartbeat of Spring            | 4187  | chunk-005 | `mana-activation-rider`       | Mana Flare, Vernal Bloom        | Same.                                                                                                                              |
| General Kreat, the Boltbringer | 2214  | chunk-002 | `token-created-attacking`     | Leonin Warleader                | The token can only attack players already attacked.                                                                                |
| Skyknight Vanguard             | 3927  | chunk-005 | `token-created-attacking`     | Leonin Warleader                | Same.                                                                                                                              |
| Battle Cry Goblin              | 5035  | chunk-006 | `token-created-attacking`     | Leonin Warleader                | Same.                                                                                                                              |
| Suki, Kyoshi Warrior           | 7277  | chunk-009 | `token-created-attacking`     | Leonin Warleader                | Same.                                                                                                                              |
| Sinkhole Surveyor              | 8867  | chunk-011 | `fabricate-choice` (endure)   | Angel of Invention              | CR 701.63a: if it left the battlefield, its controller must create the token; the IR still offers the counters and yields nothing. |
| Reckless Rage                  | 11692 | chunk-015 | `split-simultaneous-damage`   | Self-Destruct                   | The two damage amounts are dealt in two events.                                                                                    |
| Dagger Caster                  | 12095 | chunk-015 | `split-simultaneous-damage`   | Self-Destruct                   | Same.                                                                                                                              |
| Windrider Wizard               | 11840 | chunk-015 | `if-you-do-after-zero`        | Sanctum of Calm Waters          | It discards even when it drew no card.                                                                                             |
| Avacyn, Angel of Horror        | 4706  | chunk-006 | `delayed-trigger-subject`     | Benefactor's Draught (gap list) | "A delayed trigger created during an end step never fires": a creature that dies in the end step never returns. Edge case only.    |
| Ideas Unbound                  | 9697  | chunk-012 | `delayed-trigger-subject`     | (gap list)                      | Cast during an end step, it never discards. Edge case only.                                                                        |
| Honor-Worn Shaku               | 3881  | chunk-004 | `other-on-self-eligible-cost` | owner backlog, #95 section 5    | "Tap an untapped legendary permanent" compiles to `tapOther` without `allowSelf`.                                                  |
| Castle Doom                    | 7644  | chunk-009 | `other-on-self-eligible-cost` | owner backlog                   | "Sacrifice an artifact" can't sacrifice itself if it becomes an artifact.                                                          |
| Slobad, Goblin Tinkerer        | 7676  | chunk-009 | `other-on-self-eligible-cost` | owner backlog                   | Same.                                                                                                                              |
| Hearthhull, the Worldseed      | 7859  | chunk-010 | `other-on-self-eligible-cost` | owner backlog                   | "Sacrifice a land".                                                                                                                |
| Jinxed Idol                    | 9145  | chunk-011 | `other-on-self-eligible-cost` | owner backlog                   | "Sacrifice a creature".                                                                                                            |
| Scion of Opulence              | 10759 | chunk-014 | `other-on-self-eligible-cost` | owner backlog                   | "Sacrifice two artifacts".                                                                                                         |
| Savage Thallid                 | 11169 | chunk-014 | `other-on-self-eligible-cost` | owner backlog                   | "Sacrifice a Saproling" on a Fungus that can become a Saproling (changelings, type-setting).                                       |
| Dark Privilege                 | 11470 | chunk-014 | `other-on-self-eligible-cost` | (new)                           | "Sacrifice a creature: Regenerate enchanted creature" on an Aura that can become a creature.                                       |

The first eleven rows are the same engine gaps that got cards retired in #72's review, so the
evidence for them is already on record. Avacyn and Ideas Unbound are wrong only when the trigger
is created during an end step. The `other-on-self-eligible-cost` rows are wrong only when the source
has gained the cost's type, but the owner has already named seven of them as wrong.

## Cleared on reading (28)

The first pass also flagged these. I read each against its Oracle text and the engine, and none
needs a change. The detectors now exclude these readings.

- **"Triggers only once each turn" with a trigger condition** (Dionus, Elvish Archdruid; Oni-Cult
  Anvil; Suki, Courageous Rescuer). A failed condition means the ability never triggered, so it
  should not use up the once. The engine's order is right here. It is wrong only for "the first
  time each turn" (Fear of Missing Out).
- **`sacrificeAt` on a token copy** (The Fire Crystal; Kiki-Jiki, Mirror Breaker). "Sacrifice it at
  the beginning of the next end step" is a delayed trigger, which is what `sacrificeAt` is.
  Electroduplicate was wrong because its token has the sacrifice as a quoted ability.
- **`putCountersEach` on one permanent or with a stable amount** (Power Fist, Strength of Will,
  Siegfried, Heroes' Bane, Black Sun's Zenith, Southern Air Temple). Re-evaluating the amount for
  each permanent can't change the result.
- **Blinking "up to one target"** (Scrollshift, Flickering Hound, Meneldor). One card can't be moved
  sequentially. Scrollshift's merged definition draws once.
- **"Whenever you attack" targeting an attacker, or counting attackers on resolution** (Gimli's
  Reckless Might, Urdnan, Marshal of the Lost). These don't refer to "those creatures", so reading
  the current attackers is right.
- **Becoming an "artifact creature" when already an artifact** (Tough Cookie, Guardian Idol, Dimir
  Keyrune). CR 205.1b keeps the prior types, and the text sets the P/T.
- **"Is a [color] [type] creature" Auras** (Frogify, Amphibian Downpour, Eaten by Piranhas,
  Reprobation). CR 205.1a: setting the card type replaces the old types and drops their subtypes,
  so losing land subtypes is right.
- **Tokens "attacking that player"** (Soaring Lightbringer). The defender is named explicitly.
- **Felonious Rage.** A targeted "when that creature dies" delayed trigger isn't the broken case.
- **Gaea's Touch.** A basic Forest card is always a permanent.
- **Replicating Ring.** "Remove all of them and create" doesn't depend on the removal.

## Facet-only flags (315)

These cards have only a facet mismatch, with no shape hit. I hand-checked the intervening-if (25)
and target-count (24) groups:

- **Intervening-if:** benign. "During your turn" and "attacks you" are trigger conditions stored on
  `trigger.condition`. The engine rechecks that field on resolution (`stack.ts:44`), but the turn
  can't change while the trigger waits on the stack, and `eventObjectDefendingPlayerIsYou` reads
  last-known information (`condition.ts:486`). The rest of this group come from the text counter
  missing an ", if" after an ability word, or from lines the patch doesn't touch.
- **Target count:** benign. "Two target X" is two slots in the IR, and every one is marked
  `differentFromSlots`. "Divided among one or two targets" and "When … and whenever …" triggers are
  counting differences.

The `optional` (109), `untilEndOfTurn` (91) and `other` (86) groups are not reviewed. Given the
results above, I expect most of them to be counting differences.

<details>
<summary>All 315 facet-only cards</summary>

- Entish Restoration (rank 456): optional (text 0, IR 2)
- Overwhelming Stampede (rank 515): untilEndOfTurn (text 1, IR 2)
- Open the Armory (rank 634): optional (text 0, IR 1)
- Muddle the Mixture (rank 703): optional (text 0, IR 1)
- Tyvar's Stand (rank 709): untilEndOfTurn (text 1, IR 3)
- Riveteers Overlook (rank 712): optional (text 0, IR 1)
- Evendo, Waking Haven (rank 857): other (text 0, IR 2)
- Ayara, First of Locthwain (rank 864): other (text 1, IR 2)
- Kappa Cannoneer (rank 885): other (text 0, IR 1), untilEndOfTurn (text 0, IR 1)
- Cabaretti Courtyard (rank 966): optional (text 0, IR 1)
- Cruel Celebrant (rank 972): other (text 0, IR 1)
- Angel of the Ruins (rank 985): optional (text 0, IR 1)
- Steelshaper's Gift (rank 1004): optional (text 0, IR 1)
- Force of Vigor (rank 1005): optional (text 1, IR 0)
- Krosan Verge (rank 1018): optional (text 0, IR 2)
- Yahenni, Undying Partisan (rank 1037): other (text 1, IR 2)
- Spellseeker (rank 1050): optional (text 1, IR 2)
- Triumph of the Hordes (rank 1165): untilEndOfTurn (text 1, IR 3)
- The Shire (rank 1175): other (text 0, IR 1)
- Uthros, Titanic Godcore (rank 1214): other (text 0, IR 2)
- Maestros Theater (rank 1284): optional (text 0, IR 1)
- Bulk Up (rank 1372): untilEndOfTurn (text 1, IR 0)
- Fake Your Own Death (rank 1422): untilEndOfTurn (text 1, IR 2)
- Monumental Henge (rank 1454): optional (text 1, IR 0)
- Misdirection (rank 1458): optional (text 1, IR 0)
- Natural Order (rank 1505): other (text 0, IR 1), optional (text 0, IR 1)
- Uro, Titan of Nature's Wrath (rank 1599): optional (text 1, IR 0)
- Unmarked Grave (rank 1611): optional (text 0, IR 1)
- Traverse the Outlands (rank 1646): optional (text 0, IR 1)
- Gleaming Splendor (rank 1692): targetCount (text 1, IR 2)
- Obscura Storefront (rank 1702): optional (text 0, IR 1)
- Supernatural Stamina (rank 1741): untilEndOfTurn (text 1, IR 2)
- Insurrection (rank 1791): untilEndOfTurn (text 2, IR 1)
- Cycle of Renewal (rank 1833): optional (text 0, IR 1)
- Loran's Escape (rank 1848): untilEndOfTurn (text 1, IR 2)
- Sword of Forge and Frontier (rank 1855): untilEndOfTurn (text 0, IR 1)
- Cryptbreaker (rank 1878): other (text 0, IR 1)
- Bitterthorn, Nissa's Animus (rank 1890): optional (text 1, IR 2)
- Crystal Skull, Isu Spyglass (rank 1978): optional (text 1, IR 0)
- Trinket Mage (rank 2042): optional (text 1, IR 2)
- Fierce Empath (rank 2139): optional (text 1, IR 2)
- Jaya's Immolating Inferno (rank 2227): targetCount (text 0, IR 1)
- Explorer's Scope (rank 2232): optional (text 1, IR 0)
- Blacksmith's Skill (rank 2269): untilEndOfTurn (text 2, IR 3)
- Ancestral Mask (rank 2284): other (text 1, IR 2)
- Trophy Mage (rank 2324): optional (text 1, IR 2)
- Korvold, Fae-Cursed King (rank 2357): other (text 1, IR 2)
- Wavebreak Hippocamp (rank 2401): interveningIf (text 0, IR 1)
- Ezuri, Renegade Leader (rank 2402): untilEndOfTurn (text 1, IR 2)
- Force of Despair (rank 2412): optional (text 1, IR 0)
- Weatherlight (rank 2468): optional (text 1, IR 0)
- Valley Rotcaller (rank 2499): other (text 1, IR 2)
- Merchant Scroll (rank 2512): optional (text 0, IR 1)
- The Earth King (rank 2533): optional (text 0, IR 1)
- Dionus, Elvish Archdruid (rank 2543): interveningIf (text 0, IR 1)
- Final Parting (rank 2611): optional (text 0, IR 1)
- Step Through (rank 2661): optional (text 0, IR 1), targetCount (text 1, IR 2)
- Murkfiend Liege (rank 2664): other (text 2, IR 3)
- Troll of Khazad-dûm (rank 2733): optional (text 0, IR 1)
- Raging Ravine (rank 2760): untilEndOfTurn (text 1, IR 2)
- Persistent Constrictor (rank 2771): interveningIf (text 0, IR 1)
- Drift of Phantasms (rank 2804): optional (text 0, IR 1)
- Heaped Harvest (rank 2844): optional (text 1, IR 4)
- Revenge of Ravens (rank 2880): interveningIf (text 0, IR 1)
- Ulvenwald Tracker (rank 2934): other (text 1, IR 0)
- Spectacular Spider-Man (rank 2980): untilEndOfTurn (text 2, IR 3)
- Creeping Tar Pit (rank 3065): untilEndOfTurn (text 1, IR 2)
- Ravenous Squirrel (rank 3099): other (text 0, IR 1)
- Inferno Titan (rank 3131): targetCount (text 0, IR 2)
- Celestial Armor (rank 3151): untilEndOfTurn (text 1, IR 2)
- Strength of Will (rank 3168): untilEndOfTurn (text 1, IR 2)
- Ogre Battledriver (rank 3237): untilEndOfTurn (text 1, IR 2)
- Rampant Rejuvenator (rank 3251): optional (text 0, IR 1)
- Goblin Chirurgeon (rank 3255): other (text 0, IR 1)
- Karametra, God of Harvests (rank 3571): optional (text 1, IR 2)
- Dark Petition (rank 3678): optional (text 0, IR 1)
- Heliod's Pilgrim (rank 3759): optional (text 1, IR 2)
- Arbaaz Mir (rank 3837): other (text 0, IR 1)
- Rite of Oblivion (rank 3843): other (text 0, IR 1)
- Sigarda, Font of Blessings (rank 3857): optional (text 1, IR 0)
- Extinguisher Battleship (rank 3874): other (text 0, IR 2)
- Count on Luck (rank 3921): untilEndOfTurn (text 0, IR 1)
- Tiamat (rank 4018): optional (text 0, IR 1)
- Cori-Steel Cutter (rank 4037): untilEndOfTurn (text 0, IR 1)
- Zur the Enchanter (rank 4043): optional (text 1, IR 2)
- Merfolk Sovereign (rank 4074): untilEndOfTurn (text 0, IR 1)
- Murderous Redcap (rank 4105): interveningIf (text 0, IR 1)
- Tail Swipe (rank 4151): other (text 1, IR 0)
- Mothdust Changeling (rank 4322): other (text 0, IR 1)
- Planar Bridge (rank 4436): optional (text 0, IR 1)
- Brightglass Gearhulk (rank 4458): optional (text 1, IR 2)
- Gimli's Reckless Might (rank 4473): interveningIf (text 0, IR 1)
- Scampering Surveyor (rank 4500): optional (text 0, IR 1)
- Azami, Lady of Scrolls (rank 4542): other (text 0, IR 1)
- Angelic Skirmisher (rank 4555): untilEndOfTurn (text 1, IR 3)
- Glacier Godmaw (rank 4666): untilEndOfTurn (text 1, IR 3), optional (text 0, IR 1)
- Ancestral Anger (rank 4680): untilEndOfTurn (text 1, IR 2)
- Magma Opus (rank 4773): targetCount (text 1, IR 3)
- Biosynthic Burst (rank 4780): untilEndOfTurn (text 1, IR 3)
- The Odd Acorn Gang (rank 4793): untilEndOfTurn (text 1, IR 2)
- Open the Gates (rank 4803): optional (text 0, IR 1)
- Stonehoof Chieftain (rank 4812): untilEndOfTurn (text 1, IR 2)
- Aligned Heart (rank 4923): untilEndOfTurn (text 0, IR 1)
- Dauntless Scrapbot (rank 4979): optional (text 0, IR 1)
- Gift of Estates (rank 5020): optional (text 0, IR 1)
- Traverse the Ulvenwald (rank 5064): optional (text 0, IR 2)
- Pyrokinesis (rank 5117): optional (text 1, IR 0)
- South Pole Voyager (rank 5130): other (text 0, IR 1)
- Transit Mage (rank 5191): optional (text 1, IR 2)
- Time of Need (rank 5219): optional (text 0, IR 1)
- Silverclad Ferocidons (rank 5247): other (text 0, IR 1)
- Dimir Infiltrator (rank 5252): optional (text 0, IR 1)
- Squirrel Mob (rank 5307): other (text 1, IR 2)
- Turtle Lair (rank 5317): untilEndOfTurn (text 0, IR 1)
- Final Vengeance (rank 5323): other (text 0, IR 1)
- Progenitor Mimic (rank 5367): interveningIf (text 0, IR 1), optional (text 1, IR 0)
- Al Bhed Salvagers (rank 5382): other (text 0, IR 1)
- Far Wanderings (rank 5486): optional (text 0, IR 2)
- The Thirteenth Doctor (rank 5530): other (text 1, IR 0)
- Elemental Eruption (rank 5545): untilEndOfTurn (text 0, IR 1)
- Garruk Wildspeaker (rank 5613): untilEndOfTurn (text 1, IR 2), targetCount (text 1, IR 2)
- Radioactive Spider (rank 5618): optional (text 0, IR 1)
- Dreadmaw's Ire (rank 5632): untilEndOfTurn (text 1, IR 3)
- Jarad's Orders (rank 5639): optional (text 0, IR 1)
- Soldevi Adnate (rank 5657): other (text 0, IR 1)
- Gene Pollinator (rank 5678): other (text 0, IR 1)
- Go-Shintai of Boundless Vigor (rank 5694): optional (text 0, IR 1)
- Dizzy Spell (rank 5754): optional (text 0, IR 1)
- Fanatical Devotion (rank 5780): other (text 0, IR 1)
- Copycrook (rank 5792): optional (text 1, IR 0)
- Thorn Mammoth (rank 5800): other (text 0, IR 1)
- Boundless Realms (rank 5824): optional (text 0, IR 1)
- Nymris, Oona's Trickster (rank 5884): interveningIf (text 0, IR 1)
- Distortion Strike (rank 5887): untilEndOfTurn (text 1, IR 2)
- Itzquinth, Firstborn of Gishath (rank 5892): other (text 1, IR 0), optional (text 0, IR 1)
- Gatecreeper Vine (rank 5896): optional (text 1, IR 2)
- Muster the Departed (rank 5936): interveningIf (text 0, IR 1)
- Sakashima's Protege (rank 5957): optional (text 1, IR 0)
- Cosmic Hunger (rank 5978): other (text 1, IR 0)
- Lava Dart (rank 6011): other (text 0, IR 1)
- Abjure (rank 6044): other (text 0, IR 1)
- Kavaron, Memorial World (rank 6066): other (text 0, IR 3), untilEndOfTurn (text 1, IR 2)
- Woodland Bellower (rank 6151): optional (text 1, IR 2)
- Oni-Cult Anvil (rank 6185): other (text 0, IR 1), interveningIf (text 0, IR 1)
- Sojourner's Companion (rank 6255): optional (text 0, IR 1)
- Suki, Courageous Rescuer (rank 6269): interveningIf (text 0, IR 1)
- Goblin Grenade (rank 6296): other (text 0, IR 1)
- Winged Hive Tyrant (rank 6341): other (text 1, IR 2)
- Prismatic Undercurrents (rank 6347): optional (text 0, IR 1)
- Assassin Initiate (rank 6392): untilEndOfTurn (text 1, IR 3)
- Maelstrom Archangel (rank 6406): optional (text 0, IR 1)
- Galvanic Discharge (rank 6430): optional (text 0, IR 1)
- Thunderous Velocipede (rank 6522): other (text 1, IR 2)
- Layla Hassan (rank 6705): targetCount (text 1, IR 2)
- Titanic Ultimatum (rank 6747): untilEndOfTurn (text 1, IR 4)
- Rust Elemental (rank 6754): other (text 1, IR 2)
- Run Amok (rank 6798): untilEndOfTurn (text 1, IR 2)
- Spider-Man, Miles Morales (rank 6858): other (text 1, IR 4), untilEndOfTurn (text 1, IR 2)
- Dimir Keyrune (rank 7001): untilEndOfTurn (text 1, IR 2)
- Electrolyze (rank 7028): targetCount (text 0, IR 1)
- Voracious Tome-Skimmer (rank 7101): interveningIf (text 0, IR 1)
- Search the Premises (rank 7129): interveningIf (text 0, IR 1)
- Sliver Overlord (rank 7147): optional (text 0, IR 1)
- Baxter, Fly in the Ointment (rank 7174): untilEndOfTurn (text 1, IR 2)
- Sokka, Lateral Strategist (rank 7216): other (text 1, IR 0)
- Craterclaw Colossus (rank 7299): untilEndOfTurn (text 1, IR 2)
- Larval Scoutlander (rank 7301): other (text 0, IR 2), optional (text 1, IR 2)
- Dark-Dweller Oracle (rank 7317): other (text 0, IR 1), untilEndOfTurn (text 0, IR 1)
- Glarb, Calamity's Augur (rank 7348): optional (text 1, IR 0)
- Ondu Cleric (rank 7373): other (text 0, IR 1)
- Kyoshi Island Plaza (rank 7413): optional (text 0, IR 2)
- Necklace of Girion (rank 7448): targetCount (text 1, IR 2)
- Lesser Masticore (rank 7469): interveningIf (text 0, IR 1)
- Gruul Ragebeast (rank 7508): other (text 0, IR 1)
- Hraesvelgr of the First Brood (rank 7549): untilEndOfTurn (text 1, IR 4), targetCount (text 1, IR 2)
- Vampire Gourmand (rank 7565): untilEndOfTurn (text 0, IR 1)
- Hexhaven Invigorator (rank 7647): optional (text 1, IR 2)
- Return to Action (rank 7664): untilEndOfTurn (text 1, IR 3)
- Pym Particles (rank 7730): untilEndOfTurn (text 1, IR 2)
- Emergency Eject (rank 7795): optional (text 0, IR 1)
- Footfall Crater (rank 7908): untilEndOfTurn (text 1, IR 2)
- Heroic Reinforcements (rank 7921): untilEndOfTurn (text 1, IR 2)
- Goblin Bushwhacker (rank 7952): untilEndOfTurn (text 1, IR 2)
- Wedding Invitation (rank 7974): untilEndOfTurn (text 1, IR 2)
- Conflux (rank 8020): optional (text 0, IR 5)
- Ashnod's Intervention (rank 8117): untilEndOfTurn (text 1, IR 2)
- Slick Sequence (rank 8155): other (text 1, IR 0)
- Demonic Gifts (rank 8393): untilEndOfTurn (text 1, IR 2)
- Bogardan Hellkite (rank 8456): targetCount (text 0, IR 1)
- Sewer-veillance Cam (rank 8484): optional (text 1, IR 2), targetCount (text 1, IR 2)
- Lodestone Myr (rank 8494): other (text 0, IR 1)
- Pinnacle Kill-Ship (rank 8506): other (text 0, IR 2)
- Sigil of Valor (rank 8547): other (text 1, IR 2)
- Mr. Orfeo, the Boulder (rank 8595): untilEndOfTurn (text 1, IR 0)
- District Guide (rank 8617): optional (text 1, IR 2)
- Xyris, the Writhing Storm (rank 8653): interveningIf (text 0, IR 1)
- Karametra's Blessing (rank 8664): untilEndOfTurn (text 2, IR 3)
- Marit Lage's Slumber (rank 8678): other (text 0, IR 1)
- Moggcatcher (rank 8680): optional (text 0, IR 1)
- Master Piandao (rank 8685): optional (text 1, IR 0)
- Shifting Ceratops (rank 8734): untilEndOfTurn (text 1, IR 3)
- Dragonspark Reactor (rank 8750): other (text 0, IR 1)
- Ranger of Eos (rank 8785): optional (text 1, IR 2)
- Colossal Plow (rank 8794): untilEndOfTurn (text 1, IR 0)
- Practiced Offense (rank 8811): untilEndOfTurn (text 1, IR 2)
- Isperia, Supreme Judge (rank 8842): interveningIf (text 0, IR 1)
- Devout Chaplain (rank 8940): other (text 0, IR 1)
- Break Down (rank 8956): untilEndOfTurn (text 0, IR 1)
- Ashroot Animist (rank 8992): untilEndOfTurn (text 1, IR 2)
- Kothophed, Soul Hoarder (rank 8995): other (text 1, IR 0)
- Nimbleclaw Adept (rank 8996): other (text 1, IR 2), targetCount (text 1, IR 2)
- Abnormal Endurance (rank 9031): untilEndOfTurn (text 1, IR 2)
- Sight of the Scalelords (rank 9092): untilEndOfTurn (text 1, IR 2)
- Dwarven Bloodboiler (rank 9095): other (text 0, IR 1)
- Deadeye Quartermaster (rank 9101): optional (text 1, IR 2)
- Wren's Run Hydra (rank 9113): targetCount (text 0, IR 1)
- Boon-Bringer Valkyrie (rank 9154): untilEndOfTurn (text 0, IR 3), targetCount (text 0, IR 1)
- Argothian Elder (rank 9318): targetCount (text 1, IR 2)
- Network Terminal (rank 9321): other (text 1, IR 2)
- Circle of Flame (rank 9354): interveningIf (text 0, IR 1)
- Hell's Caretaker (rank 9367): other (text 0, IR 1)
- Experimental Synthesizer (rank 9395): untilEndOfTurn (text 1, IR 2)
- Kudo, King Among Bears (rank 9428): other (text 1, IR 2)
- Grove of the Guardian (rank 9469): other (text 0, IR 1)
- Micromancer (rank 9492): optional (text 1, IR 2)
- Seedship Impact (rank 9527): optional (text 0, IR 1)
- Kamahl, Fist of Krosa (rank 9529): untilEndOfTurn (text 2, IR 3)
- Raiders' Karve (rank 9630): optional (text 1, IR 0)
- Falkenrath Pit Fighter (rank 9678): other (text 0, IR 1)
- Dragonstorm (rank 9691): optional (text 0, IR 1)
- Warmaker Gunship (rank 9706): other (text 0, IR 2)
- Gaea's Touch (rank 9714): optional (text 1, IR 0)
- Voice of Resurgence (rank 9750): interveningIf (text 0, IR 1)
- Citanul Stalwart (rank 9776): other (text 0, IR 1)
- Yorvo, Lord of Garenbrig (rank 9829): other (text 2, IR 1)
- Three Dreams (rank 9887): optional (text 0, IR 1)
- Tolarian Kraken (rank 10001): optional (text 1, IR 2)
- Brineborn Cutthroat (rank 10133): interveningIf (text 0, IR 1)
- Blizzard Brawl (rank 10137): other (text 1, IR 0), untilEndOfTurn (text 1, IR 2)
- Brazen Collector (rank 10217): untilEndOfTurn (text 1, IR 0)
- Ragged Playmate (rank 10287): untilEndOfTurn (text 0, IR 1)
- Infuse with Vitality (rank 10289): untilEndOfTurn (text 1, IR 2)
- Patron Wizard (rank 10322): other (text 0, IR 1)
- Bristlebane Battler (rank 10328): interveningIf (text 0, IR 1)
- Riddlekeeper (rank 10347): interveningIf (text 0, IR 1)
- Seedship Agrarian (rank 10392): optional (text 0, IR 1)
- Dross Scorpion (rank 10439): other (text 0, IR 1)
- Skirsdag High Priest (rank 10457): other (text 0, IR 1)
- Sakiko, Mother of Summer (rank 10477): untilEndOfTurn (text 1, IR 0)
- Get a Leg Up (rank 10520): untilEndOfTurn (text 1, IR 2)
- Nature's Way (rank 10528): untilEndOfTurn (text 1, IR 2)
- Galecaster Colossus (rank 10649): other (text 0, IR 1)
- Fall of the Hammer (rank 10670): other (text 1, IR 0)
- Pain 101 (rank 10678): untilEndOfTurn (text 1, IR 2)
- Tend the Sprigs (rank 10686): optional (text 0, IR 1)
- Lunar Frenzy (rank 10702): untilEndOfTurn (text 1, IR 3)
- Commune with the Gods (rank 10712): optional (text 1, IR 0)
- Firemane Avenger (rank 10713): other (text 1, IR 0)
- Liberated Dwarf (rank 10804): untilEndOfTurn (text 1, IR 2)
- Bretagard Stronghold (rank 10810): untilEndOfTurn (text 1, IR 2)
- Shrine Steward (rank 10815): optional (text 1, IR 2)
- Iron Hills Blacksmith (rank 10911): targetCount (text 0, IR 1)
- Enslaved Dwarf (rank 10929): untilEndOfTurn (text 1, IR 2)
- Harvestrite Host (rank 10942): other (text 0, IR 1)
- Brotherhood Spy (rank 10947): untilEndOfTurn (text 1, IR 2)
- Keeper of the Nine Gales (rank 11000): other (text 0, IR 1)
- Bessie, the Doctor's Roadster (rank 11007): untilEndOfTurn (text 0, IR 1)
- Daring Saboteur (rank 11049): untilEndOfTurn (text 0, IR 1)
- Haazda Marshal (rank 11082): other (text 1, IR 0)
- Besmirch (rank 11090): untilEndOfTurn (text 1, IR 2)
- Skybind (rank 11101): other (text 0, IR 1)
- Icingdeath, Frost Tyrant (rank 11102): targetCount (text 1, IR 2)
- Transmogrant's Crown (rank 11105): targetCount (text 1, IR 2)
- Shadow-Rite Priest (rank 11152): optional (text 0, IR 1)
- Pit Fight (rank 11167): other (text 1, IR 0)
- Seahunter (rank 11412): optional (text 0, IR 1)
- Clammy Prowler (rank 11414): untilEndOfTurn (text 0, IR 1)
- Embrace Oblivion (rank 11449): other (text 0, IR 1)
- Thwip! (rank 11700): untilEndOfTurn (text 1, IR 2)
- Scrounge for Eternity (rank 11706): other (text 0, IR 1), optional (text 0, IR 1)
- Sami's Curiosity (rank 11727): optional (text 0, IR 1)
- Jhoira, Ageless Innovator (rank 11734): optional (text 1, IR 0)
- Stinging Cave Crawler (rank 11745): interveningIf (text 0, IR 1)
- Cartel Aristocrat (rank 11793): other (text 1, IR 2)
- April O'Neil, Human Element (rank 11847): targetCount (text 0, IR 1)
- Goblin Cadets (rank 11854): targetCount (text 1, IR 2)
- G'raha Tia (rank 11927): other (text 1, IR 2)
- Corpse Harvester (rank 11938): other (text 0, IR 1), optional (text 0, IR 2)
- Fleshwrither (rank 12029): optional (text 0, IR 1)
- Boomer Scrapper (rank 12113): untilEndOfTurn (text 0, IR 2)
- Saiba Cryptomancer (rank 12124): untilEndOfTurn (text 0, IR 1), targetCount (text 0, IR 1)
- Goblin Tunneler (rank 12126): untilEndOfTurn (text 0, IR 1)
- Forked Bolt (rank 12141): targetCount (text 0, IR 1)
- Underfoot Underdogs (rank 12182): untilEndOfTurn (text 0, IR 1)
- Blood Reckoning (rank 12213): interveningIf (text 0, IR 1)
- Curse-Marred Demon (rank 12265): optional (text 0, IR 1)
- Turntimber Ranger (rank 12297): other (text 0, IR 1)
- Popular Egotist (rank 12329): other (text 1, IR 2)
- Magus of the Order (rank 12399): optional (text 0, IR 1)
- Unwelcome Sprite (rank 12408): interveningIf (text 0, IR 1)
- Atmospheric Greenhouse (rank 12409): other (text 0, IR 2)
- Provisions Merchant (rank 12418): untilEndOfTurn (text 1, IR 2)
- Twin Bolt (rank 12450): targetCount (text 0, IR 1)
- Neverwinter Dryad (rank 12466): optional (text 0, IR 1)
- Tempered in Solitude (rank 12472): untilEndOfTurn (text 0, IR 1)
- Firemind's Foresight (rank 12490): optional (text 0, IR 3)
- Jade Avenger (rank 12498): untilEndOfTurn (text 0, IR 2)
- Recruitment Officer (rank 12502): optional (text 1, IR 0)
- Fortified Beachhead (rank 12531): optional (text 1, IR 0)
- Flare of Faith (rank 12699): untilEndOfTurn (text 2, IR 3)
- Nightmare Sower (rank 12767): interveningIf (text 0, IR 1)
- Felonious Rage (rank 12773): untilEndOfTurn (text 1, IR 2)
- Memorial to Unity (rank 12779): optional (text 1, IR 0)
- Behold the Beyond (rank 12783): optional (text 0, IR 1)
- Twisted Abomination (rank 12786): optional (text 0, IR 1)

</details>

## Owner backlog from #95 section 5 that the sweep does not cover

These need a person to read them. No detector matches their shape yet:

- The Sackville-Bagginses (the inverse "other" case).
- Backup on itself: Boon-Bringer Valkyrie, Saiba Cryptomancer.
- Humility's cross-layer continuation.
- Sigil of Valor under a control change. Its "each other creature" also excludes the equipment
  rather than the equipped creature.
- Jarad's Orders' destination assignment.
- Fleshwrither's hard-coded mana value.
- Turn qualifiers used as intervening-ifs on about nine triggers.
- "Token" missing from some token type lines.

## Phase 2: CI and fuzz

### CI: `Changes / Classify` has recovered

From 2026-11-17 14:53 on, every CI run gets past Classify (runs 448 to 484). Nothing changed in
`.github/workflows/ci.yml` or `.github/actions/engine-changed` after 2026-11-14, so the earlier
failure before the first step was on the runner side, not in the workflow. Today's red runs fail
for other reasons: `CI / Gate` when a pull request has no slow-suite label (by design, ADR 0036), and
one ratchet failure on its own branch. **Not done yet:** no full run on `main` since #72 merged.
That needs a manual `workflow_dispatch`, which spends Actions minutes, so I've left it to the owner.

### Weekly-style fuzz on `main` (48 games, seeds 192 to 239)

```bash
bun run fuzz --from 192 --games 48 --jobs 3
```

5 of 48 failed. Last week's run had 4 of 48 failing.

| Seed               | Failure                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fuzz-200, fuzz-223 | `mana activation state budget exceeded` (the known #46 class)                                                                                                                      |
| fuzz-218           | `mana activation depth budget exceeded` (same family)                                                                                                                              |
| fuzz-203, fuzz-212 | `one turn created more than 1000 objects`, a failure type #46 hasn't seen. No compiled card was in either game. In fuzz-203, Champion of Lambholt's counter trigger ran 271 times. |

There were no wall-clock timeouts this time. #46's runs had them in most weeks. Three random-seat
games reached the 80-turn cap, which fuzz doesn't count against random seats.

**The weekly fuzz barely touches compiled cards.** It plays the committed precon decks, so a
compiled card gets played only if it happens to be in one. Exercising them takes
`--card <name> --card-games N`, which slots the card into every deck. That's the run below.

### One card-game for every compiled card

COMPILED_FUZZ_PLACEHOLDER
