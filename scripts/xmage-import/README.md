# XMage import

Translates XMage card implementations into our card IR as override patches, for cards the Oracle
interpreter cannot read yet. XMage is MIT licensed; see `THIRD_PARTY_NOTICES.md` at the repo root.
Every patch carries `"source": "xmage@<commit>"`.

Nothing here registers cards with the engine. Patches go through the batch card compiler's checks
(`scripts/card-compiler/run.ts import` and `check`) and then wait in its review queue
(`run.ts queue`); a card becomes playable only after review.

The pilot's patches are queued by passing `docs/reviews/xmage-pilot-01` to `run.ts queue` with
the compiler's own trial directories (see that directory's README).

## Pieces

- `java-expr.ts`: a parser for the Java subset XMage card constructors use. XMage source is read
  as text and never compiled or run.
- `extract.ts`: one XMage card class → its static filters and one entry per ability, with the
  `// Oracle line` comment XMage writes above each ability.
- `adapters.ts`: XMage classes → IR. Strict: an argument, overload, duration or predicate an
  adapter does not know throws `Unmapped`, so a line is translated whole or not at all.
- `lib.ts`: indexes over an XMage checkout (card name → class, subtypes, `StaticFilters`, token
  classes) and matching of an Oracle line to the XMage ability that implements it.
- `pilot.ts`: runs the translation over every EDHREC card blocked by one unparsed line.
- `agreement.ts`: the adapters' accuracy check. On lines both the interpreter and the adapters
  read, it compares the two IR fragments.

## Running

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/magefree/mage.git <dir>
git -C <dir> sparse-checkout set Mage.Sets/src/mage/cards Mage.Sets/src/mage/sets \
  Mage/src/main/java/mage/constants Mage/src/main/java/mage/filter \
  Mage/src/main/java/mage/game/permanent/token
bun run scripts/xmage-import/agreement.ts <dir> <out.json>
bun run scripts/xmage-import/pilot.ts <dir> <out-dir> [--limit 100]
bun run scripts/card-compiler/run.ts import <trial-dir> <out-dir>/patches
bun run scripts/card-compiler/run.ts check <trial-dir>
```

Run `agreement.ts` after any adapter change. A new disagreement means an adapter bug unless the
interpreter is the one that is wrong.
