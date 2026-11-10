Type line: Creature — Vampire Cleric

Behavior:
{"activatedAbilities":[{"costs":[{"kind":"tap"},{"kind":"sacrificeOther","selector":{"kind":"allOf","of":[{"kind":"controller","who":"you"},{"kind":"anyOf","of":[{"kind":"type","value":"Artifact"},{"kind":"type","value":"Creature"}]}]}}],"timing":"any","ability":{"kind":"activated","targets":[],"effects":[{"op":"eachOpponentLosesLife","amount":1},{"op":"gainLife","amount":{"kind":"const","n":1}}]}}]}
