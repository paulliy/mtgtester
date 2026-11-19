/**
 * Card Test Lab scenarios from the scenario files the engine tests run (ADR 0034 decision 10):
 * the same position, cards and script, so a scenario is written once. P1 is the viewer, who plays
 * the script's P1 steps by hand; every other seat answers its own script steps in order, passes
 * priority otherwise, and takes its first legal action for any other choice, as lab bots do.
 * Scenario IDs come from the files, so there is no hand-kept list to drift.
 */
import { readFileSync } from 'node:fs';
import {
  CARD_SCENARIO_SEATS,
  buildCardScenario,
  parseCardScenarioFile,
  scenarioAction,
  scenarioTargets,
  type CardScenario,
  type CardScenarioFile,
} from '@mtg/engine';
import type { Engine } from '@mtg/engine';
import type { DecisionRequest, DecisionResponse, GameId, OracleCard, PlayerId } from '@mtg/shared';
import type { CardTestScenario } from './card-test-scenarios';

interface PinStoreFile {
  names: Record<string, string>;
  cards: Record<string, OracleCard>;
}

const store = JSON.parse(
  readFileSync(
    new URL('../../../../packages/engine/tests/fixtures/pin-store.json', import.meta.url),
    'utf8',
  ),
) as PinStoreFile;
const pool = JSON.parse(
  readFileSync(new URL('../../fixtures/coverage-oracle.json', import.meta.url), 'utf8'),
) as OracleCard[];

function resolveCard(name: string): OracleCard {
  const sha = store.names[name];
  if (sha !== undefined) return store.cards[sha]!;
  const basic = pool.find((card) => card.name === name && card.isBasicLand);
  if (basic !== undefined) return basic;
  throw new Error(`Scenario card "${name}" is neither pinned nor a basic land`);
}

const scenarioFile = (name: string, text: string): CardScenarioFile =>
  parseCardScenarioFile(JSON.parse(text), `engine/tests/scenarios/${name}`);

/**
 * Every scenario file, each read through its own literal path so viewer evidence binds its bytes.
 * `card:finish` adds a line here; `runner-scenarios.test.ts` checks it against the directory.
 */
export const RUNNER_SCENARIO_FILES: ReadonlyArray<{ name: string; file: CardScenarioFile }> = [
  {
    name: 'aberrant.json',
    file: scenarioFile(
      'aberrant.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/aberrant.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'abraded-bluffs.json',
    file: scenarioFile(
      'abraded-bluffs.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/abraded-bluffs.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'academy-manufactor.json',
    file: scenarioFile(
      'academy-manufactor.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/academy-manufactor.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'adventurous-impulse.json',
    file: scenarioFile(
      'adventurous-impulse.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/adventurous-impulse.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'aetherize.json',
    file: scenarioFile(
      'aetherize.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/aetherize.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'agate-instigator.json',
    file: scenarioFile(
      'agate-instigator.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/agate-instigator.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'agent-of-erebos.json',
    file: scenarioFile(
      'agent-of-erebos.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/agent-of-erebos.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'ajanis-pridemate.json',
    file: scenarioFile(
      'ajanis-pridemate.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/ajanis-pridemate.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'alpha-authority.json',
    file: scenarioFile(
      'alpha-authority.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/alpha-authority.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'ancient-stone-idol.json',
    file: scenarioFile(
      'ancient-stone-idol.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/ancient-stone-idol.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'angel-of-finality.json',
    file: scenarioFile(
      'angel-of-finality.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/angel-of-finality.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'ant-man.json',
    file: scenarioFile(
      'ant-man.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/ant-man.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'arbor-elf.json',
    file: scenarioFile(
      'arbor-elf.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/arbor-elf.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'arcane-epiphany.json',
    file: scenarioFile(
      'arcane-epiphany.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/arcane-epiphany.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'arcane-laboratory.json',
    file: scenarioFile(
      'arcane-laboratory.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/arcane-laboratory.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'arcbound-worker.json',
    file: scenarioFile(
      'arcbound-worker.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/arcbound-worker.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'arwens-gift.json',
    file: scenarioFile(
      'arwens-gift.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/arwens-gift.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'assert-authority.json',
    file: scenarioFile(
      'assert-authority.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/assert-authority.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'behind-the-scenes.json',
    file: scenarioFile(
      'behind-the-scenes.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/behind-the-scenes.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'beloved-princess.json',
    file: scenarioFile(
      'beloved-princess.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/beloved-princess.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'benevolent-bodyguard.json',
    file: scenarioFile(
      'benevolent-bodyguard.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/benevolent-bodyguard.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'blaze.json',
    file: scenarioFile(
      'blaze.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/blaze.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'boggart-trawler.json',
    file: scenarioFile(
      'boggart-trawler.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/boggart-trawler.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'braids-arisen-nightmare.json',
    file: scenarioFile(
      'braids-arisen-nightmare.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/braids-arisen-nightmare.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'burglar-rat.json',
    file: scenarioFile(
      'burglar-rat.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/burglar-rat.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'challenger-troll.json',
    file: scenarioFile(
      'challenger-troll.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/challenger-troll.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'chasm-skulker.json',
    file: scenarioFile(
      'chasm-skulker.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/chasm-skulker.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'choked-estuary.json',
    file: scenarioFile(
      'choked-estuary.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/choked-estuary.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'chrome-mox.json',
    file: scenarioFile(
      'chrome-mox.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/chrome-mox.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'clarion-conqueror.json',
    file: scenarioFile(
      'clarion-conqueror.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/clarion-conqueror.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'cloudshift.json',
    file: scenarioFile(
      'cloudshift.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/cloudshift.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'cold-eyed-selkie.json',
    file: scenarioFile(
      'cold-eyed-selkie.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/cold-eyed-selkie.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'collector-ouphe.json',
    file: scenarioFile(
      'collector-ouphe.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/collector-ouphe.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'coruscation-mage.json',
    file: scenarioFile(
      'coruscation-mage.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/coruscation-mage.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'cover-of-darkness.json',
    file: scenarioFile(
      'cover-of-darkness.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/cover-of-darkness.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'craterhoof-behemoth.json',
    file: scenarioFile(
      'craterhoof-behemoth.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/craterhoof-behemoth.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'cursed-totem.json',
    file: scenarioFile(
      'cursed-totem.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/cursed-totem.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'cyan-vengeful-samurai.json',
    file: scenarioFile(
      'cyan-vengeful-samurai.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/cyan-vengeful-samurai.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'dauthi-embrace.json',
    file: scenarioFile(
      'dauthi-embrace.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/dauthi-embrace.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'deaths-shadow.json',
    file: scenarioFile(
      'deaths-shadow.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/deaths-shadow.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'dissipate.json',
    file: scenarioFile(
      'dissipate.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/dissipate.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'donatellos-technique.json',
    file: scenarioFile(
      'donatellos-technique.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/donatellos-technique.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'doom-blade.json',
    file: scenarioFile(
      'doom-blade.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/doom-blade.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'draconic-lore.json',
    file: scenarioFile(
      'draconic-lore.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/draconic-lore.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'dwarven-grunt.json',
    file: scenarioFile(
      'dwarven-grunt.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/dwarven-grunt.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'eidolon-of-rhetoric.json',
    file: scenarioFile(
      'eidolon-of-rhetoric.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/eidolon-of-rhetoric.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'eladamri-lord-of-leaves.json',
    file: scenarioFile(
      'eladamri-lord-of-leaves.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/eladamri-lord-of-leaves.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'electrickery.json',
    file: scenarioFile(
      'electrickery.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/electrickery.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'elvish-champion.json',
    file: scenarioFile(
      'elvish-champion.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/elvish-champion.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'emerge-unscathed.json',
    file: scenarioFile(
      'emerge-unscathed.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/emerge-unscathed.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'ettercap.json',
    file: scenarioFile(
      'ettercap.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/ettercap.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'everflowing-chalice.json',
    file: scenarioFile(
      'everflowing-chalice.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/everflowing-chalice.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'faerie-mastermind.json',
    file: scenarioFile(
      'faerie-mastermind.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/faerie-mastermind.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'fervent-charge.json',
    file: scenarioFile(
      'fervent-charge.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/fervent-charge.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'finale-of-devastation.json',
    file: scenarioFile(
      'finale-of-devastation.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/finale-of-devastation.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'fleshbag-marauder.json',
    file: scenarioFile(
      'fleshbag-marauder.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/fleshbag-marauder.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'flopsie.json',
    file: scenarioFile(
      'flopsie.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/flopsie.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'flusterstorm.json',
    file: scenarioFile(
      'flusterstorm.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/flusterstorm.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'fog.json',
    file: scenarioFile(
      'fog.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/fog.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'forbidden-alchemy.json',
    file: scenarioFile(
      'forbidden-alchemy.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/forbidden-alchemy.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'frozen-aether.json',
    file: scenarioFile(
      'frozen-aether.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/frozen-aether.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'fungal-sprouting.json',
    file: scenarioFile(
      'fungal-sprouting.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/fungal-sprouting.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'geier-reach-sanitarium.json',
    file: scenarioFile(
      'geier-reach-sanitarium.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/geier-reach-sanitarium.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'ghoultree.json',
    file: scenarioFile(
      'ghoultree.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/ghoultree.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'gixian-puppeteer.json',
    file: scenarioFile(
      'gixian-puppeteer.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/gixian-puppeteer.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'glimpse-the-unthinkable.json',
    file: scenarioFile(
      'glimpse-the-unthinkable.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/glimpse-the-unthinkable.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'goblin-king.json',
    file: scenarioFile(
      'goblin-king.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/goblin-king.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'goblin-wardriver.json',
    file: scenarioFile(
      'goblin-wardriver.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/goblin-wardriver.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'gods-willing.json',
    file: scenarioFile(
      'gods-willing.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/gods-willing.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'gonti-lord-of-luxury.json',
    file: scenarioFile(
      'gonti-lord-of-luxury.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/gonti-lord-of-luxury.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'greater-sandwurm.json',
    file: scenarioFile(
      'greater-sandwurm.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/greater-sandwurm.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'grim-monolith.json',
    file: scenarioFile(
      'grim-monolith.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/grim-monolith.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'gruesome-fate.json',
    file: scenarioFile(
      'gruesome-fate.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/gruesome-fate.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'gudul-lurker.json',
    file: scenarioFile(
      'gudul-lurker.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/gudul-lurker.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'hooded-hydra.json',
    file: scenarioFile(
      'hooded-hydra.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/hooded-hydra.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'howling-golem.json',
    file: scenarioFile(
      'howling-golem.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/howling-golem.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'hunted-bonebrute.json',
    file: scenarioFile(
      'hunted-bonebrute.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/hunted-bonebrute.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'hushwing-gryff.json',
    file: scenarioFile(
      'hushwing-gryff.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/hushwing-gryff.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'imposing-sovereign.json',
    file: scenarioFile(
      'imposing-sovereign.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/imposing-sovereign.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'inkwell-leviathan.json',
    file: scenarioFile(
      'inkwell-leviathan.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/inkwell-leviathan.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'innocuous-rat.json',
    file: scenarioFile(
      'innocuous-rat.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/innocuous-rat.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'inspiring-call.json',
    file: scenarioFile(
      'inspiring-call.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/inspiring-call.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'jirina-dauntless-general.json',
    file: scenarioFile(
      'jirina-dauntless-general.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/jirina-dauntless-general.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'junk-diver.json',
    file: scenarioFile(
      'junk-diver.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/junk-diver.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'keep-safe.json',
    file: scenarioFile(
      'keep-safe.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/keep-safe.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'kinjallis-sunwing.json',
    file: scenarioFile(
      'kinjallis-sunwing.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/kinjallis-sunwing.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'kismet.json',
    file: scenarioFile(
      'kismet.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/kismet.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'kolaghan-the-storms-fury.json',
    file: scenarioFile(
      'kolaghan-the-storms-fury.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/kolaghan-the-storms-fury.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'krenko-mob-boss.json',
    file: scenarioFile(
      'krenko-mob-boss.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/krenko-mob-boss.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'languish.json',
    file: scenarioFile(
      'languish.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/languish.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'lookouts-dispersal.json',
    file: scenarioFile(
      'lookouts-dispersal.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/lookouts-dispersal.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'lord-of-atlantis.json',
    file: scenarioFile(
      'lord-of-atlantis.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/lord-of-atlantis.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'lotus-cobra.json',
    file: scenarioFile(
      'lotus-cobra.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/lotus-cobra.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'loxodon-gatekeeper.json',
    file: scenarioFile(
      'loxodon-gatekeeper.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/loxodon-gatekeeper.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'mana-geyser.json',
    file: scenarioFile(
      'mana-geyser.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/mana-geyser.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'manglehorn.json',
    file: scenarioFile(
      'manglehorn.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/manglehorn.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'mask-of-riddles.json',
    file: scenarioFile(
      'mask-of-riddles.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/mask-of-riddles.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'master-of-the-pearl-trident.json',
    file: scenarioFile(
      'master-of-the-pearl-trident.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/master-of-the-pearl-trident.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'megrim.json',
    file: scenarioFile(
      'megrim.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/megrim.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'memory-erosion.json',
    file: scenarioFile(
      'memory-erosion.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/memory-erosion.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'merrow-harbinger.json',
    file: scenarioFile(
      'merrow-harbinger.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/merrow-harbinger.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'michelangelo.json',
    file: scenarioFile(
      'michelangelo.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/michelangelo.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'mithril-coat.json',
    file: scenarioFile(
      'mithril-coat.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/mithril-coat.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'mizzium-mortars.json',
    file: scenarioFile(
      'mizzium-mortars.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/mizzium-mortars.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'monastery-swiftspear.json',
    file: scenarioFile(
      'monastery-swiftspear.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/monastery-swiftspear.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'morcants-loyalist.json',
    file: scenarioFile(
      'morcants-loyalist.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/morcants-loyalist.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'mox-diamond.json',
    file: scenarioFile(
      'mox-diamond.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/mox-diamond.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'muscle-sliver.json',
    file: scenarioFile(
      'muscle-sliver.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/muscle-sliver.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'myr-convert.json',
    file: scenarioFile(
      'myr-convert.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/myr-convert.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'myr-retriever.json',
    file: scenarioFile(
      'myr-retriever.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/myr-retriever.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'nantuko-vigilante.json',
    file: scenarioFile(
      'nantuko-vigilante.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/nantuko-vigilante.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'natures-claim.json',
    file: scenarioFile(
      'natures-claim.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/natures-claim.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'noble-hierarch.json',
    file: scenarioFile(
      'noble-hierarch.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/noble-hierarch.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'null-rod.json',
    file: scenarioFile(
      'null-rod.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/null-rod.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'offer-immortality.json',
    file: scenarioFile(
      'offer-immortality.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/offer-immortality.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'ophiomancer.json',
    file: scenarioFile(
      'ophiomancer.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/ophiomancer.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'orcish-bowmasters.json',
    file: scenarioFile(
      'orcish-bowmasters.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/orcish-bowmasters.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'overwhelming-remorse.json',
    file: scenarioFile(
      'overwhelming-remorse.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/overwhelming-remorse.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'ox-drover.json',
    file: scenarioFile(
      'ox-drover.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/ox-drover.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'path-to-exile.json',
    file: scenarioFile(
      'path-to-exile.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/path-to-exile.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'pearl-of-wisdom.json',
    file: scenarioFile(
      'pearl-of-wisdom.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/pearl-of-wisdom.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'phyrexian-metamorph.json',
    file: scenarioFile(
      'phyrexian-metamorph.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/phyrexian-metamorph.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'plea-for-power.json',
    file: scenarioFile(
      'plea-for-power.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/plea-for-power.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'praetors-grasp.json',
    file: scenarioFile(
      'praetors-grasp.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/praetors-grasp.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'primeval-protector.json',
    file: scenarioFile(
      'primeval-protector.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/primeval-protector.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'professional-face-breaker.json',
    file: scenarioFile(
      'professional-face-breaker.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/professional-face-breaker.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'prosperous-bandit.json',
    file: scenarioFile(
      'prosperous-bandit.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/prosperous-bandit.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'prowlers-helm.json',
    file: scenarioFile(
      'prowlers-helm.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/prowlers-helm.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'ragavan-nimble-pilferer.json',
    file: scenarioFile(
      'ragavan-nimble-pilferer.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/ragavan-nimble-pilferer.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'rampaging-ceratops.json',
    file: scenarioFile(
      'rampaging-ceratops.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/rampaging-ceratops.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'rancid-rats.json',
    file: scenarioFile(
      'rancid-rats.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/rancid-rats.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'ratcatcher.json',
    file: scenarioFile(
      'ratcatcher.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/ratcatcher.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'razortrap-gorge.json',
    file: scenarioFile(
      'razortrap-gorge.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/razortrap-gorge.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'remorseful-cleric.json',
    file: scenarioFile(
      'remorseful-cleric.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/remorseful-cleric.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'riders-of-rohan.json',
    file: scenarioFile(
      'riders-of-rohan.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/riders-of-rohan.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'ripjaw-raptor.json',
    file: scenarioFile(
      'ripjaw-raptor.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/ripjaw-raptor.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'ruby-medallion.json',
    file: scenarioFile(
      'ruby-medallion.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/ruby-medallion.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'rumbleweed.json',
    file: scenarioFile(
      'rumbleweed.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/rumbleweed.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'sanguine-bond.json',
    file: scenarioFile(
      'sanguine-bond.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/sanguine-bond.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'saved-by-the-shell.json',
    file: scenarioFile(
      'saved-by-the-shell.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/saved-by-the-shell.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'seedborn-muse.json',
    file: scenarioFile(
      'seedborn-muse.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/seedborn-muse.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'seers-sundial.json',
    file: scenarioFile(
      'seers-sundial.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/seers-sundial.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'sejiri-steppe.json',
    file: scenarioFile(
      'sejiri-steppe.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/sejiri-steppe.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'selfless-savior.json',
    file: scenarioFile(
      'selfless-savior.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/selfless-savior.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'serpent-of-yawning-depths.json',
    file: scenarioFile(
      'serpent-of-yawning-depths.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/serpent-of-yawning-depths.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'shadow-rift.json',
    file: scenarioFile(
      'shadow-rift.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/shadow-rift.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'shadow-sliver.json',
    file: scenarioFile(
      'shadow-sliver.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/shadow-sliver.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'shadowmage-infiltrator.json',
    file: scenarioFile(
      'shadowmage-infiltrator.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/shadowmage-infiltrator.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'shadowspear.json',
    file: scenarioFile(
      'shadowspear.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/shadowspear.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'shelter.json',
    file: scenarioFile(
      'shelter.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/shelter.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'shifting-sliver.json',
    file: scenarioFile(
      'shifting-sliver.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/shifting-sliver.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'shizo-deaths-storehouse.json',
    file: scenarioFile(
      'shizo-deaths-storehouse.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/shizo-deaths-storehouse.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'silhana-ledgewalker.json',
    file: scenarioFile(
      'silhana-ledgewalker.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/silhana-ledgewalker.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'simic-growth-chamber.json',
    file: scenarioFile(
      'simic-growth-chamber.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/simic-growth-chamber.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'skeleton-key.json',
    file: scenarioFile(
      'skeleton-key.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/skeleton-key.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'souls-attendant.json',
    file: scenarioFile(
      'souls-attendant.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/souls-attendant.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'spectral-denial.json',
    file: scenarioFile(
      'spectral-denial.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/spectral-denial.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'spider-woman-stunning-savior.json',
    file: scenarioFile(
      'spider-woman-stunning-savior.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/spider-woman-stunning-savior.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'splinters-technique.json',
    file: scenarioFile(
      'splinters-technique.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/splinters-technique.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'steel-leaf-champion.json',
    file: scenarioFile(
      'steel-leaf-champion.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/steel-leaf-champion.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'steelburr-champion.json',
    file: scenarioFile(
      'steelburr-champion.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/steelburr-champion.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'stoic-rebuttal.json',
    file: scenarioFile(
      'stoic-rebuttal.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/stoic-rebuttal.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'stony-silence.json',
    file: scenarioFile(
      'stony-silence.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/stony-silence.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'stormkeld-vanguard.json',
    file: scenarioFile(
      'stormkeld-vanguard.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/stormkeld-vanguard.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'sun-titan.json',
    file: scenarioFile(
      'sun-titan.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/sun-titan.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'sunder-shaman.json',
    file: scenarioFile(
      'sunder-shaman.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/sunder-shaman.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'sylvan-library.json',
    file: scenarioFile(
      'sylvan-library.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/sylvan-library.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'takenuma-abandoned-mire.json',
    file: scenarioFile(
      'takenuma-abandoned-mire.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/takenuma-abandoned-mire.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'termagant-swarm.json',
    file: scenarioFile(
      'termagant-swarm.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/termagant-swarm.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'tervigon.json',
    file: scenarioFile(
      'tervigon.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/tervigon.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'thalia-heretic-cathar.json',
    file: scenarioFile(
      'thalia-heretic-cathar.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/thalia-heretic-cathar.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'the-ozolith.json',
    file: scenarioFile(
      'the-ozolith.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/the-ozolith.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'thief-of-sanity.json',
    file: scenarioFile(
      'thief-of-sanity.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/thief-of-sanity.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'thraben-inspector.json',
    file: scenarioFile(
      'thraben-inspector.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/thraben-inspector.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'tithe-drinker.json',
    file: scenarioFile(
      'tithe-drinker.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/tithe-drinker.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'tormods-crypt.json',
    file: scenarioFile(
      'tormods-crypt.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/tormods-crypt.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'torpor-orb.json',
    file: scenarioFile(
      'torpor-orb.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/torpor-orb.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'trailblazers-boots.json',
    file: scenarioFile(
      'trailblazers-boots.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/trailblazers-boots.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'triskelion.json',
    file: scenarioFile(
      'triskelion.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/triskelion.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'troll-of-khazad-dum.json',
    file: scenarioFile(
      'troll-of-khazad-dum.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/troll-of-khazad-dum.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'turn-aside.json',
    file: scenarioFile(
      'turn-aside.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/turn-aside.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'urabrask-the-hidden.json',
    file: scenarioFile(
      'urabrask-the-hidden.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/urabrask-the-hidden.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'urzas-incubator.json',
    file: scenarioFile(
      'urzas-incubator.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/urzas-incubator.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'vampire-cutthroat.json',
    file: scenarioFile(
      'vampire-cutthroat.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/vampire-cutthroat.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'vapor-snag.json',
    file: scenarioFile(
      'vapor-snag.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/vapor-snag.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'venoms-hunger.json',
    file: scenarioFile(
      'venoms-hunger.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/venoms-hunger.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'vivid-creek.json',
    file: scenarioFile(
      'vivid-creek.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/vivid-creek.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'vorrac-battlehorns.json',
    file: scenarioFile(
      'vorrac-battlehorns.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/vorrac-battlehorns.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'wasteland.json',
    file: scenarioFile(
      'wasteland.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/wasteland.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'witch-enchanter.json',
    file: scenarioFile(
      'witch-enchanter.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/witch-enchanter.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'wizards-lightning.json',
    file: scenarioFile(
      'wizards-lightning.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/wizards-lightning.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'wizards-retort.json',
    file: scenarioFile(
      'wizards-retort.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/wizards-retort.json', import.meta.url),
        'utf8',
      ),
    ),
  },
  {
    name: 'workshop-assistant.json',
    file: scenarioFile(
      'workshop-assistant.json',
      readFileSync(
        new URL(
          '../../../../packages/engine/tests/scenarios/workshop-assistant.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  },
  {
    name: 'zodiac-monkey.json',
    file: scenarioFile(
      'zodiac-monkey.json',
      readFileSync(
        new URL('../../../../packages/engine/tests/scenarios/zodiac-monkey.json', import.meta.url),
        'utf8',
      ),
    ),
  },
];
const FILES = RUNNER_SCENARIO_FILES.map(({ file }) => file);

/** Every runner scenario, for the lab's picker and the viewer spec. */
export const RUNNER_SCENARIOS = FILES.flatMap((file) =>
  file.scenarios.map(({ id, title }) => ({ id, cardName: file.card, title })),
);

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Clause ids for the Oracle lines a scenario exercises. */
export function runnerClauseIds(cardName: string, lines: readonly number[]): string[] {
  return lines.map((line) => `${slug(cardName)}-clause-${line}`);
}

/** A non-viewer seat that answers its script steps, in order, and otherwise plays it safe. */
function scriptedSeat(seat: PlayerId, scenario: CardScenario, engine: () => Engine) {
  const steps = scenario.script.filter((step) => step.player === seat);
  let next = 0;
  return {
    decide(request: DecisionRequest): DecisionResponse {
      const step = steps[next];
      const action = scenarioAction(request, step);
      if (action !== null && step !== undefined) {
        next += 1;
        const targets = scenarioTargets(engine().getState(), request, action, step);
        return {
          requestId: request.requestId,
          actionId: action.id,
          ...(targets !== undefined && { targets }),
        };
      }
      const pass = request.legalActions.find((candidate) => candidate.type === 'pass');
      const fallback = pass ?? request.legalActions[0]!;
      return {
        requestId: request.requestId,
        actionId: fallback.id,
        ...(fallback.targets !== undefined && {
          targets: fallback.targets.map((slot) => ({ slot: slot.slot, choice: slot.options[0]! })),
        }),
      };
    },
  };
}

export function runnerScenario(id: string, gameId: GameId): CardTestScenario {
  for (const file of FILES) {
    const scenario = file.scenarios.find((candidate) => candidate.id === id);
    if (scenario === undefined) continue;
    const built = buildCardScenario(file, scenario, resolveCard, { gameId });
    const engine = built.engine;
    const sha = store.names[file.card];
    if (sha === undefined) throw new Error(`Scenario card ${file.card} is not pinned`);
    return {
      metadata: {
        id,
        version: 1,
        title: scenario.title,
        instructions: scenario.instructions,
        expectedOutcome: scenario.expectedOutcome,
        oracleSha256: sha,
        clauseIds: runnerClauseIds(file.card, scenario.clauses),
      },
      seed: built.seed,
      seats: built.players.map((config) => ({
        seat: config.id,
        config,
        deckSnapshotId: null,
        summary: {
          seat: config.id,
          deckId: config.deckId,
          label: config.id,
          commanderNames: [],
          colorIdentity: [],
          archetypeTag: 'card-test-lab',
        },
      })),
      engine,
      decisionProviderOverrides: Object.fromEntries(
        CARD_SCENARIO_SEATS.filter((seat) => seat !== 'P1').map((seat) => [
          seat,
          scriptedSeat(seat, scenario, () => engine),
        ]),
      ),
    };
  }
  throw new Error(`Unknown runner scenario ${id}`);
}
