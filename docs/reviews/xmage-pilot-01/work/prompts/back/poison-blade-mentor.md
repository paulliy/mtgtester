Type line: Creature — Human Assassin

Behavior:
{"triggers":[{"kind":"triggered","trigger":{"when":"attacks","subject":{"kind":"self"}},"optional":false,"targets":[{"kind":"permanent","controller":"you","filter":{"kind":"allOf","of":[{"kind":"subtype","value":"Assassin"},{"kind":"other"}]}}],"effects":[{"op":"grantKeywordUntilEot","target":0,"keyword":"deathtouch"}]}]}
