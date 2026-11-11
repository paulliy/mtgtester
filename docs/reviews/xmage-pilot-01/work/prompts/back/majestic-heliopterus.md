Type line: Creature — Dinosaur

Behavior:
{"triggers":[{"kind":"triggered","trigger":{"when":"attacks","subject":{"kind":"self"}},"optional":false,"targets":[{"kind":"permanent","controller":"you","filter":{"kind":"allOf","of":[{"kind":"subtype","value":"Dinosaur"},{"kind":"other"}]}}],"effects":[{"op":"grantKeywordUntilEot","target":0,"keyword":"flying"}]}]}
