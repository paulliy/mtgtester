import { unsupportedCard } from './index';

/** Confirmed face omissions are support exclusions until every printed face is faithful. */
export function registerUnsupportedSpellFaces(): void {
  unsupportedCard(
    'da1e019c-2ffb-412d-90d7-f2e5e5c44c4b',
    'Bloomvine Regent // Claim Territory',
    'Claim Territory must search for up to two basic Forests, reveal them, put one onto the battlefield tapped and the other into hand, and shuffle; the former single basic-land-to-hand substitute was incorrect.',
  );
  unsupportedCard(
    '099b8d2c-b482-48dd-b6bc-dedf546d66c5',
    'Marang River Regent // Coil and Catch',
    'Coil and Catch must draw three cards, then discard a card, and shuffle this card into its owner’s library; the former targeted bounce substitute was incorrect.',
  );
  unsupportedCard(
    '6d4e7943-1fdf-4085-8af0-658badbd0cb8',
    'Monster Manual // Zoological Study',
    'Zoological Study must mill five cards and return a creature card milled this way to hand, then exile this card with its Adventure permission; modeling only the artifact face omits an executable spell face.',
  );
}
