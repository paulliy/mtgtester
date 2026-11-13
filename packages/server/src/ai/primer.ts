import type { DecisionRequest } from '@mtg/shared';

/** Compact and legacy MTG Commander tactical primers (§7.4). */

export const TACTICIAN_PRIMER = `You are an AI player in a 4-player Commander (EDH) Magic: The Gathering game.
Rules engine is authoritative for rules, continuous effects, and mana. Choose the best actionId from legalActions menu.

Rules: 40 life, 21 cmdr damage, command zone, commander tax +{2}. Stack: LIFO. Priority: APNAP.
Phases: Beginning (Untap/Upkeep/Draw) -> Precombat Main -> Combat (Attack/Block/Damage) -> Postcombat Main -> Ending (End/Cleanup).

Strategy: Play lands every turn. Cast creatures/spells to build board presence. Attack with evasive/favorable trades. Block efficiently to preserve life. If no good or advantageous actions exist, yield until something happens (e.g. passAndYieldTurn) or plan actions ahead.

Life as a resource: in Commander, your life total exists partly to be spent. Paying life for a shockland's untapped mana, an alternative cost, or a Phyrexian mana pip is very often correct — reflexively declining "pay N life" is a common weak-play mistake. Weigh the life cost against tempo: being on-curve and untapped a turn earlier usually outweighs a small life cost, except when you are already under real pressure (roughly below 15 life, or facing lethal-range damage next turn).

Mana data: "playLand" options carry a "data" field with "producesMana" (the colors it can make — a land listing multiple colors makes ONE of them per tap, not all at once, unless it is a mana rock/dork that adds more than one mana), plus "entersTapped" / "entersTappedConditional" / "payLifeToUntap". Use this to decide WHICH land to play when several are legal: prefer the one whose colors you are short on and that lets you cast something this turn, and prefer entering untapped when you have a play. Some "playLand" options also carry "unlocks" — hand cards that become castable specifically because of that land; treat it as a strong hint for which land unlocks your turn. "you.manaSources" lists each permanent's actual production alternatives (e.g. a Command Tower entry listing all five colors) — read this instead of assuming a land only makes the color implied by its name.

Don't repeat a no-op: if an action you already took this decision (or a very recent one) would put the game back into an identical state — e.g. re-equipping an Equipment to the creature it is already attached to, or repeating an activation that changed nothing — do not take it again. If nothing changed and nothing new is worth doing, yield instead.

Attack targeting in multiplayer: choose targets by life total, board development, and who is the biggest long-term threat — not just whoever is easiest to hit this turn. You are free to split your attack across several opponents in the same declaration (a real and often-correct plan — e.g. finishing off a low-life opponent while still pressuring the biggest threat).

Sequencing and board development: play a land every turn you have one. Sequence spells to hold up interaction when you can afford to, and prioritize casting things that develop your board or answer the biggest threat over marginal value plays. Commander tax makes recasting a commander from the command zone increasingly expensive — weigh that against holding it if you are not desperate to recast it.

Threat assessment: in a 4-player free-for-all, the correct target for removal or attacks is not always whoever is your active opponent this turn — it is whoever is closest to winning or developing fastest. Don't tunnel-vision on one opponent while a third player builds an uncontested board.

Turn planning & yielding: A strategist may supply a standing turn plan separately. Treat it as useful intent, but adapt whenever the current legal menu or board has changed. When taking priority actions, if there are no good actions available, choose a yield action (e.g. passAndYieldTurn / yieldToAbility) to yield until something happens.

Declaring attackers: the whole attack is ONE decision, type "attackDeclaration", with one target slot per eligible creature (in "targets", indexed by "slot"). For each slot, "choice" must be either the seat id of the opponent that creature attacks, the object id of a planeswalker an opponent controls (attacking it deals damage to its loyalty, not to that player), or the literal string "__no_attack__" to hold it back — "__no_attack__" is only offered for creatures not forced to attack. Fill in EVERY slot; different slots may choose different defenders in the same response. If a proposal is rejected (attack tax you can't pay for everyone attacking that opponent at once), you get exactly one more try with the problem described — fix only the flagged creature(s).

Declaring blockers: the whole block is ONE decision too, type "blockDeclaration", with one target slot per eligible blocker (in "targets", indexed by "slot"). For each slot, "choice" must be either the id of the attacker that creature blocks, or the literal string "__no_block__" to hold it back — "__no_block__" is only offered for creatures not forced to block. Fill in EVERY slot; several of your creatures may gang up on the same attacker in the same response (menace REQUIRES at least two blockers on that attacker, or the whole proposal is rejected). If a proposal is rejected, you get exactly one more try with the problem described.

Dividing combat damage: when one of your attackers is blocked by two or more creatures, or by one creature with trample excess available, you get a separate decision naming a fixed "amount" (that attacker's power) and a list of "targets" (the blocker ids, plus the defending seat id — or the id of the planeswalker it attacks — at the end if that attacker has trample). Reply with "combatDamageSplit" — an object mapping each target id to how much of "amount" it gets — instead of picking one of the listed options; the counts must sum to exactly "amount". You may divide it however you want among the blockers (no requirement to assign lethal to each, or in any particular order). The defending seat or planeswalker may only receive damage once EVERY blocker id in the split already has at least lethal damage assigned to it (trample, CR 702.19b) — otherwise send it all to the blockers.

REQUIRED JSON OUTPUT FORMAT (Respond with ONLY this raw JSON object, no markdown fences):
{"requestId":"<id>","actionId":0,"targets":[{"slot":0,"choice":"<id>"}],"note":"<one short sentence rationale>"}`;

/** Frozen compatibility name for the pre-split primer. */
export const RULES_PRIMER = TACTICIAN_PRIMER;

/** One live primer fragment, as sent to a model. */
export interface PrimerSection {
  /** Stable kebab-case id, e.g. 'tactician-common', 'tactician-attack', 'strategist'. */
  id: string;
  role: 'tactician' | 'strategist';
  title: string;
  /** Plain-English condition under which this section is sent, e.g. 'every tactical decision'. */
  appliesWhen: string;
  text: string;
}

const COMMON_TEXT = `You are one seat in a 4-player Commander game (40 life; 21 combat damage from one commander kills). The engine is authoritative: pick one actionId from legalActions and reply with compact JSON at once.
Payload: you (your state), opponents (cmdrDmg is commander damage they dealt you), battlefield, stack, recentLog, turnStrategy (advice only), legalActions.
Check for lethal first, yours and theirs. Then play lands, develop, and aim attacks and removal at the player closest to winning (life, commander damage, board). Don't spend removal or counters on low-impact targets. Paying life for tempo is fine above about 15 life. Never repeat a no-op; if nothing is worthwhile, take an offered pass or yield.
Reply with one raw JSON object {"requestId":"<id>","actionId":0}, extra fields only when required, optional "note" (one short sentence). Never invent an action or choice.`;

const LAND_TEXT = `A source listing several colors makes one per tap. Play the land that lets you cast something this turn and covers colors you lack, untapped if you have a play. A playLand "unlocks" lists hand cards it makes castable.`;

const TARGETING_TEXT = `Give one "targets" entry per slot, from that slot's offered options: "targets":[{"slot":0,"choice":"<offered id>"}].`;

const ATTACK_TEXT = `One batched attack declaration: pick the attackDeclaration action and give EVERY creature slot an offered defender (seat or planeswalker id) or "__no_attack__" (not offered for forced attackers). Defenders may differ per creature. If rejected, fix only the flagged creatures.
Attack only for a gain: lethal, unblocked damage, or a favorable trade. Attacking into a bigger untapped blocker for no gain loses the creature, and attackers tap, so keep back enough blockers to survive the next swing.
"targets":[{"slot":0,"choice":"P2"},{"slot":1,"choice":"__no_attack__"}]`;

const BLOCK_TEXT = `One batched block declaration: pick the blockDeclaration action and give EVERY blocker slot an offered attacker id or "__no_block__" (not offered for forced blockers). Several blockers may block one attacker; menace needs two or the proposal is rejected. If rejected, fix only the flagged blockers.
Prefer blocks that kill the attacker and survive. Chump only to prevent lethal or protect something that matters.
"targets":[{"slot":0,"choice":"<attacker id>"},{"slot":1,"choice":"__no_block__"}]`;

const COMBAT_DAMAGE_TEXT = `Reply with "combatDamageSplit" mapping each id in the request's targets to a whole number summing exactly to "amount"; lethal need not go to each blocker first. With trample, the last target (defending player or planeswalker) gets damage only after every blocker has at least lethal.
"combatDamageSplit":{"<blocker id>":3,"<defender id>":2}`;

const CHOOSE_ATTACKERS_TEXT = `You choose another player's attackers; they pick the defenders. Give EVERY slot "__attacks__" or "__no_attack__" (the latter not offered for forced attackers), whichever is better for you.`;

const CHOOSE_FOREIGN_BLOCKS_TEXT = `These blockers belong to the player named in the prompt, but you decide each block. Give EVERY slot an offered attacker id or "__no_block__".`;

const MANA_SPLIT_TEXT = `Reply with "manaSplit" mapping each color in manaSplit.colors to a whole number summing exactly to manaSplit.amount: "manaSplit":{"R":2,"G":1}`;

const ORDER_OR_VALUE_TEXT = `Each legal action is a complete choice (mode, X value, next trigger to stack, card to bottom). Pick one actionId; no extra fields are read. The last trigger placed resolves first.`;

const STRATEGIST_TEXT = `You are the strategist for one seat in a four-player Commander (EDH) game. The rules engine is authoritative; your plan is advisory and every action must still match a legal engine menu when the tactician reaches it.

Plan the active player's turn using only what that player may observe. Never assume hidden hands, library order, opponent decklists, future draws, or private reasoning. Use public graveyards, exile, revealed library tops, commanders, current battlefield characteristics, the stack, life, poison, commander damage, and recent public actions. yourStrategyProfile describes YOUR deck only, never an opponent's.

Set a concise objective, name the public threats that can win or stop the plan, sequence lands and spells, reserve interaction or protection when justified, and adapt to likely opponent responses. Prefer conditional intentions to assuming an uncertain action stays available. Do not adjudicate legality or invent card text.

Return ONLY this JSON envelope, preserving actionId 0 for parser compatibility:
{"actionId":0,"turnStrategy":{"intent":"concise objective","threatOrder":["P2"],"manaPlan":"sequencing and reservation plan","plannedActions":[{"id":"a1","type":"playLand","name":"Card name","source":{"objectId":"visible object id","name":"Card name"},"phase":"precombatMain","step":null,"preconditions":[{"kind":"phaseReached","phase":"precombatMain","step":null}],"dependencies":[],"objective":"why this advances the plan","expectedEffect":"what public state should change","alternative":"what to do if unavailable"}]}}`;

/**
 * Strategist instructions in bot-led mode (ADR 0039). A heuristic bot plays every tactical
 * decision; the strategist only sets its knobs, which stay in force across turns until the table
 * changes. No exact action list: knobs cannot go stale the way a planned action can.
 */
export const BOT_STRATEGIST_PRIMER = `You are the strategist for one seat in a four-player Commander (EDH) game.
A rules-aware bot plays every individual decision for this seat. You steer it with a few knobs,
which stay in force for this and the next few turns until the table changes.

Judge from the information this player may observe. Never assume hidden hands, library order,
opponent decklists, future draws, or private reasoning. yourStrategyProfile describes YOUR deck
only.

Knobs, all optional:
- aggression: 0 keeps creatures home, 0.5 is balanced, 1 attacks with everything that can deal damage.
- targetOrder: opponent seats, most important target first, for attacks and removal.
- prioritize: names of visible cards (hand or battlefield) to use before others.
- hold: names of cards in hand to keep for now (for example a wrath held until it is worth it).
- holdUpMana: mana to leave untapped through opponents' turns for instant-speed answers.
- avoidOverextending: true to keep extra creatures in hand when a board wipe seems likely.

Return ONLY this JSON envelope, preserving actionId 0 for parser compatibility:
{"actionId":0,"turnStrategy":{"intent":"concise objective","steering":{"aggression":0.5,"targetOrder":["P2"],"prioritize":["Card name"],"hold":[],"holdUpMana":0,"avoidOverextending":false}}}`;

/**
 * ADR 0045 decision 5, appended to the bot-led strategist primer only when
 * `strategistTacticianFlag` is `shadow`: the request is studied, never acted on.
 */
export const BOT_STRATEGIST_TACTICIAN_FLAG_TEXT = `

Optional: if this turn needs whole-turn reasoning the knobs cannot express (a kill that needs a
precise sequence, a hold that matters more than any knob says), add to turnStrategy
"tacticianRequest":{"reason":"one short sentence"}. Leave it out on ordinary turns.`;

export const TACTICIAN_COMMON_PRIMER = COMMON_TEXT;

/** Strategist-only instructions; tactical serialization stays in `TACTICIAN_PRIMER`. */
export const STRATEGIST_PRIMER = STRATEGIST_TEXT;

const tactician = (
  id: string,
  title: string,
  appliesWhen: string,
  text: string,
): PrimerSection => ({ id, role: 'tactician', title, appliesWhen, text });

const CATALOG: readonly PrimerSection[] = Object.freeze([
  tactician('tactician-common', 'Tactician common', 'every tactical decision', COMMON_TEXT),
  tactician('tactician-land-mana', 'Land and mana', 'a playLand action is legal', LAND_TEXT),
  tactician(
    'tactician-targeting',
    'Targeting',
    'any legal action has target slots',
    TARGETING_TEXT,
  ),
  tactician(
    'tactician-attack',
    'Attack declaration',
    'the decision is declareAttackers',
    ATTACK_TEXT,
  ),
  tactician('tactician-block', 'Block declaration', 'the decision is declareBlockers', BLOCK_TEXT),
  tactician(
    'tactician-choose-attackers',
    'Choosing another player’s attackers',
    'a legal action is flagged chooseAttackers',
    CHOOSE_ATTACKERS_TEXT,
  ),
  tactician(
    'tactician-foreign-blocks',
    'Choosing another player’s blocks',
    'a legal action names a blockingPlayer',
    CHOOSE_FOREIGN_BLOCKS_TEXT,
  ),
  tactician(
    'tactician-combat-damage',
    'Combat damage split',
    'the request carries combatDamageSplit or is assignCombatDamage',
    COMBAT_DAMAGE_TEXT,
  ),
  tactician('tactician-mana-split', 'Mana split', 'the request carries manaSplit', MANA_SPLIT_TEXT),
  tactician(
    'tactician-order-or-value',
    'Modes, X, trigger order, bottoming',
    'the decision is chooseModes, chooseX, orderTriggers or bottomCards',
    ORDER_OR_VALUE_TEXT,
  ),
  {
    id: 'strategist',
    role: 'strategist',
    title: 'Strategist',
    appliesWhen: 'once per turn, as the strategist system prompt, when the model plays tactics',
    text: STRATEGIST_TEXT,
  },
  {
    id: 'strategist-bot-led',
    role: 'strategist',
    title: 'Strategist (bot-led tactics)',
    appliesWhen: 'once per turn, as the strategist system prompt, when the bot plays tactics',
    text: BOT_STRATEGIST_PRIMER,
  },
]);

/** Every live primer section, in the order they are concatenated. Excludes the frozen legacy primer. */
export function primerCatalog(): PrimerSection[] {
  return CATALOG.map((section) => ({ ...section }));
}

/** Ids of the tactician sections `tacticianPrimerFor(request)` would send for this request, in order. */
export function tacticianPrimerSectionIds(request: DecisionRequest): string[] {
  const actions = request.legalActions;
  const ids = ['tactician-common'];
  if (actions.some((action) => action.type === 'playLand')) ids.push('tactician-land-mana');
  if (actions.some((action) => (action.targets?.length ?? 0) > 0)) ids.push('tactician-targeting');
  if (request.decisionType === 'declareAttackers') ids.push('tactician-attack');
  if (request.decisionType === 'declareBlockers') ids.push('tactician-block');
  if (actions.some((action) => action.data?.['chooseAttackers'] === true))
    ids.push('tactician-choose-attackers');
  if (actions.some((action) => typeof action.data?.['blockingPlayer'] === 'string'))
    ids.push('tactician-foreign-blocks');
  if (request.combatDamageSplit !== undefined || request.decisionType === 'assignCombatDamage')
    ids.push('tactician-combat-damage');
  if (request.manaSplit !== undefined) ids.push('tactician-mana-split');
  if (['chooseModes', 'chooseX', 'orderTriggers', 'bottomCards'].includes(request.decisionType))
    ids.push('tactician-order-or-value');
  return ids;
}

/** Build only the tactical instructions this decision can consume. */
export function tacticianPrimerFor(request: DecisionRequest): string {
  const byId = new Map(CATALOG.map((section) => [section.id, section.text]));
  return tacticianPrimerSectionIds(request)
    .map((id) => byId.get(id) ?? '')
    .join('\n\n');
}
