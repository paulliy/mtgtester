# Plans

The files here are historical. Each was the working plan or progress log for one phase, pull request, or coverage push, and none of them describes how the code works today. For current decisions read the [ADR index](../decisions/README.md); for how to work in the repository read [AGENTS.md](../../AGENTS.md) and [docs/guides/](../guides/).

Do not delete or move a file here without checking the list below: some of them are still read or written by code.

## Files code still reads or writes

| File                                                                                                     | Used by                                                                                                                          |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [edhrec-triage.md](edhrec-triage.md)                                                                     | Written by `bun run edhrec:triage` (`packages/server/src/cli/edhrec-triage.ts`).                                                 |
| [edhrec-ready-list.md](edhrec-ready-list.md)                                                             | Written by `packages/server/src/cli/edhrec-ready-list.ts`, read by `scripts/one-line-corpus.ts`.                                 |
| [card-catalog-audit.json](card-catalog-audit.json)                                                       | Read by the engine card coverage tests and `catalog-engine-evidence.test.ts`.                                                    |
| [card-coverage-ledger.json](card-coverage-ledger.json)                                                   | Read by `card-authoring-metrics.test.ts`.                                                                                        |
| [pr11-progress.md](pr11-progress.md)                                                                     | Read by `card-authoring-metrics.test.ts`.                                                                                        |
| [gameplay-ai-evaluation.json](gameplay-ai-evaluation.json)                                               | Read by `gameplay-ai-evaluation.test.ts`.                                                                                        |
| [white-black-control-verification-requirements.json](white-black-control-verification-requirements.json) | Read by the white-black control manifest and scenario tests and `scripts/run-white-black-verification.ts`.                       |
| [fail-closed-card-restoration.md](fail-closed-card-restoration.md)                                       | Hashed as a source file by the five `scripts/generate-*-evidence.ts` generators; editing it changes their evidence fingerprints. |

Every other file here is a record only. Code comments cite some of them for history, which is safe to leave as is.
