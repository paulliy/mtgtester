import { describe, expect, it } from 'vitest';
import {
  buildCombatLane,
  combatRecap,
  damageStepsLeft,
  predictOutcome,
  withDeparted,
  type LaneInput,
  type LanePermanent,
} from './combatLane';

function creature(
  id: string,
  name: string,
  controller: string,
  power: number,
  toughness: number,
  extra: Partial<LanePermanent> = {},
): LanePermanent {
  return {
    id,
    name,
    controller,
    power,
    toughness,
    damageMarked: 0,
    tapped: false,
    keywords: [],
    attacking: null,
    blocking: null,
    blockedBy: [],
    ...extra,
  };
}

const seats = [
  { seat: 'P1', label: 'You', life: 40 },
  { seat: 'P2', label: 'Bob', life: 40 },
  { seat: 'P3', label: 'Cat', life: 40 },
];

function input(extra: Partial<LaneInput>): LaneInput {
  return {
    phase: 'combat',
    step: 'declareBlockers',
    priorityPlayer: null,
    viewerSeat: 'P1',
    permanents: [],
    seats,
    plan: null,
    ...extra,
  };
}

const both: ['first', 'regular'] = ['first', 'regular'];

describe('predictOutcome', () => {
  it('trades plain damage', () => {
    const ox = creature('a', 'Ox', 'P2', 4, 4);
    expect(predictOutcome(ox, [creature('b', 'Wall', 'P1', 0, 5)], 'P1', both, true)).toEqual({
      text: 'both survive',
      tone: 'neutral',
      trampled: 0,
    });
    expect(predictOutcome(ox, [creature('b', 'Bear', 'P1', 2, 2)], 'P1', both, true)?.text).toBe(
      'Bear dies',
    );
    expect(predictOutcome(ox, [creature('b', 'Ogre', 'P1', 5, 4)], 'P1', both, true)?.text).toBe(
      'both die',
    );
  });

  it('counts damage already marked', () => {
    const ox = creature('a', 'Ox', 'P2', 4, 4, { damageMarked: 3 });
    expect(predictOutcome(ox, [creature('b', 'Mole', 'P1', 1, 1)], 'P1', both, true)?.text).toBe(
      'both die',
    );
  });

  it('lets a first striker kill before it is hit', () => {
    const knight = creature('a', 'Knight', 'P2', 2, 2, { keywords: ['first strike'] });
    expect(
      predictOutcome(knight, [creature('b', 'Bear', 'P1', 2, 2)], 'P1', both, true)?.text,
    ).toBe('Bear dies');
    const blocker = creature('b', 'Fencer', 'P1', 2, 2, { keywords: ['first strike'] });
    expect(
      predictOutcome(creature('a', 'Bear', 'P2', 2, 2), [blocker], 'P1', both, true)?.text,
    ).toBe('Bear dies');
  });

  it('only counts the regular step once first strike damage is dealt', () => {
    const knight = creature('a', 'Knight', 'P2', 2, 2, { keywords: ['first strike'] });
    expect(predictOutcome(knight, [], 'P3', ['regular'], true)).toEqual({
      text: 'no damage',
      tone: 'neutral',
    });
  });

  it('doubles an unblocked double striker', () => {
    const twin = creature('a', 'Twin', 'P2', 3, 3, { keywords: ['double strike'] });
    expect(predictOutcome(twin, [], 'P3', both, true)?.text).toBe('6 to P3');
  });

  it('handles deathtouch and indestructible', () => {
    const snake = creature('a', 'Snake', 'P2', 1, 1, { keywords: ['deathtouch'] });
    expect(
      predictOutcome(snake, [creature('b', 'Giant', 'P1', 7, 7)], 'P1', both, true)?.text,
    ).toBe('both die');
    const god = creature('b', 'God', 'P1', 1, 1, { keywords: ['indestructible'] });
    expect(predictOutcome(creature('a', 'Ox', 'P2', 4, 4), [god], 'P1', both, true)?.text).toBe(
      'both survive',
    );
  });

  it('says trample damage over a blocker is at most the excess, since it is a choice', () => {
    const wurm = creature('a', 'Wurm', 'P2', 6, 6, { keywords: ['trample'] });
    expect(predictOutcome(wurm, [creature('b', 'Bear', 'P1', 2, 2)], 'P1', both, true)).toEqual({
      text: 'Bear dies, up to 4 tramples over',
      tone: 'danger',
      trampled: 4,
      upTo: true,
    });
  });

  it('sends all trample damage on once the blocker has left', () => {
    const wurm = creature('a', 'Wurm', 'P2', 6, 6, { keywords: ['trample'] });
    expect(predictOutcome(wurm, [], 'P1', both, true, true)).toEqual({
      text: 'blocker gone, 6 tramples over',
      tone: 'danger',
      trampled: 6,
    });
    const ox = creature('a', 'Ox', 'P2', 4, 4);
    expect(predictOutcome(ox, [], 'P1', both, true, true)?.text).toBe('blocked');
  });

  it('lets infect shrink a creature to death through indestructible', () => {
    const rat = creature('a', 'Rat', 'P2', 2, 2, { keywords: ['infect'] });
    const idol = creature('b', 'Idol', 'P1', 0, 2, { keywords: ['indestructible'] });
    expect(predictOutcome(rat, [idol], 'P1', both, true)?.text).toBe('Idol dies');
    // First-strike infect counters shrink the blocker before it strikes back.
    const fencer = creature('a', 'Fencer', 'P2', 1, 1, { keywords: ['infect', 'first strike'] });
    expect(predictOutcome(fencer, [creature('b', 'Imp', 'P1', 1, 3)], 'P1', both, true)?.text).toBe(
      'both survive',
    );
  });

  it('names poison for infect', () => {
    const rat = creature('a', 'Rat', 'P2', 2, 2, { keywords: ['infect'] });
    expect(predictOutcome(rat, [], 'P3', both, true)?.text).toBe('2 poison to P3');
  });

  it('says nothing it cannot know', () => {
    const ox = creature('a', 'Ox', 'P2', 4, 4);
    const knight = creature('b', 'Knight', 'P1', 2, 2, { keywords: ['protection from green'] });
    expect(predictOutcome(ox, [knight], 'P1', both, true)).toBeNull();
    expect(predictOutcome(ox, [], 'P1', both, false)).toBeNull();
    expect(predictOutcome(ox, [], 'P1', [], true)).toBeNull();
  });

  it('never guesses how an attacker splits its damage between blockers', () => {
    // Any division is legal, even all of it on one blocker, so only the attacker's fate is told.
    const ox = creature('a', 'Ox', 'P2', 4, 4);
    const two = [creature('b', 'Mole', 'P1', 1, 1), creature('c', 'Rat', 'P1', 1, 1)];
    expect(predictOutcome(ox, two, 'P1', both, true)?.text).toBe('Ox splits its damage');
    const big = [creature('b', 'Ogre', 'P1', 3, 3), creature('c', 'Elk', 'P1', 2, 3)];
    expect(predictOutcome(ox, big, 'P1', both, true)?.text).toBe('Ox dies, splitting its damage');
  });
});

describe('damageStepsLeft', () => {
  it('follows the damage steps', () => {
    expect(damageStepsLeft('declareBlockers', 'P1')).toEqual(['first', 'regular']);
    expect(damageStepsLeft('firstStrikeCombatDamage', 'P1')).toEqual(['regular']);
    expect(damageStepsLeft('combatDamage', 'P1')).toEqual([]);
    expect(damageStepsLeft('endCombat', null)).toEqual([]);
  });
});

describe('buildCombatLane', () => {
  it('is empty outside combat or with nobody attacking', () => {
    expect(buildCombatLane(input({ phase: 'precombatMain', step: null }))).toBeNull();
    expect(buildCombatLane(input({ step: 'beginCombat' }))).toBeNull();
  });

  it('opens one group per target while you choose attackers', () => {
    const ox = creature('ox', 'Lab Ox', 'P1', 4, 4);
    const hawk = creature('hawk', 'Lab Hawk', 'P1', 2, 2);
    const lane = buildCombatLane(
      input({
        step: 'declareAttackers',
        permanents: [ox, hawk],
        plan: {
          kind: 'attackers',
          assignment: new Map([['ox', 'P3']]),
          options: [
            ['P2', 'P3'],
            ['P2', 'P3'],
          ],
        },
      }),
    )!;
    expect(lane.kind).toBe('attackers');
    expect(lane.beat).toBe(0);
    expect(lane.groups.map((g) => g.targetId)).toEqual(['P2', 'P3']);
    expect(lane.groups[0]!.pairs).toEqual([]);
    expect(lane.groups[1]!.pairs.map((p) => p.attacker.id)).toEqual(['ox']);
    expect(lane.groups[1]!.pairs[0]!.attacker.pending).toBe(true);
    expect(lane.groups[1]!.lifeAfter).toBe(36);
    expect(lane.groups[1]!.ifUnblocked).toBe(true);
  });

  it('leaves infect out of the life preview while you choose attackers', () => {
    const rat = creature('rat', 'Lab Rat', 'P1', 2, 2, { keywords: ['infect'] });
    const ox = creature('ox', 'Lab Ox', 'P1', 4, 4);
    const plan = (assignment: Map<string, string>) =>
      input({
        step: 'declareAttackers',
        permanents: [rat, ox],
        plan: { kind: 'attackers', assignment, options: [['P2'], ['P2']] },
      });
    expect(buildCombatLane(plan(new Map([['rat', 'P2']])))!.groups[0]!.lifeAfter).toBeNull();
    const both = new Map([
      ['rat', 'P2'],
      ['ox', 'P2'],
    ]);
    expect(buildCombatLane(plan(both))!.groups[0]!.lifeAfter).toBe(36);
  });

  it('previews your blocks and leaves the other defender alone', () => {
    const ox = creature('ox', 'Lab Ox', 'P2', 4, 4, { attacking: 'P1', tapped: true });
    const servo = creature('servo', 'Lab Servo', 'P2', 1, 1, { attacking: 'P1' });
    const hawk = creature('hawk', 'Lab Hawk', 'P2', 2, 2, { attacking: 'P3' });
    const wall = creature('wall', 'Lab Wall', 'P1', 0, 5);
    const bear = creature('bear', 'Lab Bear', 'P1', 2, 2);
    const lane = buildCombatLane(
      input({
        permanents: [ox, servo, hawk, wall, bear],
        plan: {
          kind: 'blockers',
          assignment: new Map([['wall', 'ox']]),
          options: [
            ['ox', 'servo'],
            ['ox', 'servo'],
          ],
        },
      }),
    )!;
    expect(lane.kind).toBe('blockers');
    expect(lane.beat).toBe(1);
    const [you, p3] = lane.groups;
    expect(you!.targetId).toBe('P1');
    expect(you!.yours).toBe(true);
    expect(you!.pairs[0]!.blockers.map((b) => b.id)).toEqual(['wall']);
    expect(you!.pairs[0]!.blockers[0]!.pending).toBe(true);
    expect(you!.pairs[0]!.outcome?.text).toBe('both survive');
    expect(you!.pairs[1]!.blockable).toBe(true);
    expect(you!.pairs[1]!.outcome?.text).toBe('1 to P1');
    expect(you!.lifeAfter).toBe(39);
    expect(you!.ifUnblocked).toBe(false);
    expect(p3!.yours).toBe(false);
    expect(p3!.pairs[0]!.blockable).toBe(false);
    expect(p3!.pairs[0]!.outcome).toBeNull();
    expect(p3!.ifUnblocked).toBe(true);
  });

  it('shows trample life loss as the lowest it can go, and keeps it after the blocker leaves', () => {
    const wurm = creature('wurm', 'Lab Wurm', 'P2', 6, 6, {
      keywords: ['trample'],
      attacking: 'P1',
      blockedBy: ['bear'],
    });
    const bear = creature('bear', 'Lab Bear', 'P1', 2, 2, { blocking: 'wurm' });
    const blocked = buildCombatLane(input({ priorityPlayer: 'P2', permanents: [wurm, bear] }))!
      .groups[0]!;
    expect(blocked.lifeAfter).toBe(36);
    expect(blocked.atLowest).toBe(true);
    const gone = buildCombatLane(input({ priorityPlayer: 'P2', permanents: [wurm] }))!.groups[0]!;
    expect(gone.pairs[0]!.outcome?.text).toBe('blocker gone, 6 tramples over');
    expect(gone.lifeAfter).toBe(34);
    expect(gone.atLowest).toBe(false);
  });

  it('shows no life total when part of the change to it is not known yet', () => {
    const bear = creature('bear', 'Lab Bear', 'P2', 2, 2, { attacking: 'P1' });
    const wurm = creature('wurm', 'Lab Wurm', 'P2', 6, 6, {
      keywords: ['trample'],
      attacking: 'P1',
      blockedBy: ['m1', 'm2'],
    });
    const m1 = creature('m1', 'Lab Mole', 'P1', 1, 1, { blocking: 'wurm' });
    const m2 = creature('m2', 'Lab Rat', 'P1', 1, 1, { blocking: 'wurm' });
    const split = buildCombatLane(
      input({ priorityPlayer: 'P2', permanents: [bear, wurm, m1, m2] }),
    );
    expect(split!.groups[0]!.lifeAfter).toBeNull();

    const ox = creature('ox', 'Lab Ox', 'P2', 1, 4, { attacking: 'P1', blockedBy: ['priest'] });
    const priest = creature('priest', 'Lab Priest', 'P1', 3, 3, {
      keywords: ['lifelink'],
      blocking: 'ox',
    });
    const linked = buildCombatLane(input({ priorityPlayer: 'P2', permanents: [bear, ox, priest] }));
    expect(linked!.groups[0]!.lifeAfter).toBeNull();
    expect(
      buildCombatLane(input({ priorityPlayer: 'P2', permanents: [bear] }))!.groups[0]!.lifeAfter,
    ).toBe(38);
  });

  it('reads declared blocks and puts an attacker on a planeswalker under the walker', () => {
    const jace = creature(
      'jace',
      'Jace',
      'P3',
      null as unknown as number,
      null as unknown as number,
    );
    const ox = creature('ox', 'Lab Ox', 'P1', 4, 4, {
      attacking: 'P3',
      attackingPlaneswalker: 'jace',
      blockedBy: [],
    });
    const lane = buildCombatLane(
      input({ step: 'declareBlockers', priorityPlayer: 'P1', permanents: [ox, jace] }),
    )!;
    expect(lane.kind).toBe('declared');
    expect(lane.title).toBe('Blocks are in');
    expect(lane.groups[0]!.label).toBe('Jace');
    expect(lane.groups[0]!.life).toBeNull();
    expect(lane.groups[0]!.yours).toBe(true);
    expect(lane.groups[0]!.pairs[0]!.outcome?.text).toBe('4 to Jace');
  });

  it('adds a first strike beat when someone has it', () => {
    const knight = creature('k', 'Knight', 'P1', 2, 2, {
      attacking: 'P2',
      keywords: ['first strike'],
    });
    const lane = buildCombatLane(
      input({ step: 'firstStrikeCombatDamage', priorityPlayer: 'P1', permanents: [knight] }),
    )!;
    expect(lane.beats).toEqual(['Attack', 'Block', 'First strike', 'Damage']);
    expect(lane.beat).toBe(2);
  });
});

describe('withDeparted and combatRecap', () => {
  const ox = creature('ox', 'Lab Ox', 'P2', 4, 4, { attacking: 'P1', blockedBy: ['wall'] });
  const servo = creature('servo', 'Lab Servo', 'P2', 1, 1, {
    attacking: 'P1',
    blockedBy: ['bear'],
  });
  const wall = creature('wall', 'Lab Wall', 'P1', 0, 5, { blocking: 'ox' });
  const bear = creature('bear', 'Lab Bear', 'P1', 2, 2, { blocking: 'servo' });
  const before = buildCombatLane(
    input({ step: 'declareBlockers', priorityPlayer: 'P2', permanents: [ox, servo, wall, bear] }),
  )!;

  it('keeps a creature that fell in combat, struck through', () => {
    const after = buildCombatLane(
      input({
        step: 'combatDamage',
        priorityPlayer: 'P2',
        permanents: [{ ...ox }, { ...wall, damageMarked: 4 }, { ...bear, damageMarked: 1 }],
      }),
    )!;
    const merged = withDeparted(after, before, new Set(['ox', 'wall', 'bear']));
    const pairs = merged.groups[0]!.pairs;
    expect(pairs.map((p) => p.attacker.id)).toEqual(['ox', 'servo']);
    expect(pairs[1]!.attacker.gone).toBe(true);
    expect(pairs[1]!.blockers.map((b) => b.id)).toEqual(['bear']);
    expect(pairs[1]!.outcome?.text).toBe('Lab Servo left the battlefield');
  });

  it('says a regenerated attacker was removed from combat, not that it left', () => {
    const after = buildCombatLane(
      input({
        step: 'combatDamage',
        priorityPlayer: 'P2',
        permanents: [{ ...ox }, { ...servo, attacking: null, blockedBy: [] }, wall, bear],
      }),
    )!;
    const merged = withDeparted(after, before, new Set(['ox', 'servo', 'wall', 'bear']));
    const servoPair = merged.groups[0]!.pairs[1]!;
    expect(servoPair.attacker.gone).toBeFalsy();
    expect(servoPair.outcome?.text).toBe('Lab Servo was removed from combat');
  });

  it('folds into one line', () => {
    const after = withDeparted(
      buildCombatLane(
        input({ step: 'endCombat', priorityPlayer: 'P2', permanents: [ox, wall, bear] }),
      )!,
      before,
      new Set(['ox', 'wall', 'bear']),
    );
    const now = seats.map((s) => (s.seat === 'P3' ? { ...s, life: 38 } : s));
    expect(
      combatRecap(
        after,
        'P2',
        new Map([
          ['P1', 40],
          ['P3', 40],
        ]),
        now,
        'P1',
      ),
    ).toBe('P2 attacked you · Lab Servo left the battlefield · P3 40 → 38');
    expect(combatRecap(before, 'P2', new Map([['P1', 40]]), seats, 'P1')).toBe(
      'P2 attacked you · no damage to players',
    );
  });
});
