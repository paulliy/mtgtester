Type line: Legendary Creature — Human Advisor

Behavior:
{"triggers":[{"kind":"triggered","trigger":{"when":"dies","subject":{"kind":"permanent","selector":{"kind":"allOf","of":[{"kind":"type","value":"Creature"},{"kind":"color","value":"B"},{"kind":"other"},{"kind":"controller","who":"you"}]}}},"optional":false,"targets":[],"effects":[{"op":"createToken","spec":{"name":"Spirit","typeLine":"Creature — Spirit","types":["Creature"],"subtypes":["Spirit"],"colors":["W"],"power":1,"toughness":1,"keywords":["flying"]},"count":{"kind":"const","n":1}}]}]}
