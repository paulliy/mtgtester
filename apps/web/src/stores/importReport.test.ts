import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMPORT_REPORT_STORAGE_KEY,
  parseFailedImport,
  useImportReportStore,
  type FailedImport,
} from './importReport';

const sample: FailedImport = {
  seat: 'P2',
  sourceKind: 'plaintext',
  source: 'Commander\n1 Test General\n1 Mystery Engine',
  archetypeTag: '',
  deckName: 'Test General',
  unmodeled: [{ name: 'Mystery Engine', oracleSha256: 'a'.repeat(64), status: 'unsupported' }],
};

function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.unstubAllGlobals();
});

describe('parseFailedImport', () => {
  it('round-trips a report', () => {
    expect(parseFailedImport(JSON.stringify(sample))).toEqual(sample);
  });
  it('refuses anything that is not that shape', () => {
    expect(parseFailedImport(null)).toBeNull();
    expect(parseFailedImport('not json')).toBeNull();
    expect(parseFailedImport('{"seat":"P1"}')).toBeNull();
    expect(
      parseFailedImport(JSON.stringify({ ...sample, unmodeled: [{ name: 'X', status: 'done' }] })),
    ).toBeNull();
  });
});

describe('import report store', () => {
  it('mirrors to sessionStorage and gives the list back once', () => {
    const storage = fakeStorage();
    vi.stubGlobal('window', { sessionStorage: storage });
    const store = useImportReportStore();
    store.fill(sample);
    expect(JSON.parse(storage.getItem(IMPORT_REPORT_STORAGE_KEY)!)).toEqual(sample);
    expect(store.takeDraft()).toEqual(sample);
    expect(store.takeDraft()).toBeNull();
    expect(store.report).toEqual(sample);
    store.clear();
    expect(store.report).toBeNull();
    expect(storage.getItem(IMPORT_REPORT_STORAGE_KEY)).toBeNull();
  });

  it('reads a stored report after a reload', () => {
    const storage = fakeStorage();
    storage.setItem(IMPORT_REPORT_STORAGE_KEY, JSON.stringify(sample));
    vi.stubGlobal('window', { sessionStorage: storage });
    expect(useImportReportStore().report).toEqual(sample);
  });

  it('keeps working when storage throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    vi.stubGlobal('window', { sessionStorage: throwing });
    const store = useImportReportStore();
    expect(store.report).toBeNull();
    store.fill(sample);
    expect(store.report).toEqual(sample);
    store.clear();
    expect(store.report).toBeNull();
  });

  it('keeps working when sessionStorage itself is unreachable', () => {
    vi.stubGlobal('window', {
      get sessionStorage(): Storage {
        throw new Error('denied');
      },
    });
    const store = useImportReportStore();
    store.fill(sample);
    expect(store.report).toEqual(sample);
  });
});
