Type line: Creature — Phyrexian Warlock

Behavior:
{"triggers":[{"kind":"triggered","trigger":{"when":"dies","subject":{"kind":"self"}},"optional":false,"targets":[{"kind":"cardInGraveyard","filter":{"kind":"allOf","of":[{"kind":"type","value":"Creature"},{"kind":"other"},{"kind":"manaValueAtMost","n":3}]}}],"effects":[{"op":"graveyardToBattlefield","target":0}]}]}
