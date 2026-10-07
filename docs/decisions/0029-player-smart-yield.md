# ADR 0029: Player smart yield

Status: Accepted

Date: 2026-10-06

Players holding combat tricks should be able to skip quiet priority windows while retaining
opportunities to cast them during combat and in response to interaction.

The server stores an explicit per-spell-instance or per-printed-activation preference. Smart
yield hides that action during quiet priority windows. It offers the action again before the
player declares attackers, throughout combat involving their creatures or attacks against them,
and while any opponent spell or ability is on the stack. Opponent stack activity stops yield
even without explicit targets, so sweepers and other indirect interaction remain answerable.
Self-controlled stack objects targeting the player or their permanents also stop yield.

The preference persists after such a stop and hides the action again when play becomes quiet.
Resume removes it. The existing Yield always option remains available for activations. All
modes and X values of one spell share its preference; other copies are independent.

If applying the preference leaves only passing options at a priority decision, the human
provider submits the engine's ordinary pass. Other unyielded actions still require player
input. The server never filters required targets, costs, attacker declarations, or blocker
declarations. The authoritative engine menu and rules remain unchanged.

The player protocol extends the existing yield payload with optional `mode: 'always' | 'smart'`;
omitting it preserves the old activation preference. Preferences survive a connection resync
within the session. This is separate from the engine's yield-until-end-of-turn action.

Validation covers the public stop policy, normal engine/session priority progression, spell
responses in the real viewer, and declaration controls using both buttons and Enter.
