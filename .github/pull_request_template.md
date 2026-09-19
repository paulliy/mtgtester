## Card-modeling evidence

Complete this section for every card whose modeled behavior changes. Use
`docs/guides/card-modeling-and-testing.md`; write `N/A` only with a concrete reason.

- Oracle ID(s):
- Pinned Oracle fixture and SHA-256:
- Verification-manifest clause/scenario IDs:
- Shared primitives or explicit unsupported reason:
- Positive and negative engine tests:
- Cost, targeting, timing, zone-change, and normal cast/activation tests:
- Generated engine-evidence artifact:
- Real frontend/backend viewer scenario:
- Generated viewer assertions and Playwright trace:
- Tested revision and scenario/Oracle hashes:
- Aggregate inventory change:
- Separate gameplay-AI evidence (informational):

## Required checks

- [ ] No `modeled: true`, snapshot, deck membership, mocked UI check, or handwritten pass flag is
      presented as behavioral proof.
- [ ] Unsupported mechanics remain explicitly unsupported.
- [ ] Snapshot changes were inspected before regeneration.
- [ ] Mandatory local checks and CI checks executed; failures, skips, and blockers are listed.
