Type line: Creature — Dragon

Behavior:
{"triggers":[{"kind":"triggered","trigger":{"when":"castsSpell","caster":"you","filter":{"kind":"anyOf","of":[{"kind":"not","of":{"kind":"type","value":"Creature"}},{"kind":"subtype","value":"Dragon"}]}},"optional":false,"targets":[],"effects":[{"op":"eachOpponentDamage","amount":1}]}]}
