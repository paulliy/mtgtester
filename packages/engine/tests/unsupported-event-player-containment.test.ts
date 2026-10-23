import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computePriorityOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { createGame } from '../src/state/game';
import { cloneContractContext } from './helpers/contract-harness';
import { conjure, copies, forest, gameConfig } from './fixtures';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/unsupported-event-player-oracle.json', import.meta.url), 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
const expectedPins: Record<string, string> = {
  'Black Bolt, Inhuman King': 'db53d857faae9d00e9f233eae5e77aaefaf2798661c14cc011220e1f7e5a5c23',
  'Blur of Blades': 'ea522ddfaffffbcb02069421f8a25bba4867265aa0281ac0b9b4bfcb76e80dc7',
  'Consign to the Pit': '432ac6b2fdf0e5ca024d50ffc83ff7c4678a76afc4d1f3126d4c9a3d5fef3f06',
  'Dingus Staff': 'fa26a662e0d1a4e2bdabcbb0164f9e7d8df110cd13333ee0af014c9e00c5a825',
  Insolence: '27763625e27b1e341fb84b8ec0ad0699da88842e1fb68d3cdcfedc28cfa1565e',
  'Scalelord Reckoner': 'a6a82e4dd70176ed433a4e46d925a47cf78b67c1d75217f031d10d1a75fb54dc',
};
const caseIds: Record<string, string> = {
  'Black Bolt, Inhuman King': 'black-bolt-inhuman-king-event-player-contained',
  'Blur of Blades': 'blur-of-blades-event-player-contained',
  'Consign to the Pit': 'consign-to-the-pit-event-player-contained',
  'Dingus Staff': 'dingus-staff-event-player-contained',
  Insolence: 'insolence-event-player-contained',
  'Scalelord Reckoner': 'scalelord-reckoner-event-player-contained',
};
const becomesTargeted = ['Scalelord Reckoner'];
const pinnedNames = [
  'Black Bolt, Inhuman King',
  'Blur of Blades',
  'Consign to the Pit',
  'Dingus Staff',
  'Insolence',
  'Scalelord Reckoner',
];
// Coverage PR12 models these two with engine and Card Test Lab evidence (pr12-*.test.ts).
const retired = ['Black Bolt, Inhuman King', 'Dingus Staff'];
const names = pinnedNames.filter((name) => !retired.includes(name));
describe('printed clauses with unsupported event-player provenance remain contained', () => {
  it('covers exactly the six independently identified Oracle consumers', () =>
    expect(fixture.cards.map(({ card }) => card.name)).toEqual(pinnedNames));
  it('the two consumers modeled in coverage PR12 interpret with every reason cleared', () => {
    for (const name of retired) {
      const pin = fixture.cards.find(({ card }) => card.name === name)!;
      expect(pin.sha256).toBe(expectedPins[name]);
      for (const oracleId of [pin.card.oracleId, fixtureOracleId(name)])
        expect(interpretCard({ ...pin.card, oracleId }).unmodeledReasons, name).toEqual([]);
    }
  });
  for (const name of names)
    it(`${caseIds[name]}: ${name} rejects normal action generation for both Oracle identities without mutation`, () => {
      const pin = fixture.cards.find(({ card }) => card.name === name)!;
      expect(pin.sha256).toBe(expectedPins[name]);
      expect(createHash('sha256').update(JSON.stringify(pin.card)).digest('hex')).toBe(pin.sha256);
      for (const oracleId of [pin.card.oracleId, fixtureOracleId(name)]) {
        const card = { ...pin.card, oracleId };
        const def = interpretCard(card);
        expect(def.modeled).toBe(false);
        expect(def.unmodeledReasons.join('; ')).toContain(
          // Scalelord Reckoner is read now that the targeting player is bound as the event player
          // (coverage PR06), and is contained explicitly until it has evidence.
          becomesTargeted.includes(name)
            ? 'explicitly unsupported: No focused engine or Card Test Lab evidence yet'
            : 'event player reference has no owning event player scope',
        );
        const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
        ctx.state.currentTurnPlayer = 'P1';
        ctx.state.phase = 'precombatMain';
        conjure(ctx, 'P1', card, 'hand');
        const before = cloneContractContext(ctx);
        expect(() => computePriorityOptions(ctx, ctx.state.players[0]!)).toThrow('Unmodeled card');
        expect(ctx.state).toEqual(before.state);
        expect(ctx.debugLog).toEqual(before.debugLog);
        expect(ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
      }
    });
});
