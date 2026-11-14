/**
 * The three prompts of the compiler. Each is split into a fixed prefix (identical for every card,
 * so a provider caches it) and a per-card suffix.
 *
 * - compile: Oracle text + parsed behavior + nearest modeled cards → a JSON patch, or a refusal.
 * - back-translate: the patch alone, descriptions stripped, card name hidden → rules text.
 * - judge: the real Oracle lines beside the back-translation → same or different.
 *
 * The back-translator never sees the Oracle text and the judge never sees the IR, so neither can
 * agree with the compiler by copying it.
 */
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { nearestExamples } from './examples';
import { behaviorOf, stripDescriptions, type CompileTarget } from './lib';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import { buildSchema } from './schema';

export const COMPILE_PREFIX_VERSION = 1;

export function compilePrefix(): string {
  const { text } = buildSchema();
  return `You compile Magic: The Gathering rules text into the card IR of a rules engine.

The engine already parsed most of the card. You are given the rules lines it could NOT parse, and you
write a JSON patch that implements exactly those lines. The patch is merged over the parsed card:
list fields you set (triggers, activatedAbilities, manaAbilities, staticEffects, ruleStatics,
keywords) are APPENDED to the parsed lists; any other field you set replaces the parsed value.

Rules:
1. Output data in the IR below, never code. Use only types, fields and "op"/"kind" values that
   appear in the schema. Builder functions do not exist; write the plain JSON they would produce.
2. Never set identity fields: oracleId, scryfallId, name, typeLine, supertypes, types, subtypes,
   colors, colorIdentity, manaCost, hasUnsupportedCost, power, toughness, loyalty, defense,
   modeled, unmodeledReasons.
3. Model exactly what the line says: every target restriction, "you may", "up to", duration,
   condition, count, and who chooses. If the schema has no way to say part of the line exactly,
   do NOT approximate. Answer "inexpressible" instead. A wrong card is far worse than a missing
   one: the engine halts loudly on an unmodeled card, but silently plays a wrong one.
4. Reminder text in parentheses is explanation, not extra rules.
5. Set each ability's "description" to the Oracle line it implements.
6. Mana costs are ParsedManaCost objects, e.g. {2}{U} is
   {"generic":2,"colored":{"W":0,"U":1,"B":0,"R":0,"G":0},"colorless":0}. Fixed numbers are
   Values like {"kind":"const","n":2}. Copy shapes from the worked examples where they fit.

Answer with ONE JSON object and nothing else, either
  {"status":"compiled","def":{ ...the patch... }}
or
  {"status":"inexpressible","reason":"<the part of the line the schema cannot say, in one sentence>"}

THE IR SCHEMA (TypeScript declarations from the engine source; JSON values must match them):

${text}
`;
}

function cardHeader(target: CompileTarget): string {
  const card = target.card;
  const stats = [
    card.power !== null ? `Power/toughness: ${card.power}/${card.toughness}` : null,
    card.loyalty !== null ? `Loyalty: ${card.loyalty}` : null,
  ].filter((line) => line !== null);
  return [
    `Name: ${card.name}`,
    `Mana cost: ${card.manaCost ?? '(none)'}`,
    `Type line: ${card.typeLine}`,
    ...stats,
    `Oracle text:\n${card.oracleText ?? ''}`,
  ].join('\n');
}

export function compileSuffix(
  target: CompileTarget,
  retry?: { previous: string; issues: string[] },
): string {
  const parsed = behaviorOf(interpretCard(target.card));
  const examples = nearestExamples(target.lines, target.name);
  const exampleText = examples
    .map(
      (example) =>
        `### ${example.name} (${example.typeLine})\n${example.oracleText}\n${JSON.stringify(example.behavior)}`,
    )
    .join('\n\n');
  const retryText =
    retry === undefined
      ? ''
      : `\n\nYOUR PREVIOUS ANSWER WAS REJECTED by the engine's validator.\nPrevious answer:\n${retry.previous}\nValidator issues:\n${retry.issues.map((issue) => `- ${issue}`).join('\n')}\nFix these issues, or answer "inexpressible" if the line cannot be said exactly.`;
  return `WORKED EXAMPLES: modeled cards with similar rules text, and the IR the engine runs for them.

${exampleText}

THE CARD TO COMPILE

${cardHeader(target)}

What the engine already parsed (do not repeat it):
${JSON.stringify(parsed)}

Lines to implement:
${target.lines.map((line) => `- ${line}`).join('\n')}${retryText}

Answer with one JSON object.`;
}

export const BACK_PREFIX = `You read the card IR of a Magic: The Gathering rules engine and write the rules text it implements.

You get the card's type line and a JSON fragment of its behavior. Write the rules text in the style of
Oracle text, one ability per line, and state precisely what the JSON does: every target restriction,
optional choice ("you may", "up to"), duration, condition, count and who chooses. Write what the data
says, not what a real card would probably say: if the data is odd or incomplete, your text should be
odd or incomplete in the same way. Do not guess the card's name; call it "this" where needed.

Conventions of this data: a "manaAbilities" entry with no "costs" field is a "{T}: Add ..." ability.
A target slot of kind "cardInGraveyard" with no "graveyardOwnerScope" means a card in its
controller's own graveyard. A target slot with "random": true is still a target, chosen at random
as the ability is put on the stack. A "costReduction" rule static applies only to spells its
controller casts. A selector "attachedToSource" on an Aura or Equipment is the enchanted or equipped
creature. The selectors of "destroyEach", "exileEach" and "returnToHandEach" only ever match
permanents on the battlefield. A "subtype" in a target filter is a creature type unless the filter
says otherwise. A layer 7 "d" power/toughness change adds to the current values ("gets +1/+1");
only sublayer "b" sets base power and toughness. Write every flag on an effect, for example
"cantRegenerate" as "They can't be regenerated." A value shown as "<text>" was hidden on purpose
(a name or free text): never quote "<text>"; write around it, e.g. "a token" or "this ability".

The data is usually only part of a card. Write only what it contains. Never remark that an
ability, cost, type or line is absent ("this has no equip ability"), and add no notes or
explanations.

Answer with only the rules text.`;

export function backSuffix(target: CompileTarget, def: Partial<CardDefinition>): string {
  return `Type line: ${target.card.typeLine}\n\nBehavior:\n${JSON.stringify(stripDescriptions(def))}`;
}

export const JUDGE_PREFIX = `You compare two versions of Magic: The Gathering rules text and decide whether they mean the same thing in a game.

Text A is the real card's rules text: the lines under test, then the whole card for context. Text B
was written by someone reading a program's data for the lines under test. B may also restate other
lines of the same card (a spell's data covers the whole spell); that is fine when it matches the
whole card. An ability of the whole card that B does not mention is not a difference when it is
outside the lines under test, and a remark in B that something is absent counts only when the
lines under test include that thing. The one exception: when B gives the effect of an instant or
sorcery, it must give every effect the whole card's spell has. Ignore wording, the order of
separate abilities, "this" versus a card name, and reminder text. The order of the steps inside
one ability or spell does matter: "destroy it, then create tokens" and "create tokens, then destroy
it" differ, and so do "sacrifice two lands" and "sacrifice a land, then sacrifice a land". Look for
any difference
that would change what happens in a game: targets, who chooses, optional versus mandatory, amounts,
durations, conditions, timing, zones, and anything present in one but missing from the other.

A restriction is the same only when it allows exactly the same things: "can be spent only on X"
and "can't be spent on Y" differ whenever something is neither X nor Y.

Not differences: "X spells and Y spells cost {1} less" is one ability, so a spell that is both is
reduced once, the same as "spells that are X or Y". A token's name is cosmetic, so a missing or
different token name is not a difference when the token's types, stats and abilities match.
A player can only sacrifice permanents they control, so "sacrifice a nontoken artifact" and
"sacrifice a nontoken artifact you control" are the same.

Answer with ONE JSON object and nothing else:
  {"verdict":"same"} or {"verdict":"different","differences":["<one difference per item>"]}`;

export function judgeSuffix(target: CompileTarget, backTranslation: string): string {
  return `Text A (real card), lines under test:\n${target.lines.join('\n')}\n\nWhole card, for context:\n${target.card.oracleText ?? ''}\n\nText B:\n${backTranslation.trim()}`;
}
