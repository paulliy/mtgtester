Type line: Creature — Elf Warrior

Behavior:
{"triggers":[{"kind":"triggered","trigger":{"when":"dies","subject":{"kind":"self"}},"optional":false,"targets":[{"kind":"cardInGraveyard","filter":{"kind":"allOf","of":[{"kind":"subtype","value":"Elf"},{"kind":"other"}]}}],"effects":[{"op":"graveyardToHand","target":0}]}]}
