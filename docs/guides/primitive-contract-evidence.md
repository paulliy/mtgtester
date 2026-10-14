# Primitive contract evidence

`bun run test:primitive-contracts --output test-results/primitive-contracts` runs the cases
declared in `scripts/contracts/primitive-contracts.ts` through Vitest. The directory must be
new: captured sources, report, and final manifest cannot overwrite an earlier run. CI retains
these artifacts even when execution fails.

Capture requires a clean Git working tree, including staged, unstaged, and untracked files,
so the recorded tree identifies the bytes being executed. Commit source changes before capturing.

The runner captures the actual test dependency closures, fixtures, all engine sources,
contract registry, runner/reporter/loader, execution configuration, installed framework
bytes, Node runtime identity, and Git tree before running tests. It verifies those inputs
again after execution and binds the report bytes to the manifest. The custom reporter
records each collected case's file and full title path, completion count, retries, repeats,
and final result. A passing assertion in an ordinary JSON report alone is insufficient.

The loader rejects missing required positive or negative cases, duplicated executions,
skips, retries, repeats, failed modules, interrupted runs, malformed documents, incomplete
source captures, and changed sources or reports. Eligibility accepts only a privately
loader-validated context and rechecks freshness when consumed. Changes within an existing
effect discriminator invalidate the evidence just as a new discriminator does.

To include generated primitive prerequisites in the impact report, run:

```sh
bun run card-capabilities --primitive-evidence test-results/primitive-contracts
```

The input may additionally be selected with `--oracle-fixture path` or `--oracle-bulk path`.
Every final IR dependency needs a registered, currently passing contract whose machine
scope accepts that definition. Unregistered dependencies remain experimental and block
eligibility. A proven primitive outside its tested scope also blocks eligibility.

The registry covers `Effect.removeCounters` for direct effects on ordinary permanent
slots with fixed nonnegative integer counts. It also covers eight foundation capabilities:
`CardDefinition`, `CardDefinition.manaCost`, `CardDefinition.spellAbility`, `Ability.spell`,
`Ability.effects`, `ParsedManaCost`, `Effect.gainLife`, and `Value.const`. Their bounded scope
is untargeted Instant/Sorcery spells with at most two fixed life-gain instructions (0–1000)
and a total cost of at most {1}{G}. A complete card within that composition can be
primitive-eligible. Three printed-keyword contracts cover `Keyword.flying`, `Keyword.menace`,
and `Keyword.lifelink` on ordinary nonlegendary 2/2 Creatures costing {0}, with exactly that
one keyword and no other executable behavior. Separate normal-cast combat executions check
ground/reach blocker legality, legal two-blocker versus rejected lone-blocker menace, and
controller life gain versus ordinary damage without lifelink. These deliberately narrow
scopes exclude granted keywords, counters, other faces and mixed abilities; they do not make
the white-black deck's more complex creatures primitive-eligible. Other dependencies remain
unregistered.

The hand-discard composition adds a separate supported branch to six shared foundations
and registers `Ability.targets`, `Effect.revealHandAndDiscard`, `Selector.allOf`,
`Selector.not`, `Selector.type`, and `TargetSpec.player`. Its machine scope is an ordinary
{B} Sorcery with one opponent player target and one reveal-and-discard instruction using
exactly the noncreature/nonland filter. Independent normal casts check reveal, selection by
the caster, the exact discarded object, insufficient mana, Sorcery timing, illegal self
targeting, no eligible cards, and the hand as it exists at resolution. Every capability has
distinct positive and negative executions. This scope accepts Duress's IR without granting
general eligibility to other targeted spells or discard effects.

Primitive eligibility is a prerequisite for future reviewed-card promotion. It does not
replace pinned Oracle clauses, normal casting/activation card scenarios, real viewer
evidence, or the separate gameplay-AI evidence required by the card modeling guide. Legacy
card support is not silently promoted by this mechanism. CI runs `bun run primitive-promotions`
against the base commit for new or changed reviewed declarations. Broader contract
registration remains future work.
