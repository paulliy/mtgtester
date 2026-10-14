import { replaceCard } from './index';

export function registerWhiteBlackControlLeylineOverrides(): void {
  replaceCard('f4e32fc1-1b8d-441e-8e76-71f19f98e925', 'Leyline of the Void', [
    'unrecognized rules text: "If this card is in your opening hand, you may begin the game with it on the battlefield."',
    'unrecognized rules text: "If a card would be put into an opponent\'s graveyard from anywhere, exile it instead."',
  ], { ruleStatics: [{ kind: 'beginOnBattlefieldFromOpeningHand' },
    { kind: 'graveyardToExile', scope: 'opponents', basis: 'owner', includeTokens: false }] },
  'Offers the optional battlefield action after all mulligans, and redirects opponent-owned cards but not tokens.');
}
