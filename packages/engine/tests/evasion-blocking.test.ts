/**
 * Engine-feature plan PR 2: evasion keywords, block restrictions and the keyword lines whose
 * engine support already existed through overrides (offspring, ravenous, dash, sneak).
 *
 * Interpretation tests pin the IR on real pinned Oracle text and near-miss wordings that must stay
 * unmodeled; behavior tests go through a declared combat (`runCombatAndExtraCombats`), reading the
 * per-blocker legal attackers the engine offers and the violations it rejects.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { getOverride } from '../src/cards/overrides';
import { allOf, ofSubtype, ofType, SELF } from '../src/cards/selector';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { runCombatAndExtraCombats } from '../src/turn/turn';
import {
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  island,
  oracle,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const pinnedCards = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/evasion-blocking-oracle.json'), 'utf8'),
  ) as PinnedFixture
).cards;

function pinned(name: string): OracleCard {
  const entry = pinnedCards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`missing pinned Oracle fixture for ${name}`);
  return entry.card;
}

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const body = (
  name: string,
  opts: { power?: number; colors?: OracleCard['colors']; typeLine?: string; text?: string } = {},
) =>
  oracle({
    name,
    typeLine: opts.typeLine ?? 'Creature — Bear',
    power: String(opts.power ?? 2),
    toughness: '4',
    colors: opts.colors ?? ['G'],
    oracleText: opts.text ?? '',
  });

/**
 * P1 attacks P2 with `attackers`; P2 declares `blocks` (blocker id to attacker id). Returns which
 * attackers each of P2's untapped creatures was offered, the violation kinds the engine rejected,
 * and the blocks that were finally applied.
 */
function combat(
  ctx: GameContext,
  attackers: EnginePermanent[],
  blocks: Record<string, string> = {},
) {
  const offered = new Map<string, string[]>();
  const rejections: string[] = [];
  pump(
    runCombatAndExtraCombats(ctx),
    (decision) => {
      if (decision.presentationAttackDeclaration !== undefined)
        return declareAttacks(decision, (id) => (attackers.some((a) => a.id === id) ? 'P2' : null));
      if (decision.presentationBlockDeclaration !== undefined) {
        for (const subject of decision.presentationBlockDeclaration.subjects)
          offered.set(
            subject.subjectId,
            subject.attackers.map((a) => a.attackerId),
          );
        for (const violation of decision.presentationBlockDeclaration.rejection?.violations ?? [])
          rejections.push(violation.kind);
        return declareBlocks(decision, (id) => blocks[id] ?? null);
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    },
    { strict: true },
  );
  const applied = ctx.state.eventLog
    .filter((event) => event.type === 'block')
    .map((event) => event.payload['blocker'] as string);
  return { offered, rejections, applied };
}

/** May `blocker` block `attacker` in a fresh combat on this board? */
function mayBlock(ctx: GameContext, attacker: EnginePermanent, blocker: EnginePermanent): boolean {
  return combat(ctx, [attacker]).offered.get(blocker.id)?.includes(attacker.id) ?? false;
}

describe('pinned Oracle fixture', () => {
  it('evasion-pinned-hashes — every pinned card still matches its recorded hash', () => {
    for (const { sha256, card } of pinnedCards)
      expect(createHash('sha256').update(canonical(card)).digest('hex'), card.name).toBe(sha256);
  });

  it('evasion-pinned-modeled — every pinned card in this batch models', () => {
    for (const { card } of pinnedCards.filter(
      (entry) => entry.card.name !== 'Raphael, the Nightwatcher',
    ))
      expect(interpretCard(card).unmodeledReasons, card.name).toEqual([]);
  });
});

describe('interpretation', () => {
  it('evasion-keywords — printed and granted evasion keywords', () => {
    expect(interpretCard(pinned('Shadowmage Infiltrator')).keywords).toContain('fear');
    expect(interpretCard(pinned('Vampire Cutthroat')).keywords).toContain('skulk');
    expect(interpretCard(pinned('Cold-Eyed Selkie')).keywords).toContain('islandwalk');
    expect(interpretCard(pinned('Dwarven Grunt')).keywords).toContain('mountainwalk');
    expect(interpretCard(pinned("Trailblazer's Boots")).staticEffects).toEqual([
      { affects: { kind: 'attachedToSource' }, op: { layer: 6, addKeyword: 'nonbasic landwalk' } },
    ]);
  });

  it('block-restriction-shapes — except-by, not-by, greater power, more than one, N or more', () => {
    expect(interpretCard(pinned("Prowler's Helm")).ruleStatics).toEqual([
      {
        kind: 'blockRestriction',
        attackers: { kind: 'attachedToSource' },
        onlyBy: ofSubtype('Wall'),
      },
    ]);
    expect(interpretCard(pinned('Steel Leaf Champion')).ruleStatics).toEqual([
      {
        kind: 'blockRestriction',
        attackers: SELF,
        notBy: allOf(ofType('Creature'), { kind: 'powerAtMost', n: 2 }),
      },
    ]);
    expect(interpretCard(pinned('Ant-Man, Elusive Avenger')).ruleStatics).toEqual([
      { kind: 'blockRestriction', attackers: SELF, notByGreaterPower: true },
    ]);
    expect(interpretCard(pinned('Sunder Shaman')).ruleStatics).toEqual([
      { kind: 'blockRestriction', attackers: SELF, maxBlockers: 1 },
    ]);
    expect(interpretCard(pinned('Troll of Khazad-dûm')).ruleStatics).toEqual([
      { kind: 'minBlockers', minimum: 3 },
    ]);
    expect(interpretCard(pinned('Ox Drover')).ruleStatics).toEqual([
      { kind: 'blockRestriction', attackers: SELF, notBy: ofSubtype('Ox') },
    ]);
    const alpha = interpretCard(pinned('Alpha Authority'));
    expect(alpha.staticEffects).toEqual([
      { affects: { kind: 'attachedToSource' }, op: { layer: 6, addKeyword: 'hexproof' } },
    ]);
    expect(alpha.ruleStatics).toEqual([
      { kind: 'blockRestriction', attackers: { kind: 'attachedToSource' }, maxBlockers: 1 },
    ]);
  });

  it('evasion-negatives — near-miss wordings stay unmodeled', () => {
    for (const text of [
      "This creature can't be blocked as long as defending player controls a Swamp.",
      "This creature can't be blocked by Walls this turn.",
      "This creature can't be blocked except by two or more creatures.",
      "This creature can't be blocked by creatures that player controls.",
      "This creature can't be blocked except by creatures with flying or reach.",
      'Desertwalk',
      'Legendary landwalk',
      'Horsemanship',
      'Landwalk of the chosen type',
    ]) {
      const def = interpretCard(
        oracle({ name: `Near miss ${text.slice(0, 24)}`, oracleText: text }),
      );
      expect(def.modeled, text).toBe(false);
    }
    // Sneak on a creature also enters tapped and attacking, which is not modeled.
    expect(interpretCard(pinned('Raphael, the Nightwatcher')).modeled).toBe(false);
  });
});

describe('evasion keywords in combat', () => {
  it('fear — only artifact and/or black creatures may block it', () => {
    const ctx = pod('fear');
    const attacker = spawn(ctx, 'P1', pinned('Shadowmage Infiltrator'));
    const green = spawn(ctx, 'P2', body('Green Bear'));
    const black = spawn(ctx, 'P2', body('Black Bear', { colors: ['B'] }));
    const golem = spawn(
      ctx,
      'P2',
      body('Golem', { colors: [], typeLine: 'Artifact Creature — Golem' }),
    );
    const { offered } = combat(ctx, [attacker]);
    expect(offered.get(green.id) ?? []).not.toContain(attacker.id);
    expect(offered.get(black.id)).toContain(attacker.id);
    expect(offered.get(golem.id)).toContain(attacker.id);
  });

  it('intimidate — artifact creatures or creatures sharing a color; colorless attacker only artifacts', () => {
    const ctx = pod('intimidate');
    const red = spawn(ctx, 'P1', body('Red Intimidator', { colors: ['R'], text: 'Intimidate' }));
    const green = spawn(ctx, 'P2', body('Green Bear'));
    const redGreen = spawn(ctx, 'P2', body('Red-Green Bear', { colors: ['R', 'G'] }));
    const golem = spawn(
      ctx,
      'P2',
      body('Golem', { colors: [], typeLine: 'Artifact Creature — Golem' }),
    );
    const first = combat(ctx, [red]);
    expect(first.offered.get(green.id) ?? []).not.toContain(red.id);
    expect(first.offered.get(redGreen.id)).toContain(red.id);
    expect(first.offered.get(golem.id)).toContain(red.id);

    const ctx2 = pod('intimidate-colorless');
    const colorless = spawn(
      ctx2,
      'P1',
      body('Colorless Intimidator', {
        colors: [],
        typeLine: 'Creature — Eldrazi',
        text: 'Intimidate',
      }),
    );
    const anyColor = spawn(ctx2, 'P2', body('Green Bear'));
    const artifact = spawn(
      ctx2,
      'P2',
      body('Golem', { colors: [], typeLine: 'Artifact Creature — Golem' }),
    );
    const second = combat(ctx2, [colorless]);
    expect(second.offered.get(anyColor.id) ?? []).not.toContain(colorless.id);
    expect(second.offered.get(artifact.id)).toContain(colorless.id);
  });

  it('skulk — a blocker with greater power is refused; equal power may block', () => {
    const ctx = pod('skulk');
    const attacker = spawn(ctx, 'P1', body('Skulker', { power: 2, text: 'Skulk' }));
    const bigger = spawn(ctx, 'P2', body('Big Bear', { power: 3 }));
    const equal = spawn(ctx, 'P2', body('Even Bear', { power: 2 }));
    const { offered } = combat(ctx, [attacker]);
    expect(offered.get(bigger.id) ?? []).not.toContain(attacker.id);
    expect(offered.get(equal.id)).toContain(attacker.id);
  });

  it('shadow — works both ways', () => {
    const ctx = pod('shadow');
    const shade = spawn(ctx, 'P1', body('Shade', { text: 'Shadow' }));
    const plain = spawn(ctx, 'P1', body('Plain Attacker'));
    const blocker = spawn(ctx, 'P2', body('Plain Bear'));
    const shadowBlocker = spawn(ctx, 'P2', body('Shadow Bear', { text: 'Shadow' }));
    const { offered } = combat(ctx, [shade, plain]);
    expect(offered.get(blocker.id)).toEqual([plain.id]);
    expect(offered.get(shadowBlocker.id)).toEqual([shade.id]);
  });

  it('landwalk — unblockable only while the defending player controls that land type', () => {
    const ctx = pod('islandwalk');
    const selkie = spawn(ctx, 'P1', pinned('Cold-Eyed Selkie'));
    const blocker = spawn(ctx, 'P2', body('Bear'));
    expect(mayBlock(ctx, selkie, blocker)).toBe(true);
    // A nonbasic land with the Island subtype counts (CR 702.14c).
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Tropical Pool',
        typeLine: 'Land — Island Forest',
        manaCost: null,
        power: null,
        toughness: null,
      }),
    );
    selkie.tapped = false;
    expect(mayBlock(ctx, selkie, blocker)).toBe(false);
    // Another player's Island does not matter.
    const ctx2 = pod('islandwalk-other');
    const selkie2 = spawn(ctx2, 'P1', pinned('Cold-Eyed Selkie'));
    const blocker2 = spawn(ctx2, 'P2', body('Bear'));
    spawn(ctx2, 'P3', island());
    expect(mayBlock(ctx2, selkie2, blocker2)).toBe(true);
  });

  it('nonbasic landwalk — granted by equipment, off against only basic lands', () => {
    const ctx = pod('nonbasic-landwalk');
    const attacker = spawn(ctx, 'P1', body('Walker'));
    const boots = spawn(ctx, 'P1', pinned("Trailblazer's Boots"));
    boots.attachedTo = attacker.id;
    const blocker = spawn(ctx, 'P2', body('Bear'));
    expect(mayBlock(ctx, attacker, blocker)).toBe(true); // P2 has only basic Forests
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Lab Nonbasic',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
      }),
    );
    attacker.tapped = false;
    expect(mayBlock(ctx, attacker, blocker)).toBe(false);
  });

  it('granted skulk — "Creatures you control have skulk" applies to every attacker of its controller', () => {
    const ctx = pod('granted-skulk');
    spawn(ctx, 'P1', pinned('Behind the Scenes'));
    const attacker = spawn(ctx, 'P1', body('Small', { power: 1 }));
    const bigger = spawn(ctx, 'P2', body('Big Bear', { power: 3 }));
    expect(mayBlock(ctx, attacker, bigger)).toBe(false);
  });
});

describe('block restrictions in combat', () => {
  it("only-by — Prowler's Helm lets only Walls block the equipped creature", () => {
    const ctx = pod('prowler');
    const attacker = spawn(ctx, 'P1', body('Helmed'));
    const helm = spawn(ctx, 'P1', pinned("Prowler's Helm"));
    helm.attachedTo = attacker.id;
    const bear = spawn(ctx, 'P2', body('Bear'));
    const wall = spawn(ctx, 'P2', body('Wall', { typeLine: 'Creature — Wall', power: 0 }));
    const { offered } = combat(ctx, [attacker]);
    expect(offered.get(bear.id) ?? []).not.toContain(attacker.id);
    expect(offered.get(wall.id)).toContain(attacker.id);
  });

  it('not-by power — Steel Leaf Champion refuses power 2 or less, allows power 3', () => {
    const ctx = pod('steel-leaf');
    const champion = spawn(ctx, 'P1', pinned('Steel Leaf Champion'));
    const small = spawn(ctx, 'P2', body('Small Bear', { power: 2 }));
    const big = spawn(ctx, 'P2', body('Big Bear', { power: 3 }));
    const { offered } = combat(ctx, [champion]);
    expect(offered.get(small.id) ?? []).not.toContain(champion.id);
    expect(offered.get(big.id)).toContain(champion.id);
  });

  it('greater power — Ant-Man refuses a bigger blocker and allows an equal one', () => {
    const ctx = pod('ant-man');
    const ant = spawn(ctx, 'P1', pinned('Ant-Man, Elusive Avenger'));
    const power = Number(
      (ant as { basePower?: number }).basePower ??
        interpretCard(pinned('Ant-Man, Elusive Avenger')).power,
    );
    const bigger = spawn(ctx, 'P2', body('Bigger', { power: power + 1 }));
    const equal = spawn(ctx, 'P2', body('Equal', { power }));
    const { offered } = combat(ctx, [ant]);
    expect(offered.get(bigger.id) ?? []).not.toContain(ant.id);
    expect(offered.get(equal.id)).toContain(ant.id);
  });

  it('group restriction — Shifting Sliver: Slivers only by Slivers, other attackers unaffected', () => {
    const ctx = pod('shifting-sliver');
    spawn(ctx, 'P1', pinned('Shifting Sliver'));
    const sliver = spawn(ctx, 'P1', body('Lab Sliver', { typeLine: 'Creature — Sliver' }));
    const bear = spawn(ctx, 'P1', body('Attacking Bear'));
    const blocker = spawn(ctx, 'P2', body('Bear'));
    const sliverBlocker = spawn(ctx, 'P2', body('Their Sliver', { typeLine: 'Creature — Sliver' }));
    const { offered } = combat(ctx, [sliver, bear]);
    expect(offered.get(blocker.id)).toEqual([bear.id]);
    expect(offered.get(sliverBlocker.id)).toEqual(expect.arrayContaining([sliver.id, bear.id]));
  });

  it('more than one — two blockers on Sunder Shaman are rejected and repaired to one', () => {
    const ctx = pod('sunder');
    const shaman = spawn(ctx, 'P1', pinned('Sunder Shaman'));
    const a = spawn(ctx, 'P2', body('Bear A'));
    const b = spawn(ctx, 'P2', body('Bear B'));
    const run = combat(ctx, [shaman], { [a.id]: shaman.id, [b.id]: shaman.id });
    expect(new Set(run.rejections)).toEqual(new Set(['maxBlockers']));
    expect(run.applied).toHaveLength(1);
  });

  it('more than one — the repair keeps a required blocker and never redirects it onto a full attacker', () => {
    const ctx = pod('sunder-required');
    const first = spawn(ctx, 'P1', pinned('Sunder Shaman'));
    const second = spawn(ctx, 'P1', pinned('Sunder Shaman'));
    const required = spawn(ctx, 'P2', body('Required Bear', { power: 1 }));
    required.mustBlockThisTurn = true;
    const other = spawn(ctx, 'P2', body('Other Bear', { power: 2 }));
    const third = spawn(ctx, 'P2', body('Third Bear', { power: 3 }));
    const run = combat(ctx, [first, second], {
      [required.id]: first.id,
      [other.id]: first.id,
      [third.id]: second.id,
    });
    expect(new Set(run.rejections)).toEqual(new Set(['maxBlockers']));
    expect(run.applied.sort()).toEqual(['Required Bear', 'Third Bear']);
  });

  it('more than one — a required blocker that cannot block alone never recruits a partner past the limit', () => {
    const ctx = pod('sunder-block-alone');
    const shaman = spawn(ctx, 'P1', pinned('Sunder Shaman'));
    const lonely = body('Lonely Bear', { power: 1 });
    registerCustomDef(ctx, { ...interpretCard(lonely), ruleStatics: [{ kind: 'cantBlockAlone' }] });
    const required = spawn(ctx, 'P2', lonely);
    required.mustBlockThisTurn = true;
    const other = spawn(ctx, 'P2', body('Other Bear', { power: 2 }));
    const run = combat(ctx, [shaman], { [required.id]: shaman.id, [other.id]: shaman.id });
    expect(run.rejections).toContain('maxBlockers');
    // Two blockers break the limit and one alone breaks "can't block alone", so the only legal
    // declaration with this attacker leaves the lonely creature out (CR 509.1c).
    expect(run.applied).not.toContain('Lonely Bear');
    expect(run.applied.length).toBeLessThanOrEqual(1);
  });

  it('more than one — one blocker is accepted', () => {
    const ctx = pod('sunder-one');
    const shaman = spawn(ctx, 'P1', pinned('Sunder Shaman'));
    const a = spawn(ctx, 'P2', body('Bear A'));
    const run = combat(ctx, [shaman], { [a.id]: shaman.id });
    expect(run.rejections).toEqual([]);
    expect(run.applied).toEqual(['Bear A']);
  });

  it('three or more — Rampaging Ceratops rejects two blockers and accepts three', () => {
    const ctx = pod('ceratops');
    const ceratops = spawn(ctx, 'P1', pinned('Rampaging Ceratops'));
    const bears = [0, 1, 2].map((n) => spawn(ctx, 'P2', body(`Bear ${n}`)));
    const two = combat(ctx, [ceratops], {
      [bears[0]!.id]: ceratops.id,
      [bears[1]!.id]: ceratops.id,
    });
    expect(new Set(two.rejections)).toEqual(new Set(['minBlockers']));
    expect(two.applied).toEqual([]);
    const life = playerById(ctx, 'P2').life;
    expect(life).toBeLessThan(40);

    const ctx3 = pod('ceratops-three');
    const ceratops3 = spawn(ctx3, 'P1', pinned('Rampaging Ceratops'));
    const bears3 = [0, 1, 2].map((n) => spawn(ctx3, 'P2', body(`Bear ${n}`)));
    const three = combat(
      ctx3,
      [ceratops3],
      Object.fromEntries(bears3.map((bear) => [bear.id, ceratops3.id])),
    );
    expect(three.rejections).toEqual([]);
    expect(three.applied).toHaveLength(3);
  });
});

describe('override-proven keywords', () => {
  const sibling = (name: string, typeLine: string, manaCost: string, oracleText: string) =>
    oracle({ name, typeLine, manaCost, oracleText });

  it('offspring — the interpreted cost and trigger equal the authored Tender Wildguide shape', () => {
    const coruscation = interpretCard(pinned('Coruscation Mage'));
    expect(coruscation.optionalAdditionalCost?.mechanic).toBe('offspring');
    const offspringTrigger = coruscation.triggers.find((t) =>
      t.description?.startsWith('Offspring'),
    );
    expect(offspringTrigger).toEqual({
      kind: 'triggered',
      trigger: { when: 'enters', subject: { kind: 'self' } },
      targets: [],
      effects: [
        {
          op: 'createTokenCopyOf',
          ref: 'source',
          count: { kind: 'optionalCostCount', mechanic: 'offspring' },
          powerOverride: 1,
          toughnessOverride: 1,
        },
      ],
      description: 'Offspring — create a 1/1 token copy',
    });
  });

  it('ravenous — X counters and the X>=5 draw trigger, as Jacked Rabbit authors them', () => {
    const tervigon = interpretCard(pinned('Tervigon'));
    expect(tervigon.ravenous).toBe(true);
    expect(tervigon.entersWithCounters).toEqual({ '+1/+1': { kind: 'xValue' } });
    expect(tervigon.triggers[0]).toEqual({
      kind: 'triggered',
      trigger: {
        when: 'enters',
        subject: { kind: 'self' },
        condition: { kind: 'announcedXAtLeast', n: 5 },
      },
      targets: [],
      effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }],
      description: 'Ravenous — draw a card if X was 5 or greater',
    });
    // Without an X in the mana cost, ravenous has nothing to read.
    expect(
      interpretCard(sibling('Fixed Ravenous', 'Creature — Tyranid', '{3}{G}', 'Ravenous')).modeled,
    ).toBe(false);
  });

  it('dash — the alternative cost Ragavan authors', () => {
    const riders = interpretCard(pinned('Riders of Rohan'));
    expect(riders.alternativeCasts).toEqual([
      {
        kind: 'nonMana',
        manaCost: expect.objectContaining({}),
        dashed: true,
        description: 'Dash {4}{R}{W}',
      },
    ]);
  });

  it('sneak — an instant or sorcery reads exactly as the authored New Generation’s Technique', () => {
    const donatello = interpretCard(pinned("Donatello's Technique"));
    expect(donatello.alternativeCasts).toEqual([
      {
        kind: 'nonMana',
        manaCost: expect.objectContaining({}),
        costs: [{ kind: 'returnUnblockedAttacker' }],
        instantTiming: true,
        condition: {
          kind: 'allOf',
          of: [{ kind: 'yourTurn' }, { kind: 'duringStep', step: 'declareBlockers' }],
        },
        description: 'Sneak {U} — return an unblocked attacker you control',
      },
    ]);
  });

  it('retired overrides — the formerly authored cards now model from the parser alone', () => {
    for (const name of ['Tender Wildguide', "New Generation's Technique"]) {
      const card = pinned(name);
      expect(getOverride(card.oracleId), name).toBeUndefined();
      expect(interpretCard(card).unmodeledReasons, name).toEqual([]);
    }
    const wildguide = interpretCard(pinned('Tender Wildguide'));
    expect(wildguide.optionalAdditionalCost?.mechanic).toBe('offspring');
    const technique = interpretCard(pinned("New Generation's Technique"));
    expect(technique.alternativeCasts?.[0]?.description).toBe(
      'Sneak {2}{G} — return an unblocked attacker you control',
    );
  });
});
