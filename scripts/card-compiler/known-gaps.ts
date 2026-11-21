/**
 * Known engine gaps as IR shapes (issue #95). Each detector matches a card patch whose shape an
 * open engine gap, or a known misreading, makes wrong. The batch compiler refuses a patch that
 * matches an open detector, at the compile round and at `promote`; `gap-sweep.ts` lists the live
 * compiled cards that match.
 *
 * A detector is written from the retired cards in `docs/reviews/compiled-card-retired.json` that
 * showed the gap, and names them in `examples`; `known-gaps.test.ts` requires it to match every
 * one. When an engine change closes a gap, set `open: false` in that change (with the change's
 * own positive and negative tests); the detector then stops refusing patches, and retired cards
 * with the shape can be recompiled.
 *
 * Deliberately not inside `applyPatch`: the calibration set holds known-wrong patches that must
 * still validate, so the meaning check can be measured on them.
 */
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import type { CompileTarget } from './lib';

type Json = unknown;
interface Node {
  value: Record<string, Json>;
  /** Ancestor objects, outermost first. */
  ancestors: Record<string, Json>[];
  /** The key under which this node sits in its parent object (array indices skipped). */
  key: string;
}

/** Every object in a patch, with its ancestors. */
function nodes(def: Json): Node[] {
  const out: Node[] = [];
  const walk = (value: Json, ancestors: Record<string, Json>[], key: string): void => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, ancestors, key);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, Json>;
    out.push({ value: record, ancestors, key });
    for (const [childKey, child] of Object.entries(record))
      walk(child, [...ancestors, record], childKey);
  };
  walk(def, [], 'def');
  return out;
}

const op = (node: Record<string, Json>): string | undefined =>
  typeof node['op'] === 'string' ? node['op'] : undefined;
const kind = (node: Record<string, Json>): string | undefined =>
  typeof node['kind'] === 'string' ? node['kind'] : undefined;
const has = (node: Record<string, Json>, test: (n: Record<string, Json>) => boolean): boolean =>
  nodes(node).some((n) => test(n.value));
/** Effect lists anywhere in the patch (each `effects`, `then` and `else` array of effects). */
function effectLists(def: Json): Record<string, Json>[][] {
  const lists: Record<string, Json>[][] = [];
  for (const { value } of nodes(def))
    for (const key of ['effects', 'then', 'else'])
      if (Array.isArray(value[key]))
        lists.push(
          (value[key] as Json[]).filter(
            (e): e is Record<string, Json> => e !== null && typeof e === 'object' && 'op' in e,
          ),
        );
  return lists;
}

const STEP_TRIGGERS = new Set([
  'upkeep',
  'endStep',
  'untapStep',
  'drawStep',
  'beginningOfCombat',
  'endOfCombat',
  'precombatMain',
]);

export interface Detector {
  id: string;
  /** The gap, in the words of issue #95 or the retirement that found it. */
  gap: string;
  /** Retired cards this detector was written from, by name (its calibration set). */
  examples: string[];
  /** True while the engine gap is unfixed: the compiler refuses patches this detector matches. */
  open: boolean;
  matches(def: Json, text: string, typeLine: string): boolean;
}

export const DETECTORS: readonly Detector[] = [
  {
    id: 'mana-activation-rider',
    open: true,
    gap: "A land's tapped-for-mana rider also augments its non-tap mana abilities.",
    examples: [
      'Dictate of Karametra',
      'Fertile Ground',
      'Gauntlet of Might',
      'Groundchuck & Dirtbag',
      'Mana Flare',
      'Market Festival',
      'Overabundance',
      'Trace of Abundance',
      'Verdant Haven',
      'Vernal Bloom',
      'Zhur-Taa Ancient',
    ],
    matches: (def) => nodes(def).some((n) => kind(n.value) === 'manaActivationRider'),
  },
  {
    id: 'sequential-group-move',
    open: true,
    gap: 'Multi-card blink and "sacrifice two" happen one at a time, not simultaneously.',
    examples: ['Displace', "Illusionist's Stratagem", 'Lotus Field', 'Planar Engineering'],
    matches: (def, text) =>
      nodes(def).some(
        (n) =>
          (op(n.value) === 'blinkEachChosen' && !/up to one (other )?target/i.test(text)) ||
          (op(n.value) === 'sacrificeOneThen' &&
            has({ x: (n.value['then'] as never) ?? null }, (c) => op(c) === 'sacrificeOneThen')),
      ) ||
      effectLists(def).some((list) => list.filter((e) => op(e) === 'sacrificeOneThen').length >= 2),
  },
  {
    id: 'reward-after-unpaid-removal',
    open: true,
    gap: 'A reward follows a counter removal that did not happen; there is no "counters removed this way" value.',
    examples: [
      'Bounty of the Luxa',
      'Coalition Relic',
      'Lily Bowen, Raging Grandma',
      'Mercurial Spelldancer',
      'Noosegraf Mob',
    ],
    matches: (def, text) =>
      /if you do|removed this way/i.test(text) &&
      effectLists(def).some((list) => {
        const at = list.findIndex((e) => op(e) === 'removeCounters');
        return at >= 0 && list.length > 1;
      }),
  },
  {
    id: 'token-created-attacking',
    // Closed: each token now chooses among every opponent, enters untapped when `untapped` is
    // set, and a newly attacked player can block it (token-created-attacking.test.ts).
    open: false,
    gap: 'Tokens created attacking share one defender choice, limited to players already attacked, and are always tapped.',
    examples: [
      'Andúril, Flame of the West',
      'Anim Pakal, Thousandth Moon',
      "Captain's Claws",
      'Inquisitorial Rosette',
      'Kessig Cagebreakers',
      'Leonin Warleader',
      'Sigiled Sword of Valeron',
    ],
    matches: (def) =>
      nodes(def).some(
        (n) => op(n.value) === 'createTokenAttacking' && n.value['defender'] === undefined,
      ),
  },
  {
    id: 'copy-gains-keyword',
    open: true,
    gap: '`createTokenCopyOf.addKeywords` is copiable, so it fits only "except it has"; no op grants a keyword to a token just created.',
    examples: [
      'Chrome Dome',
      'Devastating Onslaught',
      'Helm of the Host',
      'Molten Duplication',
      "Saheeli, the Sun's Brilliance",
      'Tempestra, Dame of Games',
    ],
    matches: (def, text) =>
      nodes(def).some(
        (n) => op(n.value) === 'createTokenCopyOf' && n.value['addKeywords'] !== undefined,
      ) && !/except it has/i.test(text),
  },
  {
    id: 'copy-sacrifice-at',
    open: true,
    gap: "A copy's end-step sacrifice is a delayed trigger on the creation, not an ability of the token, so later copies of the token keep it.",
    examples: ['Electroduplicate'],
    matches: (def, text) =>
      /"[^"]*sacrifice (this|that) (token|creature)[^"]*"/i.test(text) &&
      nodes(def).some(
        (n) => op(n.value) === 'createTokenCopyOf' && n.value['sacrificeAt'] !== undefined,
      ),
  },
  {
    id: 'copy-of-departed-object',
    open: true,
    gap: 'Copies read the event object after it left; there is no last-known copiable value.',
    examples: ['Impostor Syndrome', 'Mirrorworks', 'Necroduality'],
    matches: (def) =>
      nodes(def).some(
        (n) =>
          (op(n.value) === 'createTokenCopyOf' || op(n.value) === 'becomeCopyOf') &&
          /trigger|event/i.test(String(n.value['ref'] ?? n.value['of'] ?? '')),
      ),
  },
  {
    id: 'attached-outside-target',
    open: true,
    gap: '`attachedToSource` never matches in a condition, an attackRestriction, a mana rider or a mass grant (affectedBy passes no attachment).',
    examples: [
      'Blade of the Bloodchief',
      'Ring of Evos Isle',
      'Vow of Duty',
      'Vow of Lightning',
      'Vow of Torment',
      'Wand of Orcus',
    ],
    matches: (def) =>
      nodes(def).some(
        (n) =>
          kind(n.value) === 'attachedToSource' &&
          n.ancestors.some(
            (a) =>
              ['attackRestriction', 'manaActivationRider', 'countPermanents'].includes(
                kind(a) ?? '',
              ) ||
              /Each(UntilEot)?$|Each$/.test(op(a) ?? '') ||
              (kind(a) !== undefined && 'condition' === n.key),
          ),
      ),
  },
  {
    id: 'delayed-trigger-subject',
    open: true,
    gap: 'An untargeted delayed trigger ignores its inner subject selector; one created during an end step never fires.',
    examples: ["Benefactor's Draught", 'Forth Eorlingas!'],
    matches: (def) =>
      nodes(def).some(
        (n) =>
          op(n.value) === 'registerDelayedTrigger' &&
          (n.value['when'] === 'endStep' || n.value['target'] === undefined),
      ),
  },
  {
    id: 'once-per-turn-condition',
    open: true,
    gap: '`oncePerTurn` is recorded after the condition check, so a failed check uses up nothing.',
    examples: ['Fear of Missing Out'],
    matches: (def, text) =>
      /first time each turn/i.test(text) &&
      nodes(def).some((n) => {
        if (kind(n.value) !== 'triggered') return false;
        const trigger = (n.value['trigger'] as Record<string, Json> | undefined) ?? {};
        return (
          (n.value['oncePerTurn'] === true || trigger['oncePerTurn'] === true) &&
          (n.value['condition'] !== undefined || trigger['condition'] !== undefined)
        );
      }),
  },
  {
    id: 'graveyard-activation-condition',
    open: true,
    gap: 'The graveyard activation loop in legal.ts never evaluates `activated.condition`.',
    examples: ['Gutterbones'],
    matches: (def) =>
      nodes(def).some((n) => n.value['zone'] === 'graveyard' && n.value['condition'] !== undefined),
  },
  {
    id: 'off-battlefield-step-trigger',
    open: true,
    gap: 'Step triggers scan only the battlefield.',
    examples: ['Genesis'],
    matches: (def) =>
      nodes(def).some(
        (n) =>
          kind(n.value) === 'triggered' &&
          (n.value['functionsInGraveyard'] === true || n.value['zone'] !== undefined) &&
          STEP_TRIGGERS.has(
            String((n.value['trigger'] as Record<string, Json> | undefined)?.['when']),
          ),
      ),
  },
  {
    id: 'granted-dies-trigger',
    open: true,
    gap: 'The single-object destroy path loses death triggers (seen on a dies trigger granted by a static).',
    examples: ['Relic Vial'],
    matches: (def) =>
      nodes(def).some(
        (n) =>
          n.value['addTrigger'] !== undefined &&
          has({ t: n.value['addTrigger'] as never }, (c) => c['when'] === 'dies'),
      ),
  },
  {
    id: 'put-counters-each-dynamic',
    open: true,
    gap: '`putCountersEach` re-evaluates its amount for each permanent.',
    examples: ['Ouroboroid'],
    matches: (def) =>
      nodes(def).some((n) => {
        if (op(n.value) !== 'putCountersEach') return false;
        if (kind(n.value['selector'] as never) === 'self') return false;
        const count = n.value['count'];
        return (
          count !== null &&
          typeof count === 'object' &&
          has({ c: count as never }, (c) =>
            /power|toughness|counters|hasCounter/i.test(`${kind(c) ?? ''}`),
          )
        );
      }),
  },
  {
    id: 'value-after-counter',
    open: true,
    gap: "A countered spell's mana value reads 0 after it leaves the stack.",
    examples: ['Electrosiphon', 'Reject Imperfection'],
    matches: (def) =>
      effectLists(def).some(
        (list) =>
          list.some((e) => op(e) === 'counter') &&
          list.some((e) => has(e, (c) => kind(c) === 'manaValueOfTarget')),
      ) ||
      (has({ d: def as never }, (c) => op(c) === 'counter') &&
        has({ d: def as never }, (c) => kind(c) === 'manaValueOfTarget')),
  },
  {
    id: 'attack-group-damage',
    open: true,
    gap: 'No damage selector reads an attack group; damage hits every attacker, including later ones.',
    examples: ['Lightmine Field', 'Witch-king, Sky Scourge'],
    matches: (def, text) =>
      /\b(those|their)\b/i.test(text) &&
      nodes(def).some(
        (n) =>
          kind(n.value) === 'triggered' &&
          (n.value['trigger'] as Record<string, Json> | undefined)?.['when'] === 'attackDeclared' &&
          has({ e: (n.value['effects'] as never) ?? null }, (c) =>
            ['combatRole', 'attackingCreatures'].includes(kind(c) ?? ''),
          ),
      ),
  },
  {
    id: 'become-creature-types',
    open: true,
    gap: '`becomeCreatureUntilEot` only adds Creature unless `replaceTypes` is set, and overwrites base P/T.',
    examples: ['Phantom Train'],
    matches: (def, text, typeLine) =>
      nodes(def).some((n) => {
        if (op(n.value) !== 'becomeCreatureUntilEot') return false;
        const named = /becomes? an? [^.]*?\b(artifact|enchantment|land) creature/i.exec(text)?.[1];
        const addsMissingType =
          named !== undefined &&
          n.value['target'] === 'source' &&
          !new RegExp(named, 'i').test(typeLine);
        const setsUnprintedPt = n.value['power'] !== undefined && !/\d+\/\d+/.test(text);
        return addsMissingType || setsUnprintedPt;
      }),
  },
  {
    id: 'set-subtypes',
    open: true,
    gap: '`setSubtypes` drops land subtypes; an animated land loses its creature subtypes.',
    examples: ['Spreading Seas'],
    matches: (def) =>
      nodes(def).some(
        (n) =>
          (op(n.value) === 'setSubtypes' ||
            n.value['setSubtypes'] !== undefined ||
            n.value['setLandSubtype'] !== undefined) &&
          n.value['setTypes'] === undefined,
      ),
  },
  {
    id: 'double-counters-every-kind',
    open: true,
    gap: '`doubleCountersTarget` doubles every counter kind.',
    examples: [],
    matches: (def, text) =>
      nodes(def).some((n) => op(n.value) === 'doubleCountersTarget') &&
      /double the number of [^.]*\b(\+1\/\+1|loyalty|charge|\w+) counters/i.test(text),
  },
  {
    id: 'hand-to-battlefield-nonpermanent',
    open: true,
    gap: '`handToBattlefield` has no permanent check.',
    examples: [],
    matches: (def) =>
      nodes(def).some(
        (n) =>
          op(n.value) === 'handToBattlefield' &&
          !has({ f: (n.value['filter'] as never) ?? null }, (c) =>
            [
              'Creature',
              'Artifact',
              'Enchantment',
              'Land',
              'Planeswalker',
              'Battle',
              'Plains',
              'Island',
              'Swamp',
              'Mountain',
              'Forest',
            ].includes(String(c['value'])),
          ),
      ),
  },
  {
    id: 'self-only-activation-reduction',
    open: true,
    gap: 'A battlefield `selfOnly` activation cost reduction is never applied.',
    examples: ['Plate Armor'],
    matches: (def) =>
      nodes(def).some(
        (n) =>
          kind(n.value) === 'costReduction' &&
          (n.value['appliesTo'] === 'activate' || n.value['selfOnly'] === true) &&
          n.value['appliesTo'] === 'activate',
      ),
  },
  {
    id: 'other-on-self-eligible-cost',
    open: true,
    gap: 'A "sacrifice/tap a <type>" cost compiled as `…Other` without `allowSelf`, on a card that is itself that type, so the source cannot pay with itself (owner review, #95 section 5).',
    examples: [],
    matches: (def, text, typeLine) => {
      const costPart = text
        .split('\n')
        .map((line) => line.split(':')[0] ?? '')
        .join('\n');
      if (/\b(another|other)\b/i.test(costPart)) return false;
      // A spell is never on the battlefield while its costs are paid, so it cannot pay with itself.
      if (/\b(Instant|Sorcery)\b/.test(typeLine)) return false;
      // Any permanent can become the named type (Mycosynth Lattice, March of the Machines), so
      // "sacrifice an artifact" includes the source whenever it is one; `…Other` never does.
      return nodes(def).some((n) => {
        if (!/Other$/.test(kind(n.value) ?? '') || n.value['allowSelf'] === true) return false;
        // "{T}, Tap an untapped permanent": the source is already tapped by its own {T}.
        const siblings = n.ancestors.at(-1)?.['costs'];
        const alsoTapsSelf =
          Array.isArray(siblings) && siblings.some((c) => kind(c as never) === 'tap');
        return !(kind(n.value) === 'tapOther' && alsoTapsSelf);
      });
    },
  },
  {
    id: 'optional-cost-copy',
    open: true,
    gap: 'Offspring has no intervening-if, so its trigger goes on the stack when offspring was not paid.',
    examples: ['Agate Instigator', 'Coruscation Mage', 'Prosperous Bandit', 'Steelburr Champion'],
    matches: (def) => nodes(def).some((n) => kind(n.value) === 'optionalCostCount'),
  },
  {
    id: 'fabricate-choice',
    open: true,
    gap: 'Fabricate still offers counters it cannot place, yielding no Servos.',
    examples: ['Angel of Invention', 'Weaponcraft Enthusiast'],
    matches: (def) =>
      nodes(def).some(
        (n) =>
          op(n.value) === 'chooseOne' &&
          has(n.value, (c) => op(c) === 'createToken') &&
          has(n.value, (c) => op(c) === 'putCounters'),
      ),
  },
  {
    id: 'if-you-do-after-zero',
    open: true,
    gap: '"If you do" is modeled as an unconditional follow-up or a separate counterable trigger.',
    examples: ['Promise of Bunrei', 'Sanctum of Calm Waters', 'Uncover the Moon-Letters'],
    matches: (def, text) =>
      /if you do/i.test(text) &&
      (nodes(def).some((n) => op(n.value) === 'sacrificeSourceThenReflexive') ||
        effectLists(def).some((list) => {
          const draw = list.findIndex((e) => op(e) === 'draw');
          const discard = list.findIndex((e) => op(e) === 'discard');
          return draw >= 0 && discard > draw;
        })),
  },
  {
    id: 'flash-for-more',
    open: true,
    gap: '"Flash if you pay {2} more" modeled as an alternative cost is skipped outside the hand and cannot combine with other alternative costs.',
    examples: ['Rout', 'Saproling Symbiosis'],
    matches: (def) => nodes(def).some((n) => n.value['instantTiming'] !== undefined),
  },
  {
    id: 'shuffle-before-search',
    open: true,
    gap: 'A shuffle placed before the search leaves the library unshuffled after a search to hand.',
    examples: ['Loyal Inventor'],
    matches: (def) =>
      effectLists(def).some((list) => {
        const shuffle = list.findIndex((e) => op(e) === 'shuffle');
        const search = list.findIndex((e) => has(e, (c) => op(c) === 'searchLibrary'));
        return shuffle >= 0 && search > shuffle;
      }),
  },
  {
    id: 'split-simultaneous-damage',
    open: true,
    gap: 'Damage the card deals at once is dealt in two events.',
    examples: ['Self-Destruct'],
    matches: (def, text) =>
      /damage to [^.]*\band (\w+ )?damage\b/i.test(text) &&
      effectLists(def).some((list) => list.filter((e) => /damage/i.test(op(e) ?? '')).length >= 2),
  },
  {
    id: 'merged-whenever-triggers',
    open: true,
    gap: 'Two independent "whenever" triggers merged into one anyOf trigger trigger once for an object matching both.',
    examples: ['Giott, King of the Dwarves'],
    matches: (def, text) =>
      (text.match(/\bwhenever\b/gi) ?? []).length >
        nodes(def).filter((n) => kind(n.value) === 'triggered' && n.key !== 'then').length &&
      nodes(def).some((n) => n.key === 'subject' && has(n.value, (c) => kind(c) === 'anyOf')),
  },
];

/** The open detectors a patch matches, for a card with these handled lines and type line. */
export function knownGaps(
  def: Partial<CardDefinition>,
  lines: readonly string[],
  typeLine: string,
): Detector[] {
  return DETECTORS.filter(
    (detector) => detector.open && detector.matches(def, lines.join('\n'), typeLine),
  );
}

/** Validator-style issues for a compile target: empty when the patch uses no open gap. */
export function knownGapIssues(target: CompileTarget, def: Partial<CardDefinition>): string[] {
  return knownGaps(def, target.lines, target.card.typeLine ?? '').map(
    (detector) =>
      `known engine gap ${detector.id}: ${detector.gap} The engine runs this shape wrongly, so ` +
      'answer inexpressible unless the line can be said exactly without it.',
  );
}
