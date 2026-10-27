# Independent multiplayer and deals plan reviews

Date: 2026-10-27

The user requested separate reviews of multiplayer on its own and of the deals/communication
design. Three subagents were launched with no inherited conversation: a multiplayer source-plan
reviewer, a deals source/implementation reviewer, and a communication-flow reviewer. They worked
read-only. The main thread checked the findings against source before editing the plans.

Baseline: main `4888fa39277401d5fb1dfb14fded034c6243adb4`; deals branch
`claude/happy-cori-fe78h7` at `b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba`.
This extends the earlier [integration review](multiplayer-diplomacy-integration-review-2026-10-27.md),
which already recorded the hidden-menu trust, mode-specific clock and request-time-fact repairs.

## Multiplayer findings

### High: a healthy human wait was indistinguishable from a hung worker

M3 specified termination after 30 seconds without a reply, while the runner can legitimately
await a human for longer ([runner.ts](../../packages/server/src/match/runner.ts), provider await)
and M4 permits a substantial decision bank. A game-progress watchdog alone can kill healthy play.

Plan repair: independent 5-second worker health probes with a 30-second unanswered-probe limit,
including responses during human/timer waits. Health messages do not reach players or revise
their views. Stuck synchronous computation still fails the probe. Worker generations fence
late replies; wall-clock game caps remain separate. Test both a long healthy wait and a blocked
worker while another table continues.

### High: worker death had no durable terminal outcome or honest replay limit

The promised main-thread post-game view depended on worker-owned persistence. Current terminal
status/outcome writes run through the runner's `finish`/`recordHalt`, and stored turn snapshots
are playback data, not resumable authoritative state
([games.ts](../../packages/server/src/db/games.ts), `GameRecorder` snapshots). A hard kill can
leave a running row and a partial turn.

Plan repair: commit a start-attempt manifest before worker startup, including approved decks,
key and configuration identity. Fence and stop the worker, then commit a distinct interruption
status/reason before unlocking full views. Preserve a real committed result in a race. Setup
failure has no fabricated engine result; interrupted play exposes only its committed replay
range and is not counted as a win, draw or rules bug. Test setup and mid-turn death, terminal
races, stale frames and readable deck/key/range metadata. ADR 0031 and M3 were updated together.
Follow-up review also required a distinct recoverable typed-validation path: retire its private
attempt, return to `open` with private problems, and reveal no key/replay. Corrected retry uses
one fresh attempt; bot snapshots must be committed before ready. Host abandonment follows the
same terminal fencing/commit discipline as an interruption, with its own reason.

### Medium: action authority, telemetry revisions and reconnect budgets needed explicit fences

The existing [human provider](../../packages/server/src/match/human-provider.ts) validates the
pinned request id/revision; it does not establish which socket currently owns a seat. Meanwhile
M3 described revisions as frame counts, and M4 introduces clock/status updates.

Plan repair: check table/seat/current socket generation before dispatch; retired sockets cannot
act even with a current request pair. Invite-only sockets never receive player frames. Clock,
status and health updates do not stale a pending action. Reconnect retains the original choice,
remaining allowance and consumed grace/budget; repeated reconnects cannot renew them. Add direct
takeover, telemetry and near-grace-limit tests. These clarify the existing authority model.

## Deals and communication findings

### High: an excused attack could become a breach at expiry

The source
[`requiredAttackPower`](https://github.com/paulliy/mtgtester/blob/b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba/packages/bot/src/diplomacy/compliance.ts#L68)
returns zero for an unreachable player, and judgment excuses that declaration. But
[`table.ts`](https://github.com/paulliy/mtgtester/blob/b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba/packages/bot/src/diplomacy/table.ts#L391)
can breach an unmet promise at expiry using `couldAttack`, populated from generic positive
attack pressure. The estimate does not prove target-specific legality.

Plan repair: record public, authoritative target-specific opportunity evidence and the one-shot
outcome; generic creature power is insufficient. The proposed semantics distinguish genuinely
unreachable, deliberately withheld/tapped, later-changed reachability, forced-empty and repaired
declarations. Excused impossibility cannot earn trust or become a delayed false breach. Record
the exact next-declaration clarification in the deals amendment before human release.
External skipped combat creates no declaration/opportunity and does not consume the one-shot;
an unmet obligation eventually ends void unless an earlier publicly proved opportunity was
deliberately withheld. Follow-up review requested this explicit expected outcome.

### Medium: adversarial tests had no measurable release gate

The deals ADR's Phase 3 requested an exploiter and an extraction bound, but the integration plan
only named fixtures. Plan repair: fixed seed/rotation corpora and matched diplomacy/exploiter/
no-deal arms, with every halt/failure reported. Require zero malformed/cooldown activations,
zero private/impossible trust credit, zero LEP above audited credit caps, and zero excess
concession beyond the allowed investment/noise budget in controlled fixtures. Report worst
sequences and paired outcomes with uncertainty; heuristic LEP and small win-rate differences
are not evidence of general strategic safety.
Controlled concession fixtures use independent fixed expected values or a reference oracle,
not the production valuation function as its own expected result.

### Medium: communication lifecycle and definitions needed a complete player contract

Plan repair: [table diplomacy and communication](../plans/table-diplomacy-and-communication.md)
now owns exact vocabulary, public immutable terms, transport receipt versus acceptance,
correlated private command results, one linked counter, replay/resync behavior, closed reasons,
continuation of the parked rules decision and keyboard/narrow-screen acceptance scenarios.

Two proposed reviewer interpretations were corrected against the source: `released` is an
automatic coordinator event, so no manual release command is added; two-party deals bind two
promisors but may name a third living seat as an attack/protection target. That third seat has
no obligation or acceptance right. `noCounter` is the source's stack-target restriction, not a
promise limited to cards with a counterspell effect. Rendered language must say what is enforced.

## Disposition and limits

The [multiplayer plan](../plans/multiplayer-tables.md), its
[proposed ADR](../decisions/0031-multiplayer-tables.md), the new standalone
[deals/communication plan](../plans/table-diplomacy-and-communication.md), and the
[integration plan](../plans/multiplayer-diplomacy-integration.md) contain the proposed repairs.
Source ADR acceptance is not changed, the deals branch is not merged, and runtime code is not
modified. The release scenarios above are future implementation requirements.

Follow-up reviewers re-read the amended multiplayer/ADR and standalone communication/integration
documents. They confirmed the core repairs compose with the source designs; the additional
validation-boundary, skipped-combat and independent-oracle details they requested are incorporated
above. The communication reviewer reported no remaining material findings.

This review used source tracing and document checks, not live games, exploit reproduction or
runtime tests. Formatting, local Markdown links and whitespace are checked for the edited
documents. Runtime fixes and their release evidence remain future implementation work.
