# Multiplayer and diplomacy integration review

Date: 2026-10-27

Scope: [integration plan](../plans/multiplayer-diplomacy-integration.md), main's
[multiplayer plan](../plans/multiplayer-tables.md) and
[ADR 0031](../decisions/0031-multiplayer-tables.md), the
[presentation plan](../plans/server-computed-presentation.md), and the deals branch
`claude/happy-cori-fe78h7` at `b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba`.

The reviewer was launched with no inherited conversation history (`fork_turns: none`) and read
the repository instructions, both source designs and the branch implementation independently.
A broad comparison followed by adversarial source tracing identified the three issues below.
The plan was revised; these are design requirements for future implementation, not claims that
the branch's runtime behavior has been fixed.

## Findings and plan repairs

### Critical: hidden legal options can affect public trust

Source: branch
[`compliance.ts:166`](https://github.com/paulliy/mtgtester/blob/b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba/packages/bot/src/diplomacy/compliance.ts#L166)
scans every legal action to decide whether a party had an opportunity to breach.
[`table.ts:319`](https://github.com/paulliy/mtgtester/blob/b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba/packages/bot/src/diplomacy/table.ts#L319)
uses that result to mark the party `tested`, and
[`table.ts:423`](https://github.com/paulliy/mtgtester/blob/b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba/packages/bot/src/diplomacy/table.ts#L423)
can credit kept trust at deal completion. Trust then feeds
[`value.ts:338`](https://github.com/paulliy/mtgtester/blob/b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba/packages/bot/src/diplomacy/value.ts#L338)
and later negotiation choices.

Consequence: replacing a hidden interaction spell with a non-interaction card, with the same
public hand count and public play, can change trust and subsequent proposals or acceptance.
Redacting the menu or removing a ledger field from frames does not close the derived channel.

Repair: require public-evidence trust for human games, including the ledger bots use internally.
Award no kept credit when temptation cannot be established publicly. Retain the real-cost
minimum/cap and public breach penalties. Version the policy separately from the offline sweep.
D1/D3/D4/D5 must verify paired states with identical public history/actions and randomness but
different unused cards in a non-acting human's hand, through trust completion and subsequent
bot negotiation. Hold bot-private hands fixed so legitimate use of a bot's own information
is not mistaken for a cross-seat leak.

### High: single-player has no table time bank

Source: [ADR 0018](../decisions/0018-single-player-mode.md), decisions 4 and 5, makes the human
provider untimed and gates bot calls while disconnected. D3 precedes multiplayer M4. The first
draft applied prompt caps, bank charging and disconnect expiration without scoping them to
table mode, so its D3 implementation had no compatible production clock policy.

Repair: explicitly separate spectator, single-player and table policies. D3 offers/answers stay
untimed; disconnect freezes the pending choice and bot gate, and reconnect restores it. D4
uses M4's bank, original deadlines and fallback behavior. Development clock `off` also disables
negotiation timers and bank charging. Add distinct elapsed-time and disconnect tests for each mode.

### High: accepted actions need immutable decision-time target facts

Source: branch
[`compliance.ts:36`](https://github.com/paulliy/mtgtester/blob/b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba/packages/bot/src/diplomacy/compliance.ts#L36)
captures visible target relations, and
[`compliance.ts:87`](https://github.com/paulliy/mtgtester/blob/b4f5f16e9b27b0356f637e0c6d9a451fc6d3afba/packages/bot/src/diplomacy/compliance.ts#L87)
captures stack membership. The branch driver captures these before engine processing. Moving
judgment after acceptance without preserving those facts lets subsequent movement, control
changes or resolution change the verdict.

Repair: freeze serializable request-time public target facts, join them to engine-normalized
accepted targets, and discard rejected candidates. Preserve delayed attack acceptance and the
repair exemption. Add regressions for leaving play, changing control, resolved stack targets
and omitted single-option targets. Do not reuse private menu evidence for public trust.

## Compatibility checks

- Deals Phase 1 remains an opt-in offline baseline; Phase 2 maps to D1/D2; human Phase 3 maps to
  D3 and D4 with post-attack windows explicitly deferred; LLM Phase 4 stays deferred.
- D1's pure reducer can proceed alongside M1; runner wiring waits for M1. D3 explicitly waits
  for M1/M2a and presentation P4/P5. D4 waits for M3/M4/M2b; D5 retains M5/M6 exposure and UI gates.
- All proposal sources reuse an extracted pure validate/register-offer transition; the current
  synchronous `offer` method's recipient answering and activation are separate. Human answers
  remain pending, while offline bot adapters can answer immediately. Table commands remain
  seat-bound, serialized, idempotent and distinct from engine action revisions.
- Active deals survive fallback/controller changes, while an absent human makes no new promises.
  Action controllers are not silently changed into negotiation-capable providers.
- Diplomacy RNG streams remain separate from game, bot, fallback and generated-deck streams.
  Rules replay uses accepted actions; diplomacy replay uses committed versioned negotiation events.
- The main-thread post-game reader rebuilds diplomacy from committed events after worker death.
  No live server-restart recovery or live table spectators are promised.
- Default engine streams, AI prompts and bot behavior remain unchanged; off-mode equivalence is
  an implementation acceptance check, not runtime evidence produced by this document review.

## Verification and limits

This is a source/design review. No application run, live multiplayer game, deal sweep or runtime
privacy exploit was executed. The hidden-menu issue is a traced data dependency requiring the
paired-state regression above. The required implementation tests are recorded in the plan.

Follow-up review re-read both revised documents and confirmed that the three findings were
addressed and the source designs still compose. Its remaining recommendations were incorporated:
make the synchronous offer-method split explicit and hold bot-private hands fixed in the
paired-state privacy test. No material design findings remain unaddressed within this scope;
implementation and its release evidence remain future work.

Document checks cover formatting, local Markdown link targets and whitespace.
