/**
 * Entry replacements and entry/death trigger suppression for white-black-control.
 *
 * Every card this file once overrode (Authority of the Consuls, Archon of Emeria, Doorkeeper
 * Thrull, Karn, Argent Defender, Hushbringer) is now read by the interpreter's rule-static lines
 * (`parseRuleStaticLine`: "<types> your opponents control enter tapped", "each player can't cast
 * more than one spell each turn", "<types> entering [or dying] don't cause abilities to
 * trigger"), with the same rule statics the overrides authored. The registration stays so the
 * deck's evidence tests keep exercising those cards through the same entry point.
 */
export function registerWhiteBlackControlEntryOverrides(): void {}
