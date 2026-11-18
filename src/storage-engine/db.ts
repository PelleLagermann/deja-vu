import type { RunRecord } from '@shared/model/execution';
import {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  type Collection,
  type Recording,
  type RecordingMeta,
  type Settings,
  type StepGroup,
  type VariableDef,
} from '@shared/model/recording';
import type { SetupStep } from '@shared/model/setup';
import type { Step } from '@shared/model/step';
import { createId } from '@shared/util';

const DB_NAME = 'deja-vu';
const DB_VERSION = 1;
const RUNS_KEPT_PER_RECORDING = 20;

const META = 'recordings';
const CONTENT = 'recordingContent';
const COLLECTIONS = 'collections';
const RUNS = 'runs';
const KV = 'kv';

/** The heavy part of a recording, kept apart so that listing never has to load it. */
interface ContentRow {
  id: string;
  steps: Step[];
  groups: StepGroup[];
  variables: VariableDef[];
  /** Absent in rows written before schema version 2. */
  setup?: SetupStep[];
}

export type StorageEntity = 'recording' | 'collection' | 'settings' | 'run';

export interface StorageChange {
  entity: StorageEntity;
  id?: string;
}

export class StorageError extends Error {
  constructor(action: string, cause: unknown) {
    const quota = cause instanceof DOMException && cause.name === 'QuotaExceededError';
    super(
      quota
        ? `Couldn't ${action}: the browser's storage is full. Delete some recordings and try again.`
        : `Couldn't ${action}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'StorageError';
  }
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted'));
    transaction.onerror = () => reject(transaction.error);
  });
}

function toRows(recording: Recording): { meta: RecordingMeta; content: ContentRow } {
  const { steps, groups, variables, setup, ...rest } = recording;
  return {
    meta: { ...rest, stepCount: steps.length },
    content: {
      id: recording.id,
      steps,
      groups,
      setup,
      // Secret values must never reach the disk.
      variables: variables.map((variable) => (variable.secret ? { ...variable, defaultValue: '' } : variable)),
    },
  };
}

function fromRows(meta: RecordingMeta, content: ContentRow | undefined): Recording {
  const { stepCount: _stepCount, ...rest } = meta;
  return {
    ...rest,
    steps: content?.steps ?? [],
    groups: content?.groups ?? [],
    variables: content?.variables ?? [],
    setup: content?.setup ?? [],
  };
}

export interface StorageOptions {
  factory?: IDBFactory;
  /** Set to false where BroadcastChannel isn't wanted. */
  broadcast?: boolean;
}

/**
 * All persistence. Both the background page and the sidebar open their own instance;
 * every read-modify-write is a single transaction, so they can't overwrite each other.
 */
export class Storage {
  private readonly factory: IDBFactory;
  private database: Promise<IDBDatabase> | null = null;
  private readonly listeners = new Set<(change: StorageChange) => void>();
  private readonly channel: BroadcastChannel | null;

  constructor(options: StorageOptions = {}) {
    this.factory = options.factory ?? indexedDB;
    this.channel = options.broadcast === false ? null : new BroadcastChannel('dejavu-storage');
    if (this.channel) {
      this.channel.onmessage = (event: MessageEvent<StorageChange>) => this.deliver(event.data);
    }
  }

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = this.factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const meta = db.createObjectStore(META, { keyPath: 'id' });
        meta.createIndex('collectionId', 'collectionId');
        db.createObjectStore(CONTENT, { keyPath: 'id' });
        db.createObjectStore(COLLECTIONS, { keyPath: 'id' });
        const runs = db.createObjectStore(RUNS, { keyPath: 'id' });
        runs.createIndex('recordingId', 'recordingId');
        db.createObjectStore(KV);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.database = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(new StorageError('open the database', request.error));
      request.onblocked = () => reject(new StorageError('open the database', new Error('Another tab is blocking the upgrade')));
    });
    return this.database;
  }

  /* ---------- Change notification ---------- */

  subscribe(listener: (change: StorageChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private deliver(change: StorageChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private notify(change: StorageChange): void {
    this.deliver(change);
    this.channel?.postMessage(change);
  }

  /* ---------- Recordings ---------- */

  async listRecordings(): Promise<RecordingMeta[]> {
    const db = await this.open();
    const rows = await promisify(db.transaction(META).objectStore(META).getAll() as IDBRequest<RecordingMeta[]>);
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getRecording(id: string): Promise<Recording | undefined> {
    const db = await this.open();
    const transaction = db.transaction([META, CONTENT]);
    const [meta, content] = await Promise.all([
      promisify(transaction.objectStore(META).get(id) as IDBRequest<RecordingMeta | undefined>),
      promisify(transaction.objectStore(CONTENT).get(id) as IDBRequest<ContentRow | undefined>),
    ]);
    return meta ? fromRows(meta, content) : undefined;
  }

  async saveRecording(recording: Recording): Promise<void> {
    try {
      const db = await this.open();
      const transaction = db.transaction([META, CONTENT], 'readwrite');
      const { meta, content } = toRows({ ...recording, schemaVersion: SCHEMA_VERSION });
      transaction.objectStore(META).put(meta);
      transaction.objectStore(CONTENT).put(content);
      await transactionDone(transaction);
    } catch (error) {
      throw new StorageError('save the recording', error);
    }
    this.notify({ entity: 'recording', id: recording.id });
  }

  /** Applies a change atomically. `mutate` runs inside the transaction and must be synchronous. */
  async updateRecording(id: string, mutate: (recording: Recording) => void): Promise<Recording> {
    let updated: Recording | undefined;
    try {
      const db = await this.open();
      const transaction = db.transaction([META, CONTENT], 'readwrite');
      const metaStore = transaction.objectStore(META);
      const contentStore = transaction.objectStore(CONTENT);
      const metaRequest = metaStore.get(id) as IDBRequest<RecordingMeta | undefined>;
      const contentRequest = contentStore.get(id) as IDBRequest<ContentRow | undefined>;
      contentRequest.onsuccess = () => {
        const meta = metaRequest.result;
        if (!meta) {
          transaction.abort();
          return;
        }
        const recording = fromRows(meta, contentRequest.result);
        try {
          mutate(recording);
        } catch (error) {
          transaction.abort();
          throw error;
        }
        recording.updatedAt = Date.now();
        const rows = toRows(recording);
        metaStore.put(rows.meta);
        contentStore.put(rows.content);
        updated = recording;
      };
      await transactionDone(transaction);
    } catch (error) {
      throw new StorageError('update the recording', error);
    }
    if (!updated) throw new StorageError('update the recording', new Error('It no longer exists'));
    this.notify({ entity: 'recording', id });
    return updated;
  }

  async deleteRecording(id: string): Promise<void> {
    try {
      const db = await this.open();
      const transaction = db.transaction([META, CONTENT, RUNS], 'readwrite');
      transaction.objectStore(META).delete(id);
      transaction.objectStore(CONTENT).delete(id);
      const runs = transaction.objectStore(RUNS);
      const keys = await promisify(runs.index('recordingId').getAllKeys(id));
      for (const key of keys) runs.delete(key);
      await transactionDone(transaction);
    } catch (error) {
      throw new StorageError('delete the recording', error);
    }
    this.notify({ entity: 'recording', id });
  }

  /* ---------- Collections ---------- */

  async listCollections(): Promise<Collection[]> {
    const db = await this.open();
    const rows = await promisify(db.transaction(COLLECTIONS).objectStore(COLLECTIONS).getAll() as IDBRequest<Collection[]>);
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveCollection(collection: Collection): Promise<void> {
    try {
      const db = await this.open();
      const transaction = db.transaction(COLLECTIONS, 'readwrite');
      transaction.objectStore(COLLECTIONS).put(collection);
      await transactionDone(transaction);
    } catch (error) {
      throw new StorageError('save the collection', error);
    }
    this.notify({ entity: 'collection', id: collection.id });
  }

  async createCollection(name: string, description = ''): Promise<Collection> {
    const now = Date.now();
    const collection: Collection = { id: createId('col'), name, description, createdAt: now, updatedAt: now };
    await this.saveCollection(collection);
    return collection;
  }

  /** Deletes a collection. Its recordings stay, without a collection. */
  async deleteCollection(id: string): Promise<void> {
    try {
      const db = await this.open();
      const transaction = db.transaction([COLLECTIONS, META], 'readwrite');
      transaction.objectStore(COLLECTIONS).delete(id);
      const metaStore = transaction.objectStore(META);
      const members = await promisify(metaStore.index('collectionId').getAll(id) as IDBRequest<RecordingMeta[]>);
      for (const member of members) metaStore.put({ ...member, collectionId: null });
      await transactionDone(transaction);
    } catch (error) {
      throw new StorageError('delete the collection', error);
    }
    this.notify({ entity: 'collection', id });
    this.notify({ entity: 'recording' });
  }

  /* ---------- Runs ---------- */

  async saveRun(run: RunRecord): Promise<void> {
    try {
      const db = await this.open();
      const transaction = db.transaction(RUNS, 'readwrite');
      const store = transaction.objectStore(RUNS);
      store.put(run);
      const all = await promisify(store.index('recordingId').getAll(run.recordingId) as IDBRequest<RunRecord[]>);
      all
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(RUNS_KEPT_PER_RECORDING)
        .forEach((old) => store.delete(old.id));
      await transactionDone(transaction);
    } catch (error) {
      throw new StorageError('save the run log', error);
    }
    this.notify({ entity: 'run', id: run.recordingId });
  }

  async listRuns(recordingId: string): Promise<RunRecord[]> {
    const db = await this.open();
    const rows = await promisify(
      db.transaction(RUNS).objectStore(RUNS).index('recordingId').getAll(recordingId) as IDBRequest<RunRecord[]>,
    );
    return rows.sort((a, b) => b.startedAt - a.startedAt);
  }

  /* ---------- Settings ---------- */

  async getSettings(): Promise<Settings> {
    const db = await this.open();
    const stored = await promisify(db.transaction(KV).objectStore(KV).get('settings') as IDBRequest<Partial<Settings> | undefined>);
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  async saveSettings(settings: Settings): Promise<void> {
    try {
      const db = await this.open();
      const transaction = db.transaction(KV, 'readwrite');
      transaction.objectStore(KV).put(settings, 'settings');
      await transactionDone(transaction);
    } catch (error) {
      throw new StorageError('save the settings', error);
    }
    this.notify({ entity: 'settings' });
  }
}
