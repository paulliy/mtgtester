Type line: Creature — Human Wizard Sorcerer

Behavior:
{"triggers":[{"kind":"triggered","trigger":{"when":"castsSpell","caster":"you","filter":{"kind":"anyOf","of":[{"kind":"type","value":"Instant"},{"kind":"type","value":"Sorcery"},{"kind":"subtype","value":"Wizard"}]}},"optional":false,"targets":[{"kind":"anyTarget"}],"effects":[{"op":"dealDamage","target":0,"amount":{"kind":"const","n":1}}]}]}
