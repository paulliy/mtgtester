Type line: Legendary Creature — Spirit

Behavior:
{"triggers":[{"kind":"triggered","trigger":{"when":"castsSpell","caster":"you","filter":{"kind":"anyOf","of":[{"kind":"subtype","value":"Spirit"},{"kind":"subtype","value":"Arcane"}]}},"optional":false,"targets":[],"effects":[{"op":"createToken","spec":{"name":"Spirit","typeLine":"<text>","types":["Creature"],"subtypes":["Spirit"],"colors":["W"],"power":3,"toughness":3,"keywords":["flying"]},"count":{"kind":"const","n":1}}]}]}
