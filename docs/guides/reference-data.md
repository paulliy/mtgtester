# Reference data

- `docs/rules/comprehensive-rules.txt`: local Comprehensive Rules reference.
- `docs/rules/commander-rules.md` and `docs/rules/commander-banned-list.md`: support Commander validation.
- `data/scryfall-oracle-cards.json`: gitignored; see [data/README.md](../../data/README.md).
- `packages/server/fixtures/edhrec-ranking.json`: EDHREC's Commander popularity ranking (nonland and nonbasic land cards with their deck counts), cut at 95% of all nonbasic slots and frozen by `bun run edhrec:fetch`. It is the source of `edh-staples-200.txt` and of the EDHREC ready list.
- Never send the Comprehensive Rules to an AI provider. They are implementation reference, not runtime prompt context.
