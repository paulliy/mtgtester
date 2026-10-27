# Table diplomacy and communication

Status: Proposed refinements and implementation plan. This does not change an accepted ADR's
status or imply that the branch has been merged.

Date: 2026-10-27

Source: the accepted offline deals design on `claude/happy-cori-fe78h7`, reviewed at
`b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba`, especially its
[deals ADR](https://github.com/paulliy/mtgtester/blob/b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba/docs/decisions/0031-table-diplomacy-and-deals.md),
[shared types](https://github.com/paulliy/mtgtester/blob/b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba/packages/shared/src/diplomacy.ts),
[table](https://github.com/paulliy/mtgtester/blob/b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba/packages/bot/src/diplomacy/table.ts),
[compliance](https://github.com/paulliy/mtgtester/blob/b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba/packages/bot/src/diplomacy/compliance.ts)
and [rendering](https://github.com/paulliy/mtgtester/blob/b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba/packages/bot/src/diplomacy/render.ts).

This document specifies the deal semantics, communication experience and evaluation gates on
their own. [Multiplayer diplomacy integration](multiplayer-diplomacy-integration.md) owns the
session/worker wiring, persistence, RNG, mode-specific clocks and multiplayer dependencies.
The [review record](../reviews/multiplayer-and-deals-plan-review-2026-10-27.md) records the source
findings behind these changes.

## Preserve the source design

Deals remain public, structured, two-party, non-binding and optional. Bots negotiate heuristically
without model calls. The rules engine alone decides which actions are legal. A human may choose
to break a promise; the interface explains the consequence and the server judges the accepted
action. No general chat, private whispers, card-name messages, block pacts or LLM interpretation
are added. Off remains the default.

Exactly two seats can owe promises: the proposer and named counterparty. An obligation's `by`
must be one of them, and its other seat must be living and distinct from `by`. That referenced
seat may be a third player, as when A promises B to attack C. C gains no obligation, acceptance
right or trust record for that deal. Every proposer, including a bot or counter-proposer, uses
the same validate/register transition before answering or activation.

## Terms players can understand

Use one versioned typed contract to generate the composer preview, pending cards, active-deal
summary and replay text. Store immutable accepted terms and the applicable policy/weight version;
a later UI or weight change cannot rewrite what the parties accepted. The server supplies exact
labels and threshold explanations. The browser renders them and collects selections.

| Promise        | Meaning shown to the parties                                                                                                                                                 | Release evidence                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `noAttack`     | The promiser declares no attacker at the named player or a permanent they control. Blocks remain free.                                                                       | Player and planeswalker defenders, ownership/control changes and split attacks are tested.                                                                     |
| `noTarget`     | The promiser chooses no target that is the named player or an applicable permanent, stack object or graveyard card they own or control. Helpful targeting also counts.       | Resolve the branch's controller-only lookup mismatch before exposing the contract; test stolen permanents and graveyards.                                      |
| `noCounter`    | The stack-target restriction from `noTarget`. It can cover targeting a protected stack object with an effect other than a counterspell.                                      | Labels must not promise only "no counterspells"; test the actual supported stack-object scope.                                                                 |
| `attackPlayer` | At the next accepted attack declaration covered by the promise, send the configured share of eligible attack power at the named player, capped by power that can reach them. | Display the configured percentage (50% in the reviewed branch), duration, one-shot status and impossible-attack exception. "In earnest" alone is insufficient. |

Duration is a count of each party's own turns, including the accepting turn for the active party.
Display each party's remaining count separately. A one-sided release must distinguish promises
still owed from promises already released. Keep met, pending, excused and broken one-shot
obligations distinct; color alone cannot express these states.

Leader/threat estimates are public-information heuristics, not rules determinations or actual
win probabilities. Show their public reasons without exposing private evaluator scores, hidden
menus, acceptance noise or unplayed cards.

## Offer and communication lifecycle

The branch's `offer` method combines validation and synchronous answering. Extract a pure
validate/register transition, then let an offline bot adapter answer immediately or let the human
protocol retain the pending offer. Human eligibility must not use the branch's bot-only gate.

| State                          | What a player sees                                                                             | Authority                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Draft                          | Editable terms and their full preview; visible only on that device.                            | Local interaction only.                                                                      |
| Sending                        | A short pending-transport indication with the client command id.                               | Receipt or a socket write is not agreement.                                                  |
| Pending                        | One immutable public offer; proposer sees "awaiting B", recipient sees accept/decline/counter. | Appears only after the server commits registration.                                          |
| Countered                      | Original offer is terminal; one linked replacement needs the original proposer's answer.       | The recipient may counter once. No automatic acceptance, second counter or merging of terms. |
| Accepted                       | The active deal, exact terms and each party's remaining promises.                              | Only a committed answer/activation creates obligations.                                      |
| Declined / expired / withdrawn | One closed card with a typed reason and no new obligation.                                     | A closed offer cannot be accepted by a retry or late answer.                                 |

A bot declining a human offer may issue the single counter; show a new answer card to the human.
A bot answers a human counter immediately. Connected single-player humans are untimed; table
deadlines, banks and disconnect expiry follow the integration plan. Sending, retrying or
reconnecting never restarts a table deadline.

Define a private correlated `diplomacyCommandResult` for command application/rejection, distinct
from the public offer lifecycle. It carries the client command id and a sanitized code such as
`applied`, `invalidTerms`, `staleOffer`, `windowClosed` or `notController`. `applied` means the
command was committed; the separately projected offer state says whether a deal was accepted.
Do not put bot valuation or raw backend exceptions in a rejection.

Bind answers to the immutable offer id and terms version, expected pending recipient/status,
window and current socket authority. The viewing seat's diplomacy revision supports resync;
unrelated display updates cannot change accepted terms or make a still-current offer unanswerable.
Deduplicate under game, seat and client command id across reconnects. A restored view contains one
pending card and its actual state, not a second optimistic copy. Term changes require the linked
counter flow; the original proposer cannot silently edit a pending offer.

There is no first-release manual release/withdraw command. Skip applies to an unused opportunity;
decline applies to an offer addressed to the seat. `withdrawn` is a server lifecycle outcome when
the window/session becomes invalid, with a typed reason. Active promises cannot be revoked by
closing their card or disconnecting.

## Automatic releases and closed states

These are derived coordinator transitions, never arbitrary client declarations:

| Event                                                                | Deal/offer effect                                                                      | Continuation                                                                                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A party becomes the table leader                                     | Release only the other party's side; the new leader still owes its promises.           | Publish `released`, retaining the obligations still in force.                                                              |
| Supported lethal, self-defense or party-left escape                  | Void the deal as specified in the deals ADR; it earns/charges no trust.                | Publish the applicable public `dealEnded` reason.                                                                          |
| Ordinary offer rejection, table deadline or prompted-seat disconnect | Decline/expire that pending offer without a breach or kept credit.                     | Close the window and offer the parked engine decision if the game is still live, subject to its existing disconnect grace. |
| Single-player disconnect                                             | Freeze its pending offer/window and gate bot calls.                                    | Reconnect restores it; elapsed time alone is not a rejection.                                                              |
| Game end, halt, table close or an eliminated negotiating party       | Close pending offers once with the public reason.                                      | Show the terminal view, or resume play among survivors when the game remains live. No promise activates after closure.     |
| Worker interruption or journal failure                               | Stop action/negotiation effects and mark the attempt interrupted with a fixed message. | No uncommitted acceptance is displayed; post-game shows only the committed replay range.                                   |

Define the supported public reason union in shared types, including `deadline`, `disconnected`,
`partyLeft`, `windowClosed`, `gameEnded`, `tableClosed` and `interrupted`. This describes pending
offer closure; do not overload the active-deal `kept/broken/void` reasons with transport failures.
If the table has stopped, never resume the parked engine request. On a live window closure,
resume that request once, with no simultaneous negotiation/action clocks.

One-party release and whole-deal voiding must have different visual and text states. Retain the
immutable public message history when the active projection changes. Log/cursor replay and
resync cannot turn an old pending proposal into a new notification or acceptance.

## Attack promises: feasibility and expiry

The branch has a source-traced contradiction to fix before human release: `requiredAttackPower`
returns zero for an unreachable target and the declaration is excused, but turn-start
`couldAttack` is based only on estimated positive creature power. At expiry that coarse flag
can turn the same unmet promise into a breach. Generic attack pressure is not proof that the
promised player could legally have been attacked.

Track the one-shot obligation's own accepted-declaration identity, target-specific public
reachability evidence and outcome. Use authoritative public legality facts captured before
discretionary choices can erase an opportunity; do not reuse hidden legal menus or the heuristic
`attackPower` estimate as proof. Observe accepted combat boundaries even when the engine resolves
an empty/forced declaration without asking a provider. Keep engine-repaired or other-player
chooser decisions out of the promiser's blame, as required by the integration plan.

Proposed clarification: the first authoritative declaration covered by the promise consumes its
one-shot opportunity. If its target was genuinely unreachable, with no earlier public evidence
that the promiser deliberately withheld a reachable attack, mark the obligation excused. It does
not revive at a later combat; at ordinary deal expiry it contributes the existing `void/unmet`
outcome, with no kept credit, broken trust or breach cooldown. Other live promises continue until
the deal ends. If public evidence establishes a reachable opportunity that the promiser held back
or removed by voluntarily tapping/withholding attackers while the obligation was active, record
a breach once. If no trustworthy
public evidence distinguishes those cases, use the conservative void outcome and give no trust.
Record this clarification in the deals amendment rather than silently changing the contract.

Combat involuntarily skipped by an external effect creates no player-controlled opportunity and does
not consume the one-shot or cause a breach. The obligation can be met at the next covered
declaration; if it remains unmet when the deal expires, end void with no trust credit. An earlier
public reachable opportunity deliberately withheld by the promiser still supports a breach.

Required scenarios: positive-power creatures can never attack the named target; target reachability
changes between combats; the promiser voluntarily taps/holds reachable attackers; combat is skipped
by an external effect; a forced empty declaration is observed; and the first declaration is repaired
or chosen by another player. An excuse must never become trust-farming credit or a later false breach.

## Trust and adversarial evaluation

For human games, use the public-evidence trust policy in the integration plan. The public ledger
and the ledger driving bot negotiation are the same policy; a hidden alternate ledger would still
leak through later answers. Freeze request-time public facts and judge engine-normalized accepted
targets. The offline sweep's legacy policy is a separately versioned compatibility choice.

Replace a vague "exploiter fixtures pass" gate with a reproducible protocol:

1. Commit a corpus covering small-to-large trust farming, hidden-menu variants, adaptive threshold
   probes/counter re-proposals, duplicate/padded/overlapping obligations, chained truces and
   deliberately impossible attack promises. Fix decks, seeds, seat rotations, turn cap and all
   policy/weight versions before the run. Begin with 32 documented seeds and all four seat rotations.
2. Compare paired runs with the same game inputs: normal diplomacy, diplomacy with the exploiter,
   and threat-aware targeting with deals disabled. Record failures and halted games rather than
   dropping them. Report actual seed/rotation coverage, accepted transfers, trust credits, deal
   outcomes, estimated extracted LEP and win outcomes with uncertainty.
3. Require **zero** invariant violations: invalid/padded/cooldown-bypassing offers never activate;
   no credit comes from a private or impossible opportunity; per-party credited LEP is at most
   its positive audited cost capped by stake; cumulative credit exceeds the sum of those caps
   by **0 LEP**. The public ledger, answers and messages are identical in paired hidden-human-hand
   variants with the same public play and fixed bot hands/randomness.
4. Measure concessions beyond the policy's explicitly allowed investment/noise budget separately.
   In controlled public-state fixtures, independently calculate the permitted budget from the
   pinned weights and require **0 LEP** of excess concession. Use fixed expected values or an
   independent reference oracle, not the production evaluator being tested. Do not relabel the intended early
   investment subsidy as a bug or price a new deal without already-active obligations.
5. Publish the worst exploit sequences and paired outcome differences. These LEP scores are the
   heuristic's estimates, not actual win probabilities; a small observed win-rate difference
   does not prove strategic safety. New invariant failures or unpriced concession paths block
   release. Empirical regressions require a documented policy/weight decision and new baseline,
   never a post-hoc removal of bad seeds.

The hard bounds are policy/evidence bounds. Keep the source ADR's acknowledged weaknesses visible:
public board estimates miss hidden combo strength, combat/evasion estimates are crude, and deals
can concentrate pressure on the leader. No claim of game-theoretic non-exploitability is made.

## Interface and release evidence

Before human release, demonstrate all composer and response operations by keyboard alone: edit
parties/terms/duration, inspect the exact summary, send, accept, decline, counter and skip. Move focus
to a newly addressed offer, announce meaningful lifecycle changes and return focus sensibly after
closure. Avoid announcing every countdown tick. Retain readable text states without color, dragging
or access to the public log. Test a narrow viewport and assistive-technology status semantics.

Replay/e2e scenarios must distinguish command receipt from acceptance under latency, retries and
reconnect; show one linked counter; reject a third-party promisor; permit a third-party attack target;
show a one-sided release while the other side remains bound; and show each closed/failure reason
without raw errors. Verify that terminal closure either resumes the one parked rules decision or
shows the terminal game, never both. No draft, unseen menu, internal counter or private valuation
appears in another seat's frames.

Source phases remain the rollout unit: Phase 1 follow-ups fix contract/compliance/evaluation gaps;
Phase 2 adds the durable reducer and spectator communication; Phase 3 adds structured human offers
and this interface evidence; Phase 4 LLM work remains deferred. Multiplayer dependencies, exposure
review and the post-attack-window deferral remain in the integration plan. Resolve the duplicate
ADR 0031 numbering when importing the deals branch; keep this proposal distinct from that accepted
offline design until its amendments are recorded.
