/**
 * Test fixtures: oracle-card builders, deck builders, engine harnesses, and a generator
 * pump for exercising internal flow functions directly (brief §12 — fixture-based rules
 * scenarios are the bulk of engine coverage).
 */
import type { AttackDeclarationSubject, BlockDeclarationSubject, OracleCard, PlayerId } from '@mtg/shared';
import type { CardDefinition } from '../src/cards/definition';
import type { DecisionOutcome, GameGen, PendingDecision } from '../src/decisions';
import { Engine } from '../src/engine';
import type { EngineCardObject, EnginePermanent, EnginePlayerConfig, GameConfig, GameContext } from '../src/state/types';
/** Build an OracleCard with sensible defaults. Oracle id derives from the name. */
export declare function oracle(partial: Partial<OracleCard> & {
    name: string;
}): OracleCard;
export declare const forest: () => OracleCard;
export declare const island: () => OracleCard;
export declare const mountain: () => OracleCard;
export declare const plains: () => OracleCard;
export declare const swamp: () => OracleCard;
export declare const bear: () => OracleCard;
export declare const giantGrowth: () => OracleCard;
export declare const bolt: () => OracleCard;
export declare const doom: () => OracleCard;
export declare const cancel: () => OracleCard;
export declare const divination: () => OracleCard;
/** A legendary creature commander in the given color. */
export declare function commanderFor(color: 'W' | 'U' | 'B' | 'R' | 'G', name: string): OracleCard;
export declare function keywordCreature(name: string, keywords: string, manaCost?: string, pt?: string): OracleCard;
export interface SeatSpec {
    id?: PlayerId;
    commander?: OracleCard;
    commanders?: OracleCard[];
    cards: OracleCard[];
    companion?: OracleCard | null;
}
export declare function seat(spec: SeatSpec, index: number): EnginePlayerConfig;
/** N copies of a card list, expanded. */
export declare function copies(n: number, card: () => OracleCard): OracleCard[];
export declare function gameConfig(seats: SeatSpec[], overrides?: Partial<Omit<GameConfig, 'players'>>): GameConfig;
/** Four seats of `n` Forests each — the minimal do-nothing pod. */
export declare function forestsPod(n?: number): SeatSpec[];
export declare function makeEngine(seats: SeatSpec[], overrides?: Partial<Omit<GameConfig, 'players'>>): Engine;
/** Register (interpret) a card's definition in a live game context. */
export declare function registerDef(ctx: GameContext, card: OracleCard): CardDefinition;
export declare function registerCustomDef(ctx: GameContext, def: CardDefinition): void;
/** Create a card object out of thin air, in the given zone container of its owner. */
export declare function conjure(ctx: GameContext, ownerId: PlayerId, card: OracleCard, zone: 'hand' | 'graveyard' | 'library' | 'exile' | 'command', opts?: {
    isCommander?: boolean;
}): EngineCardObject;
/** Put a permanent straight onto the battlefield (not summoning sick by default). */
export declare function spawn(ctx: GameContext, controllerId: PlayerId, card: OracleCard, opts?: {
    tapped?: boolean;
    summoningSick?: boolean;
    isToken?: boolean;
    isCommander?: boolean;
}): EnginePermanent;
/**
 * Pump an internal generator to completion. `answer` maps surfaced decisions to
 * outcomes; forced decisions resolve automatically; the default picks option 0.
 */
export declare function pump<T>(gen: GameGen<T>, answer?: (decision: PendingDecision, count: number) => DecisionOutcome): {
    value: T;
    decisions: PendingDecision[];
};
export interface ProviderRule {
    when: (request: import('@mtg/shared').DecisionRequest) => boolean;
    then: (request: import('@mtg/shared').DecisionRequest) => import('@mtg/shared').DecisionResponse;
    /** Fire at most once. */
    once?: boolean;
}
/**
 * Answers decisions by the first matching rule; anything unmatched takes the first
 * option (pass / keep / don't attack / don't block — always the conservative default).
 */
export declare class RuleBasedProvider {
    private readonly rules;
    readonly seen: import('@mtg/shared').DecisionRequest[];
    private readonly used;
    constructor(rules: ProviderRule[]);
    decide(request: import('@mtg/shared').DecisionRequest): import('@mtg/shared').DecisionResponse;
}
/**
 * Rule builder: fire when (optionally) the deciding player, prompt, and turn match AND an
 * action matching `option` is on the menu; choose that action. Targets default to the
 * first legal choice per slot; pass a function to pick targets from the request.
 */
export declare function whenChoose(spec: {
    player?: PlayerId;
    prompt?: RegExp | string;
    turn?: number;
    option: RegExp | string;
    targets?: {
        slot: number;
        choice: string;
    }[] | ((req: import('@mtg/shared').DecisionRequest) => {
        slot: number;
        choice: string;
    }[]);
    once?: boolean;
}): ProviderRule;
/** Drive an engine to completion with one provider answering every seat. */
export declare function drive(engine: Engine, provider: RuleBasedProvider): import('@mtg/shared').GameResult;
/**
 * Outcome helper for the batched `declareAttackers` decision (ADR 0023 items 13/14): call
 * `chooseDefender(subjectId, subject)` for every eligible creature and build the resulting
 * per-slot targets in one outcome, the way a real proposer would. Returning `null` declines that
 * creature — which throws instead of silently no-op'ing if the creature can't legally decline
 * (`subject.mustAttack`), since a test that gets this wrong should fail loudly, not produce a
 * declaration the engine would have rejected.
 */
export declare function declareAttacks(decision: PendingDecision, chooseDefender: (subjectId: string, subject: AttackDeclarationSubject) => string | null): DecisionOutcome;
/** `declareAttacks` shorthand: nobody attacks. */
export declare function declareNoAttacks(decision: PendingDecision): DecisionOutcome;
/**
 * Outcome helper for the batched `declareBlockers` decision (ADR 0023 Phase 4) — the
 * blocker-side mirror of `declareAttacks`: call `chooseAttacker(subjectId, subject)` for every
 * eligible blocker and build the resulting per-slot targets in one outcome. Returning `null`
 * declines that blocker — throws instead of silently no-op'ing if it can't legally decline
 * (`subject.mustBlock`).
 */
export declare function declareBlocks(decision: PendingDecision, chooseAttacker: (subjectId: string, subject: BlockDeclarationSubject) => string | null): DecisionOutcome;
/** `declareBlocks` shorthand: nobody blocks. */
export declare function declareNoBlocks(decision: PendingDecision): DecisionOutcome;
/** Outcome helper for the batched `assignCombatDamage` decision (ADR 0023 Phase 4, CR 510.1c-d):
 * supply the exact division as `{ targetId: amount }`. */
export declare function splitDamage(split: Record<string, number>): DecisionOutcome;
/** Outcome helper: pick the option whose description matches. */
export declare function pick(decision: PendingDecision, pattern: RegExp | string): DecisionOutcome;
//# sourceMappingURL=fixtures.d.ts.map