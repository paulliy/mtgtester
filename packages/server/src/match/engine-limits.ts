/**
 * Engine work limits for table games (ADR 0031 decision 9, multiplayer plan M3 task 6). The tester
 * leaves both unlimited, so its fixed-seed games are unchanged; a table sets them and stores them
 * with the game.
 *
 * Calibrated on 2026-10-29 over every Card Test Lab scenario (up to 60 steps each) and six seeded
 * four-bot games capped at 40 turns: the most events one `advance()` emitted was 63, and the most
 * objects one game created was 436. Ten times those (630 and about 4,400) would halt legitimate
 * long games and board wipes that sample did not reach, while a runaway loop reaches 50,000 events
 * in milliseconds, so the plan's starting values stand until recorded table games say otherwise.
 *
 * 2026-11-16: that last assumption fails for a loop that grows the board. A token trigger that
 * retriggers on its own token emits three events per token, and each iteration costs more as the
 * board grows (1,000 objects in about 1 s, 8,000 in 5 min), so it would take hours to reach either
 * limit. The engine therefore also halts a turn that creates more than `DEFAULT_MAX_TURN_OBJECTS`
 * (1,000) objects whenever `maxObjects` is set; no stored limit changes. Over 60 seeded four-bot
 * fuzz games the most one turn created was 173.
 *
 * 2026-11-20 (#46): legal turns pass that. Rabble Rousing with Champion of Lambholt created 2,272
 * objects in one turn (fuzz-203), Old Gnawbone 1,536 (fuzz-212). A token loop now halts on its
 * chain depth (`DEFAULT_MAX_TOKEN_CHAIN_DEPTH`, 100): each token that triggers an ability making
 * the next token is one step deeper, which a loop climbs every round and a wide legal turn does
 * not. The per-turn object default rises to 5,000 as the backstop. No stored limit changes.
 */
export const TABLE_ENGINE_LIMITS = Object.freeze({ maxStepWork: 50_000, maxObjects: 20_000 });
