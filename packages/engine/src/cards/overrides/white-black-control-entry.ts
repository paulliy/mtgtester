/** Entry replacements and entry/death trigger suppression for white-black-control. */

import { allOf, anyOf, not, ofSupertype, ofType, OPPONENTS } from '../selector';
import { replaceCard } from './index';

const OPPONENT_CREATURES = allOf(ofType('Creature'), OPPONENTS);
const OPPONENT_NONBASIC_LANDS = allOf(
  ofType('Land'),
  not(ofSupertype('Basic')),
  OPPONENTS,
);
const ARTIFACTS_OR_CREATURES = anyOf(ofType('Artifact'), ofType('Creature'));

export function registerWhiteBlackControlEntryOverrides(): void {
  replaceCard(
    '55f3c721-e13a-406e-bc8e-d6cdc91ac477',
    'Authority of the Consuls',
    ['unrecognized rules text: "Creatures your opponents control enter tapped."'],
    {
      ruleStatics: [{ kind: 'otherPermanentsEnterTapped', filter: OPPONENT_CREATURES }],
    },
    'Makes opposing creatures enter tapped while preserving Authority’s already parsed life-gain trigger.',
  );

  replaceCard(
    'ceef2d5a-77ea-4e56-9806-fd1a2d5be400',
    'Archon of Emeria',
    [
      `unrecognized rules text: "Each player can't cast more than one spell each turn."`,
      'unrecognized rules text: "Nonbasic lands your opponents control enter tapped."',
    ],
    {
      ruleStatics: [
        { kind: 'spellCastLimit', category: 'any', limit: 1 },
        { kind: 'otherPermanentsEnterTapped', filter: OPPONENT_NONBASIC_LANDS },
      ],
    },
    'Applies Archon’s per-player spell limit and opponent nonbasic-land entry replacement; its parsed flying remains intact.',
  );

  replaceCard(
    '0eaea4fd-a377-4541-9bdd-14921034a975',
    'Doorkeeper Thrull',
    [
      `unrecognized rules text: "Artifacts and creatures entering don't cause abilities to trigger."`,
    ],
    {
      ruleStatics: [
        { kind: 'suppressObjectTriggers', events: ['enters'], filter: ARTIFACTS_OR_CREATURES },
      ],
    },
    'Suppresses enters triggers caused by artifact or creature entrants while retaining the parsed flash and flying keywords.',
  );

  replaceCard(
    'aecc621f-67da-41a7-9d47-05ded302ae35',
    'Karn, Argent Defender',
    [
      `unrecognized rules text: "Artifacts and creatures entering the battlefield don't cause abilities to trigger."`,
    ],
    {
      ruleStatics: [
        { kind: 'suppressObjectTriggers', events: ['enters'], filter: ARTIFACTS_OR_CREATURES },
      ],
    },
    'Suppresses enters triggers caused by artifact or creature entrants while retaining Karn’s printed artifact-creature characteristics.',
  );

  replaceCard(
    '3d21f710-6bbc-41ae-a8e5-02debe3e02bd',
    'Hushbringer',
    [
      `unrecognized rules text: "Creatures entering or dying don't cause abilities to trigger."`,
    ],
    {
      ruleStatics: [
        { kind: 'suppressObjectTriggers', events: ['enters', 'dies'], filter: ofType('Creature') },
      ],
    },
    'Suppresses creature enters and dies triggers while keeping Hushbringer’s parsed flying and lifelink.',
  );
}
