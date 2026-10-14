import { replaceCard } from './index';

export function registerWhiteBlackControlLibraryOverrides(): void {
  replaceCard(
    '867def48-4be8-4056-bcf1-d6b00450b9a3',
    'Library of Leng',
    [
      'unrecognized rules text: "If an effect causes you to discard a card, discard it, but you may put it on top of your library instead of into your graveyard."',
    ],
    { ruleStatics: [{ kind: 'noMaximumHandSize' }, { kind: 'effectDiscardMayGoToLibraryTop' }] },
    'Preserves unlimited hand size and optionally redirects effect discards only; hidden discarded card characteristics are undefined under CR 701.9c.',
  );
}
