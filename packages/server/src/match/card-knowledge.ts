/**
 * The card-traits lookup the heuristic bot plays with (ADR 0043), one per game and shared by every
 * seat. It lives outside `ai/` so a session with heuristic bots only, such as a table or a game
 * running in a browser, never loads the model code.
 */

import type { Engine } from '@mtg/engine';
import type { CardKnowledge } from '@mtg/bot';
import { buildCardKnowledge } from '../ai/card-traits';

const knowledgeByEngine = new WeakMap<object, CardKnowledge>();

/** One card-traits lookup per game, shared by every seat. */
export function knowledgeFor(engine: Engine): CardKnowledge {
  let knowledge = knowledgeByEngine.get(engine);
  if (knowledge === undefined) {
    const defs = typeof engine.cardDefinitions === 'function' ? engine.cardDefinitions() : [];
    knowledge = buildCardKnowledge(defs);
    knowledgeByEngine.set(engine, knowledge);
  }
  return knowledge;
}
