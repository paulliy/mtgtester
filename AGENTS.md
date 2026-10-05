# Contributor instructions

Read `CLAUDE.md` for repository-wide architecture and command guidance.

For every card-modeling change, the sole completion standard is
`docs/guides/card-modeling-and-testing.md`. Follow its pinned-Oracle, clause mapping, positive and
negative engine scenarios, normal cast/activation path, real-viewer evidence, and separate
gameplay-AI evidence requirements. `modeled: true`, snapshots, deck membership, aggregate
coverage, mocked UI checks, and written completion claims are not proof.

Unsupported mechanics must remain explicit with `unimplemented()` or `unsupportedCard()` until
implemented faithfully. Never substitute a mana cost, target, event, or `noOp` for unsupported
rules behavior.

## Cursor Cloud specific instructions

- Viewer-evidence tests call `python`, not `python3`, for ZIP checks. `python-is-python3` provides that command.
- Pin Bun to 1.3.14 and symlink `bun` and `bunx` into `/usr/local/bin`. Non-interactive login shells skip `~/.bashrc`.
- `bun run dev` reads `data/scryfall-oracle-cards.json` as a JSON array. Scryfall now publishes Oracle cards only as gzipped JSONL (`jsonl_download_uri` from `https://api.scryfall.com/bulk-data/oracle-cards`); convert that download into a JSON array before serving. Random and heuristic games do not need a provider key.
