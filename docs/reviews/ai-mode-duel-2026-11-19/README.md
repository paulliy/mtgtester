# Paid `ai-mode-duel`, 2026-11-19 (ADR 0039, PR 78)

Raw reports and logs for the paid duel on the Particle-1 tactician chain. The summary table and
the comparison with the pre-run bar are in [ADR 0039](../../decisions/0039-bot-led-tactics.md)
under "Paid duel, 2026-11-19".

- Tactician: `particle-ai/particle-1` (reasoning low), then `deepseek/deepseek-v4-flash`.
- Strategist: `z-ai/glm-5.3-flash`, then `deepseek/deepseek-v4-flash`.
- Command: `bun run ai-mode-duel --seed <seed> [--swap] --json <file>`, default caps
  (`--max-usd 2`, `--max-calls 1500`), 60-turn cap. Bot-led seats are P1 and P3 (P2 and P4 when
  swapped); the model seats are the others.
- Files: `<seed>[-swap].json` is each game's report. `<seed>[-swap].txt` is its console output
  with the per-turn progress lines removed, so it keeps the model and fallback warnings.

| Game                   | Winner     | Turns | Cost    | Model fallback lines in the log | Reported `failedTacticianCalls` |
| ---------------------- | ---------- | ----- | ------- | ------------------------------- | ------------------------------- |
| `mode-duel-2`          | model (P2) | 44    | $0.1153 | 2                               | 2                               |
| `mode-duel-2`, swapped | bot (P4)   | 35    | $0.0566 | 2                               | 2                               |
| `mode-duel-3`          | model (P4) | 54    | $0.1621 | 5                               | 5                               |
| `mode-duel-3`, swapped | model (P1) | 37    | $0.0817 | 1                               | 1                               |
| `mode-duel-4`          | model (P4) | 48    | $0.0918 | 4                               | 4                               |

The fallback column counts `using heuristic bot fallback` lines in each log. It equals the reported
failures in every game, so the counter did not undercount here (the open Codex review thread on PR
78 notes it can in principle).

`mode-duel-4-swap-unfinished.txt` is the sixth game. It stayed on turn 34 for over 30 minutes at
about 80% CPU and 3 GB of memory with no model spend, and was stopped by hand. It has no report and
is not counted. An offline replay of the same seed and seating did not reproduce the loop.

The first attempt at this run (before the CoreWeave, Modal and Cohere exclusion was added)
was stopped mid-game and discarded. The container also restarted twice and killed the swapped
`mode-duel-2` game each time; it was rerun from the start.
