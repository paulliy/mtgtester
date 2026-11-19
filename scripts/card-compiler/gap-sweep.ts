/**
 * Gap sweep (issue #95, section 1): lists every promoted compiled card whose patch uses an IR shape
 * a known engine gap or a known misreading makes wrong, and every compiled card whose Oracle text
 * and IR disagree on a facet (ADR 0034 decision 6).
 *
 * It reads the patches and changes nothing. A flagged card is a lead for review, not a verdict: a
 * detector matches the shape, and whether the card's own Oracle text needs the broken behavior is
 * the reviewer's call. Each detector is calibrated against the retired patches it was written from
 * (`docs/reviews/compiled-card-retired.json`); the report prints its recall there, so a detector that
 * misses its own examples shows up immediately.
 *
 *   bun run scripts/card-compiler/gap-sweep.ts [--json out.json] [--markdown out.md]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { OracleCard } from '../../packages/shared/src';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import { facetMismatches, type FacetMismatch } from '../../packages/engine/src/cards/facets';
import { compiledCards } from '../../packages/engine/src/cards/overrides/compiled/register';
import { withPatch } from './lib';

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

interface Detector {
  id: string;
  /** The gap, in the words of issue #95 or the retirement that found it. */
  gap: string;
  /** Retired cards this detector was written from, by name (its calibration set). */
  examples: string[];
  matches(def: Json, text: string, typeLine: string): boolean;
}

const DETECTORS: Detector[] = [
  {
    id: 'mana-activation-rider',
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
    gap: 'The graveyard activation loop in legal.ts never evaluates `activated.condition`.',
    examples: ['Gutterbones'],
    matches: (def) =>
      nodes(def).some((n) => n.value['zone'] === 'graveyard' && n.value['condition'] !== undefined),
  },
  {
    id: 'off-battlefield-step-trigger',
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
    gap: '`doubleCountersTarget` doubles every counter kind.',
    examples: [],
    matches: (def, text) =>
      nodes(def).some((n) => op(n.value) === 'doubleCountersTarget') &&
      /double the number of [^.]*\b(\+1\/\+1|loyalty|charge|\w+) counters/i.test(text),
  },
  {
    id: 'hand-to-battlefield-nonpermanent',
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
    gap: 'Offspring has no intervening-if, so its trigger goes on the stack when offspring was not paid.',
    examples: ['Agate Instigator', 'Coruscation Mage', 'Prosperous Bandit', 'Steelburr Champion'],
    matches: (def) => nodes(def).some((n) => kind(n.value) === 'optionalCostCount'),
  },
  {
    id: 'fabricate-choice',
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
    gap: '"Flash if you pay {2} more" modeled as an alternative cost is skipped outside the hand and cannot combine with other alternative costs.',
    examples: ['Rout', 'Saproling Symbiosis'],
    matches: (def) => nodes(def).some((n) => n.value['instantTiming'] !== undefined),
  },
  {
    id: 'shuffle-before-search',
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
    gap: 'Damage the card deals at once is dealt in two events.',
    examples: ['Self-Destruct'],
    matches: (def, text) =>
      /damage to [^.]*\band (\w+ )?damage\b/i.test(text) &&
      effectLists(def).some((list) => list.filter((e) => /damage/i.test(op(e) ?? '')).length >= 2),
  },
  {
    id: 'merged-whenever-triggers',
    gap: 'Two independent "whenever" triggers merged into one anyOf trigger trigger once for an object matching both.',
    examples: ['Giott, King of the Dwarves'],
    matches: (def, text) =>
      (text.match(/\bwhenever\b/gi) ?? []).length >
        nodes(def).filter((n) => kind(n.value) === 'triggered' && n.key !== 'then').length &&
      nodes(def).some((n) => n.key === 'subject' && has(n.value, (c) => kind(c) === 'anyOf')),
  },
];

interface Flag {
  name: string;
  oracleId: string;
  rank: number;
  batch: string;
  detectors: string[];
  facets: FacetMismatch[];
}

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const pinned = new Map<string, { rank: number; card: OracleCard }>(
  (
    JSON.parse(readFileSync('packages/server/fixtures/edhrec-pinned-oracle.json', 'utf8')) as {
      rank: number;
      card: OracleCard;
    }[]
  ).map((row) => [row.card.oracleId, row]),
);
const lineText = (lines: readonly string[]): string => lines.join('\n');

// Calibration: each detector against the retired patches it was written from.
const patches = new Map<string, { def: Json; handledLines: string[] }>();
for (const dir of readdirSync('docs/reviews').filter((d) => d.startsWith('card-compiler-trial'))) {
  let files: string[] = [];
  try {
    files = readdirSync(`docs/reviews/${dir}/patches`);
  } catch {
    continue;
  }
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const patch = JSON.parse(readFileSync(`docs/reviews/${dir}/patches/${file}`, 'utf8')) as {
      oracleId?: string;
      def: Json;
      handledLines: string[];
    };
    if (patch.oracleId !== undefined) patches.set(patch.oracleId, patch);
  }
}
const retired = (
  JSON.parse(readFileSync('docs/reviews/compiled-card-retired.json', 'utf8')) as {
    retired: { name: string; oracleId: string; reason: string }[];
  }
).retired;
const retiredByName = new Map(retired.map((r) => [r.name, r]));
const calibration = DETECTORS.map((detector) => {
  const missed = detector.examples.filter((name) => {
    const entry = retiredByName.get(name);
    const patch = entry && patches.get(entry.oracleId);
    const typeLine = (entry && pinned.get(entry.oracleId)?.card.typeLine) ?? '';
    return !patch || !detector.matches(patch.def, lineText(patch.handledLines), typeLine);
  });
  return { id: detector.id, examples: detector.examples.length, missed };
});

// Facet recall on the retired wrong patches (grammar supersessions excluded).
let wrongRetired = 0;
let facetCaught = 0;
for (const entry of retired) {
  if (/now parses/.test(entry.reason)) continue;
  const patch = patches.get(entry.oracleId);
  const pin = pinned.get(entry.oracleId);
  if (!patch || !pin) continue;
  wrongRetired++;
  const mismatches = withPatch(
    {
      oracleId: entry.oracleId,
      name: entry.name,
      lines: patch.handledLines,
      card: pin.card,
    } as Parameters<typeof withPatch>[0],
    patch.def as never,
    () => facetMismatches(pin.card, interpretCard(pin.card)),
  );
  if (mismatches.length > 0) facetCaught++;
}

// The sweep.
const flags: Flag[] = [];
const compiled = compiledCards();
for (const [oracleId, card] of compiled) {
  const pin = pinned.get(oracleId);
  if (!pin) throw new Error(`compiled card ${card.name} has no pinned Oracle entry`);
  const text = lineText(card.handledLines);
  const detectors = DETECTORS.filter((d) => d.matches(card.def, text, pin.card.typeLine)).map(
    (d) => d.id,
  );
  const facets = facetMismatches(pin.card, interpretCard(pin.card));
  if (detectors.length > 0 || facets.length > 0)
    flags.push({ name: card.name, oracleId, rank: pin.rank, batch: card.batch, detectors, facets });
}
flags.sort((a, b) => b.detectors.length - a.detectors.length || a.rank - b.rank);

const byDetector = DETECTORS.map((d) => ({
  ...d,
  cards: flags.filter((f) => f.detectors.includes(d.id)),
}));
const shapeFlagged = flags.filter((f) => f.detectors.length > 0);
const facetOnly = flags.filter((f) => f.detectors.length === 0);

const summary = {
  compiled: compiled.size,
  shapeFlagged: shapeFlagged.length,
  facetOnly: facetOnly.length,
  facetRecallOnRetired: `${facetCaught}/${wrongRetired}`,
  calibration,
};
console.log(JSON.stringify(summary, null, 2));
for (const d of byDetector) console.log(`${d.id.padEnd(34)} ${d.cards.length}`);

const jsonPath = option('--json');
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify({ summary, flags }, null, 2)}\n`);

const mdPath = option('--markdown');
if (mdPath) {
  const facetText = (f: FacetMismatch): string => `${f.facet} (text ${f.text}, IR ${f.ir})`;
  const lines: string[] = [];
  lines.push('## Shape detectors', '');
  for (const d of byDetector) {
    const cal = calibration.find((c) => c.id === d.id)!;
    lines.push(
      `### \`${d.id}\` — ${d.cards.length} live card${d.cards.length === 1 ? '' : 's'}`,
      '',
      d.gap,
      '',
      `Calibration: ${cal.examples - cal.missed.length}/${cal.examples} retired examples matched${
        cal.missed.length > 0 ? ` (missed: ${cal.missed.join(', ')})` : ''
      }.`,
      '',
    );
    for (const card of d.cards)
      lines.push(
        `- ${card.name} (rank ${card.rank}, ${card.batch})${
          card.facets.length > 0 ? ` — also facets: ${card.facets.map(facetText).join(', ')}` : ''
        }`,
      );
    if (d.cards.length > 0) lines.push('');
  }
  lines.push(
    '## Facet mismatches only',
    '',
    `${facetOnly.length} cards. Weak signal: the facet counter matched ${facetCaught} of ${wrongRetired} known-wrong retired patches, so most of these are expected to be modeling choices.`,
    '',
  );
  for (const card of [...facetOnly].sort((a, b) => a.rank - b.rank))
    lines.push(`- ${card.name} (rank ${card.rank}): ${card.facets.map(facetText).join(', ')}`);
  writeFileSync(mdPath, `${lines.join('\n')}\n`);
}
