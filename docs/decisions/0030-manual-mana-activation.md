# ADR 0030: Manual mana activation

Status: Accepted

Date: 2026-10-23

Amended by [0031](0031-multiplayer-tables.md): the fallback bot that answers for a missing player at a table sees its seat's menu without manual-mana options. Ordinary bots still never opt in.

The single-player board keeps your lands in a pile you open to see them one by one. Players asked
to tap those lands for mana themselves, as in Arena, instead of leaving every payment to the
engine.

The engine still auto-pays every cost (ADR 0003 decision 4). A player who opts in may also
activate a mana ability at priority (CR 605.3a): it resolves at once, without the stack, and its
mana goes to their pool. The pool is already spent before anything is tapped (`planPayment`), so
the next spell or ability pays from that mana first. Nothing about payment planning changes.

`EnginePlayerConfig.manualMana` (copied to the player state) opts a seat in. The server sets it
for the human seat of a single-player game, in the game config for a fresh game and through
`Engine.enableManualMana` for a prepared Card Test Lab engine. Bots never opt in. Their menus,
prompts and fixed-seed games are unchanged, which is the "explicit player preference" route the
rules-engine constraints allow, rather than offering every player new options and filtering them
in each provider.

For an opted-in player, `computePriorityOptions` appends one `activateManaAbility` option per
distinct set of mana each available mana source can make (`mana/manual.ts`). A painland offers
{C}, {W} and {U}; a Sol Ring offers {C}{C}. The options come last, so the ids of the options
before them do not move. Applying one runs `payManaCost` with a one-source prepared plan and
nothing to buy, so the source's costs, riders (a painland's damage), restrictions, spend
triggers and "whenever tapped for mana" behavior are exactly those of auto-pay. The plan is
re-derived from the board when applied, so a stale or forged choice fails. The event
`manaAbilityActivated` logs it ("adds {G} with Forest").

A source is not offered by hand when its production is only known after its costs are paid (a
`productionSpec` or state-dependent production), or when it can make more than ten different
sets of mana ("two mana in any combination of colors"). Auto-pay still uses those sources.
Mana abilities are offered at priority only, not in the middle of paying a cost.

A priority menu of only passes and mana activations is a quiet window: `isForced` auto-passes
it, as it did before these options existed, and the server's smart-yield auto-pass treats them
the same way. Mana with nothing to spend it on empties at the end of the step, so stopping a
player for it would only add a click. The web board keeps mana activations out of the usual
source flow (no glow, no "Playable now" entry, no pass confirmation). In the open lands pile,
clicking a land that makes one kind of mana taps it; a land with a choice of colors or another
ability shows a mana button for each choice. Floating mana shows in the top bar.

Validation: engine tests for the opt-in, the per-source options, riders, spending floating mana
first, the quiet-window rule and refusing mana a source cannot make; a session test that the
human is offered mana abilities and never stopped for them alone; and the War Room lab spec,
which taps a Forest by hand and pays War Room's {3} from that mana and two more Forests.
