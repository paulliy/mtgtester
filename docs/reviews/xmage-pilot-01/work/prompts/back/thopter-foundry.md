Type line: Artifact

Behavior:
{"activatedAbilities":[{"costs":[{"kind":"mana","cost":{"generic":1,"colored":{"W":0,"U":0,"B":0,"R":0,"G":0},"colorless":0}},{"kind":"sacrificeOther","selector":{"kind":"allOf","of":[{"kind":"controller","who":"you"},{"kind":"type","value":"Artifact"},{"kind":"not","of":{"kind":"isToken"}}]},"allowSelf":true}],"timing":"any","ability":{"kind":"activated","targets":[],"effects":[{"op":"createToken","spec":{"name":"Thopter","typeLine":"Artifact Creature — Thopter","types":["Artifact","Creature"],"subtypes":["Thopter"],"colors":["U"],"power":1,"toughness":1,"keywords":["flying"]},"count":{"kind":"const","n":1}},{"op":"gainLife","amount":{"kind":"const","n":1}}]}}]}
