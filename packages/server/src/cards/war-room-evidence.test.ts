import type { DecisionRequest, LegalAction } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import {
  chooseWarRoomEvidence,
  driveWarRoomEvidence,
  verifyWarRoomRun,
  verifyWarRoomReplay,
  WAR_ROOM_TRACE_PATHS,
} from '../../../../scripts/generate-war-room-evidence';

const draw = 'war-room-viewer-dynamic-life-activation';
const mana = 'war-room-viewer-colorless-mana';
function request(actions: LegalAction[]): DecisionRequest {
  return { requestId: 'evidence-choice', legalActions: actions } as DecisionRequest;
}
const pass = { id: 9, type: 'pass', description: 'Pass' };
const activate = {
  id: 3,
  type: 'activateAbility',
  description: "War Room: Pay life equal to your commanders' color identity colors: draw a card",
};
const cast = { id: 5, type: 'castSpell', description: 'Cast War Room Mana Sink ({1})' };

describe('War Room evidence generator behavior', () => {
  it.each([
    [draw, activate],
    [mana, cast],
  ] as const)('chooses the expected typed action for %s', (id, action) => {
    expect(chooseWarRoomEvidence(id, request([pass, action]), false).actionId).toBe(action.id);
    expect(chooseWarRoomEvidence(id, request([pass]), true).actionId).toBe(pass.id);
  });
  it.each(
    [
      [],
      [cast],
      [{ ...activate, type: 'castSpell' }],
      [pass, { id: 7, type: 'discard', description: 'Unexpected' }],
      [activate, { ...activate, id: 8 }],
    ].map((actions) => ({ actions })),
  )('rejects unexpected draw menus %#', ({ actions }) => {
    expect(() => chooseWarRoomEvidence(draw, request(actions), false)).toThrow(/War Room evidence/);
  });
  it('rejects missing required first action even when a pass exists', () => {
    expect(() => chooseWarRoomEvidence(mana, request([pass]), false)).toThrow(/War Room evidence/);
  });
  it('leaves the new browser trace unresolved until an actual browser result exists', () => {
    expect(WAR_ROOM_TRACE_PATHS[mana]).toBeNull();
  });
  it.each([draw, mana] as const)(
    'verifies exact costs, resolution, events and replay for %s',
    (id) => {
      const run = driveWarRoomEvidence(id);
      expect(() => verifyWarRoomRun(run)).not.toThrow();
      const replay = driveWarRoomEvidence(id);
      verifyWarRoomReplay(run, replay);
      const wrongReplay = { ...replay, eventLogSha256: 'wrong' };
      expect(() => verifyWarRoomReplay(run, wrongReplay)).toThrow(/War Room evidence/);
      expect(replay.finalStateSha256).toBe(run.finalStateSha256);
      expect(replay.eventLogSha256).toBe(run.eventLogSha256);
      if (id === draw) {
        expect(run.initial.players[0]!.hand).toHaveLength(2);
        expect(run.settled!.state.players[0]!.hand).toHaveLength(3);
        expect(replay.settled).toEqual(run.settled);
        const missingWitness = structuredClone(run);
        missingWitness.settled!.request.legalActions =
          missingWitness.settled!.request.legalActions.filter(
            (action) => action.description !== 'Cast War Room Action Witness ({0})',
          );
        expect(() => verifyWarRoomRun(missingWitness)).toThrow(/missing retained legal witness/);
      }
      const wrongLife = structuredClone(run);
      wrongLife.final.players[0]!.life--;
      expect(() => verifyWarRoomRun(wrongLife)).toThrow(/War Room evidence/);
      const wrongPayment = structuredClone(run);
      wrongPayment.paymentAction.data!['paymentSourceNames'] = [];
      expect(() => verifyWarRoomRun(wrongPayment)).toThrow(/War Room evidence/);
      const wrongHand = structuredClone(run);
      wrongHand.final.players[0]!.hand = [];
      if (id === draw) expect(() => verifyWarRoomRun(wrongHand)).toThrow(/War Room evidence/);
      const wrongTaps = structuredClone(run);
      wrongTaps.final.battlefield[0]!.tapped = false;
      expect(() => verifyWarRoomRun(wrongTaps)).toThrow(/War Room evidence/);
      const wrongEvent = structuredClone(run);
      wrongEvent.final.eventLog = wrongEvent.final.eventLog.filter(
        (event) => event.type !== 'resolved',
      );
      expect(() => verifyWarRoomRun(wrongEvent)).toThrow(/War Room evidence/);
    },
  );
});
