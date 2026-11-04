import { anyOf, ofType } from '../selector';
import { onEndStep, triggered } from '../templates';
import { constant } from '../value';
import { defineCard } from './index';

/**
 * EDHREC coverage plan, Phase 3: staples whose rules text is one card's own sentence, authored as
 * overrides over engine ops with their own tests (docs/plans/edhrec-coverage-modelling.md).
 */
export function registerEdhrecStapleOverrides(): void {
  // The sacrifice is chosen on resolution, so the trigger is not also optional: declining the
  // sacrifice is the "you may". Each opponent then answers in APNAP order (CR 101.4); the chosen
  // permanents are sacrificed together, and each opponent who did not loses 2 life while you
  // draw a card. "Shares a card type" reads the sacrificed permanent as it last existed.
  defineCard(
    'e0445c80-fa53-4c3e-881e-940e9fce7f57',
    'Braids, Arisen Nightmare',
    [
      "At the beginning of your end step, you may sacrifice an artifact, creature, enchantment, land, or planeswalker. If you do, each opponent may sacrifice a permanent of their choice that shares a card type with it. For each opponent who doesn't, that player loses 2 life and you draw a card.",
    ],
    {
      triggers: [
        triggered(onEndStep('you'), {
          effects: [
            {
              op: 'sacrificeThenOpponentsShareTypeOrPunish',
              selector: anyOf(
                ...['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker'].map((type) =>
                  ofType(type),
                ),
              ),
              life: constant(2),
            },
          ],
          description:
            'At the beginning of your end step, you may sacrifice an artifact, creature, enchantment, land, or planeswalker; each opponent may sacrifice a permanent sharing a card type with it, and each who does not loses 2 life while you draw a card',
        }),
      ],
    },
  );
}
