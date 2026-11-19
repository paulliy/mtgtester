# ADR 0029: Player smart yield

Status: Accepted (2026-10-06)

Date: 2026-10-06

Players holding combat tricks should be able to skip quiet priority windows while retaining
opportunities to cast them during combat and in response to interaction.

The server stores an explicit per-spell-instance or per-printed-activation preference. Smart
yield hides that action during quiet priority windows. It offers the action again at relevant
combat checkpoints and for new opponent stack interaction, with the utility exceptions below.
Opponent stack activity stops yield even without explicit targets, so sweepers and other
indirect interaction remain answerable.
Self-controlled stack objects targeting the player or their permanents also stop yield.

The preference persists after such a stop and hides the action again when play becomes quiet.
Passing priority declines the currently visible stack objects and combat checkpoint for every
smart-yielded action on that menu. Resolving a declined object or another player's pass does not
reoffer it. A new stack object or a changed relevant combat checkpoint does. Choosing Smart yield
also declines the current opportunity immediately; it must not reoffer the action it just yielded.
Only accepted submissions update this session-local memory; reconnection preserves it. The
declined-opportunity memory resets each turn, while yield preferences continue to persist.

Combat stops use the action's legal targets and source: unrelated utility activations stay quiet.
Stops occur before attacks, after attacks/blocks, and between first-strike and normal damage;
ordinary post-damage and end-of-combat priority do not wake an action. Known value-only
activations (draw, scry, or library search) stay quiet for stack objects targeting unrelated
permanents, but wake for interaction targeting their source or the player. They are also offered
once at the last opponent's end step before the viewer's turn, to use spare mana before untapping.
This classification uses descriptive modeled effect operations on the legal menu; unknown,
compound, and team-protection abilities keep conservative stops. Untargeted opponent interaction
remains a conservative stop because it may affect the source indirectly. Other actions retain the
conservative opponent-stack policy.
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
