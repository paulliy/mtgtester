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
 */
export const TABLE_ENGINE_LIMITS = Object.freeze({ maxStepWork: 50_000, maxObjects: 20_000 });
