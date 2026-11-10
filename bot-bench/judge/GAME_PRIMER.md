## The game, as far as these positions need it

Commander is a four-player free-for-all. Each player starts at 40 life and is eliminated at 0.
The last player standing wins, so removing a player from the game is a large gain and being
removed is the worst outcome. The seats are P1 to P4. Turns go in seat order.

A turn has a first main phase (play one land, cast spells), combat (declare attackers, the
defender declares blockers, damage), a second main phase, and an end step. Spells go on a stack
and resolve last in, first out; any player may respond with instants while a spell is on the
stack. A player with nothing to do passes priority.

What the cards in these positions do:

- Lands tap for mana. A spell's cost such as `{2}{G}{G}` needs two green mana and two of any
  kind. A player may play one land per turn. The engine pays costs automatically from the
  player's untapped mana sources.
- A creature shown as 4/5 has 4 power (the damage it deals) and 5 toughness (the damage that
  destroys it in one turn). A creature that attacks becomes tapped and cannot block on the next
  opponent's turn.
- An attacker chooses which opponent it attacks. Each blocker blocks one attacker. An unblocked
  attacker deals its power to the player it attacked. A blocked attacker and its blockers deal
  damage to each other instead.
- Flying: can be blocked only by creatures with flying or reach.
- Trample: when blocked, damage beyond what kills the blockers is dealt to the defending player.
  The attacking player chooses how to divide it, and must assign lethal damage to every blocker
  before any goes to the player.
- Deathtouch: any damage it deals to a creature destroys that creature.
- Vigilance: attacking does not tap it, so it can still block.
- Defender: cannot attack.
- Summoning sickness: a creature cannot attack or use a tap ability on the turn it arrives.
- Instants can be cast at any time the player has priority; sorceries and creatures only in the
  player's own main phase with the stack empty.

## What the tactician is and is not

The product splits an AI player into a strategist (plans a turn, once per turn) and a tactician
(answers each decision). This benchmark tests the tactician alone, with no strategist advice.
At every decision the engine computes the complete list of legal actions; the model cannot do
anything that is not on the list. It replies with a small JSON object naming one `actionId`,
plus a choice for each target slot the action has. For an attack or a block the whole
declaration is one action with one slot per creature.

The model is not given the reference analysis, the grades or the consequences. It sees the
instructions below and the position.
