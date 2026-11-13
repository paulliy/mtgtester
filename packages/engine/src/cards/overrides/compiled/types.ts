/**
 * Cards whose unparsed rules line is implemented by a patch from the batch card compiler
 * (`scripts/card-compiler/`), rather than by a hand-authored override.
 *
 * A compiled patch is data in the card IR. It reaches this directory only through
 * `bun run scripts/card-compiler/run.ts promote`, which takes patches that passed the compiler's
 * checks (validator, smoke game, meaning check) and carry an accepted review in
 * `docs/reviews/compiled-card-queue.json`. A promoted card is `implemented-unreviewed`: nothing
 * here is a claim that the card met the completion standard
 * (`docs/guides/card-modeling-and-testing.md`).
 *
 * The batch modules and `index.ts` are generated. Change them with `promote` and `retire`, never
 * by hand: a hand edit breaks the link between the reviewed patch bytes and what the engine runs.
 */
import type { CardDefinition } from '../../definition';

export interface CompiledCard {
  oracleId: string;
  name: string;
  /** The rules lines the patch implements, exactly as the interpreter reports them unparsed. */
  handledLines: string[];
  /** The patch, merged over the interpreted definition as an `extendCard` override is. */
  def: Partial<CardDefinition>;
  /** Where the patch came from, e.g. `compiler@claude-haiku-5-5` or `xmage@31ede542`. */
  source: string;
  /** The trial directory that holds the patch file and its check results. */
  trial: string;
  /** SHA-256 of the reviewed patch file's bytes. */
  patchSha256: string;
  /**
   * SHA-256 of the merged definition's behavior when it was promoted (descriptions dropped, keys
   * and ability lists sorted). When a later grammar change parses the line itself, `retire`
   * compares the interpreter's own reading with this.
   */
  behaviorSha256: string;
  /** Who accepted the patch in the review queue. */
  acceptedBy: string;
}

export interface CompiledBatch {
  id: string;
  cards: readonly CompiledCard[];
}
