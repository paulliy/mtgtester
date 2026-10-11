/**
 * Audited Token Triumph support contract shared by the card suites and CLI gates.
 *
 * Keep these lists explicit. A card moves from EXPECTED_UNSUPPORTED_TOKEN_TRIUMPH_CARDS only
 * after it meets docs/guides/card-modeling-and-testing.md; aggregate parser coverage alone is
 * not enough.
 */
export const VERIFIED_TOKEN_TRIUMPH_CARDS = [
  'Harvest Season',
  'Rishkar, Peema Renegade',
  'Sylvan Reclamation',
  'Thunderfoot Baloth',
  'Voice of Many',
  'Emmara, Soul of the Accord',
  'Leafkin Druid',
  'Fortified Village',
  'Overwhelming Instinct',
  'Ajani, Caller of the Pride',
  'Mentor of the Meek',
  "Commander's Insignia",
  'Loyal Guardian',
  'Dawn of Hope',
  'Hornet Nest',
  'Trostani Discordant',
  'Slate of Ancestry',
  'Felidar Retreat',
  'Great Oak Guardian',
  'Path to Exile',
  'Rootborn Defenses',
  'Scavenging Ooze',
] as const;

export const EXPECTED_UNSUPPORTED_TOKEN_TRIUMPH_CARDS = ['Champion of Lambholt'] as const;
