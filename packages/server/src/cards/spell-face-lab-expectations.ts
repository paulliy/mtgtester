/** Independent printed-clause outcomes. These arrange witnesses and verify results, not card IR. */
export interface SpellFaceLabExpectation {
  name: string;
  pt?: readonly [number, number];
  keyword?: string;
  counters?: number;
  draw?: number;
  discard?: number;
  life?: number;
  tokens?: number;
  tokenName?: string;
  tokenPt?: readonly [number, number];
  tokenKeyword?: string;
  x?: number;
  destroyArtifact?: boolean;
  damage?: number;
  opponentsOnly?: boolean;
  bounce?: boolean;
  search?: boolean;
  omen?: boolean;
  untap?: boolean;
  destroyNonGiants?: boolean;
  ownKeyword?: string;
  scry?: number;
}
export const SPELL_FACE_LAB_EXPECTATIONS: readonly SpellFaceLabExpectation[] = [
  { name: 'Faerie Guidemother', pt: [4, 3], keyword: 'flying' },
  { name: 'Tuinvale Treefolk', counters: 2 },
  { name: 'Two-Headed Hunter', keyword: 'double strike' },
  { name: 'Foulmire Knight', draw: 1, life: 39 },
  { name: 'An Unexpected Party', tokens: 1, tokenName: 'Dwarf', tokenPt: [2, 2], x: 1 },
  { name: "Obyra's Attendants", pt: [-2, 2] },
  { name: 'Garenbrig Carver', pt: [4, 4] },
  { name: 'Lindblum, Industrial Regency', tokens: 1, tokenName: 'Wizard', tokenPt: [0, 1] },
  { name: 'Tempest Hart', draw: 2, discard: 2 },
  {
    name: "Imodane's Recruiter",
    tokens: 2,
    tokenName: 'Knight',
    tokenPt: [2, 2],
    tokenKeyword: 'vigilance',
  },
  { name: 'Embereth Shieldbreaker', destroyArtifact: true },
  { name: 'Glóin the Mighty', damage: 1, opponentsOnly: true },
  { name: 'Shepherd of the Flock', bounce: true },
  { name: 'Sagu Wildling', search: true, omen: true },
  { name: 'Silverflame Squire', pt: [4, 4], untap: true },
  { name: 'Oakhame Ranger', tokens: 2, tokenName: 'Human', tokenPt: [1, 1] },
  { name: 'Realm-Cloaked Giant', destroyNonGiants: true },
  { name: 'Frolicking Familiar', damage: 1 },
  {
    name: 'Lonesome Unicorn',
    tokens: 1,
    tokenName: 'Knight',
    tokenPt: [2, 2],
    tokenKeyword: 'vigilance',
  },
  { name: 'Topaz Dragon', ownKeyword: 'deathtouch' },
  { name: 'Horn of Valhalla', tokens: 1, tokenName: 'Soldier', tokenPt: [1, 1], x: 1 },
  { name: 'Minecart Daredevil', pt: [4, 3] },
  { name: 'Curious Pair', tokens: 1, tokenName: 'Food' },
  { name: 'Gingerbread Hunter', pt: [0, 0] },
  { name: 'Bilbo Baggins, Burglar', scry: 2 },
  { name: 'Smaug, the Great Calamity', damage: 5 },
  { name: 'Young Blue Dragon', scry: 1, draw: 1 },
];
