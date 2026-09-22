import { describe, expect, it } from 'vitest';
import { assessThreats, ThreatTracker } from './index';
import { capabilities, developmentCases, fixtureView, permanent, request } from './fixtures';
import { recentPressure } from './history';
import { pressureMatrix } from './features';
import { summarizeThreats } from './explain';

const assess = (view = fixtureView()) =>
  assessThreats(view, {
    ...request,
    phase: view.threatFacts?.phase ?? request.phase,
    step: view.threatFacts?.step ?? null,
  });
describe('threat development positions', () => {
  for (const c of developmentCases())
    it(c.name, () => {
      const result = assess(c.view);
      expect(c.acceptable).toContain(result.opponents[0]?.seat);
      expect(
        result.opponents
          .filter((o) => o.urgency < 4)
          .map((o) => o.seat)
          .sort(),
      ).toEqual([...c.urgent].sort());
      expect(assess(c.view)).toEqual(result);
      expect(result.opponents.every((o) => o.strategicScore >= 0 && o.strategicScore <= 100)).toBe(
        true,
      );
    });
});
describe('threat invariants', () => {
  it('unknown does not become zero or a confidence-discounted score', () => {
    const o = assess().opponents[0]!;
    expect(o.components.W.value).toBeNull();
    expect(o.components.W.range).toEqual([0, 1]);
    expect(o.scoreRange[1]).toBeGreaterThan(o.strategicScore);
    expect(assess().search).toBe('unknown');
  });
  it('does not encode own private identities or irrelevant hidden fields', () => {
    const a = fixtureView(),
      b = structuredClone(a);
    b.hand = [{ id: 'secret', name: 'Secret counterspell' }];
    b.deck = [{ id: 'secret-deck', name: 'Private combo' }];
    Object.assign(b.opponents[0]!, { hand: ['SECRET'] });
    expect(assess(a)).toEqual(assess(b));
    expect(JSON.stringify(assess(b))).not.toContain('SECRET');
  });
  it('excludes self and eliminated opponents', () => {
    const v = fixtureView();
    v.opponents[0]!.seat = v.seat;
    v.threatFacts!.turnOrder = ['P1', 'P3'];
    expect(assess(v).opponents.map((o) => o.seat)).toEqual(['P3']);
  });
  it('mana alternatives cannot double count colors, modes, restricted or tapped sources', () => {
    const v = fixtureView();
    v.battlefield = [
      permanent('mana', 'P2', 0, {
        capabilities: capabilities({
          mana: [
            { units: [['W', 'U', 'B', 'R', 'G']], available: true, restricted: false },
            { units: [['C'], ['C']], available: true, restricted: false },
            { units: [['G'], ['G'], ['G']], available: true, restricted: true },
            { units: Array.from({ length: 10 }, () => ['U']), available: false, restricted: false },
          ],
        }),
      }),
    ];
    expect(assess(v).opponents.find((o) => o.seat === 'P2')!.components.M.value).toBe(2 / 12);
    v.battlefield = [];
    expect(assess(v).opponents[0]!.components.M.value).toBe(0);
  });
  it('increasing feasible damage cannot lower combat pressure', () => {
    const v = fixtureView();
    v.battlefield = [permanent('attacker')];
    const before = assess(v).opponents[0]!.components.C.value!;
    v.battlefield[0]!.power = 10;
    expect(assess(v).opponents[0]!.components.C.value).toBeGreaterThanOrEqual(before);
  });
  it('removing engine capability lowers its component immediately', () => {
    const v = developmentCases().find((c) => c.category === 'engines')!.view;
    const before = assess(v).opponents[0]!.components.E.value!;
    v.battlefield[0]!.capabilities!.engines = [];
    expect(assess(v).opponents.find((o) => o.seat === 'P2')!.components.E.value).toBeLessThan(
      before,
    );
  });
  it('history preserves direction, excludes self damage, and decays by table rounds', () => {
    const events = [
      { sequence: 1, turn: 4, actor: 'P2', recipient: 'P1', amount: 10, kind: 'combat' as const },
    ];
    expect(recentPressure(events, 'P2', 'P1', 8, 4)).toBeCloseTo(7);
    expect(recentPressure(events, 'P2', 'P3', 8, 4)).toBe(0);
    expect(recentPressure([...events, ...events], 'P2', 'P1', 8, 4)).toBeCloseTo(7);
    expect(recentPressure([{ ...events[0]!, recipient: 'P2' }], 'P2', 'P2', 8, 4)).toBe(0);
  });
  it('changing attack direction changes direct danger, not total hypothetical simultaneous damage', () => {
    const v = developmentCases().find((c) => c.name === 'declared lethal to us')!.view;
    expect(assess(v).opponents[0]!.directDanger).toBe(100);
    v.battlefield[0]!.capabilities!.attacking = 'P3';
    expect(assess(v).opponents[0]!.directDanger).toBe(0);
    expect(
      pressureMatrix(v).find((p) => p.actor === 'P2' && p.recipient === 'P1')!.upperDamage,
    ).toBe(0);
  });
  it('commander damage is per commander, never summed across partners', () => {
    const v = developmentCases().find((c) => c.name === 'declared lethal to us')!.view;
    v.battlefield[0]!.power = 2;
    v.battlefield[0]!.capabilities!.commanderId = 'cmd-a';
    v.threatFacts!.players[0]!.commanderDamage = { 'cmd-a': 10, 'cmd-b': 10 };
    expect(assess(v).opponents[0]!.urgency).toBe(4);
    v.threatFacts!.players[0]!.commanderDamage['cmd-a'] = 19;
    expect(assess(v).opponents[0]!.urgency).toBe(2);
  });
  it('infect uses engine-projected poison threshold and excludes normal life damage', () => {
    const v = developmentCases().find((c) => c.name === 'declared lethal to us')!.view;
    v.battlefield[0]!.power = 2;
    v.battlefield[0]!.keywords = ['infect'];
    v.threatFacts!.players[0]!.poison = 8;
    expect(assess(v).opponents[0]!.urgency).toBe(2);
    v.threatFacts!.rules.poisonLoss = 11;
    expect(assess(v).opponents[0]!.urgency).toBe(4);
  });
  it('does not count an already dealt first strike again', () => {
    const v = developmentCases().find((c) => c.name === 'declared lethal to us')!.view;
    v.threatFacts!.step = 'combatDamage';
    v.battlefield[0]!.keywords = ['first strike'];
    expect(assess(v).opponents[0]!.urgency).toBe(4);
  });
  it('earlier stack deadlines override strategic board strength', () => {
    const v = developmentCases().find((c) => c.category === 'deadlines')!.view;
    const a = assess(v);
    expect(a.opponents[0]!.seat).toBe('P2');
    expect(a.opponents[0]!.urgentEvents[0]!.forced).toBe(false);
    expect(summarizeThreats(a).opponents[0]!.urgent[0]!.sources).toEqual(['burn']);
  });
  it('cache invalidates on sequence, timing, direction, history, observer and removed sources', () => {
    const tracker = new ThreatTracker(),
      v = fixtureView();
    expect(tracker.assess(v, request).cached).toBe(false);
    expect(tracker.assess(v, request).cached).toBe(true);
    v.threatFacts!.sequence++;
    expect(tracker.assess(v, request).cached).toBe(false);
    v.battlefield.push(permanent('new'));
    expect(tracker.assess(v, request).cached).toBe(false);
    v.battlefield = [];
    expect(
      tracker.assess(v, request).assessment.opponents.find((o) => o.seat === 'P2')!.changes,
    ).toContain('Source removed: new');
    expect(tracker.assess(v, { ...request, turn: 9 }).cached).toBe(false);
  });
  it('preserves near ties, bypassing display stabilization on source removal and urgent events', () => {
    const tracker = new ThreatTracker(),
      v = fixtureView();
    v.battlefield = [permanent('p2', 'P2', 5), permanent('p3', 'P3', 4)];
    expect(tracker.assess(v, request).assessment.displayedLeader).toBe('P2');
    v.battlefield[1]!.power = 6;
    const next = tracker.assess(v, request).assessment;
    expect(next.opponents[0]!.seat).toBe('P3');
    expect(next.displayedLeader).toBe('P2');
    v.battlefield.shift();
    expect(tracker.assess(v, request).assessment.displayedLeader).toBe('P3');
  });
  it('consistent seat renaming preserves scores and directions', () => {
    const v = developmentCases().find((c) => c.name === 'declared lethal to us')!.view;
    const renamed = JSON.parse(
      JSON.stringify(v)
        .replaceAll('P1', 'seat-a')
        .replaceAll('P2', 'seat-b')
        .replaceAll('P3', 'seat-c')
        .replaceAll('P4', 'seat-d'),
    ) as typeof v;
    const a = assess(v),
      b = assess(renamed);
    expect(b.opponents.map((o) => [o.strategicScore, o.directDanger, o.urgency])).toEqual(
      a.opponents.map((o) => [o.strategicScore, o.directDanger, o.urgency]),
    );
  });
  it('missing projected capabilities remain unknown instead of zero', () => {
    const v = fixtureView();
    v.battlefield = [permanent('legacy')];
    delete v.battlefield[0]!.capabilities;
    const opponent = assess(v).opponents.find((o) => o.seat === 'P2')!;
    expect(opponent.components.M.value).toBeNull();
    expect(opponent.components.E.status).toBe('unknown');
  });
  it('next-combat upper bound stays separate from current tapped-source danger', () => {
    const v = fixtureView();
    v.battlefield = [permanent('tapped', 'P2', 10, { tapped: true })];
    const pair = assess(v).pressure.find((p) => p.actor === 'P2' && p.recipient === 'P1')!;
    expect(pair.damage).toBe(0);
    expect(pair.nextCombatUpperDamage).toBe(10);
  });
});
