/**
 * The bot's policy version, part of bot-bench's run fingerprint (ADR 0043).
 *
 * Bump it in any change that alters what the bot chooses for the same view and seed: a weight, a
 * scoring rule, a policy fix's default, a tie-break. A run measured against one policy is then
 * never extended with play from another (`bot-bench run --out`).
 */
export const BOT_POLICY_VERSION = '2026-11-19.adr0050-answers.1';
