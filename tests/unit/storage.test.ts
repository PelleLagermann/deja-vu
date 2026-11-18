import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION, type Recording } from '@shared/model/recording';
import type { RunRecord } from '@shared/model/execution';
import type { SetupStep } from '@shared/model/setup';
import { newSetupStep } from '@shared/setup';
import { duplicateRecording, newRecording, newStep } from '@shared/steps';
import {
  ImportError,
  Storage,
  exportCollection,
  exportFileName,
  exportRecording,
  importFile,
  parseExportFile,
} from '../../src/storage-engine';
import { EXPORT_FORMAT, migrate } from '../../src/storage-engine/schema';

let factory: IDBFactory;
let storage: Storage;

function sample(partial: Partial<Recording> = {}): Recording {
  return newRecording({
    name: 'Create customer',
    startUrl: 'https://app.example.test/customers',
    steps: [newStep({ type: 'navigate', url: 'https://app.example.test' }), newStep({ type: 'input', value: 'Ada' })],
    ...partial,
  });
}

function cookieSetup(): SetupStep {
  return newSetupStep({ type: 'setCookie', name: 'session', value: 'secret-token', path: '/', expiresInDays: 7 });
}

beforeEach(() => {
  factory = new IDBFactory();
  storage = new Storage({ factory, broadcast: false });
});

describe('recordings', () => {
  it('stores and retrieves a recording intact', async () => {
    const recording = sample();
    await storage.saveRecording(recording);
    expect(await storage.getRecording(recording.id)).toEqual(recording);
  });

  it('survives a restart', async () => {
    const recording = sample();
    await storage.saveRecording(recording);
    const reopened = new Storage({ factory, broadcast: false });
    expect((await reopened.getRecording(recording.id))?.steps).toEqual(recording.steps);
  });

  it('lists metadata without step data, newest first', async () => {
    await storage.saveRecording(sample({ name: 'old', updatedAt: 1 }));
    await storage.saveRecording(sample({ name: 'new', updatedAt: 2 }));
    const list = await storage.listRecordings();
    expect(list.map((item) => item.name)).toEqual(['new', 'old']);
    expect(list[0]!.stepCount).toBe(2);
    expect(list[0]).not.toHaveProperty('steps');
  });

  it('updates atomically and bumps the timestamp', async () => {
    const recording = sample({ updatedAt: 1 });
    await storage.saveRecording(recording);
    const updated = await storage.updateRecording(recording.id, (draft) => {
      draft.steps.pop();
    });
    expect(updated.updatedAt).toBeGreaterThan(1);
    expect((await storage.listRecordings())[0]!.stepCount).toBe(1);
  });

  it('does not lose concurrent updates', async () => {
    const recording = sample({ steps: [] });
    await storage.saveRecording(recording);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        storage.updateRecording(recording.id, (draft) => {
          draft.steps.push(newStep({ type: 'input', value: String(index) }));
        }),
      ),
    );
    expect((await storage.getRecording(recording.id))?.steps).toHaveLength(20);
  });

  it('rejects an update to a missing recording', async () => {
    await expect(storage.updateRecording('nope', () => undefined)).rejects.toThrow(/update the recording/);
  });

  it('deletes a recording along with its runs', async () => {
    const recording = sample();
    await storage.saveRecording(recording);
    const run: RunRecord = { id: 'r1', recordingId: recording.id, startedAt: 1, finishedAt: 2, outcome: 'completed', log: [] };
    await storage.saveRun(run);
    await storage.deleteRecording(recording.id);
    expect(await storage.getRecording(recording.id)).toBeUndefined();
    expect(await storage.listRuns(recording.id)).toEqual([]);
  });

  it('never persists the value of a secret variable', async () => {
    const recording = sample({ variables: [{ name: 'pw', defaultValue: 'hunter2', secret: true }] });
    await storage.saveRecording(recording);
    expect((await storage.getRecording(recording.id))?.variables[0]?.defaultValue).toBe('');
  });

  it('stores setup steps with the recording', async () => {
    const recording = sample({ setup: [cookieSetup()] });
    await storage.saveRecording(recording);
    expect((await storage.getRecording(recording.id))?.setup).toEqual(recording.setup);
  });

  it('reads a recording stored before setup existed as having none', async () => {
    const recording = sample();
    await storage.saveRecording({ ...recording, setup: undefined as never });
    expect((await storage.getRecording(recording.id))?.setup).toEqual([]);
  });

  it('tells subscribers about changes', async () => {
    const listener = vi.fn();
    storage.subscribe(listener);
    const recording = sample();
    await storage.saveRecording(recording);
    expect(listener).toHaveBeenCalledWith({ entity: 'recording', id: recording.id });
  });

  it('duplicates with fresh IDs, keeping groups connected', () => {
    const source = sample({ groups: [{ id: 'g', name: 'Group' }] });
    source.steps[0]!.groupId = 'g';
    const copy = duplicateRecording(source, 'Copy');
    expect(copy.id).not.toBe(source.id);
    expect(copy.steps[0]!.id).not.toBe(source.steps[0]!.id);
    expect(copy.steps[0]!.groupId).toBe(copy.groups[0]!.id);
    expect(copy.groups[0]!.id).not.toBe('g');
  });

  it('duplicates setup steps under fresh IDs', () => {
    const source = sample({ setup: [cookieSetup()] });
    const copy = duplicateRecording(source, 'Copy');
    expect(copy.setup[0]!.id).not.toBe(source.setup[0]!.id);
    expect(copy.setup[0]!.action).toEqual(source.setup[0]!.action);
  });
});

describe('collections', () => {
  it('creates and lists collections by name', async () => {
    await storage.createCollection('Zebra');
    await storage.createCollection('Alpha', 'First');
    const list = await storage.listCollections();
    expect(list.map((item) => item.name)).toEqual(['Alpha', 'Zebra']);
    expect(list[0]!.description).toBe('First');
  });

  it('keeps recordings when their collection is deleted', async () => {
    const collection = await storage.createCollection('Temp');
    const recording = sample({ collectionId: collection.id });
    await storage.saveRecording(recording);
    await storage.deleteCollection(collection.id);
    expect((await storage.getRecording(recording.id))?.collectionId).toBeNull();
  });
});

describe('runs and settings', () => {
  it('keeps only the most recent runs of a recording', async () => {
    for (let i = 0; i < 25; i++) {
      await storage.saveRun({ id: `r${i}`, recordingId: 'x', startedAt: i, finishedAt: i, outcome: 'completed', log: [] });
    }
    const runs = await storage.listRuns('x');
    expect(runs).toHaveLength(20);
    expect(runs[0]!.id).toBe('r24');
  });

  it('merges stored settings over defaults, so new settings get a value', async () => {
    expect((await storage.getSettings()).defaultTimeoutMs).toBe(10_000);
    const settings = await storage.getSettings();
    await storage.saveSettings({ ...settings, theme: 'dark' });
    expect((await storage.getSettings()).theme).toBe('dark');
  });
});

describe('export', () => {
  it('produces a versioned file', () => {
    const file = exportRecording(sample());
    expect(file).toMatchObject({ format: EXPORT_FORMAT, schemaVersion: SCHEMA_VERSION, kind: 'recording' });
    expect(file.recordings).toHaveLength(1);
  });

  it('can strip typed values for sharing', () => {
    const file = exportRecording(sample(), { stripValues: true });
    expect(file.recordings[0]!.steps[1]!.action).toEqual({ type: 'input', value: '', redacted: true });
  });

  it('strips cookie values along with typed values', () => {
    const file = exportRecording(sample({ setup: [cookieSetup()] }), { stripValues: true });
    expect(file.recordings[0]!.setup[0]!.action).toMatchObject({ type: 'setCookie', name: 'session', value: '' });
  });

  it('never exports secret variable values', () => {
    const file = exportRecording(sample({ variables: [{ name: 'k', defaultValue: 'v', secret: true }] }));
    expect(file.recordings[0]!.variables[0]!.defaultValue).toBe('');
  });

  it('makes safe file names', () => {
    expect(exportFileName('Create customer / v2!')).toBe('create-customer-v2.dejavu.json');
  });
});

describe('import', () => {
  it('round-trips a recording under new IDs', async () => {
    const original = sample({ groups: [{ id: 'g', name: 'Fill' }], tags: ['smoke'] });
    original.steps[1]!.groupId = 'g';
    const { recordings } = await importFile(storage, JSON.stringify(exportRecording(original)));
    const imported = await storage.getRecording(recordings[0]!.id);
    expect(imported?.id).not.toBe(original.id);
    expect(imported?.name).toBe(original.name);
    expect(imported?.tags).toEqual(['smoke']);
    expect(imported?.steps.map((step) => step.action)).toEqual(original.steps.map((step) => step.action));
    expect(imported?.steps[1]!.groupId).toBe(imported?.groups[0]!.id);
  });

  it('round-trips setup steps under new IDs', async () => {
    const original = sample({ setup: [cookieSetup(), newSetupStep({ type: 'clearCookies' })] });
    const { recordings } = await importFile(storage, JSON.stringify(exportRecording(original)));
    const imported = await storage.getRecording(recordings[0]!.id);
    expect(imported?.setup.map((item) => item.action)).toEqual(original.setup.map((item) => item.action));
    expect(imported?.setup[0]!.id).not.toBe(original.setup[0]!.id);
  });

  it('upgrades a version 1 file to have no setup', () => {
    const file = valid();
    file.schemaVersion = 1;
    file.recordings[0].schemaVersion = 1;
    delete file.recordings[0].setup;
    const parsed = parseExportFile(JSON.stringify(file));
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.recordings[0]!.setup).toEqual([]);
  });

  it('can be repeated without overwriting anything', async () => {
    const text = JSON.stringify(exportRecording(sample()));
    await importFile(storage, text);
    await importFile(storage, text);
    expect(await storage.listRecordings()).toHaveLength(2);
  });

  it('round-trips a collection and keeps links between its recordings', async () => {
    const shared = sample({ name: 'Login' });
    const main = sample({ name: 'Main', steps: [newStep({ type: 'runRecording', recordingId: shared.id })] });
    const collection = await storage.createCollection('Suite', 'All of it');
    const text = JSON.stringify(exportCollection(collection, [shared, main]));

    const result = await importFile(storage, text);
    expect(result.collection?.name).toBe('Suite');
    expect(result.collection?.id).not.toBe(collection.id);
    expect(result.recordings.every((recording) => recording.collectionId === result.collection?.id)).toBe(true);

    const importedLogin = result.recordings.find((recording) => recording.name === 'Login')!;
    const importedMain = result.recordings.find((recording) => recording.name === 'Main')!;
    expect(importedMain.steps[0]!.action).toEqual({ type: 'runRecording', recordingId: importedLogin.id });
  });

  const valid = () => JSON.parse(JSON.stringify(exportRecording(sample({ setup: [cookieSetup()] }))));

  it.each<[string, (file: ReturnType<typeof valid>) => void, RegExp]>([
    ['the wrong format', (file) => (file.format = 'other'), /isn't a Déjà Vu/],
    ['a missing version', (file) => delete file.schemaVersion, /schemaVersion/],
    ['a future version', (file) => (file.schemaVersion = 999), /Update the extension/],
    ['an unknown kind', (file) => (file.kind = 'x'), /kind/],
    ['no recordings', (file) => (file.recordings = []), /at least one/],
    ['a step without an action', (file) => delete file.recordings[0].steps[0].action, /steps\[0\]\.action/],
    ['an unknown action', (file) => (file.recordings[0].steps[1].action.type = 'hack'), /unknown action "hack"/],
    ['a bad execution type', (file) => (file.recordings[0].steps[0].execution = 'maybe'), /execution/],
    ['a missing required field', (file) => delete file.recordings[0].steps[1].action.value, /action\.value/],
    ['a bad selector kind', (file) => {
      file.recordings[0].steps[1].target = { selectors: [{ kind: 'magic', value: 'x' }], fingerprint: { tag: 'a' }, summary: 'a' };
    }, /unknown kind "magic"/],
    ['setup that is not a list', (file) => (file.recordings[0].setup = {}), /setup: expected an array/],
    ['an unknown setup action', (file) => (file.recordings[0].setup[0].action.type = 'wipeDisk'), /unknown setup action "wipeDisk"/],
    ['a cookie without a name', (file) => delete file.recordings[0].setup[0].action.name, /setup\[0\]\.action\.name/],
    ['a setup site that is not a web address', (file) => (file.recordings[0].setup[0].action.url = 'javascript:alert(1)'), /http or https/],
    ['a bad SameSite value', (file) => (file.recordings[0].setup[0].action.sameSite = 'sometimes'), /sameSite/],
  ])('rejects %s', (_name, corrupt, message) => {
    const file = valid();
    corrupt(file);
    expect(() => parseExportFile(JSON.stringify(file))).toThrow(message);
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseExportFile('{nope')).toThrow(ImportError);
  });

  it.each(['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'about:config', 'moz-extension://x'])(
    'refuses a navigate step to %s',
    (url) => {
      const file = valid();
      file.recordings[0].steps[0].action.url = url;
      expect(() => parseExportFile(JSON.stringify(file))).toThrow(/web addresses/);
    },
  );

  it('accepts a URL that starts with a variable', () => {
    const file = valid();
    file.recordings[0].steps[0].action.url = '{{baseUrl}}/login';
    expect(() => parseExportFile(JSON.stringify(file))).not.toThrow();
  });
});

describe('migrations', () => {
  it('upgrades through each version in turn', () => {
    const migrated = migrate(
      { schemaVersion: 1, steps: 'old' },
      {
        1: (file) => ({ ...file, renamed: file['steps'] }),
        2: (file) => ({ ...file, added: true }),
      },
      3,
    );
    expect(migrated).toEqual({ schemaVersion: 3, steps: 'old', renamed: 'old', added: true });
  });

  it('fails clearly if a step in the chain is missing', () => {
    expect(() => migrate({ schemaVersion: 1 }, {}, 2)).toThrow(/no upgrade path/);
  });
});
