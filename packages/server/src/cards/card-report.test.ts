import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CardTestScenarioMetadata, OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { GameServer, type GameServerDeps } from '../ws/server';
import {
  buildCardReport,
  CARD_REPORT_MAX_NAMES,
  loadCatalogAudit,
  oracleSha256,
  type AuditEntry,
  type CatalogAudit,
} from './card-report';
import { buildOracleIndexFromCards } from './oracle-index';

const cards = JSON.parse(
  readFileSync(resolve('packages/server/fixtures/coverage-oracle.json'), 'utf8'),
) as OracleCard[];
const index = buildOracleIndexFromCards(cards);
const lab = JSON.parse(
  readFileSync(resolve('packages/engine/tests/fixtures/casting-statics-oracle.json'), 'utf8'),
).cards.map((entry: { card: OracleCard }) => entry.card) as OracleCard[];
const audit = loadCatalogAudit();
const byName = (name: string): OracleCard => cards.find((card) => card.name === name)!;

describe('card report', () => {
  it('reads the audit ledger', () => {
    expect(audit).not.toBeNull();
    expect(audit!.size).toBeGreaterThan(300);
  });

  it('reports an unsupported card with the ledger reason and only the evidence the ledger holds', () => {
    const timely = lab.find((card) => card.name === 'Timely Ward')!;
    const ledger: CatalogAudit = new Map([
      [
        timely.oracleId,
        {
          oracleId: timely.oracleId,
          name: timely.name,
          implementationStatus: 'unsupported',
          unsupportedReason: 'Cast as though it had flash is not modeled.',
          engineEvidence: 'contained',
        },
      ],
    ]);
    const labIndex = buildOracleIndexFromCards([timely]);
    const card = buildCardReport(['Timely Ward'], {
      index: labIndex,
      audit: ledger,
      scenarios: null,
    }).cards[0]!;
    expect(card.status).toBe('unsupported');
    expect(card.unmodeledReasons[0]).toMatch(/unrecognized rules text/);
    expect(card.unsupportedReason).toMatch(/flash/);
    expect(card.oracleText).toBe(timely.oracleText);
    expect(card.oracleSha256).toBe(oracleSha256(timely));
    // The ledger recorded engine evidence only: nothing is said about the viewer or the AI.
    expect(card.evidence).toEqual({ engine: 'contained' });
  });

  it('shows no ledger evidence for a card the ledger calls unsupported but the engine models', () => {
    const entry = buildCardReport(['Adaptive Omnitool'], { index, audit, scenarios: null })
      .cards[0]!;
    expect(entry.status).toBe('implemented-unreviewed');
    expect(entry).not.toHaveProperty('evidence');
    expect(entry).not.toHaveProperty('unsupportedReason');
    expect(entry.auditConflict).toMatch(/records this card as unsupported/);
  });

  it('calls a modeled card reviewed only when the ledger says so for the same Oracle hash', () => {
    const name = 'Academy Ruins';
    const card = byName(name);
    const ledger = audit!.get(card.oracleId)!;
    const report = buildCardReport([name], { index, audit, scenarios: null }).cards[0]!;
    if (ledger.oracleSha256 === oracleSha256(card)) {
      expect(report.status).toBe('implemented-reviewed');
      expect(report.evidence?.oracleMatchesAudit).toBe(true);
    } else {
      expect(report.status).toBe('implemented-unreviewed');
      expect(report.evidence?.oracleMatchesAudit).toBe(false);
    }
    // The ledger says the viewer has not been run: that is what the report says, not "complete".
    expect(report.evidence?.viewer).toBe('not-run');
  });

  it('downgrades a reviewed claim whose Oracle hash no longer matches', () => {
    const card = byName('Academy Ruins');
    const stale = new Map<string, AuditEntry>([
      [
        card.oracleId,
        {
          oracleId: card.oracleId,
          name: card.name,
          implementationStatus: 'implemented-reviewed',
          oracleSha256: 'f'.repeat(64),
          engineEvidence: 'engine-tests',
        },
      ],
    ]);
    const entry = buildCardReport([card.name], { index, audit: stale, scenarios: null }).cards[0]!;
    expect(entry.status).toBe('implemented-unreviewed');
    expect(entry.evidence).toEqual({ engine: 'engine-tests', oracleMatchesAudit: false });
  });

  it('gives a modeled card with no ledger entry no evidence at all', () => {
    const empty: CatalogAudit = new Map();
    const entry = buildCardReport(['Forest'], { index, audit: empty, scenarios: null }).cards[0]!;
    expect(entry.status).toBe('implemented-unreviewed');
    expect(entry).not.toHaveProperty('evidence');
    expect(entry.unmodeledReasons).toEqual([]);
  });

  it('says so when the ledger cannot be read', () => {
    const report = buildCardReport(['Forest', 'Nonesuch Card'], {
      index,
      audit: null,
      scenarios: null,
    });
    expect(report.auditAvailable).toBe(false);
    expect(report.cards[0]).not.toHaveProperty('evidence');
    expect(report.unresolved).toEqual(['Nonesuch Card']);
  });

  it('matches lab scenarios by Oracle hash, and says null when there is no lab', () => {
    const card = byName('Adaptive Omnitool');
    const scenario: CardTestScenarioMetadata = {
      id: 'lab-omnitool',
      version: 1,
      title: 'Omnitool',
      instructions: [],
      expectedOutcome: '',
      oracleSha256: oracleSha256(card),
      clauseIds: ['c1'],
    };
    const other = { ...scenario, id: 'other', oracleSha256: 'a'.repeat(64) };
    const withLab = buildCardReport([card.name, 'Forest'], {
      index,
      audit,
      scenarios: [scenario, other],
    });
    expect(withLab.labAvailable).toBe(true);
    expect(withLab.cards[0]?.scenarios).toEqual([
      { id: 'lab-omnitool', title: 'Omnitool', clauseIds: ['c1'] },
    ]);
    expect(withLab.cards[1]?.scenarios).toEqual([]);
    const noLab = buildCardReport([card.name], { index, audit, scenarios: null });
    expect(noLab.labAvailable).toBe(false);
    expect(noLab.cards[0]?.scenarios).toBeNull();
  });

  it('keeps asked order and drops repeats', () => {
    const report = buildCardReport(['Forest', 'Adaptive Omnitool', 'forest'], {
      index,
      audit,
      scenarios: null,
    });
    expect(report.cards.map((card) => card.name)).toEqual(['Forest', 'Adaptive Omnitool']);
  });
});

describe('GET /api/card-report', () => {
  const server = new GameServer({
    index,
    pool: { cards: [] },
    banned: {},
  } as unknown as GameServerDeps) as unknown as { handleCardReport(url: URL): Response };
  const ask = (query: string): Response =>
    server.handleCardReport(new URL(`http://localhost/api/card-report?${query}`));

  it('answers repeated names, including names with commas', async () => {
    const response = ask('names=Forest&names=Gev%2C%20Scaled%20Scorch');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { cards: { name: string }[]; unresolved: string[] };
    expect(body.cards.map((card) => card.name)).toEqual(
      ['Forest', 'Gev, Scaled Scorch'].filter((name) => index.resolve(name) !== null),
    );
  });

  it('refuses no names and too many names', async () => {
    expect(ask('').status).toBe(400);
    const many = Array.from({ length: CARD_REPORT_MAX_NAMES + 1 }, (_, i) => `names=Card${i}`);
    const response = ask(many.join('&'));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toMatch(/at most 250/);
    expect(ask(many.slice(0, CARD_REPORT_MAX_NAMES).join('&')).status).toBe(200);
  });
});
