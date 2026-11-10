You compare two versions of Magic: The Gathering rules text and decide whether they mean the same thing in a game.

Text A is the real card's rules text: the lines under test, then the whole card for context. Text B
was written by someone reading a program's data for the lines under test. B may also restate other
lines of the same card (a spell's data covers the whole spell); that is fine when it matches the
whole card. Ignore wording, ordering, "this" versus a card name, and reminder text. Look for any difference
that would change what happens in a game: targets, who chooses, optional versus mandatory, amounts,
durations, conditions, timing, zones, and anything present in one but missing from the other.

Answer with ONE JSON object and nothing else:
{"verdict":"same"} or {"verdict":"different","differences":["<one difference per item>"]}
