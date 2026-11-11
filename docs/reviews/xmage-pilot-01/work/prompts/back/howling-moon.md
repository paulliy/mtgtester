Type line: Enchantment

Behavior:
{"triggers":[{"kind":"triggered","trigger":{"when":"beginningOfCombat","player":"you"},"optional":false,"targets":[{"kind":"permanent","controller":"you","filter":{"kind":"anyOf","of":[{"kind":"subtype","value":"Wolf"},{"kind":"subtype","value":"Werewolf"}]}}],"effects":[{"op":"pumpUntilEot","target":0,"power":2,"toughness":2}]}]}
