/**
 * Optional AI refinement of the deterministic archetype tag (ADR 0022 §5, Stage 2).
 *
 * The heuristic classifier in `decks/archetype.ts` is the product; this only polishes its wording,
 * and it is off unless `AI_ARCHETYPE_INFERENCE` says otherwise. Every failure path — disabled,
 * timeout, bad JSON, empty tag, low confidence — returns `null`, and the caller keeps the
 * heuristic tag. This function can make the tag nicer; it can never make it worse or absent.
 *
 * What it is sent is deliberately narrow: the computed feature vector and card *names*. Never
 * full oracle text (a 99-card deck of it is enormous and the features already summarise it), and
 * never the Comprehensive Rules (brief §7.4).
 */

import type { ArchetypeFeatures, ArchetypeResult } from '../decks/archetype';
import type { AiClient } from './client';

interface QueueLike {
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
}

export interface ArchetypeRefinementInput {
  heuristic: ArchetypeResult;
  commanderNames: readonly string[];
  /** Main-deck card names, deduplicated. Trimmed before sending. */
  cardNames: readonly string[];
  colorIdentityName: string;
}

/** Below this the model is telling us it is guessing, and the heuristic is the better answer. */
const MIN_CONFIDENCE = 0.6;

/** A tag is a label, not a sentence. Anything longer is the model narrating. */
const MAX_TAG_LENGTH = 60;

/**
 * Card names sent. A commander deck is 99 singletons and the model does not need all of them to
 * recognise a plan — the feature vector already carries the shape.
 */
const MAX_CARD_NAMES = 60;

/**
 * Validate and clamp a refinement response. Mirrors `validate.ts`'s posture: trust nothing about
 * the shape, and fail closed to `null` rather than passing a half-parsed value onward.
 */
export function validateArchetypeResponse(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as { tag?: unknown; confidence?: unknown };

  if (typeof value.tag !== 'string') return null;
  const tag = value.tag.trim().replace(/\s+/g, ' ');
  if (tag.length === 0 || tag.length > MAX_TAG_LENGTH) return null;

  // A missing confidence is treated as "not confident". The field is the model's own escape
  // hatch for a deck it cannot read, and silently promoting an absent one to certainty would
  // defeat the point of asking.
  if (typeof value.confidence !== 'number' || Number.isNaN(value.confidence)) return null;
  if (value.confidence < MIN_CONFIDENCE) return null;

  return tag;
}

function buildPrompt(input: ArchetypeRefinementInput): { system: string; user: string } {
  const { heuristic } = input;
  const features: Partial<ArchetypeFeatures> = {
    lands: heuristic.features.lands,
    creatures: heuristic.features.creatures,
    instants: heuristic.features.instants,
    sorceries: heuristic.features.sorceries,
    artifacts: heuristic.features.artifacts,
    enchantments: heuristic.features.enchantments,
    averageManaValue: heuristic.features.averageManaValue,
    ramp: heuristic.features.ramp,
    spotRemoval: heuristic.features.spotRemoval,
    boardWipes: heuristic.features.boardWipes,
    cardDraw: heuristic.features.cardDraw,
    tutors: heuristic.features.tutors,
    counterspells: heuristic.features.counterspells,
    stax: heuristic.features.stax,
    ...(heuristic.features.topSubtype !== null
      ? { topSubtype: heuristic.features.topSubtype }
      : {}),
  };

  const system = `You name Magic: The Gathering Commander deck archetypes.
Return ONLY this JSON: {"tag":"<short archetype>","confidence":<0..1>}
The tag is at most 6 words, lowercase except colour/guild names, and describes what the deck DOES
(e.g. "Gruul dragon tribal aggro", "Azorius stax control"). A computed tag is supplied; keep it
unless the card list clearly shows a better one. Set confidence below ${MIN_CONFIDENCE} if unsure —
the computed tag is used whenever you are.`;

  const user = JSON.stringify({
    colorIdentity: input.colorIdentityName,
    commanders: input.commanderNames,
    computedTag: heuristic.tag,
    computedStrategy: heuristic.strategy,
    computedTheme: heuristic.theme,
    features,
    sampleCards: input.cardNames.slice(0, MAX_CARD_NAMES),
  });

  return { system, user };
}

/**
 * Ask the model for a better tag. Returns `null` whenever the heuristic should stand — which is
 * every failure mode, by design.
 */
export async function refineArchetype(
  client: AiClient | null,
  queue: QueueLike,
  input: ArchetypeRefinementInput,
  options: { enabled: boolean },
): Promise<string | null> {
  if (!options.enabled || client === null) return null;

  const { system, user } = buildPrompt(input);
  try {
    const result = await queue.enqueue(() =>
      client.requestDecision(
        {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          estimatedTokens: Math.ceil((system.length + user.length) / 4),
        },
        {
          requestId: `archetype-${input.commanderNames.join('-') || 'deck'}`,
          gameId: 'archetype-inference',
          turn: 0,
          activePlayer: 'P1',
          decidingPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          decisionType: 'general',
          prompt: 'Name this deck archetype.',
          legalActions: [{ id: 0, type: 'nameArchetype', description: 'Return the archetype tag' }],
        },
      ),
    );

    // The client parses into a `DecisionResponse`; the tag rides on the raw response body, so
    // re-parse it rather than hoping a decision-shaped field happens to carry it.
    const parsed: unknown = JSON.parse(result.meta.rawResponse);
    const tag = validateArchetypeResponse(parsed);
    return tag === null || tag === input.heuristic.tag ? null : tag;
  } catch {
    // Import must never fail because a nicety was unavailable.
    return null;
  }
}
