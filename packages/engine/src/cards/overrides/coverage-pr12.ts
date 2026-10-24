/** PR12 authored cards reopened by the quality audit. Review status is in the manifest. */
import { allOf, ofSubtype, ofSupertype, ofType } from '../selector';
import { spell } from '../templates';
import { constant } from '../value';
import { defineSpellFace } from './index';

export function registerCoveragePr12Overrides(): void {
  // PR12.05: the Omen face searches for up to two basic Forests, reveals them, puts one onto the
  // battlefield tapped and the other into its owner's hand, then shuffles. The card itself is
  // shuffled into its owner's library as the Omen spell resolves.
  defineSpellFace(
    'da1e019c-2ffb-412d-90d7-f2e5e5c44c4b',
    'Bloomvine Regent // Claim Territory',
    'Claim Territory',
    [
      'Search your library for up to two basic Forest cards, reveal them, put one onto the battlefield tapped and the other into your hand, then shuffle.',
    ],
    {
      spellAbility: spell({
        effects: [
          {
            op: 'searchLibrary',
            filter: allOf(ofSupertype('Basic'), ofSubtype('Forest')),
            destinations: [{ zone: 'battlefield', tapped: true }, { zone: 'hand' }],
            count: constant(2),
            reveal: true,
          },
          { op: 'shuffle' },
        ],
      }),
    },
  );

  // PR12.07: the Adventure face mills five, then returns a creature card milled this way. The
  // card is exiled on an Adventure as the spell resolves, and the artifact may be cast from there.
  defineSpellFace(
    '6d4e7943-1fdf-4085-8af0-658badbd0cb8',
    'Monster Manual // Zoological Study',
    'Zoological Study',
    ['Mill five cards, then return a creature card milled this way to your hand.'],
    {
      spellAbility: spell({
        effects: [{ op: 'millThenReturnMilledCard', count: 5, filter: ofType('Creature') }],
      }),
    },
  );
}
