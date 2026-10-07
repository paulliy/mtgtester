# Primitive contract evidence

`bun run test:primitive-contracts --output test-results/primitive-contracts` runs the cases
declared in `scripts/contracts/primitive-contracts.ts` through Vitest. The directory must be
new: captured sources, report, and final manifest cannot overwrite an earlier run. CI retains
these artifacts even when execution fails.

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

The initial registry covers `Effect.removeCounters` for direct effects on ordinary permanent
target slots with fixed nonnegative integer counts. It proves zero removal, exact removal,
removal up to the available count, preservation of other counter kinds, and rejection of an
illegal target. Dynamic amounts, counted targets, nested effects, and modes are outside this
initial scope. Other dependencies are deliberately unregistered; this first receipt cannot
make any complete card eligible by itself.

Primitive eligibility is a prerequisite for future reviewed-card promotion. It does not
replace pinned Oracle clauses, normal casting/activation card scenarios, real viewer
evidence, or the separate gameplay-AI evidence required by the card modeling guide. Legacy
card support is not silently promoted by this mechanism. Broader contract registration and
promotion enforcement remain roadmap work.
