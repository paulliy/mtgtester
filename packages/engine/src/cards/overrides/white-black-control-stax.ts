/**
 * Rule of Law and Deafening Silence casting limits for white-black-control.
 *
 * Both are now read by the interpreter ("each player can't cast more than one [noncreature] spell
 * each turn" → `spellCastLimit`), with the rule statics these overrides once authored. The
 * registration stays so the deck's evidence tests keep using the same entry point.
 */
export function registerWhiteBlackControlStaxOverrides(): void {}
