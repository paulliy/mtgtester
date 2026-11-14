import { interpretCard } from '@mtg/engine';
import { isProvisional } from '../cards/provisional';
import type {
  Color,
  OracleCard,
  PlayerId,
  ResolvedDeck,
  SeatSource,
  SetupPreview,
  SetupPreviewSeat,
  ProviderKind,
  GameMode,
  SeatControllerKind,
  SeatControllers,
} from '@mtg/shared';
import { ALL_COLORS, assertNever } from '@mtg/shared';
import { generateCommanderDeck } from '../decks/generate';
import { inferArchetype } from '../decks/archetype';
import { importDeck } from '../decks/source';
import { resolveDeck } from '../decks/resolve';
import { validateDeck } from '../decks/validate';
import type { SeatSetupDeps, SeatSetup, SeatProblem } from './setup';

export type PreviewDeps = SeatSetupDeps;
export interface PreviewRequest {
  seats: SeatSource[];
  seed: string;
  providerKind: ProviderKind;
  gameMode: GameMode;
  humanSeat?: PlayerId;
  /** Who answers each seat of a `'table'` preview. */
  seatControllers?: SeatControllers;
}

/**
 * Who a preview shows as answering a seat.
 *
 * flow: a seat's provider kind in the preview (m1 row preview.ts:129). A table shows `human` for
 * every seat its controllers name as human.
 */
function previewController(input: PreviewRequest, seat: PlayerId): SeatControllerKind {
  switch (input.gameMode) {
    case 'spectator':
      return input.providerKind;
    case 'singlePlayer':
      return input.humanSeat === seat ? 'human' : input.providerKind;
    case 'table':
      return input.seatControllers?.[seat] === 'human' ? 'human' : input.providerKind;
    default:
      return assertNever(input.gameMode, 'preview controller');
  }
}

/** Rebuild from stable Oracle IDs and validate against today's rules/model. Never trust cached names. */
export function resolveSavedSeat(
  seat: PlayerId,
  snapshotId: string,
  deps: SeatSetupDeps,
): SeatSetup | SeatProblem {
  const fail = (message: string): SeatProblem => ({
    seat,
    message,
    issues: [],
    unresolvedNames: [],
    unmodeledCards: [],
  });
  if (!deps.store) return fail('Saved decks are disabled without a database.');
  const snapshot = deps.store.savedSnapshot(snapshotId);
  if (!snapshot) return fail('Saved deck was removed or is unavailable.');
  const entries = snapshot.cards.map((entry) => ({
    entry,
    card: deps.index.getByOracleId(entry.oracleId),
  }));
  if (entries.some(({ card }) => !card))
    return fail('Saved deck has cards missing from the current Oracle index.');
  const all = entries.map(({ entry, card }) => ({
    card: card as OracleCard,
    quantity: entry.quantity,
  }));
  const commanders =
    snapshot.commanderOracleIds?.map(
      (id) => all.find(({ card }) => card.oracleId === id)?.card ?? null,
    ) ??
    snapshot.commanderNames.map((name) => all.find(({ card }) => card.name === name)?.card ?? null);
  if (commanders.some((card) => card === null))
    return fail('Saved commander is missing from the current Oracle index.');
  const companion =
    snapshot.companionOracleId === null
      ? null
      : deps.index.getByOracleId(snapshot.companionOracleId);
  if (snapshot.companionOracleId !== null && companion === null)
    return fail('Saved companion is missing from the current Oracle index.');
  const remaining = all.map(({ card, quantity }) => ({ card, quantity }));
  for (const card of [...commanders, ...(companion ? [companion] : [])]) {
    const found = remaining.find(
      (entry) => entry.card.oracleId === card?.oracleId && entry.quantity > 0,
    );
    if (!found) return fail('Saved deck is missing a commander or companion card.');
    found.quantity--;
  }
  const currentCommanderNames = (commanders as OracleCard[]).map((card) => card.name);
  const currentIdentity = ALL_COLORS.filter((color) =>
    commanders.some((card) => card?.colorIdentity.includes(color)),
  );
  const resolved: ResolvedDeck = {
    sourceType: 'plaintext',
    sourceUrl: null,
    name: snapshot.name,
    archetypeTag: snapshot.archetypeTag,
    commanders: commanders as OracleCard[],
    companion,
    cards: remaining.filter((entry) => entry.quantity > 0),
  };
  const validation = validateDeck(resolved, deps.banned);
  if (!validation.valid)
    return { ...fail('Saved deck is no longer Commander legal.'), issues: validation.issues };
  const cards = resolved.cards.flatMap(({ card, quantity }) =>
    Array.from({ length: quantity }, () => card),
  );
  const unmodeled = [...resolved.commanders, ...(companion ? [companion] : []), ...cards].filter(
    (card) => !interpretCard(card).modeled && !isProvisional(deps.pool.provisional, card),
  );
  if (unmodeled.length > 0)
    return {
      ...fail('Saved deck is no longer fully modeled.'),
      unmodeledCards: unmodeled.map((card) => card.name),
    };
  return {
    seat,
    deckSnapshotId: snapshotId,
    config: { id: seat, deckId: snapshotId, commanders: resolved.commanders, cards },
    summary: {
      seat,
      deckId: snapshotId,
      label: snapshot.name,
      commanderNames: currentCommanderNames,
      colorIdentity: currentIdentity,
      archetypeTag: snapshot.archetypeTag,
    },
  };
}

/** Preview performs no store writes; start re-runs validation before constructing the session. */
export async function previewMatchup(
  input: PreviewRequest,
  deps: PreviewDeps,
): Promise<SetupPreview> {
  const seats: SetupPreviewSeat[] = [];
  const blockers: string[] = [];
  for (const [index, source] of input.seats.entries()) {
    const seat = `P${index + 1}` as PlayerId;
    const controller = previewController(input, seat);
    const summary: SetupPreviewSeat = {
      seat,
      commanderNames: [],
      colorIdentity: [],
      archetypeTag: '',
      controller,
      modeled: false,
    };
    try {
      if (source.kind === 'pool') {
        const deck = generateCommanderDeck(deps.pool, {
          seed: source.seed ?? `${input.seed}-seat${index + 1}`,
        });
        summary.commanderNames = [deck.commander.name];
        summary.colorIdentity = [...deck.commander.colorIdentity];
        summary.archetypeTag = inferArchetype({
          commanders: [deck.commander],
          cards: deck.cards.map((card) => ({ card, quantity: 1 })),
          colorIdentity: [...deck.commander.colorIdentity],
        }).tag;
        summary.modeled = true;
      } else if (source.kind === 'snapshot') {
        const result = resolveSavedSeat(seat, source.snapshotId, deps);
        if ('message' in result) {
          // The blocker is all a failed saved seat publishes. A preview is public — three of its
          // four seats are opponents — and the snapshot's own cached `commanderNames`,
          // `colorIdentity` and `archetypeTag` are stored strings that nothing has validated
          // against the current Oracle index, legality list or model coverage. Copying them in
          // here would publish unvalidated deck metadata on the one path where validation is
          // known to have failed. The neutral fields the summary was initialized with stand.
          blockers.push(`${seat}: ${result.message}`);
        } else {
          Object.assign(summary, {
            commanderNames: result.summary.commanderNames,
            colorIdentity: result.summary.colorIdentity,
            archetypeTag: result.summary.archetypeTag,
            modeled: true,
          });
        }
      } else if (!deps.store) {
        blockers.push(`${seat}: Imported decks are disabled without a database.`);
      } else {
        const parsed = await importDeck(source.kind === 'url' ? source.url : source.text);
        summary.commanderNames = parsed.commanderNames;
        const { resolved } = resolveDeck(parsed, deps.index);
        if (!resolved) blockers.push(`${seat}: Some deck names could not be resolved.`);
        else {
          const identity = new Set(resolved.commanders.flatMap((card) => card.colorIdentity));
          summary.colorIdentity = ALL_COLORS.filter((color) => identity.has(color)) as Color[];
          summary.archetypeTag =
            source.archetypeTag?.trim() ||
            resolved.archetypeTag ||
            inferArchetype({
              commanders: resolved.commanders,
              companion: resolved.companion,
              cards: resolved.cards,
              colorIdentity: summary.colorIdentity as Color[],
            }).tag;
          if (!validateDeck(resolved, deps.banned).valid)
            blockers.push(`${seat}: Deck is not Commander legal.`);
          const cards = [
            ...resolved.commanders,
            ...(resolved.companion ? [resolved.companion] : []),
            ...resolved.cards.map((entry) => entry.card),
          ];
          summary.modeled = cards.every(
            (card) => interpretCard(card).modeled || isProvisional(deps.pool.provisional, card),
          );
          if (!summary.modeled) blockers.push(`${seat}: Deck is not fully modeled.`);
        }
      }
    } catch {
      blockers.push(
        `${seat}: ${source.kind === 'pool' ? 'Could not generate a supported deck.' : 'Could not inspect the deck.'}`,
      );
    }
    seats.push(summary);
  }
  return { previewId: '', seed: input.seed, seats, blockers };
}
