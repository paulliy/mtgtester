Type line: Creature — Human Assassin

Behavior:
{"triggers":[{"kind":"triggered","trigger":{"when":"enters","subject":{"kind":"self"}},"optional":false,"targets":[{"kind":"creature","filter":{"kind":"allOf","of":[{"kind":"not","of":{"kind":"type","value":"Artifact"}},{"kind":"not","of":{"kind":"color","value":"B"}}]}}],"effects":[{"op":"destroy","target":0,"cantRegenerate":true}]}]}
